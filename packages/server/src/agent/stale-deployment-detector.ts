import type { DebriefWriter } from "@synth-deploy/core";
import type { DeploymentStore } from "./synth-agent.js";

const DEFAULT_STALE_THRESHOLD_MS = Number(
  process.env.SYNTH_STALE_DEPLOYMENT_TIMEOUT_MS ?? 30 * 60 * 1000, // 30 minutes
);

const DEFAULT_SCAN_INTERVAL_MS = Number(
  process.env.SYNTH_STALE_SCAN_INTERVAL_MS ?? 60 * 1000, // 1 minute
);

/**
 * Scans for deployments stuck in "running" status beyond the stale threshold
 * and marks them as failed with a clear explanation.
 *
 * Returns the number of deployments marked as stale.
 */
export function markStaleDeployments(
  deployments: DeploymentStore,
  debrief: DebriefWriter,
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): number {
  const now = Date.now();
  const stale = deployments.list().filter(
    (d) =>
      d.status === "running" &&
      now - new Date(d.createdAt).getTime() > thresholdMs,
  );

  for (const deployment of stale) {
    deployment.status = "failed";
    deployments.save(deployment);

    const staleDurationMin = Math.round(
      (now - new Date(deployment.createdAt).getTime()) / 60_000,
    );

    debrief.record({
      partitionId: deployment.partitionId ?? null,
      operationId: deployment.id,
      agent: "server",
      decisionType: "deployment-failure",
      decision: `Marked deployment as failed: exceeded ${Math.round(thresholdMs / 60_000)} minute stale threshold`,
      reasoning:
        `Deployment ${deployment.id.slice(0, 8)} has been in "running" status for ${staleDurationMin} minutes ` +
        `without receiving a completion report. This typically indicates Command lost connection to the Envoy ` +
        `or the Envoy process crashed during execution. The deployment has been marked as failed to prevent ` +
        `indefinite "running" status.`,
      context: {
        deploymentId: deployment.id,
        partitionId: deployment.partitionId ?? null,
        staleDurationMinutes: staleDurationMin,
        thresholdMinutes: Math.round(thresholdMs / 60_000),
      },
    });
  }

  return stale.length;
}

/**
 * Starts a periodic scan for stale deployments.
 * Returns a cleanup function to stop the interval.
 */
export function startStaleDeploymentScanner(
  deployments: DeploymentStore,
  debrief: DebriefWriter,
  intervalMs: number = DEFAULT_SCAN_INTERVAL_MS,
  thresholdMs: number = DEFAULT_STALE_THRESHOLD_MS,
): () => void {
  const timer = setInterval(() => {
    const count = markStaleDeployments(deployments, debrief, thresholdMs);
    if (count > 0) {
      console.log(`[stale-detector] Marked ${count} stale deployment(s) as failed`);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
