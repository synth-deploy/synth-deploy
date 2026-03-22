import type {
  DebriefEntry,
  DebriefReader,
  DecisionType,
} from "@synth-deploy/core";
import { LlmClient } from "@synth-deploy/core";
import type { LlmResult } from "@synth-deploy/core";
import type { EnvoyKnowledgeStore, LocalDeploymentRecord, EnvironmentSnapshot } from "../state/knowledge-store.js";
import type { EnvironmentScanner } from "./environment-scanner.js";

// ---------------------------------------------------------------------------
// Types — what a query produces
// ---------------------------------------------------------------------------

export type QueryIntent =
  | "deployment-diagnostic"    // "Why did X deployment cause problems?"
  | "change-history"           // "What changed in the last N days?"
  | "pre-deployment-assessment" // "What should I know before deploying?"
  | "environment-state"        // "What's the current state?"
  | "general";                 // Catch-all for unclassified queries

export interface QueryResult {
  /** The original question */
  query: string;
  /** What the engine understood the question to be about */
  intent: QueryIntent;
  /** The specific, grounded answer */
  answer: string;
  /** Supporting evidence — debrief entries, deployment records, etc. */
  evidence: QueryEvidence[];
  /** When this was answered */
  answeredAt: Date;
  /** Whether the Envoy could fully answer this locally */
  confident: boolean;
  /** If not confident, what's missing */
  escalationHint: string | null;
  /** Capability gating notice — present when the model is marginal, unverified, or gated */
  notice?: string;
}

export interface QueryEvidence {
  source: string;
  summary: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

interface TimeReference {
  from: Date;
  to: Date;
  label: string;
}

function parseTimeReference(query: string): TimeReference | null {
  const now = new Date();
  const lowerQuery = query.toLowerCase();

  // "last tuesday", "last monday", etc.
  const dayNames = [
    "sunday", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday",
  ];
  for (let i = 0; i < dayNames.length; i++) {
    if (lowerQuery.includes(`last ${dayNames[i]}`)) {
      const targetDay = i;
      const currentDay = now.getDay();
      let daysBack = currentDay - targetDay;
      if (daysBack <= 0) daysBack += 7;
      const target = new Date(now);
      target.setDate(target.getDate() - daysBack);
      target.setHours(0, 0, 0, 0);
      const targetEnd = new Date(target);
      targetEnd.setHours(23, 59, 59, 999);
      return {
        from: target,
        to: targetEnd,
        label: `last ${dayNames[i]} (${target.toISOString().split("T")[0]})`,
      };
    }
  }

  // "last N days"
  const daysMatch = lowerQuery.match(/last\s+(\d+)\s+days?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const from = new Date(now);
    from.setDate(from.getDate() - days);
    from.setHours(0, 0, 0, 0);
    return { from, to: now, label: `last ${days} days` };
  }

  // "last week"
  if (lowerQuery.includes("last week")) {
    const from = new Date(now);
    from.setDate(from.getDate() - 7);
    from.setHours(0, 0, 0, 0);
    return { from, to: now, label: "last 7 days" };
  }

  // "last month" / "last 30 days"
  if (lowerQuery.includes("last month") || lowerQuery.includes("past month")) {
    const from = new Date(now);
    from.setDate(from.getDate() - 30);
    from.setHours(0, 0, 0, 0);
    return { from, to: now, label: "last 30 days" };
  }

  // "yesterday"
  if (lowerQuery.includes("yesterday")) {
    const from = new Date(now);
    from.setDate(from.getDate() - 1);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);
    return { from, to, label: "yesterday" };
  }

  // "today"
  if (lowerQuery.includes("today")) {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    return { from, to: now, label: "today" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

function classifyIntent(query: string): QueryIntent {
  const lower = query.toLowerCase();

  // Diagnostic — failure analysis, performance issues, deployment problems
  if (
    /why\s+did|what\s+caused|what\s+went\s+wrong|slow|failed|broke|issue|problem|outage|error|crash|not\s+respond|unavailable|down|timeout|connection/i.test(lower)
  ) {
    return "deployment-diagnostic";
  }

  // Change history — "what changed", "what happened", "what was deployed"
  if (
    /what\s+changed|what\s+happened|what\s+was\s+deployed|changes?\s+in|history|recent\s+deployments|when\s+did.*deploy|last\s+deploy/i.test(lower)
  ) {
    return "change-history";
  }

  // Pre-deployment — readiness checks, risk assessment
  if (
    /before\s+(deploy|the\s+next)|should\s+i\s+know|anything\s+.*(know|aware)|ready\s+(for|to)|risk|upcoming|pre-deploy|can\s+i\s+deploy|is\s+.*stable|blocking|safe\s+to/i.test(lower)
  ) {
    return "pre-deployment-assessment";
  }

  // Environment state — current deployment info, health, versions
  if (
    /current\s+state|status|what'?s?\s+running|what\s+version|deployed\s+now|environment\s+state|health|active\s+deploy|how\s+many/i.test(lower)
  ) {
    return "environment-state";
  }

  return "general";
}

// ---------------------------------------------------------------------------
// QueryEngine — the Envoy's ability to answer questions
// ---------------------------------------------------------------------------

/**
 * Answers natural language questions from engineers by querying local
 * deployment history, Debrief entries, and environment state.
 *
 * Every answer is grounded in actual data — no generic responses.
 * If the Envoy doesn't have enough information to answer
 * specifically, it says what it doesn't know and suggests escalation.
 */
export class QueryEngine {
  constructor(
    private debrief: DebriefReader,
    private state: EnvoyKnowledgeStore,
    private scanner: EnvironmentScanner,
    private llm?: LlmClient,
  ) {}

  /**
   * Answer a natural language question (synchronous, deterministic).
   */
  query(question: string): QueryResult {
    const intent = classifyIntent(question);

    switch (intent) {
      case "deployment-diagnostic":
        return this.answerDiagnostic(question);
      case "change-history":
        return this.answerChangeHistory(question);
      case "pre-deployment-assessment":
        return this.answerPreDeployment(question);
      case "environment-state":
        return this.answerEnvironmentState(question);
      default:
        return this.answerGeneral(question);
    }
  }

  /**
   * Answer a natural language question, optionally using the LLM for
   * richer analytical answers. Falls back to the deterministic `query()`
   * when the LLM is unavailable, not configured, or returns an error.
   */
  async queryAsync(question: string): Promise<QueryResult> {
    // Always compute the deterministic answer first — it serves as both
    // the fallback and the source of grounded evidence for the LLM.
    const deterministicResult = this.query(question);

    // If there is no LLM, or it has no API key, return deterministic.
    if (!this.llm || !this.llm.isAvailable()) {
      return deterministicResult;
    }

    // For simple factual queries that the deterministic engine handles
    // well (environment-state with high confidence), skip the LLM call.
    if (deterministicResult.intent === "environment-state" && deterministicResult.confident) {
      return deterministicResult;
    }

    // Build LLM prompts grounded in real deployment data.
    const systemPrompt = this.buildLlmSystemPrompt();
    const userPrompt = this.buildLlmUserPrompt(question, deterministicResult);

    try {
      const llmResult: LlmResult = await this.llm.reason({
        prompt: userPrompt,
        systemPrompt,
        promptSummary: `Query answering: "${question.slice(0, 80)}"`,
        maxTokens: 1024,
      }, "queryAnswering");

      if (!llmResult.ok) {
        // LLM declined, failed, or gated — fall back to deterministic.
        return deterministicResult;
      }

      // Return the LLM-enhanced answer, preserving the structured
      // metadata from the deterministic pass.
      return {
        ...deterministicResult,
        answer: llmResult.text,
        confident: true,
        // Attach capability gating notice if present (marginal/unverified)
        ...(llmResult.notice ? { notice: llmResult.notice } : {}),
      };
    } catch {
      // Any unexpected error — fall back to deterministic.
      return deterministicResult;
    }
  }

  // -------------------------------------------------------------------------
  // LLM prompt construction
  // -------------------------------------------------------------------------

  private buildLlmSystemPrompt(): string {
    return [
      "You are a Synth Envoy — an intelligent deployment agent running on a specific machine.",
      "Your job is to answer questions from deployment engineers about what happened, what is running,",
      "and what they should know before deploying. Every answer must be grounded in the deployment data",
      "provided. Never speculate beyond the evidence. If the data is insufficient, say exactly what is",
      "missing and suggest where to look (e.g., Server debrief, application logs, monitoring).",
      "",
      "Rules:",
      "- Reference specific version numbers, operation names, timestamps, and failure reasons from the data.",
      "- Do not give generic advice. Every statement must trace back to a data point.",
      "- Keep answers concise and actionable — engineers read these at 2am.",
      "- If asked about something outside the deployment data, say so plainly.",
    ].join("\n");
  }

  private buildLlmUserPrompt(question: string, deterministicResult: QueryResult): string {
    const parts: string[] = [];

    parts.push(`Engineer's question: ${question}`);
    parts.push("");
    parts.push(`Classified intent: ${deterministicResult.intent}`);
    parts.push("");

    // Include the deterministic answer as grounding data
    parts.push("=== Deployment data (ground truth) ===");
    parts.push(deterministicResult.answer);
    parts.push("");

    // Include evidence
    if (deterministicResult.evidence.length > 0) {
      parts.push("=== Supporting evidence ===");
      for (const ev of deterministicResult.evidence) {
        parts.push(`[${ev.source}] ${ev.summary}: ${ev.detail}`);
      }
      parts.push("");
    }

    // Include escalation hint if present
    if (deterministicResult.escalationHint) {
      parts.push(`Note: ${deterministicResult.escalationHint}`);
      parts.push("");
    }

    parts.push(
      "Using the deployment data above, provide a clear, specific answer to the engineer's question. " +
      "Reference actual version numbers, operation names, and timestamps from the data.",
    );

    return parts.join("\n");
  }

  // -------------------------------------------------------------------------
  // Diagnostic — "Why did last Tuesday's deployment slow things down?"
  // -------------------------------------------------------------------------

  private answerDiagnostic(question: string): QueryResult {
    const evidence: QueryEvidence[] = [];
    const timeRef = parseTimeReference(question);

    // Find deployments in the time window
    let relevantDeployments: LocalDeploymentRecord[];
    let timeLabel: string;

    if (timeRef) {
      relevantDeployments = this.state.listDeployments().filter(
        (d) => d.receivedAt >= timeRef.from && d.receivedAt <= timeRef.to,
      );
      timeLabel = timeRef.label;
    } else {
      // No time reference — look at all recent deployments
      relevantDeployments = this.state.listDeployments().slice(0, 10);
      timeLabel = "recent history";
    }

    if (relevantDeployments.length === 0) {
      return {
        query: question,
        intent: "deployment-diagnostic",
        answer: timeRef
          ? `No deployments were executed on this machine during ${timeLabel}. ` +
            `The Envoy has no local deployment records matching that time window. ` +
            `If a deployment was triggered elsewhere, check the Server's Debrief ` +
            `for the full orchestration history.`
          : `No recent deployments found on this machine. The Envoy has no ` +
            `local deployment history to analyze.`,
        evidence: [],
        answeredAt: new Date(),
        confident: false,
        escalationHint: "No local deployment data for the requested time window. Server debrief may have more context.",
      };
    }

    evidence.push({
      source: "local deployment history",
      summary: `${relevantDeployments.length} deployment(s) found during ${timeLabel}`,
      detail: relevantDeployments.map((d) =>
        `${d.operationId} v${d.version} — ${d.status}` +
        (d.failureReason ? ` (${d.failureReason})` : ""),
      ).join("; "),
    });

    // Gather debrief entries for these deployments
    const allDebriefEntries: DebriefEntry[] = [];
    for (const deployment of relevantDeployments) {
      const entries = this.debrief.getByOperation(deployment.deploymentId);
      allDebriefEntries.push(...entries);
    }

    // Find failure entries, diagnostic entries, and conflict entries
    const failedDeployments = relevantDeployments.filter((d) => d.status === "failed");
    const diagnosticEntries = allDebriefEntries.filter(
      (e) => e.decisionType === "diagnostic-investigation",
    );
    const conflictEntries = allDebriefEntries.filter(
      (e) => e.decisionType === "variable-conflict",
    );
    const healthEntries = allDebriefEntries.filter(
      (e) => e.decisionType === "health-check" && e.decision.toLowerCase().includes("retry"),
    );

    // Build the answer
    const answerParts: string[] = [];

    // Summarize what happened
    const succeeded = relevantDeployments.filter((d) => d.status === "succeeded").length;
    const failed = failedDeployments.length;

    answerParts.push(
      `During ${timeLabel}, ${relevantDeployments.length} deployment(s) were executed on this machine: ` +
      `${succeeded} succeeded, ${failed} failed.`,
    );

    // Detail each deployment
    for (const deployment of relevantDeployments) {
      const deployEntries = allDebriefEntries.filter(
        (e) => e.operationId === deployment.deploymentId,
      );

      const line = `• ${deployment.operationId} v${deployment.version} — ${deployment.status.toUpperCase()}`;

      if (deployment.status === "failed") {
        const diagnostic = diagnosticEntries.find(
          (e) => e.operationId === deployment.deploymentId,
        );
        const failureEntry = deployEntries.find(
          (e) => e.decisionType === "deployment-failure",
        );

        if (diagnostic) {
          const rootCause = (diagnostic.context?.diagnostic as Record<string, unknown>)?.rootCause as string
            ?? diagnostic.reasoning;
          const recommendation = (diagnostic.context?.diagnostic as Record<string, unknown>)?.recommendation as string
            ?? "";
          answerParts.push(
            `${line}. Root cause: ${rootCause}` +
            (recommendation ? ` Recommendation: ${recommendation}` : ""),
          );
          evidence.push({
            source: `diagnostic for ${deployment.deploymentId}`,
            summary: diagnostic.decision,
            detail: diagnostic.reasoning,
          });
        } else if (failureEntry) {
          answerParts.push(`${line}. ${failureEntry.reasoning}`);
          evidence.push({
            source: `failure entry for ${deployment.deploymentId}`,
            summary: failureEntry.decision,
            detail: failureEntry.reasoning,
          });
        } else {
          answerParts.push(`${line}. Failure reason: ${deployment.failureReason ?? "unknown"}`);
        }
      } else {
        // Successful — check for issues that could have caused slowness
        const completionEntry = deployEntries.find(
          (e) => e.decisionType === "deployment-completion",
        );
        const duration = deployment.completedAt && deployment.receivedAt
          ? deployment.completedAt.getTime() - deployment.receivedAt.getTime()
          : null;
        const durationNote = duration ? ` (took ${duration}ms)` : "";

        // Check for conflicts or health retries that could indicate problems
        const deployConflicts = conflictEntries.filter(
          (e) => e.operationId === deployment.deploymentId,
        );
        const deployHealthRetries = healthEntries.filter(
          (e) => e.operationId === deployment.deploymentId,
        );

        if (deployConflicts.length > 0 || deployHealthRetries.length > 0) {
          const issues: string[] = [];
          if (deployConflicts.length > 0) {
            issues.push(`${deployConflicts.length} variable conflict(s)`);
            for (const c of deployConflicts) {
              evidence.push({
                source: `conflict in ${deployment.deploymentId}`,
                summary: c.decision,
                detail: c.reasoning,
              });
            }
          }
          if (deployHealthRetries.length > 0) {
            issues.push(`${deployHealthRetries.length} health check retry/retries`);
          }
          answerParts.push(
            `${line}${durationNote}, but with issues: ${issues.join(", ")}. ` +
            `These may have contributed to degraded performance.`,
          );
        } else if (completionEntry) {
          answerParts.push(`${line}${durationNote}. ${completionEntry.decision}`);
        } else {
          answerParts.push(`${line}${durationNote}.`);
        }
      }
    }

    // Check for environment-wide patterns
    const envVersionChanges = this.findVersionChanges(relevantDeployments);
    if (envVersionChanges.length > 0) {
      answerParts.push(
        "",
        "Version changes during this period: " +
        envVersionChanges.map((c) => `${c.operationId} went from v${c.fromVersion} to v${c.toVersion}`).join("; ") +
        ".",
      );
    }

    // Confidence is high only when we found data that actually addresses the diagnostic question.
    // Having deployments but no failures means we can't explain what went wrong.
    const hasRelevantData = relevantDeployments.length > 0;
    const hasFailureData = failedDeployments.length > 0 || conflictEntries.length > 0 || healthEntries.length > 0;
    const confident = hasRelevantData && hasFailureData;

    let escalationHint: string | null = null;
    if (!hasRelevantData) {
      escalationHint = "Envoy has no local deployment records for this time window. Check the Server's Debrief for orchestration-level data.";
    } else if (!hasFailureData) {
      escalationHint = "All deployments in this window succeeded with no issues recorded locally. If something is still wrong, the issue may be external to the deployment pipeline — check application logs and monitoring.";
    }

    return {
      query: question,
      intent: "deployment-diagnostic",
      answer: answerParts.join("\n"),
      evidence,
      answeredAt: new Date(),
      confident,
      escalationHint,
    };
  }

  // -------------------------------------------------------------------------
  // Change history — "What changed in this environment in the last 30 days?"
  // -------------------------------------------------------------------------

  private answerChangeHistory(question: string): QueryResult {
    const evidence: QueryEvidence[] = [];
    const timeRef = parseTimeReference(question);

    // Default to 30 days if no time reference
    const from = timeRef?.from ?? (() => {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      d.setHours(0, 0, 0, 0);
      return d;
    })();
    const to = timeRef?.to ?? new Date();
    const timeLabel = timeRef?.label ?? "last 30 days";

    // Get all deployments in the window
    const deployments = this.state.listDeployments().filter(
      (d) => d.receivedAt >= from && d.receivedAt <= to,
    );

    // Get debrief entries in the window
    const debriefEntries = this.debrief.getByTimeRange(from, to);

    if (deployments.length === 0 && debriefEntries.length === 0) {
      return {
        query: question,
        intent: "change-history",
        answer: `No changes were recorded on this machine in the ${timeLabel}. ` +
          `The environment has been stable with no deployments or agent decisions during this period.`,
        evidence: [],
        answeredAt: new Date(),
        confident: true,
        escalationHint: null,
      };
    }

    const answerParts: string[] = [];

    // Overview
    const succeeded = deployments.filter((d) => d.status === "succeeded").length;
    const failed = deployments.filter((d) => d.status === "failed").length;

    answerParts.push(
      `In the ${timeLabel}, ${deployments.length} deployment(s) were executed: ` +
      `${succeeded} succeeded, ${failed} failed.`,
    );

    // Group by environment
    const envGroups = new Map<string, LocalDeploymentRecord[]>();
    for (const d of deployments) {
      const key = `${d.partitionId}:${d.environmentId}`;
      const group = envGroups.get(key) ?? [];
      group.push(d);
      envGroups.set(key, group);
    }

    // Detail per environment
    for (const [key, envDeployments] of envGroups) {
      const envSnapshot = this.state.getEnvironment(
        envDeployments[0].partitionId,
        envDeployments[0].environmentId,
      );
      const currentVersion = envSnapshot?.currentVersion ?? "unknown";
      const sorted = [...envDeployments].sort(
        (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
      );

      answerParts.push("");
      answerParts.push(`Environment ${key}:`);
      answerParts.push(`  Currently running: v${currentVersion}`);

      for (const d of sorted) {
        const dateStr = d.receivedAt.toISOString().split("T")[0];
        const status = d.status === "succeeded" ? "OK" : "FAILED";
        const failNote = d.failureReason ? ` — ${d.failureReason}` : "";
        answerParts.push(
          `  • [${dateStr}] ${d.operationId} v${d.version} — ${status}${failNote}`,
        );
        evidence.push({
          source: "deployment record",
          summary: `${d.operationId} v${d.version} deployed ${dateStr} — ${d.status}`,
          detail: d.failureReason ?? "completed successfully",
        });
      }

      // Version progression
      const versions = sorted.filter((d) => d.status === "succeeded").map((d) => d.version);
      if (versions.length > 1) {
        answerParts.push(
          `  Version progression: ${versions.map((v) => `v${v}`).join(" → ")}`,
        );
      }
    }

    // Notable debrief entries — conflicts, diagnostics, failures
    const notableEntries = debriefEntries.filter(
      (e) =>
        e.decisionType === "variable-conflict" ||
        e.decisionType === "diagnostic-investigation" ||
        e.decisionType === "deployment-failure",
    );

    if (notableEntries.length > 0) {
      answerParts.push("");
      answerParts.push("Notable events:");
      for (const entry of notableEntries) {
        answerParts.push(`  • [${entry.decisionType}] ${entry.decision}`);
        evidence.push({
          source: `debrief entry ${entry.id}`,
          summary: entry.decision,
          detail: entry.reasoning,
        });
      }
    }

    return {
      query: question,
      intent: "change-history",
      answer: answerParts.join("\n"),
      evidence,
      answeredAt: new Date(),
      confident: true,
      escalationHint: null,
    };
  }

  // -------------------------------------------------------------------------
  // Pre-deployment assessment — "What should I know before deploying?"
  // -------------------------------------------------------------------------

  private answerPreDeployment(question: string): QueryResult {
    const evidence: QueryEvidence[] = [];
    const answerParts: string[] = [];
    const concerns: string[] = [];

    // 1. Current environment state
    const environments = this.state.listEnvironments();
    const scanResult = this.scanner.scan();
    const readiness = this.scanner.checkReadiness();

    evidence.push({
      source: "environment scan",
      summary: `${environments.length} active environment(s), workspace ${readiness.ready ? "ready" : "NOT ready"}`,
      detail: readiness.reason,
    });

    if (!readiness.ready) {
      concerns.push(
        `CRITICAL: Workspace is not ready — ${readiness.reason}. ` +
        `Deployments will fail until this is resolved.`,
      );
    }

    // 2. Current versions and state
    if (environments.length > 0) {
      answerParts.push("Current environment state:");
      for (const env of environments) {
        answerParts.push(
          `  • ${env.partitionId}:${env.environmentId} — running v${env.currentVersion ?? "none"} ` +
          `(last updated: ${env.lastUpdated.toISOString().split("T")[0]})`,
        );
      }
    } else {
      answerParts.push("No active environments on this machine — this would be a first deployment.");
    }

    // 3. Recent failure patterns
    const recentDeployments = this.state.listDeployments().slice(0, 20);
    const recentFailures = recentDeployments.filter((d) => d.status === "failed");

    if (recentFailures.length > 0) {
      const failureRate = Math.round(
        (recentFailures.length / recentDeployments.length) * 100,
      );

      concerns.push(
        `${recentFailures.length} of the last ${recentDeployments.length} deployments failed ` +
        `(${failureRate}% failure rate).`,
      );

      // Check for recurring failure reasons
      const failureReasons = new Map<string, number>();
      for (const f of recentFailures) {
        const reason = f.failureReason ?? "unknown";
        failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1);
      }

      for (const [reason, count] of failureReasons) {
        if (count >= 2) {
          concerns.push(
            `Recurring failure: "${reason}" has occurred ${count} times. ` +
            `This pattern may affect the next deployment.`,
          );
        }
      }

      // Get diagnostic insights from debrief
      const diagnosticEntries = this.debrief.getByType("diagnostic-investigation");
      const recentDiagnostics = diagnosticEntries.slice(-5);
      for (const diag of recentDiagnostics) {
        const report = diag.context?.diagnostic as Record<string, unknown> | undefined;
        if (report) {
          evidence.push({
            source: `previous diagnostic (${diag.operationId})`,
            summary: diag.decision,
            detail: (report.recommendation as string) ?? diag.reasoning,
          });
        }
      }
    }

    // 4. Variable conflicts from recent history
    const conflictEntries = this.debrief.getByType("variable-conflict");
    const recentConflicts = conflictEntries.slice(-5);
    if (recentConflicts.length > 0) {
      concerns.push(
        `${recentConflicts.length} variable conflict(s) observed in recent deployments. ` +
        `Review variable bindings before deploying to avoid configuration issues.`,
      );
      for (const c of recentConflicts) {
        evidence.push({
          source: "variable conflict history",
          summary: c.decision,
          detail: c.reasoning,
        });
      }
    }

    // 5. Disk / workspace state
    if (scanResult.disk.deploymentCount > 50) {
      concerns.push(
        `${scanResult.disk.deploymentCount} deployment directories on disk. ` +
        `Consider cleaning old deployment workspaces to free disk space.`,
      );
    }

    // Assemble the answer
    if (concerns.length > 0) {
      answerParts.push("");
      answerParts.push("Concerns before deploying:");
      for (const concern of concerns) {
        answerParts.push(`  ⚠ ${concern}`);
      }
    } else {
      answerParts.push("");
      answerParts.push(
        "No concerns identified. The environment appears stable with no " +
        "recent failure patterns or configuration issues.",
      );
    }

    // Summary assessment
    const riskLevel =
      !readiness.ready
        ? "HIGH"
        : concerns.length > 2
          ? "ELEVATED"
          : concerns.length > 0
            ? "MODERATE"
            : "LOW";

    answerParts.push("");
    answerParts.push(`Pre-deployment risk assessment: ${riskLevel}`);

    return {
      query: question,
      intent: "pre-deployment-assessment",
      answer: answerParts.join("\n"),
      evidence,
      answeredAt: new Date(),
      confident: true,
      escalationHint: concerns.length > 2
        ? "Multiple concerns identified. Consider reviewing with the Server before proceeding."
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // Environment state — "What's the current state?"
  // -------------------------------------------------------------------------

  private answerEnvironmentState(question: string): QueryResult {
    const evidence: QueryEvidence[] = [];
    const answerParts: string[] = [];

    const environments = this.state.listEnvironments();
    const scanResult = this.scanner.scan();
    const readiness = this.scanner.checkReadiness();
    const summary = this.state.getSummary();

    answerParts.push(
      `This Envoy (${scanResult.hostname}) has processed ` +
      `${summary.totalDeployments} deployment(s): ${summary.succeeded} succeeded, ` +
      `${summary.failed} failed, ${summary.executing} currently executing.`,
    );

    answerParts.push(`Workspace: ${readiness.ready ? "ready" : `NOT READY — ${readiness.reason}`}`);

    if (environments.length > 0) {
      answerParts.push("");
      answerParts.push("Active environments:");
      for (const env of environments) {
        const deployCount = this.state.getDeploymentsByEnvironment(
          env.partitionId,
          env.environmentId,
        ).length;
        answerParts.push(
          `  • ${env.partitionId}:${env.environmentId}`,
        );
        answerParts.push(
          `    Version: v${env.currentVersion ?? "none"}`,
        );
        answerParts.push(
          `    Deployments: ${deployCount}`,
        );
        answerParts.push(
          `    Active variables: ${Object.keys(env.activeVariables).length}`,
        );
        answerParts.push(
          `    Last updated: ${env.lastUpdated.toISOString()}`,
        );

        evidence.push({
          source: `environment ${env.partitionId}:${env.environmentId}`,
          summary: `Running v${env.currentVersion ?? "none"}, ${deployCount} deployments`,
          detail: `Variables: ${Object.keys(env.activeVariables).join(", ") || "none"}`,
        });
      }
    } else {
      answerParts.push("No active environments — no deployments have been executed on this machine.");
    }

    return {
      query: question,
      intent: "environment-state",
      answer: answerParts.join("\n"),
      evidence,
      answeredAt: new Date(),
      confident: true,
      escalationHint: null,
    };
  }

  // -------------------------------------------------------------------------
  // General — unclassified queries
  // -------------------------------------------------------------------------

  private answerGeneral(question: string): QueryResult {
    const evidence: QueryEvidence[] = [];
    const answerParts: string[] = [];

    // Try to be helpful with whatever data we have
    const summary = this.state.getSummary();
    const recentDeployments = this.state.listDeployments().slice(0, 5);
    const recentEntries = this.debrief.getRecent(10);

    answerParts.push(
      `This Envoy has processed ${summary.totalDeployments} deployment(s) ` +
      `across ${summary.environments} environment(s).`,
    );

    if (recentDeployments.length > 0) {
      answerParts.push("");
      answerParts.push("Most recent deployments:");
      for (const d of recentDeployments) {
        const dateStr = d.receivedAt.toISOString().split("T")[0];
        answerParts.push(
          `  • [${dateStr}] ${d.operationId} v${d.version} — ${d.status}`,
        );
      }
    }

    if (recentEntries.length > 0) {
      answerParts.push("");
      answerParts.push("Recent decisions:");
      for (const entry of recentEntries.slice(0, 5)) {
        answerParts.push(`  • [${entry.decisionType}] ${entry.decision}`);
        evidence.push({
          source: `debrief entry ${entry.id}`,
          summary: entry.decision,
          detail: entry.reasoning,
        });
      }
    }

    answerParts.push("");
    answerParts.push(
      "For more specific answers, try asking about: deployment diagnostics " +
      "(\"why did X fail?\"), change history (\"what changed in the last N days?\"), " +
      "or pre-deployment assessment (\"what should I know before deploying?\").",
    );

    return {
      query: question,
      intent: "general",
      answer: answerParts.join("\n"),
      evidence,
      answeredAt: new Date(),
      confident: false,
      escalationHint: "Query didn't match a specific intent. The answer includes general state information.",
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private findVersionChanges(
    deployments: LocalDeploymentRecord[],
  ): Array<{ operationId: string; fromVersion: string; toVersion: string }> {
    const changes: Array<{ operationId: string; fromVersion: string; toVersion: string }> = [];
    const byoperation = new Map<string, LocalDeploymentRecord[]>();

    for (const d of deployments) {
      if (d.status !== "succeeded") continue;
      const existing = byoperation.get(d.operationId) ?? [];
      existing.push(d);
      byoperation.set(d.operationId, existing);
    }

    for (const [operationId, operationDeploys] of byoperation) {
      const sorted = [...operationDeploys].sort(
        (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
      );
      if (sorted.length >= 2) {
        changes.push({
          operationId,
          fromVersion: sorted[0].version,
          toVersion: sorted[sorted.length - 1].version,
        });
      }
    }

    return changes;
  }
}
