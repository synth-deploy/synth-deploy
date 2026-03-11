import type { DebriefEntry } from "@synth-deploy/core";
import type { DeploymentResult } from "./envoy-agent.js";

// ---------------------------------------------------------------------------
// Types — what the Envoy sends to Command
// ---------------------------------------------------------------------------

/**
 * A report the Envoy pushes to Command.
 * Each report carries the Envoy's debrief entries for a deployment,
 * plus the deployment result metadata.
 */
export interface EnvoyReport {
  type: "deployment-result";
  envoyId: string;
  deploymentId: string;
  success: boolean;
  failureReason: string | null;
  /** Full debrief entries — Command ingests these into its own debrief */
  debriefEntries: SerializedDebriefEntry[];
  /** Summary for Command's own debrief entry about this Envoy's work */
  summary: {
    artifacts: string[];
    workspacePath: string;
    executionDurationMs: number;
    totalDurationMs: number;
    verificationPassed: boolean;
    verificationChecks: Array<{ name: string; passed: boolean; detail: string }>;
  };
}

/**
 * DebriefEntry serialized for transport — dates become ISO strings.
 */
export interface SerializedDebriefEntry {
  id: string;
  timestamp: string;
  partitionId: string | null;
  deploymentId: string | null;
  agent: "command" | "envoy";
  decisionType: string;
  decision: string;
  reasoning: string;
  context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ServerReporter — the Envoy's voice to Command
// ---------------------------------------------------------------------------

/**
 * Pushes reports from the Envoy to Command.
 *
 * This is the Envoy→Command direction of communication:
 * - After each deployment, pushes the full debrief entries so Command
 *   has a unified record of both orchestration and execution decisions.
 * - Can push events proactively (health changes, environment issues).
 *
 * The reporter is fire-and-forget from the Envoy's perspective:
 * the deployment result was already returned synchronously via HTTP.
 * This is the additional push that ensures the Command's debrief is complete.
 */
export class ServerReporter {
  constructor(
    private serverUrl: string,
    private envoyId: string,
    private timeoutMs: number = 5_000,
    private token?: string,
  ) {}

  /**
   * Push a deployment result (with full debrief entries) to Command.
   */
  async reportDeploymentResult(result: DeploymentResult): Promise<void> {
    const report: EnvoyReport = {
      type: "deployment-result",
      envoyId: this.envoyId,
      deploymentId: result.deploymentId,
      success: result.success,
      failureReason: result.failureReason,
      debriefEntries: result.debriefEntries.map(serializeDebriefEntry),
      summary: {
        artifacts: result.artifacts,
        workspacePath: result.workspacePath,
        executionDurationMs: result.executionDurationMs,
        totalDurationMs: result.totalDurationMs,
        verificationPassed: result.verificationPassed,
        verificationChecks: result.verificationChecks,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

      const response = await fetch(
        `${this.serverUrl}/api/envoy/report`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(report),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(
          `Command rejected report: HTTP ${response.status} ${response.statusText}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeDebriefEntry(entry: DebriefEntry): SerializedDebriefEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp.toISOString(),
    partitionId: entry.partitionId,
    deploymentId: entry.deploymentId,
    agent: entry.agent,
    decisionType: entry.decisionType,
    decision: entry.decision,
    reasoning: entry.reasoning,
    context: entry.context,
  };
}
