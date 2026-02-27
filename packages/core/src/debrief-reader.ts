import type { DebriefEntry, Deployment, DeploymentId } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PostmortemReport {
  /** One-line summary: what was deployed, where, and what happened. */
  summary: string;
  /** Chronological timeline of every decision the agent made. */
  timeline: TimelineEntry[];
  /** Configuration section: variables applied and any conflicts resolved. */
  configuration: ConfigurationSection;
  /** Present only when the deployment failed. */
  failureAnalysis: FailureAnalysis | null;
  /** Final outcome -- what state the deployment ended in. */
  outcome: string;
  /** Full formatted text suitable for reading without any other context. */
  formatted: string;
}

export interface TimelineEntry {
  timestamp: Date;
  step: string;
  decision: string;
  reasoning: string;
}

export interface ConfigurationSection {
  variableCount: number;
  conflictCount: number;
  conflicts: ConflictSummary[];
}

export interface ConflictSummary {
  description: string;
  riskLevel: string;
  resolution: string;
}

export interface FailureAnalysis {
  failedStep: string;
  whatHappened: string;
  whyItFailed: string;
  suggestedFix: string;
}

export interface ProjectHistory {
  /** High-level stats: total deployments, success rate, environments. */
  overview: HistoryOverview;
  /** Per-deployment summaries in chronological order. */
  deployments: DeploymentSummary[];
  /** Recurring configuration patterns observed across deployments. */
  configurationPatterns: ConfigurationPattern[];
  /** Per-environment observations. */
  environmentNotes: EnvironmentNote[];
  /** Full formatted text suitable for onboarding read. */
  formatted: string;
}

export interface HistoryOverview {
  totalDeployments: number;
  succeeded: number;
  failed: number;
  successRate: string;
  environments: string[];
  versions: string[];
}

export interface DeploymentSummary {
  deploymentId: string;
  version: string;
  environment: string;
  outcome: "succeeded" | "failed";
  durationMs: number | null;
  conflictCount: number;
  keyDecision: string;
}

export interface ConfigurationPattern {
  pattern: string;
  occurrences: number;
  detail: string;
}

export interface EnvironmentNote {
  environment: string;
  deploymentCount: number;
  successRate: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Postmortem generator
// ---------------------------------------------------------------------------

/**
 * Generate a postmortem report from a deployment's debrief entries.
 *
 * Designed so a reviewer can read this and understand exactly what the agent
 * decided, why it rolled back or continued, and what the suggested fix is --
 * without reading any log files.
 */
export function generatePostmortem(
  entries: DebriefEntry[],
  deployment: Deployment,
): PostmortemReport {
  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );

  const summary = buildSummary(sorted, deployment);
  const timeline = buildTimeline(sorted);
  const configuration = buildConfigurationSection(sorted);
  const failureAnalysis = buildFailureAnalysis(sorted, deployment);
  const outcome = buildOutcome(sorted, deployment);
  const formatted = formatPostmortem(
    summary,
    timeline,
    configuration,
    failureAnalysis,
    outcome,
    deployment,
  );

  return {
    summary,
    timeline,
    configuration,
    failureAnalysis,
    outcome,
    formatted,
  };
}

function buildSummary(entries: DebriefEntry[], deployment: Deployment): string {
  const planEntry = entries.find((e) => e.decisionType === "pipeline-plan");
  const project = (planEntry?.context?.projectId as string) ?? deployment.projectId;
  const version = (planEntry?.context?.version as string) ?? deployment.version;
  const environment =
    (planEntry?.context?.environmentName as string) ?? deployment.environmentId;
  const tenant =
    (planEntry?.context?.tenantName as string) ?? deployment.tenantId;

  const statusLabel = deployment.status === "succeeded" ? "SUCCEEDED" : "FAILED";

  return (
    `Deployment of ${project} v${version} to "${environment}" ` +
    `for tenant "${tenant}" -- ${statusLabel}`
  );
}

function buildTimeline(entries: DebriefEntry[]): TimelineEntry[] {
  return entries.map((e) => ({
    timestamp: e.timestamp,
    step: e.decisionType,
    decision: e.decision,
    reasoning: e.reasoning,
  }));
}

function buildConfigurationSection(entries: DebriefEntry[]): ConfigurationSection {
  const configEntry = entries.find(
    (e) => e.decisionType === "configuration-resolved",
  );
  const conflictEntries = entries.filter(
    (e) => e.decisionType === "variable-conflict",
  );

  const variableCount = (configEntry?.context?.variableCount as number) ?? 0;
  // When the deployment is blocked before configuration-resolved is recorded,
  // the conflict count comes from the number of variable-conflict entries instead.
  const conflictCount =
    (configEntry?.context?.conflictCount as number) ?? conflictEntries.length;

  const conflicts: ConflictSummary[] = conflictEntries.map((e) => ({
    description: e.decision,
    riskLevel: (e.context?.riskLevel as string) ?? "unknown",
    resolution: e.reasoning,
  }));

  return { variableCount, conflictCount, conflicts };
}

function buildFailureAnalysis(
  entries: DebriefEntry[],
  deployment: Deployment,
): FailureAnalysis | null {
  if (deployment.status !== "failed") return null;

  const failureEntry = entries.find(
    (e) => e.decisionType === "deployment-failure",
  );
  if (!failureEntry) return null;

  const failedStep = (failureEntry.context?.step as string) ?? "unknown";
  const whatHappened = failureEntry.decision;
  const whyItFailed = failureEntry.reasoning;

  // Extract suggested fix from reasoning -- the agent always includes
  // "Recommended action:" in failure reasoning
  const recommendedIdx = whyItFailed.indexOf("Recommended action:");
  const suggestedFix =
    recommendedIdx >= 0
      ? whyItFailed.slice(recommendedIdx + "Recommended action:".length).trim()
      : extractSuggestedFix(entries, failedStep);

  return { failedStep, whatHappened, whyItFailed, suggestedFix };
}

/**
 * Fallback: extract a suggested fix from health-check or conflict entries
 * when the failure entry doesn't include an explicit recommendation.
 */
function extractSuggestedFix(entries: DebriefEntry[], failedStep: string): string {
  // Look for health check abort reasoning
  if (failedStep === "preflight-health-check") {
    const healthAbort = entries.find(
      (e) =>
        e.decisionType === "health-check" &&
        e.decision.toLowerCase().includes("abort"),
    );
    if (healthAbort) {
      const recIdx = healthAbort.reasoning.indexOf("Recommended action:");
      if (recIdx >= 0) {
        return healthAbort.reasoning
          .slice(recIdx + "Recommended action:".length)
          .trim();
      }
    }
    return "Verify the target environment's infrastructure is running and network-accessible, then re-trigger the deployment.";
  }

  if (failedStep === "resolve-configuration") {
    const conflictEntry = entries.find(
      (e) =>
        e.decisionType === "variable-conflict" &&
        (e.context?.action === "block" ||
          e.decision.toLowerCase().includes("block")),
    );
    if (conflictEntry) {
      const recIdx = conflictEntry.reasoning.indexOf("To deploy");
      if (recIdx >= 0) {
        return conflictEntry.reasoning.slice(recIdx).trim();
      }
    }
    return "Review and correct the tenant's variable bindings for the target environment, then re-trigger.";
  }

  return "Review the debrief entries above for details on what failed, then address the root cause and re-trigger.";
}

function buildOutcome(entries: DebriefEntry[], deployment: Deployment): string {
  if (deployment.status === "succeeded") {
    const completionEntry = entries.find(
      (e) => e.decisionType === "deployment-completion",
    );
    return completionEntry?.reasoning ?? "Deployment completed successfully.";
  }

  const failureEntry = entries.find(
    (e) => e.decisionType === "deployment-failure",
  );
  return (
    failureEntry?.decision ?? `Deployment failed: ${deployment.failureReason}`
  );
}

function formatPostmortem(
  summary: string,
  timeline: TimelineEntry[],
  configuration: ConfigurationSection,
  failureAnalysis: FailureAnalysis | null,
  outcome: string,
  deployment: Deployment,
): string {
  const lines: string[] = [];

  lines.push("# Deployment Postmortem");
  lines.push("");
  lines.push(`## Summary`);
  lines.push(summary);
  lines.push(`Deployment ID: ${deployment.id}`);
  lines.push(
    `Started: ${deployment.createdAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`,
  );
  if (deployment.completedAt) {
    lines.push(
      `Completed: ${deployment.completedAt.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")}`,
    );
    const durationMs =
      deployment.completedAt.getTime() - deployment.createdAt.getTime();
    lines.push(`Duration: ${durationMs}ms`);
  }
  lines.push("");

  // Timeline
  lines.push("## Decision Timeline");
  for (const entry of timeline) {
    const ts = entry.timestamp
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
    lines.push(`[${ts}] ${entry.step.toUpperCase()}`);
    lines.push(`  Decision: ${entry.decision}`);
    lines.push(`  Reasoning: ${entry.reasoning}`);
    lines.push("");
  }

  // Configuration
  lines.push("## Configuration");
  lines.push(
    `${configuration.variableCount} variable(s) resolved, ${configuration.conflictCount} conflict(s)`,
  );
  if (configuration.conflicts.length > 0) {
    lines.push("");
    lines.push("### Conflicts");
    for (const conflict of configuration.conflicts) {
      lines.push(`- ${conflict.description}`);
      lines.push(`  Risk: ${conflict.riskLevel}`);
      lines.push(`  Resolution: ${conflict.resolution}`);
    }
  }
  lines.push("");

  // Failure Analysis
  if (failureAnalysis) {
    lines.push("## Failure Analysis");
    lines.push(`Failed Step: ${failureAnalysis.failedStep}`);
    lines.push(`What Happened: ${failureAnalysis.whatHappened}`);
    lines.push(`Why: ${failureAnalysis.whyItFailed}`);
    lines.push("");
    lines.push(`### Suggested Fix`);
    lines.push(failureAnalysis.suggestedFix);
    lines.push("");
  }

  // Outcome
  lines.push("## Outcome");
  lines.push(outcome);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Knowledge base / project history generator
// ---------------------------------------------------------------------------

/**
 * Generate a project history from debrief entries and deployments.
 *
 * Designed so a new engineer joining a project with 10 deployments in its
 * history can read this and understand the project's configuration decisions
 * and deployment patterns without digging through individual logs.
 */
export function generateProjectHistory(
  entries: DebriefEntry[],
  deployments: Deployment[],
): ProjectHistory {
  const sorted = [...entries].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
  );
  const sortedDeployments = [...deployments].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );

  const overview = buildOverview(sortedDeployments, sorted);
  const deploymentSummaries = buildDeploymentSummaries(
    sortedDeployments,
    sorted,
  );
  const configurationPatterns = buildConfigurationPatterns(sorted);
  const environmentNotes = buildEnvironmentNotes(
    sortedDeployments,
    sorted,
  );
  const formatted = formatProjectHistory(
    overview,
    deploymentSummaries,
    configurationPatterns,
    environmentNotes,
  );

  return {
    overview,
    deployments: deploymentSummaries,
    configurationPatterns,
    environmentNotes,
    formatted,
  };
}

function buildOverview(
  deployments: Deployment[],
  entries: DebriefEntry[],
): HistoryOverview {
  const succeeded = deployments.filter((d) => d.status === "succeeded").length;
  const failed = deployments.filter((d) => d.status === "failed").length;
  const total = deployments.length;
  const successRate =
    total > 0 ? `${Math.round((succeeded / total) * 100)}%` : "N/A";

  // Extract environments and versions from plan entries
  const environments = new Set<string>();
  const versions = new Set<string>();

  for (const entry of entries) {
    if (entry.decisionType === "pipeline-plan") {
      const env = entry.context?.environmentName;
      const ver = entry.context?.version;
      if (typeof env === "string") environments.add(env);
      if (typeof ver === "string") versions.add(ver);
    }
  }

  return {
    totalDeployments: total,
    succeeded,
    failed,
    successRate,
    environments: [...environments],
    versions: [...versions],
  };
}

function buildDeploymentSummaries(
  deployments: Deployment[],
  entries: DebriefEntry[],
): DeploymentSummary[] {
  return deployments.map((d) => {
    const deployEntries = entries.filter((e) => e.deploymentId === d.id);
    const planEntry = deployEntries.find(
      (e) => e.decisionType === "pipeline-plan",
    );
    const conflictEntries = deployEntries.filter(
      (e) => e.decisionType === "variable-conflict",
    );

    const version =
      (planEntry?.context?.version as string) ?? d.version;
    const environment =
      (planEntry?.context?.environmentName as string) ?? d.environmentId;
    const durationMs =
      d.completedAt && d.createdAt
        ? d.completedAt.getTime() - d.createdAt.getTime()
        : null;

    // Find the most significant decision for this deployment
    const keyDecision = findKeyDecision(deployEntries, d);

    return {
      deploymentId: d.id,
      version,
      environment,
      outcome: d.status === "succeeded" ? "succeeded" : "failed",
      durationMs,
      conflictCount: conflictEntries.length,
      keyDecision,
    };
  });
}

function findKeyDecision(entries: DebriefEntry[], deployment: Deployment): string {
  // For failures, the failure entry is the key decision
  if (deployment.status === "failed") {
    const failEntry = entries.find(
      (e) => e.decisionType === "deployment-failure",
    );
    return failEntry?.decision ?? "Deployment failed (no details recorded)";
  }

  // For successes with conflicts, the conflict resolution is key
  const conflictEntries = entries.filter(
    (e) => e.decisionType === "variable-conflict",
  );
  if (conflictEntries.length > 0) {
    return conflictEntries[0].decision;
  }

  // For clean successes, the completion entry
  const completionEntry = entries.find(
    (e) => e.decisionType === "deployment-completion",
  );
  return completionEntry?.decision ?? "Deployment completed";
}

function buildConfigurationPatterns(
  entries: DebriefEntry[],
): ConfigurationPattern[] {
  const patterns: ConfigurationPattern[] = [];

  // Pattern: variable conflicts
  const conflictEntries = entries.filter(
    (e) => e.decisionType === "variable-conflict",
  );
  if (conflictEntries.length > 0) {
    // Group by conflict category
    const categories = new Map<string, DebriefEntry[]>();
    for (const e of conflictEntries) {
      const cat = (e.context?.category as string) ?? "standard";
      const existing = categories.get(cat) ?? [];
      existing.push(e);
      categories.set(cat, existing);
    }

    for (const [category, catEntries] of categories) {
      const variables = new Set<string>();
      for (const e of catEntries) {
        const conflicts = e.context?.conflicts;
        if (Array.isArray(conflicts)) {
          for (const c of conflicts) {
            if (typeof c === "object" && c !== null && "variable" in c) {
              variables.add(c.variable as string);
            }
          }
        }
        // Also check the variables field for sensitive overrides
        const vars = e.context?.variables;
        if (Array.isArray(vars)) {
          for (const v of vars) {
            if (typeof v === "object" && v !== null && "variable" in v) {
              variables.add(v.variable as string);
            }
          }
        }
      }

      patterns.push({
        pattern: `${formatCategory(category)} conflicts`,
        occurrences: catEntries.length,
        detail:
          variables.size > 0
            ? `Variables involved: ${[...variables].join(", ")}. ` +
              `Seen in ${catEntries.length} deployment(s).`
            : `Seen in ${catEntries.length} deployment(s).`,
      });
    }
  }

  // Pattern: health check issues
  const healthRetries = entries.filter(
    (e) =>
      e.decisionType === "health-check" &&
      e.decision.toLowerCase().includes("retry"),
  );
  if (healthRetries.length > 0) {
    const errorCategories = new Set<string>();
    for (const e of healthRetries) {
      const cat = e.context?.errorCategory;
      if (typeof cat === "string") errorCategories.add(cat);
    }
    patterns.push({
      pattern: "Health check retries",
      occurrences: healthRetries.length,
      detail:
        `${healthRetries.length} health check retry event(s) observed. ` +
        `Error types: ${[...errorCategories].join(", ") || "various"}.`,
    });
  }

  // Pattern: deployment blocks (high-risk config)
  const blockEntries = entries.filter(
    (e) =>
      e.decisionType === "variable-conflict" &&
      e.context?.action === "block",
  );
  if (blockEntries.length > 0) {
    patterns.push({
      pattern: "Deployment blocks from configuration",
      occurrences: blockEntries.length,
      detail:
        `${blockEntries.length} deployment(s) were blocked due to high-risk ` +
        `variable configurations. These indicate misconfigured tenant ` +
        `variable bindings for the target environment.`,
    });
  }

  return patterns;
}

function formatCategory(category: string): string {
  switch (category) {
    case "cross-environment":
      return "Cross-environment connectivity";
    case "cross-environment-non-connectivity":
      return "Cross-environment (non-connectivity)";
    case "sensitive-override":
      return "Security-sensitive override";
    case "standard-override":
      return "Standard override";
    default:
      return category;
  }
}

function buildEnvironmentNotes(
  deployments: Deployment[],
  entries: DebriefEntry[],
): EnvironmentNote[] {
  // Group deployments by environment (using plan entry for name)
  const envMap = new Map<
    string,
    { deployments: Deployment[]; entries: DebriefEntry[] }
  >();

  for (const d of deployments) {
    const deployEntries = entries.filter((e) => e.deploymentId === d.id);
    const planEntry = deployEntries.find(
      (e) => e.decisionType === "pipeline-plan",
    );
    const envName =
      (planEntry?.context?.environmentName as string) ?? d.environmentId;

    const existing = envMap.get(envName) ?? { deployments: [], entries: [] };
    existing.deployments.push(d);
    existing.entries.push(...deployEntries);
    envMap.set(envName, existing);
  }

  const notes: EnvironmentNote[] = [];

  for (const [envName, data] of envMap) {
    const total = data.deployments.length;
    const succeeded = data.deployments.filter(
      (d) => d.status === "succeeded",
    ).length;
    const successRate =
      total > 0 ? `${Math.round((succeeded / total) * 100)}%` : "N/A";

    const envNotes: string[] = [];

    // Note health check patterns
    const healthIssues = data.entries.filter(
      (e) =>
        e.decisionType === "health-check" &&
        !e.decision.toLowerCase().includes("confirmed healthy") &&
        !e.decision.toLowerCase().includes("passed") &&
        !e.decision.toLowerCase().includes("proceeding"),
    );
    if (healthIssues.length > 0) {
      envNotes.push(
        `${healthIssues.length} health check issue(s) observed in this environment.`,
      );
    }

    // Note conflict patterns
    const conflicts = data.entries.filter(
      (e) => e.decisionType === "variable-conflict",
    );
    if (conflicts.length > 0) {
      envNotes.push(
        `${conflicts.length} variable conflict(s) across deployments to this environment.`,
      );
    }

    // Note failures
    const failures = data.deployments.filter((d) => d.status === "failed");
    if (failures.length > 0) {
      const failReasons = new Set<string>();
      for (const f of failures) {
        const failEntry = data.entries.find(
          (e) =>
            e.deploymentId === f.id &&
            e.decisionType === "deployment-failure",
        );
        const step = failEntry?.context?.step;
        if (typeof step === "string") failReasons.add(step);
      }
      envNotes.push(
        `${failures.length} failure(s). ` +
          `Failed steps: ${[...failReasons].join(", ") || "unknown"}.`,
      );
    }

    if (envNotes.length === 0) {
      envNotes.push("All deployments to this environment succeeded without issues.");
    }

    notes.push({
      environment: envName,
      deploymentCount: total,
      successRate,
      notes: envNotes,
    });
  }

  return notes;
}

function formatProjectHistory(
  overview: HistoryOverview,
  deploymentSummaries: DeploymentSummary[],
  configurationPatterns: ConfigurationPattern[],
  environmentNotes: EnvironmentNote[],
): string {
  const lines: string[] = [];

  lines.push("# Project Deployment History");
  lines.push("");
  lines.push("## Overview");
  lines.push(`Total deployments: ${overview.totalDeployments}`);
  lines.push(
    `Outcomes: ${overview.succeeded} succeeded, ${overview.failed} failed (${overview.successRate} success rate)`,
  );
  lines.push(`Environments: ${overview.environments.join(", ") || "none"}`);
  lines.push(`Versions deployed: ${overview.versions.join(", ") || "none"}`);
  lines.push("");

  // Deployment timeline
  lines.push("## Deployment Timeline");
  for (let i = 0; i < deploymentSummaries.length; i++) {
    const d = deploymentSummaries[i];
    const outcome = d.outcome === "succeeded" ? "OK" : "FAILED";
    const duration =
      d.durationMs !== null ? ` (${d.durationMs}ms)` : "";
    const conflicts =
      d.conflictCount > 0 ? ` [${d.conflictCount} conflict(s)]` : "";

    lines.push(
      `${i + 1}. v${d.version} → ${d.environment} -- ${outcome}${duration}${conflicts}`,
    );
    lines.push(`   ${d.keyDecision}`);
  }
  lines.push("");

  // Configuration patterns
  if (configurationPatterns.length > 0) {
    lines.push("## Configuration Patterns");
    for (const p of configurationPatterns) {
      lines.push(
        `- ${p.pattern} (${p.occurrences}x): ${p.detail}`,
      );
    }
    lines.push("");
  }

  // Environment notes
  lines.push("## Environment Notes");
  for (const n of environmentNotes) {
    lines.push(
      `### ${n.environment} (${n.deploymentCount} deployments, ${n.successRate} success)`,
    );
    for (const note of n.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}
