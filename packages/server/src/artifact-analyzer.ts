import type { ArtifactAnalysis, Artifact } from "@synth-deploy/core";
import type { LlmClient, LlmResult } from "@synth-deploy/core";
import type { DebriefWriter } from "@synth-deploy/core";
import { sanitizeForPrompt } from "@synth-deploy/core";
import type { PatternStore, PatternMatch, DerivedAnalysis } from "./pattern-store.js";
import { archiveFormat, unpackArchive, formatExtractedFiles } from "./archive-unpacker.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArtifactInput {
  name: string;
  type?: string;
  source: string;
  content?: Buffer;
  metadata?: Record<string, string>;
}

export interface AnalysisResult {
  analysis: ArtifactAnalysis;
  /** How the analysis was produced */
  method: "llm" | "pattern-auto" | "pattern-suggest" | "unavailable";
  /** Patterns that were matched, if any */
  matchedPatterns?: PatternMatch[];
}

// ---------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------

/**
 * Detect artifact type from name and metadata.
 * Used as a hint for the LLM and for intake routing — not for analysis.
 */
export function detectArtifactType(artifact: ArtifactInput): string {
  if (artifact.type) return artifact.type;

  const name = artifact.name.toLowerCase();
  const meta = artifact.metadata || {};

  if (name === "dockerfile" || name.endsWith("/dockerfile") || meta["content-type"]?.includes("dockerfile")) {
    return "dockerfile";
  }
  if (name === "chart.yaml" || name === "chart.yml") return "helm-chart";
  if (name === "values.yaml" || name === "values.yml") return "helm-values";
  if (name === "package.json") return "node-package";
  if (name === "makefile" || name.endsWith("/makefile")) return "makefile";
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return "tarball";
  if (name.endsWith(".tar")) return "tarball";
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".nupkg")) return "nupkg";
  if (name.endsWith(".jar") || name.endsWith(".war") || name.endsWith(".ear")) return "java-archive";
  if (name.endsWith(".whl")) return "python-package";
  if (name.endsWith(".deb")) return "debian-package";
  if (name.endsWith(".rpm")) return "rpm-package";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".sh") || name.endsWith(".bash")) return "shell-script";

  return "unknown";
}

// ---------------------------------------------------------------------------
// LLM reasoning
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT = `You are a deployment artifact analyzer. Given information about a deployment artifact, produce a structured analysis.

Your response must be valid JSON with these fields:
- "summary": A plain-language description (1-3 sentences) of what this artifact is and how it should be deployed.
- "dependencies": An array of strings listing runtime dependencies, system requirements, or external services needed.
- "configurationExpectations": An object mapping configuration key names to descriptions of expected values.
- "deploymentIntent": A short phrase describing the deployment method (e.g., "Container deployment via Docker Compose", "Kubernetes Helm release").
- "confidence": A number 0-1 indicating how confident you are in this analysis.

Focus on actionable deployment intelligence. Be specific about ports, environment variables, and deployment prerequisites.`;

async function analyzeWithLlm(
  llm: LlmClient,
  artifact: ArtifactInput,
  artifactType: string,
  extractedArchiveContent?: string,
): Promise<ArtifactAnalysis | null> {
  const contentSection = extractedArchiveContent
    ? `Archive contents:\n\n${sanitizeForPrompt(extractedArchiveContent)}`
    : artifact.content
      ? `Content:\n'''\n${sanitizeForPrompt(artifact.content.toString("utf-8").slice(0, 4000))}\n'''`
      : "(no content available)";

  const prompt = `Analyze this deployment artifact.

Name: ${sanitizeForPrompt(artifact.name)}
Type: ${sanitizeForPrompt(artifactType)}
Source: ${sanitizeForPrompt(artifact.source)}
Metadata: ${sanitizeForPrompt(JSON.stringify(artifact.metadata || {}))}

${contentSection}

Produce a JSON analysis of this artifact for deployment planning purposes.`;

  const result: LlmResult = await llm.reason({
    prompt,
    systemPrompt: ANALYSIS_SYSTEM_PROMPT,
    promptSummary: `Artifact analysis for "${artifact.name}" (${artifactType})`,
  });

  if (!result.ok) {
    console.warn(`[artifact-analyzer] LLM analysis failed for "${artifact.name}": ${result.reason}`);
    return null;
  }

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      summary?: string;
      dependencies?: string[];
      configurationExpectations?: Record<string, string>;
      deploymentIntent?: string;
      confidence?: number;
    };

    return {
      summary: parsed.summary ?? `Analysis of "${artifact.name}"`,
      dependencies: parsed.dependencies ?? [],
      configurationExpectations: parsed.configurationExpectations ?? {},
      deploymentIntent: parsed.deploymentIntent,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pattern overlay
// ---------------------------------------------------------------------------

function applyPatternOverrides(
  analysis: ArtifactAnalysis,
  derived: DerivedAnalysis,
): ArtifactAnalysis {
  return {
    summary: derived.summary || analysis.summary,
    dependencies: derived.dependencies && derived.dependencies.length > 0
      ? derived.dependencies
      : analysis.dependencies,
    configurationExpectations: derived.configurationExpectations
      ? { ...analysis.configurationExpectations, ...derived.configurationExpectations }
      : analysis.configurationExpectations,
    deploymentIntent: derived.deploymentIntent || analysis.deploymentIntent,
    confidence: analysis.confidence,
  };
}

// ---------------------------------------------------------------------------
// ArtifactAnalyzer
// ---------------------------------------------------------------------------

export interface ArtifactAnalyzerDeps {
  llm: LlmClient;
  debrief: DebriefWriter;
  patternStore?: PatternStore;
}

/**
 * Artifact analysis engine.
 *
 * Analysis pipeline:
 *   1. Check pattern store for matching corrections (if available)
 *      - Auto-apply if >= 2 corrections and confidence >= 0.7 (no LLM call)
 *      - Suggest if 1 correction or confidence < 0.7 (apply as overlay after LLM)
 *   2. If LLM is unavailable, return an "unavailable" result — no silent fallback
 *   3. Run LLM analysis on the raw artifact content
 *   4. Apply pattern-suggest overlay if applicable
 *   5. Record debrief entry with decision trail
 */
export class ArtifactAnalyzer {
  private readonly _llm: LlmClient;
  private readonly _debrief: DebriefWriter;
  private readonly _patternStore?: PatternStore;

  constructor(deps: ArtifactAnalyzerDeps) {
    this._llm = deps.llm;
    this._debrief = deps.debrief;
    this._patternStore = deps.patternStore;
  }

  /**
   * Analyze a deployment artifact. Returns structured analysis with
   * confidence score and method used.
   */
  async analyze(artifact: ArtifactInput): Promise<AnalysisResult> {
    const artifactType = detectArtifactType(artifact);
    const reasoningTrail: string[] = [];

    reasoningTrail.push(`Artifact: "${artifact.name}", detected type: ${artifactType}, source: ${artifact.source}`);

    // --- Step 1: Check pattern store ---
    let matchedPatterns: PatternMatch[] = [];
    if (this._patternStore) {
      matchedPatterns = this._patternStore.findMatches(
        artifact.source,
        artifactType,
        artifact.name,
      );

      if (matchedPatterns.length > 0) {
        const autoMatch = matchedPatterns.find((m) => m.mode === "auto");
        if (autoMatch) {
          reasoningTrail.push(
            `Pattern match: "${autoMatch.pattern.namePattern}" (${autoMatch.pattern.corrections.length} corrections, confidence ${autoMatch.pattern.confidence}). Auto-applying without LLM call.`,
          );

          const analysis: ArtifactAnalysis = {
            summary: autoMatch.pattern.derivedAnalysis.summary ?? `Pattern-matched artifact "${artifact.name}"`,
            dependencies: autoMatch.pattern.derivedAnalysis.dependencies ?? [],
            configurationExpectations: autoMatch.pattern.derivedAnalysis.configurationExpectations ?? {},
            deploymentIntent: autoMatch.pattern.derivedAnalysis.deploymentIntent,
            confidence: autoMatch.pattern.confidence,
          };

          this._patternStore.recordApplication(autoMatch.pattern.id);
          reasoningTrail.push("Pattern derived analysis applied directly.");

          this._recordDebrief(artifact, artifactType, analysis, "pattern-auto", reasoningTrail);

          return { analysis, method: "pattern-auto", matchedPatterns };
        }

        reasoningTrail.push(
          `Pattern suggestion available: "${matchedPatterns[0].pattern.namePattern}" ` +
          `(${matchedPatterns[0].pattern.corrections.length} corrections, ` +
          `confidence ${matchedPatterns[0].pattern.confidence}). ` +
          `Not auto-applying — threshold not met.`,
        );
      }
    }

    // --- Step 2: Unpack archive if applicable ---
    let extractedArchiveContent: string | undefined;
    if (artifact.content) {
      const format = archiveFormat(artifactType, artifact.name);
      if (format) {
        const unpacked = await unpackArchive(artifact.content, format);
        extractedArchiveContent = formatExtractedFiles(unpacked);
        reasoningTrail.push(
          `Archive unpacked (${format}): ${unpacked.files.length} text files extracted, ${unpacked.skipped} skipped.`,
        );
      }
    }

    // --- Step 3: Require LLM ---

    if (!this._llm.isAvailable()) {
      const analysis: ArtifactAnalysis = {
        summary: `Cannot analyze "${artifact.name}" — LLM is required for artifact analysis.`,
        dependencies: [],
        configurationExpectations: {},
        confidence: 0,
      };

      reasoningTrail.push("LLM not available — analysis cannot proceed.");
      this._recordDebrief(artifact, artifactType, analysis, "unavailable", reasoningTrail);

      return { analysis, method: "unavailable" };
    }

    // --- Step 4: LLM analysis ---
    reasoningTrail.push("LLM available — analyzing artifact.");
    const llmAnalysis = await analyzeWithLlm(this._llm, artifact, artifactType, extractedArchiveContent);

    if (!llmAnalysis) {
      const analysis: ArtifactAnalysis = {
        summary: `Analysis of "${artifact.name}" failed — LLM returned no usable result.`,
        dependencies: [],
        configurationExpectations: {},
        confidence: 0,
      };

      reasoningTrail.push("LLM returned no usable result.");
      this._recordDebrief(artifact, artifactType, analysis, "unavailable", reasoningTrail);

      return { analysis, method: "unavailable" };
    }

    reasoningTrail.push(`LLM analysis complete. Confidence: ${llmAnalysis.confidence}.`);

    let analysis = llmAnalysis;
    let method: AnalysisResult["method"] = "llm";

    // --- Step 4: Apply pattern-suggest overlay ---
    if (matchedPatterns.length > 0) {
      analysis = applyPatternOverrides(analysis, matchedPatterns[0].pattern.derivedAnalysis);
      method = "pattern-suggest";
      reasoningTrail.push("Pattern suggestion applied as overlay on LLM analysis.");
    }

    this._recordDebrief(artifact, artifactType, analysis, method, reasoningTrail);

    return {
      analysis,
      method,
      matchedPatterns: matchedPatterns.length > 0 ? matchedPatterns : undefined,
    };
  }

  /**
   * Re-analyze an artifact using its stored annotations as correction context.
   * Returns null if LLM is unavailable.
   */
  async reanalyzeWithAnnotations(artifact: Artifact): Promise<ArtifactAnalysis | null> {
    if (!this._llm.isAvailable() || artifact.annotations.length === 0) return null;

    const correctionsText = artifact.annotations
      .map((a) => `- ${a.field}: ${a.correction}`)
      .join("\n");

    const prompt = `An artifact's analysis has user corrections. Revise the analysis to incorporate them.

Artifact Name: ${sanitizeForPrompt(artifact.name)}
Type: ${sanitizeForPrompt(artifact.type)}

Current Analysis:
Summary: ${sanitizeForPrompt(artifact.analysis.summary)}
Dependencies: ${sanitizeForPrompt(JSON.stringify(artifact.analysis.dependencies))}
Configuration Expectations: ${sanitizeForPrompt(JSON.stringify(artifact.analysis.configurationExpectations))}
Deployment Intent: ${sanitizeForPrompt(artifact.analysis.deploymentIntent ?? "unknown")}
Confidence: ${artifact.analysis.confidence}

User Corrections:
${sanitizeForPrompt(correctionsText)}

Produce a JSON analysis that incorporates all user corrections. Raise confidence proportional to how much the corrections clarify the artifact's purpose.`;

    const result: LlmResult = await this._llm.reason({
      prompt,
      systemPrompt: ANALYSIS_SYSTEM_PROMPT,
      promptSummary: `Re-analysis of "${artifact.name}" with ${artifact.annotations.length} user correction(s)`,
    });

    if (!result.ok) return null;

    try {
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as {
        summary?: string;
        dependencies?: string[];
        configurationExpectations?: Record<string, string>;
        deploymentIntent?: string;
        confidence?: number;
      };

      const revised: ArtifactAnalysis = {
        summary: parsed.summary ?? artifact.analysis.summary,
        dependencies: parsed.dependencies ?? artifact.analysis.dependencies,
        configurationExpectations: parsed.configurationExpectations ?? artifact.analysis.configurationExpectations,
        deploymentIntent: parsed.deploymentIntent ?? artifact.analysis.deploymentIntent,
        confidence: typeof parsed.confidence === "number"
          ? Math.max(parsed.confidence, artifact.analysis.confidence)
          : artifact.analysis.confidence,
      };

      this._debrief.record({
        partitionId: null,
        operationId: null,
        agent: "server",
        decisionType: "artifact-analysis",
        decision: `Re-analyzed "${artifact.name}" with ${artifact.annotations.length} user correction(s). Confidence: ${revised.confidence}.`,
        reasoning: result.text,
        context: {
          artifactName: artifact.name,
          corrections: correctionsText,
          confidence: revised.confidence,
          prompt,
        },
      });

      return revised;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Debrief integration
  // -------------------------------------------------------------------------

  private _recordDebrief(
    artifact: ArtifactInput,
    artifactType: string,
    analysis: ArtifactAnalysis,
    method: AnalysisResult["method"],
    reasoningTrail: string[],
  ): void {
    const confidenceLabel =
      analysis.confidence >= 0.8
        ? "high"
        : analysis.confidence >= 0.5
          ? "medium"
          : "low";

    this._debrief.record({
      partitionId: null,
      operationId: null,
      agent: "server",
      decisionType: "artifact-analysis",
      decision: `Analyzed artifact "${artifact.name}" (${artifactType}) via ${method}. ` +
        `Confidence: ${analysis.confidence} (${confidenceLabel}). ` +
        `Found ${analysis.dependencies.length} dependencies, ` +
        `${Object.keys(analysis.configurationExpectations).length} configuration expectations.`,
      reasoning: reasoningTrail.join(" "),
      context: {
        artifactName: artifact.name,
        artifactType,
        source: artifact.source,
        method,
        confidence: analysis.confidence,
        confidenceLabel,
        dependencyCount: analysis.dependencies.length,
        configExpectationCount: Object.keys(analysis.configurationExpectations).length,
        deploymentIntent: analysis.deploymentIntent,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createArtifactAnalyzer(deps: ArtifactAnalyzerDeps): ArtifactAnalyzer {
  return new ArtifactAnalyzer(deps);
}
