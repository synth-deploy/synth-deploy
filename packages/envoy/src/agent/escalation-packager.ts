import type {
  DebriefEntry,
  DebriefReader,
} from "@synth-deploy/core";
import type {
  EnvoyKnowledgeStore,
  LocalDeploymentRecord,
  EnvironmentSnapshot,
} from "../state/knowledge-store.js";
import type { EnvironmentScanner, EnvironmentScanResult } from "./environment-scanner.js";
import type { DiagnosticReport } from "./diagnostic-investigator.js";

// ---------------------------------------------------------------------------
// Types — the escalation package
// ---------------------------------------------------------------------------

export type EscalationSeverity = "critical" | "high" | "medium" | "low";

export interface EscalationPackage {
  /** When this package was created */
  createdAt: Date;
  /** Why the Envoy is escalating */
  reason: string;
  /** Severity assessment */
  severity: EscalationSeverity;
  /** One-paragraph executive summary of the situation */
  summary: string;
  /** What the Envoy tried and what it knows */
  envoyAssessment: string;
  /** What the Envoy recommends the Server/human do */
  recommendedAction: string;

  /** Current environment state at time of escalation */
  environmentState: {
    scan: EnvironmentScanResult;
    environments: EnvironmentSnapshot[];
    readiness: { ready: boolean; reason: string };
  };

  /** Recent deployment history on this machine */
  recentDeployments: LocalDeploymentRecord[];

  /** Relevant debrief entries — the decision trail leading to this escalation */
  relevantDebriefEntries: DebriefEntry[];

  /** Diagnostic reports for any recent failures */
  diagnostics: Array<{
    deploymentId: string;
    report: DiagnosticReport;
  }>;

  /** Formatted text version — readable without parsing the structure */
  formatted: string;
}

// ---------------------------------------------------------------------------
// EscalationPackager — packages everything the Envoy knows
// ---------------------------------------------------------------------------

/**
 * When the Envoy encounters a situation it cannot resolve locally,
 * it packages everything it knows and sends it up the chain.
 *
 * The package includes:
 * - What happened (recent deployments, debrief trail)
 * - What the Envoy investigated and found (diagnostics)
 * - What the environment looks like right now
 * - What the Envoy thinks should happen next
 *
 * This is designed so whoever receives it — Server agent, support
 * engineer, or on-call human — can act immediately without asking
 * the Envoy for more context.
 */
export class EscalationPackager {
  constructor(
    private debrief: DebriefReader,
    private state: EnvoyKnowledgeStore,
    private scanner: EnvironmentScanner,
    private envoyId: string = "envoy-local",
  ) {}

  /**
   * Create an escalation package for a specific deployment failure.
   */
  packageForDeployment(
    deploymentId: string,
    reason: string,
  ): EscalationPackage {
    const deployment = this.state.getDeployment(deploymentId);
    const debriefEntries = this.debrief.getByOperation(deploymentId);

    // Get diagnostics from debrief entries
    const diagnosticEntries = debriefEntries.filter(
      (e) => e.decisionType === "diagnostic-investigation",
    );
    const diagnostics = diagnosticEntries.map((e) => ({
      deploymentId,
      report: (e.context?.diagnostic as DiagnosticReport) ?? {
        failureType: "unknown" as const,
        summary: e.decision,
        rootCause: e.reasoning,
        recommendation: "Review debrief entries for full context.",
        evidence: [],
        traditionalComparison: "",
      },
    }));

    const severity = this.assessSeverity(deployment, diagnostics);
    const summary = this.buildSummary(deployment, debriefEntries, diagnostics, reason);
    const assessment = this.buildAssessment(deployment, debriefEntries, diagnostics);
    const recommendedAction = this.buildRecommendation(deployment, diagnostics, severity);

    // Gather context
    const scan = this.scanner.scan();
    const environments = this.state.listEnvironments();
    const readiness = this.scanner.checkReadiness();
    const recentDeployments = this.state.listDeployments().slice(0, 10);

    // Include debrief entries from related deployments (same partition/environment)
    const allRelevantEntries = [...debriefEntries];
    if (deployment) {
      const envDeployments = this.state.getDeploymentsByEnvironment(
        deployment.partitionId,
        deployment.environmentId,
      );
      for (const related of envDeployments.slice(-3)) {
        if (related.deploymentId !== deploymentId) {
          const relatedEntries = this.debrief.getByOperation(related.deploymentId);
          allRelevantEntries.push(...relatedEntries);
        }
      }
    }

    const formatted = this.formatPackage(
      reason,
      severity,
      summary,
      assessment,
      recommendedAction,
      deployment ?? null,
      debriefEntries,
      diagnostics,
      scan,
      environments,
      readiness,
      recentDeployments,
    );

    return {
      createdAt: new Date(),
      reason,
      severity,
      summary,
      envoyAssessment: assessment,
      recommendedAction,
      environmentState: { scan, environments, readiness },
      recentDeployments,
      relevantDebriefEntries: allRelevantEntries,
      diagnostics,
      formatted,
    };
  }

  /**
   * Create a general escalation package (not tied to a specific deployment).
   */
  packageGeneral(reason: string): EscalationPackage {
    const scan = this.scanner.scan();
    const environments = this.state.listEnvironments();
    const readiness = this.scanner.checkReadiness();
    const recentDeployments = this.state.listDeployments().slice(0, 10);
    const recentEntries = this.debrief.getRecent(20);

    // Get diagnostics from recent failures
    const diagnostics: Array<{ deploymentId: string; report: DiagnosticReport }> = [];
    const recentFailures = recentDeployments.filter((d) => d.status === "failed");
    for (const failure of recentFailures.slice(-3)) {
      const diagEntries = this.debrief.getByOperation(failure.deploymentId).filter(
        (e) => e.decisionType === "diagnostic-investigation",
      );
      for (const diagEntry of diagEntries) {
        const report = diagEntry.context?.diagnostic as DiagnosticReport | undefined;
        if (report) {
          diagnostics.push({ deploymentId: failure.deploymentId, report });
        }
      }
    }

    const severity = this.assessGeneralSeverity(recentDeployments, readiness);

    const summaryParts: string[] = [];
    summaryParts.push(
      `Envoy ${this.envoyId} is escalating: ${reason}.`,
    );
    summaryParts.push(
      `Machine has ${recentDeployments.length} recent deployment(s), ` +
      `${recentFailures.length} of which failed.`,
    );
    if (!readiness.ready) {
      summaryParts.push(`Workspace is NOT ready: ${readiness.reason}`);
    }
    const summary = summaryParts.join(" ");

    const assessmentParts: string[] = [];
    assessmentParts.push(
      `The Envoy has ${environments.length} active environment(s) ` +
      `and has processed ${recentDeployments.length} recent deployment(s).`,
    );
    if (recentFailures.length > 0) {
      assessmentParts.push(
        `${recentFailures.length} recent failure(s) observed. ` +
        `Failure reasons: ${recentFailures.map((d) => d.failureReason ?? "unknown").join("; ")}.`,
      );
    }
    if (diagnostics.length > 0) {
      assessmentParts.push(
        `Diagnostic investigations found: ${diagnostics.map((d) => d.report.summary).join("; ")}.`,
      );
    }
    const assessment = assessmentParts.join(" ");

    const recommendedAction =
      !readiness.ready
        ? `Resolve workspace readiness issue first: ${readiness.reason}. Then re-evaluate the situation.`
        : recentFailures.length >= 3
          ? `Multiple recent failures indicate a systemic issue. Investigate the root cause before attempting more deployments.`
          : `Review the attached debrief entries and diagnostic reports for context, then decide on next steps.`;

    const formatted = this.formatPackage(
      reason,
      severity,
      summary,
      assessment,
      recommendedAction,
      null,
      recentEntries,
      diagnostics,
      scan,
      environments,
      readiness,
      recentDeployments,
    );

    return {
      createdAt: new Date(),
      reason,
      severity,
      summary,
      envoyAssessment: assessment,
      recommendedAction,
      environmentState: { scan, environments, readiness },
      recentDeployments,
      relevantDebriefEntries: recentEntries,
      diagnostics,
      formatted,
    };
  }

  // -------------------------------------------------------------------------
  // Severity assessment
  // -------------------------------------------------------------------------

  private assessSeverity(
    deployment: LocalDeploymentRecord | undefined,
    diagnostics: Array<{ deploymentId: string; report: DiagnosticReport }>,
  ): EscalationSeverity {
    if (!deployment) return "medium";

    // Check for recurring failures
    const envDeployments = this.state.getDeploymentsByEnvironment(
      deployment.partitionId,
      deployment.environmentId,
    );
    const recentFailures = envDeployments.filter((d) => d.status === "failed");

    // Critical: 3+ consecutive failures, or workspace not ready
    if (recentFailures.length >= 3) return "critical";

    // High: diagnostic shows service crash or dependency unavailable
    for (const diag of diagnostics) {
      if (
        diag.report.failureType === "service-crash" ||
        diag.report.failureType === "dependency-unavailable"
      ) {
        return "high";
      }
    }

    // Medium: deployment failed but it's isolated
    if (deployment.status === "failed") return "medium";

    return "low";
  }

  private assessGeneralSeverity(
    recentDeployments: LocalDeploymentRecord[],
    readiness: { ready: boolean; reason: string },
  ): EscalationSeverity {
    if (!readiness.ready) return "critical";

    const failures = recentDeployments.filter((d) => d.status === "failed");
    if (failures.length >= 3) return "critical";
    if (failures.length >= 2) return "high";
    if (failures.length >= 1) return "medium";
    return "low";
  }

  // -------------------------------------------------------------------------
  // Content building
  // -------------------------------------------------------------------------

  private buildSummary(
    deployment: LocalDeploymentRecord | undefined,
    debriefEntries: DebriefEntry[],
    diagnostics: Array<{ deploymentId: string; report: DiagnosticReport }>,
    reason: string,
  ): string {
    if (!deployment) {
      return `Escalation from Envoy ${this.envoyId}: ${reason}. No deployment record found for the referenced ID.`;
    }

    const parts: string[] = [];
    parts.push(
      `${deployment.operationId} v${deployment.version} deployment to ` +
      `environment ${deployment.environmentId} for partition ${deployment.partitionId} ` +
      `${deployment.status === "failed" ? "FAILED" : deployment.status.toUpperCase()}.`,
    );

    if (diagnostics.length > 0) {
      parts.push(
        `Investigation found: ${diagnostics[0].report.summary}`,
      );
    } else if (deployment.failureReason) {
      parts.push(`Failure reason: ${deployment.failureReason}.`);
    }

    parts.push(`Reason for escalation: ${reason}.`);

    return parts.join(" ");
  }

  private buildAssessment(
    deployment: LocalDeploymentRecord | undefined,
    debriefEntries: DebriefEntry[],
    diagnostics: Array<{ deploymentId: string; report: DiagnosticReport }>,
  ): string {
    if (!deployment) {
      return "The Envoy could not find local records for this deployment. The deployment may have been executed elsewhere or the records may have been lost.";
    }

    const parts: string[] = [];

    // What the Envoy observed
    parts.push(
      `The Envoy executed ${debriefEntries.length} steps during this deployment, ` +
      `recording ${debriefEntries.length} debrief entries.`,
    );

    // Diagnostic findings
    if (diagnostics.length > 0) {
      const diag = diagnostics[0].report;
      parts.push(
        `Diagnostic investigation classified this as a "${diag.failureType}" failure. ` +
        `Root cause: ${diag.rootCause}`,
      );
      parts.push(
        `The Envoy collected ${diag.evidence.length} pieces of evidence during investigation.`,
      );
    }

    // Previous deployment context
    const envDeployments = this.state.getDeploymentsByEnvironment(
      deployment.partitionId,
      deployment.environmentId,
    );
    if (envDeployments.length > 1) {
      const previousSuccesses = envDeployments.filter(
        (d) => d.status === "succeeded" && d.deploymentId !== deployment.deploymentId,
      );
      if (previousSuccesses.length > 0) {
        const last = previousSuccesses[previousSuccesses.length - 1];
        parts.push(
          `Previous successful deployment was ${last.operationId} v${last.version}. ` +
          `That version may still be available for rollback.`,
        );
      }
    }

    return parts.join(" ");
  }

  private buildRecommendation(
    deployment: LocalDeploymentRecord | undefined,
    diagnostics: Array<{ deploymentId: string; report: DiagnosticReport }>,
    severity: EscalationSeverity,
  ): string {
    if (!deployment) {
      return "Locate the deployment records — either on the correct Envoy or in the Server debrief — before taking action.";
    }

    // Use diagnostic recommendation if available
    if (diagnostics.length > 0) {
      return diagnostics[0].report.recommendation;
    }

    // Fall back to severity-based recommendation
    switch (severity) {
      case "critical":
        return `Immediate action required. The environment ${deployment.environmentId} has experienced ` +
          `multiple failures. Investigate the underlying cause before attempting another deployment. ` +
          `If a previous version is available, consider rolling back.`;
      case "high":
        return `Review the failure details and diagnostic evidence. The Envoy was unable to resolve ` +
          `this issue locally. Verify the environment's dependencies and infrastructure before retrying.`;
      default:
        return `Review the attached debrief entries for context on what happened, then decide whether ` +
          `to retry the deployment or investigate further.`;
    }
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  private formatPackage(
    reason: string,
    severity: EscalationSeverity,
    summary: string,
    assessment: string,
    recommendedAction: string,
    deployment: LocalDeploymentRecord | null,
    debriefEntries: DebriefEntry[],
    diagnostics: Array<{ deploymentId: string; report: DiagnosticReport }>,
    scan: EnvironmentScanResult,
    environments: EnvironmentSnapshot[],
    readiness: { ready: boolean; reason: string },
    recentDeployments: LocalDeploymentRecord[],
  ): string {
    const lines: string[] = [];

    lines.push("# Escalation Package");
    lines.push(`Envoy: ${this.envoyId}`);
    lines.push(`Created: ${new Date().toISOString()}`);
    lines.push(`Severity: ${severity.toUpperCase()}`);
    lines.push("");

    lines.push("## Reason for Escalation");
    lines.push(reason);
    lines.push("");

    lines.push("## Summary");
    lines.push(summary);
    lines.push("");

    lines.push("## Envoy Assessment");
    lines.push(assessment);
    lines.push("");

    lines.push("## Recommended Action");
    lines.push(recommendedAction);
    lines.push("");

    // Deployment details
    if (deployment) {
      lines.push("## Failed Deployment");
      lines.push(`  ID: ${deployment.deploymentId}`);
      lines.push(`  operation: ${deployment.operationId} v${deployment.version}`);
      lines.push(`  Partition: ${deployment.partitionId}`);
      lines.push(`  Environment: ${deployment.environmentId}`);
      lines.push(`  Status: ${deployment.status}`);
      lines.push(`  Received: ${deployment.receivedAt.toISOString()}`);
      if (deployment.completedAt) {
        lines.push(`  Completed: ${deployment.completedAt.toISOString()}`);
      }
      if (deployment.failureReason) {
        lines.push(`  Failure: ${deployment.failureReason}`);
      }
      lines.push("");
    }

    // Diagnostics
    if (diagnostics.length > 0) {
      lines.push("## Diagnostic Reports");
      for (const diag of diagnostics) {
        lines.push(`### Deployment ${diag.deploymentId}`);
        lines.push(`  Type: ${diag.report.failureType}`);
        lines.push(`  Summary: ${diag.report.summary}`);
        lines.push(`  Root Cause: ${diag.report.rootCause}`);
        lines.push(`  Recommendation: ${diag.report.recommendation}`);
        if (diag.report.evidence.length > 0) {
          lines.push("  Evidence:");
          for (const ev of diag.report.evidence) {
            lines.push(`    - [${ev.source}] ${ev.finding} (${ev.relevance})`);
          }
        }
        lines.push("");
      }
    }

    // Environment state
    lines.push("## Environment State");
    lines.push(`  Hostname: ${scan.hostname}`);
    lines.push(`  Workspace ready: ${readiness.ready ? "yes" : `NO — ${readiness.reason}`}`);
    lines.push(`  Active environments: ${environments.length}`);
    for (const env of environments) {
      lines.push(
        `    • ${env.partitionId}:${env.environmentId} — v${env.currentVersion ?? "none"}`,
      );
    }
    lines.push("");

    // Recent deployments
    lines.push("## Recent Deployment History");
    for (const d of recentDeployments.slice(0, 5)) {
      const date = d.receivedAt.toISOString().split("T")[0];
      lines.push(
        `  [${date}] ${d.operationId} v${d.version} — ${d.status}` +
        (d.failureReason ? ` (${d.failureReason})` : ""),
      );
    }
    lines.push("");

    // Decision trail
    lines.push("## Decision Trail");
    lines.push(`${debriefEntries.length} debrief entries included.`);
    for (const entry of debriefEntries.slice(-10)) {
      const ts = entry.timestamp.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
      lines.push(`  [${ts}] [${entry.decisionType}] ${entry.decision}`);
    }

    return lines.join("\n");
  }
}
