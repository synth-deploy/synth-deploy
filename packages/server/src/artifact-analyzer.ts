import type { ArtifactAnalysis, Artifact } from "@synth-deploy/core";
import type { LlmClient, LlmResult } from "@synth-deploy/core";
import type { DebriefWriter } from "@synth-deploy/core";
import type { PatternStore, PatternMatch, DerivedAnalysis } from "./pattern-store.js";

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
  method: "deterministic" | "llm-enhanced" | "pattern-auto" | "pattern-suggest" | "fallback";
  /** Patterns that were matched, if any */
  matchedPatterns?: PatternMatch[];
}

/**
 * Confidence tier — determines the analysis strategy.
 *
 *   high:   Highly structured artifacts (Dockerfile, Helm chart, package.json).
 *           Deterministic extraction yields reliable results.
 *   medium: Composite packages (zip, tarball) with recognizable patterns.
 *           Partial deterministic extraction, LLM for interpretation.
 *   low:    Opaque artifacts. Best-effort type detection, LLM-heavy.
 */
export type ConfidenceTier = "high" | "medium" | "low";

// ---------------------------------------------------------------------------
// Deterministic extractors
// ---------------------------------------------------------------------------

interface ExtractedData {
  summary: string;
  dependencies: string[];
  configurationExpectations: Record<string, string>;
  deploymentIntent?: string;
  confidence: number;
  tier: ConfidenceTier;
}

/**
 * Parse Dockerfile content to extract base image, ports, env vars, entrypoint.
 */
function extractDockerfile(content: string): ExtractedData {
  const lines = content.split("\n");
  const baseImages: string[] = [];
  const ports: string[] = [];
  const envVars: Record<string, string> = {};
  let entrypoint = "";
  let cmd = "";

  for (const line of lines) {
    const trimmed = line.trim();
    const fromMatch = trimmed.match(/^FROM\s+(\S+)/i);
    if (fromMatch) baseImages.push(fromMatch[1]);

    const exposeMatch = trimmed.match(/^EXPOSE\s+(.+)/i);
    if (exposeMatch) ports.push(...exposeMatch[1].split(/\s+/));

    const envMatch = trimmed.match(/^ENV\s+(\S+)\s+(.*)/i);
    if (envMatch) envVars[envMatch[1]] = envMatch[2];

    // ENV KEY=VALUE format
    const envEqMatch = trimmed.match(/^ENV\s+(\S+)=(\S*)/i);
    if (envEqMatch && !envMatch) envVars[envEqMatch[1]] = envEqMatch[2];

    const entrypointMatch = trimmed.match(/^ENTRYPOINT\s+(.+)/i);
    if (entrypointMatch) entrypoint = entrypointMatch[1];

    const cmdMatch = trimmed.match(/^CMD\s+(.+)/i);
    if (cmdMatch) cmd = cmdMatch[1];
  }

  const dependencies = baseImages.map((img) => `base-image:${img}`);
  const configExpectations: Record<string, string> = {};
  for (const [k, v] of Object.entries(envVars)) {
    configExpectations[k] = v || "(required, no default)";
  }
  if (ports.length > 0) {
    configExpectations["EXPOSED_PORTS"] = ports.join(", ");
  }

  const parts: string[] = [];
  if (baseImages.length > 0) parts.push(`Base: ${baseImages[baseImages.length - 1]}`);
  if (ports.length > 0) parts.push(`Ports: ${ports.join(", ")}`);
  if (entrypoint) parts.push(`Entrypoint: ${entrypoint}`);
  else if (cmd) parts.push(`CMD: ${cmd}`);

  return {
    summary: `Container image. ${parts.join(". ")}.`,
    dependencies,
    configurationExpectations: configExpectations,
    deploymentIntent: "Container deployment",
    confidence: 0.85,
    tier: "high",
  };
}

/**
 * Parse Helm Chart.yaml content.
 */
function extractHelmChart(content: string): ExtractedData {
  const lines = content.split("\n");
  const fields: Record<string, string> = {};

  for (const line of lines) {
    const match = line.match(/^(\w[\w.-]*)\s*:\s*(.+)/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }

  const name = fields["name"] || "unknown";
  const version = fields["version"] || "unknown";
  const appVersion = fields["appVersion"] || "";
  const description = fields["description"] || "";

  // Extract dependencies from the YAML (simplified — top-level only)
  const deps: string[] = [];
  let inDeps = false;
  for (const line of lines) {
    if (/^dependencies\s*:/i.test(line)) {
      inDeps = true;
      continue;
    }
    if (inDeps) {
      if (/^\S/.test(line) && !/^\s*-/.test(line)) {
        inDeps = false;
        continue;
      }
      const depName = line.match(/name\s*:\s*(\S+)/);
      if (depName) deps.push(`helm:${depName[1]}`);
    }
  }

  const configExpectations: Record<string, string> = {};
  if (appVersion) configExpectations["appVersion"] = appVersion;

  return {
    summary: `Helm chart "${name}" v${version}. ${description}`.trim(),
    dependencies: deps,
    configurationExpectations: configExpectations,
    deploymentIntent: "Kubernetes Helm deployment",
    confidence: 0.85,
    tier: "high",
  };
}

/**
 * Parse Helm values.yaml for configuration expectations.
 */
function extractHelmValues(content: string): Record<string, string> {
  const expectations: Record<string, string> = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^(\w[\w.-]*)\s*:\s*(.+)/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      if (value && !value.startsWith("#")) {
        expectations[key] = value;
      }
    }
  }

  return expectations;
}

/**
 * Parse package.json content.
 */
function extractPackageJson(content: string): ExtractedData {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content);
  } catch {
    return {
      summary: "Node.js package (invalid JSON)",
      dependencies: [],
      configurationExpectations: {},
      confidence: 0.3,
      tier: "low",
    };
  }

  const name = (pkg.name as string) || "unknown";
  const version = (pkg.version as string) || "";
  const scripts = (pkg.scripts as Record<string, string>) || {};
  const deps = Object.keys((pkg.dependencies as Record<string, string>) || {});
  const devDeps = Object.keys((pkg.devDependencies as Record<string, string>) || {});
  const engines = (pkg.engines as Record<string, string>) || {};

  const configExpectations: Record<string, string> = {};
  for (const [engine, constraint] of Object.entries(engines)) {
    configExpectations[engine] = constraint;
  }

  const scriptNames = Object.keys(scripts);
  const hasStart = scriptNames.includes("start");
  const hasBuild = scriptNames.includes("build");
  const hasDeploy = scriptNames.includes("deploy");

  let intent: string | undefined;
  if (hasDeploy) intent = "Node.js application with deploy script";
  else if (hasStart) intent = "Node.js application (startable)";
  else if (hasBuild) intent = "Node.js package (buildable)";

  const allDeps = [
    ...deps.map((d) => `npm:${d}`),
    ...devDeps.map((d) => `npm-dev:${d}`),
  ];

  const parts: string[] = [`"${name}"`];
  if (version) parts[0] += ` v${version}`;
  if (deps.length > 0) parts.push(`${deps.length} deps`);
  if (scriptNames.length > 0) parts.push(`scripts: ${scriptNames.join(", ")}`);

  return {
    summary: `Node.js package ${parts.join(". ")}.`,
    dependencies: allDeps,
    configurationExpectations: configExpectations,
    deploymentIntent: intent,
    confidence: 0.9,
    tier: "high",
  };
}

/**
 * Parse Makefile content for targets and patterns.
 */
function extractMakefile(content: string): ExtractedData {
  const lines = content.split("\n");
  const targets: string[] = [];
  const variables: Record<string, string> = {};

  for (const line of lines) {
    const targetMatch = line.match(/^([a-zA-Z_][\w-]*)\s*:/);
    if (targetMatch && !line.startsWith("\t")) {
      targets.push(targetMatch[1]);
    }

    const varMatch = line.match(/^([A-Z_]+)\s*[?:]?=\s*(.*)$/);
    if (varMatch) {
      variables[varMatch[1]] = varMatch[2].trim() || "(configurable)";
    }
  }

  const hasDeploy = targets.some((t) =>
    ["deploy", "install", "release", "publish"].includes(t),
  );

  return {
    summary: `Makefile with targets: ${targets.slice(0, 10).join(", ")}${targets.length > 10 ? ` (+${targets.length - 10} more)` : ""}.`,
    dependencies: [],
    configurationExpectations: variables,
    deploymentIntent: hasDeploy ? "Makefile-driven deployment" : undefined,
    confidence: 0.7,
    tier: "medium",
  };
}

/**
 * Detect artifact type from name, metadata, and content.
 * Exported for use in intake handlers before the full analyzer runs.
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
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".jar") || name.endsWith(".war") || name.endsWith(".ear")) return "java-archive";
  if (name.endsWith(".whl") || name.endsWith(".tar.gz") && meta["python-package"]) return "python-package";
  if (name.endsWith(".deb")) return "debian-package";
  if (name.endsWith(".rpm")) return "rpm-package";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".sh") || name.endsWith(".bash")) return "shell-script";

  return "unknown";
}

/**
 * Run deterministic extraction based on artifact type.
 */
function extractDeterministic(artifact: ArtifactInput, artifactType: string): ExtractedData | null {
  const text = artifact.content?.toString("utf-8");
  if (!text) return null;

  switch (artifactType) {
    case "dockerfile":
      return extractDockerfile(text);
    case "helm-chart":
      return extractHelmChart(text);
    case "node-package":
      return extractPackageJson(text);
    case "makefile":
      return extractMakefile(text);
    case "helm-values": {
      const expectations = extractHelmValues(text);
      return {
        summary: "Helm values configuration file.",
        dependencies: [],
        configurationExpectations: expectations,
        deploymentIntent: "Kubernetes Helm deployment values",
        confidence: 0.75,
        tier: "high",
      };
    }
    default:
      return null;
  }
}

/**
 * Analyze composite packages (zip, tarball) — list patterns.
 */
function extractComposite(artifact: ArtifactInput, artifactType: string): ExtractedData | null {
  if (artifactType !== "zip" && artifactType !== "tarball") return null;

  // Without content we can only report metadata
  const meta = artifact.metadata || {};
  const entries = meta["entries"]
    ? meta["entries"].split(",").map((e) => e.trim())
    : [];
  const size = meta["size"] || "unknown";

  const hasDockerfile = entries.some((e) => e.toLowerCase().includes("dockerfile"));
  const hasMakefile = entries.some((e) => e.toLowerCase().includes("makefile"));
  const hasPackageJson = entries.some((e) => e.toLowerCase().includes("package.json"));
  const hasScripts = entries.some((e) => e.endsWith(".sh") || e.endsWith(".bash"));

  const patterns: string[] = [];
  if (hasDockerfile) patterns.push("Dockerfile");
  if (hasMakefile) patterns.push("Makefile");
  if (hasPackageJson) patterns.push("package.json");
  if (hasScripts) patterns.push("shell scripts");

  const intent = hasDockerfile
    ? "Container deployment (Dockerfile found)"
    : hasMakefile
      ? "Makefile-driven deployment"
      : hasPackageJson
        ? "Node.js deployment"
        : undefined;

  return {
    summary: `${artifactType === "zip" ? "ZIP" : "Tarball"} archive (${size}). Contains: ${
      patterns.length > 0 ? patterns.join(", ") : `${entries.length} entries`
    }.`,
    dependencies: [],
    configurationExpectations: {},
    deploymentIntent: intent,
    confidence: patterns.length > 0 ? 0.6 : 0.4,
    tier: "medium",
  };
}

/**
 * Opaque artifact fallback — minimal type detection.
 */
function extractOpaque(artifact: ArtifactInput, artifactType: string): ExtractedData {
  const meta = artifact.metadata || {};
  const size = meta["size"] || (artifact.content ? `${artifact.content.length} bytes` : "unknown");

  return {
    summary: `${artifactType !== "unknown" ? artifactType : "Unknown"} artifact "${artifact.name}" (${size}). Requires manual review for accurate analysis.`,
    dependencies: [],
    configurationExpectations: {},
    confidence: 0.2,
    tier: "low",
  };
}

// ---------------------------------------------------------------------------
// LLM reasoning
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT = `You are a deployment artifact analyzer. Given extracted data about a deployment artifact, produce a structured analysis.

Your response must be valid JSON with these fields:
- "summary": A plain-language description (1-3 sentences) of what this artifact is and how it should be deployed.
- "dependencies": An array of strings listing runtime dependencies, system requirements, or external services needed.
- "configurationExpectations": An object mapping configuration key names to descriptions of expected values.
- "deploymentIntent": A short phrase describing the deployment method (e.g., "Container deployment via Docker Compose", "Kubernetes Helm release").
- "confidence": A number 0-1 indicating how confident you are in this analysis.

Focus on actionable deployment intelligence. Be specific about ports, environment variables, and deployment prerequisites.`;

async function enhanceWithLlm(
  llm: LlmClient,
  artifact: ArtifactInput,
  artifactType: string,
  extracted: ExtractedData | null,
): Promise<Partial<ExtractedData> | null> {
  const contentPreview = artifact.content
    ? artifact.content.toString("utf-8").slice(0, 4000)
    : "(no content available)";

  const prompt = `Analyze this deployment artifact.

Name: ${artifact.name}
Type: ${artifactType}
Source: ${artifact.source}
Metadata: ${JSON.stringify(artifact.metadata || {})}

${extracted ? `Deterministic extraction found:
Summary: ${extracted.summary}
Dependencies: ${JSON.stringify(extracted.dependencies)}
Configuration: ${JSON.stringify(extracted.configurationExpectations)}
Intent: ${extracted.deploymentIntent || "unknown"}
` : "No deterministic extraction was possible."}

Content preview:
\`\`\`
${contentPreview}
\`\`\`

Produce a JSON analysis that enhances or corrects the extracted data.`;

  const result: LlmResult = await llm.reason({
    prompt,
    systemPrompt: ANALYSIS_SYSTEM_PROMPT,
    promptSummary: `Artifact analysis for "${artifact.name}" (${artifactType})`,
  });

  if (!result.ok) {
    console.warn(`[artifact-analyzer] LLM enhancement failed for "${artifact.name}": ${result.reason}`);
    return null;
  }

  try {
    // Extract JSON from the response (may be wrapped in markdown code blocks)
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
      summary: parsed.summary,
      dependencies: parsed.dependencies,
      configurationExpectations: parsed.configurationExpectations,
      deploymentIntent: parsed.deploymentIntent,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------

function mergeAnalysis(
  base: ExtractedData,
  llmEnhancement: Partial<ExtractedData> | null,
): ExtractedData {
  if (!llmEnhancement) return base;

  return {
    summary: llmEnhancement.summary || base.summary,
    dependencies: llmEnhancement.dependencies && llmEnhancement.dependencies.length > 0
      ? deduplicateStrings([...base.dependencies, ...llmEnhancement.dependencies])
      : base.dependencies,
    configurationExpectations: {
      ...base.configurationExpectations,
      ...(llmEnhancement.configurationExpectations || {}),
    },
    deploymentIntent: llmEnhancement.deploymentIntent || base.deploymentIntent,
    confidence: llmEnhancement.confidence !== undefined
      ? Math.max(base.confidence, llmEnhancement.confidence)
      : base.confidence,
    tier: base.tier,
  };
}

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

function deduplicateStrings(arr: string[]): string[] {
  return [...new Set(arr)];
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
 *      - Auto-apply if >= 2 corrections and confidence >= 0.7
 *      - Suggest if 1 correction or confidence < 0.7
 *   2. Run deterministic extraction based on artifact type
 *   3. Enhance with LLM reasoning (using extracted data as context)
 *   4. Record debrief entry with decision trail
 *
 * The deterministic extraction always runs first. The LLM sees extracted
 * data and can enhance, correct, or fill gaps. This ensures the analysis
 * is grounded in concrete artifact data, not hallucinated.
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
            `Pattern match: "${autoMatch.pattern.namePattern}" (${autoMatch.pattern.corrections.length} corrections, confidence ${autoMatch.pattern.confidence}). Auto-applying.`,
          );

          // Still run deterministic extraction as a base
          const extracted =
            extractDeterministic(artifact, artifactType) ||
            extractComposite(artifact, artifactType) ||
            extractOpaque(artifact, artifactType);

          const baseAnalysis: ArtifactAnalysis = {
            summary: extracted.summary,
            dependencies: extracted.dependencies,
            configurationExpectations: extracted.configurationExpectations,
            deploymentIntent: extracted.deploymentIntent,
            confidence: Math.max(extracted.confidence, autoMatch.pattern.confidence),
          };

          const finalAnalysis = applyPatternOverrides(
            baseAnalysis,
            autoMatch.pattern.derivedAnalysis,
          );

          this._patternStore.recordApplication(autoMatch.pattern.id);
          reasoningTrail.push("Pattern overrides applied to deterministic base.");

          this._recordDebrief(artifact, artifactType, finalAnalysis, "pattern-auto", reasoningTrail);

          return {
            analysis: finalAnalysis,
            method: "pattern-auto",
            matchedPatterns,
          };
        }

        // Suggest mode — note the suggestion but continue with normal analysis
        reasoningTrail.push(
          `Pattern suggestion available: "${matchedPatterns[0].pattern.namePattern}" ` +
          `(${matchedPatterns[0].pattern.corrections.length} corrections, ` +
          `confidence ${matchedPatterns[0].pattern.confidence}). ` +
          `Not auto-applying — threshold not met.`,
        );
      }
    }

    // --- Step 2: Deterministic extraction ---
    let extracted = extractDeterministic(artifact, artifactType);

    if (extracted) {
      reasoningTrail.push(
        `Deterministic extraction succeeded (tier: ${extracted.tier}, confidence: ${extracted.confidence}).`,
      );
    } else {
      // Try composite
      extracted = extractComposite(artifact, artifactType);
      if (extracted) {
        reasoningTrail.push(
          `Composite pattern extraction (tier: ${extracted.tier}, confidence: ${extracted.confidence}).`,
        );
      } else {
        // Opaque fallback
        extracted = extractOpaque(artifact, artifactType);
        reasoningTrail.push(
          `Opaque artifact — minimal type detection only (confidence: ${extracted.confidence}).`,
        );
      }
    }

    // --- Step 3: LLM enhancement ---
    let method: AnalysisResult["method"] = "deterministic";
    let finalExtracted = extracted;

    if (this._llm.isAvailable()) {
      reasoningTrail.push("LLM available — enhancing analysis.");
      const enhancement = await enhanceWithLlm(this._llm, artifact, artifactType, extracted);
      if (enhancement) {
        finalExtracted = mergeAnalysis(extracted, enhancement);
        method = "llm-enhanced";
        reasoningTrail.push(
          `LLM enhancement merged. Confidence: ${extracted.confidence} -> ${finalExtracted.confidence}.`,
        );
      } else {
        reasoningTrail.push("LLM enhancement returned no usable result — using deterministic analysis.");
      }
    } else {
      reasoningTrail.push("LLM not available — using deterministic analysis only.");
    }

    let analysis: ArtifactAnalysis = {
      summary: finalExtracted.summary,
      dependencies: finalExtracted.dependencies,
      configurationExpectations: finalExtracted.configurationExpectations,
      deploymentIntent: finalExtracted.deploymentIntent,
      confidence: finalExtracted.confidence,
    };

    // Apply pattern suggestions as overlay if available
    if (matchedPatterns.length > 0) {
      const suggestion = matchedPatterns[0];
      analysis = applyPatternOverrides(analysis, suggestion.pattern.derivedAnalysis);
      method = "pattern-suggest";
      reasoningTrail.push("Pattern suggestion applied as overlay on analysis.");
    }

    // If no extraction worked and LLM failed, mark as fallback
    if (extracted.tier === "low" && method === "deterministic") {
      method = "fallback";
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
   * Calls the LLM with the existing analysis + user corrections and returns
   * a revised analysis. Returns null if LLM is unavailable.
   */
  async reanalyzeWithAnnotations(artifact: Artifact): Promise<ArtifactAnalysis | null> {
    if (!this._llm.isAvailable() || artifact.annotations.length === 0) return null;

    const correctionsText = artifact.annotations
      .map((a) => `- ${a.field}: ${a.correction}`)
      .join("\n");

    const prompt = `An artifact's analysis has user corrections. Revise the analysis to incorporate them.

Artifact Name: ${artifact.name}
Type: ${artifact.type}

Current Analysis:
Summary: ${artifact.analysis.summary}
Dependencies: ${JSON.stringify(artifact.analysis.dependencies)}
Configuration Expectations: ${JSON.stringify(artifact.analysis.configurationExpectations)}
Deployment Intent: ${artifact.analysis.deploymentIntent ?? "unknown"}
Confidence: ${artifact.analysis.confidence}

User Corrections:
${correctionsText}

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
        deploymentId: null,
        agent: "command",
        decisionType: "artifact-analysis",
        decision: `Re-analyzed "${artifact.name}" with ${artifact.annotations.length} user correction(s). Confidence: ${revised.confidence}.`,
        // reasoning = actual LLM response text; context carries the prompt for full auditability
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
      deploymentId: null,
      agent: "command",
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

/**
 * Create an ArtifactAnalyzer wired to the given dependencies.
 */
export function createArtifactAnalyzer(deps: ArtifactAnalyzerDeps): ArtifactAnalyzer {
  return new ArtifactAnalyzer(deps);
}
