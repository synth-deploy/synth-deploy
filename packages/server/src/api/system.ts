import type { FastifyInstance } from "fastify";
import type {
  IDeploymentStore,
  IArtifactStore,
  IEnvironmentStore,
  IPartitionStore,
  Partition,
  Environment,
} from "@synth-deploy/core";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalEvidence {
  label: string;
  value: string;
  status: "healthy" | "warning" | "info";
}

export interface SignalRecommendation {
  action: string;
  detail: string;
  priority: "high" | "medium" | "low";
}

export interface SignalInvestigation {
  title: string;
  entity: string;
  entityType: string;
  status: string;
  detectedAt: string;
  synthAssessment: {
    confidence: number;
    summary: string;
  };
  evidence: SignalEvidence[];
  recommendations: SignalRecommendation[];
  timeline: Array<{ time: string; event: string }>;
  relatedDeployments: Array<{
    artifact: string;
    version: string;
    target: string;
    status: string;
    time: string;
  }>;
}

export interface AlertSignal {
  type: "envoy-health" | "deployment-failure" | "drift";
  severity: "warning" | "critical";
  title: string;
  detail: string;
  relatedEntity?: { type: string; id: string; name: string };
  investigation: SignalInvestigation;
}

export interface SystemStateResponse {
  state: "empty" | "normal" | "alert";
  signals: AlertSignal[];
  stats: {
    artifacts: number;
    envoys: number;
    deployments: { total: number; active: number; failed24h: number };
    environments: number;
  };
  assessment: {
    headline: string;
    detail: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(date: Date | string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fmtTime(date: Date | string): string {
  return new Date(date).toTimeString().slice(0, 8);
}

function nowIso(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function nowTime(): string {
  return new Date().toTimeString().slice(0, 8);
}

// ---------------------------------------------------------------------------
// Drift detection (reused from agent.ts pattern)
// ---------------------------------------------------------------------------

function detectDrift(partition: Partition, environment: Environment): string[] {
  const conflicts: string[] = [];
  const envPatterns: Record<string, RegExp[]> = {
    production: [/\bstag/i, /\bdev\b/i],
    staging: [/\bprod/i],
    development: [/\bprod/i, /\bstag/i],
  };

  const patternsToCheck = envPatterns[environment.name.toLowerCase()];
  if (!patternsToCheck) return conflicts;

  for (const [key, value] of Object.entries(partition.variables)) {
    if (patternsToCheck.some((p) => p.test(value))) {
      conflicts.push(key);
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerSystemRoutes(
  app: FastifyInstance,
  deployments: IDeploymentStore,
  artifacts: IArtifactStore,
  environments: IEnvironmentStore,
  partitions: IPartitionStore,
  envoyRegistry: EnvoyRegistry,
): void {
  app.get("/api/system/state", async () => {
    const allArtifacts = artifacts.list();
    const allEnvoys = envoyRegistry.list();
    const allDeployments = deployments.list();
    const allEnvironments = environments.list();
    const allPartitions = partitions.list();

    // --- Stats ---
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

    const activeDeployments = allDeployments.filter(
      (d) => d.status === "running" || d.status === "pending",
    );
    const failed24h = allDeployments.filter(
      (d) =>
        d.status === "failed" &&
        new Date(d.createdAt).getTime() > twentyFourHoursAgo,
    );

    const stats = {
      artifacts: allArtifacts.length,
      envoys: allEnvoys.length,
      deployments: {
        total: allDeployments.length,
        active: activeDeployments.length,
        failed24h: failed24h.length,
      },
      environments: allEnvironments.length,
    };

    // --- Empty state ---
    if (allArtifacts.length === 0 && allEnvoys.length === 0) {
      return {
        state: "empty",
        signals: [],
        stats,
        assessment: { headline: "Welcome to Synth.", detail: "Get started by connecting an envoy and registering your first artifact." },
      } satisfies SystemStateResponse;
    }

    // --- Alert detection ---
    const signals: AlertSignal[] = [];

    // 1. Envoy health signals
    for (const envoy of allEnvoys) {
      if (envoy.lastHealthStatus === "degraded" || envoy.lastHealthStatus === "unreachable") {
        const isDegraded = envoy.lastHealthStatus === "degraded";
        const severity = isDegraded ? "warning" : "critical";
        const lastCheck = envoy.lastHealthCheck ? timeAgo(envoy.lastHealthCheck) : "never";
        const lastCheckTime = envoy.lastHealthCheck ? fmtTime(envoy.lastHealthCheck) : nowTime();

        const recentToEnvoy = allDeployments
          .filter((d) => {
            const envForDep = allEnvironments.find((e) => e.id === d.environmentId);
            return envForDep != null;
          })
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 2);

        signals.push({
          type: "envoy-health",
          severity,
          title: `${envoy.name} envoy ${isDegraded ? "heartbeat degraded" : "unreachable"}`,
          detail: isDegraded
            ? `Health check returned degraded status. Last checked: ${lastCheck}.`
            : `Cannot reach envoy at ${envoy.url}. Last checked: ${lastCheck}.`,
          relatedEntity: { type: "envoy", id: envoy.id, name: envoy.name },
          investigation: {
            title: isDegraded ? "Envoy Heartbeat Degradation" : "Envoy Unreachable",
            entity: envoy.name,
            entityType: "envoy",
            status: "active",
            detectedAt: nowIso(),
            synthAssessment: {
              confidence: isDegraded ? 0.78 : 0.62,
              summary: isDegraded
                ? `${envoy.name} is responding to health probes but returning degraded status. This typically indicates resource pressure (CPU, memory, or disk), a failed sub-component, or intermittent network connectivity. The envoy process is likely still running — deployments may succeed but with reduced reliability.`
                : `Cannot reach ${envoy.name} at ${envoy.url}. The envoy process may have stopped, the host may be down, or network connectivity may be blocked. Cannot distinguish between these causes without direct host access.`,
            },
            evidence: [
              { label: "Health status", value: isDegraded ? "Degraded — returning non-OK on health probe" : "Unreachable — no response to ping", status: "warning" },
              { label: "Last health check", value: `${lastCheck} (normal: <2m)`, status: isDegraded ? "warning" : "warning" },
              { label: "Envoy URL", value: envoy.url, status: isDegraded ? "info" : "warning" },
              { label: "Registered name", value: envoy.name, status: "info" },
              ...(isDegraded
                ? [{ label: "Deployment risk", value: "Elevated — envoy running but degraded", status: "info" as const }]
                : [{ label: "Deployment risk", value: "Critical — envoy cannot be reached", status: "warning" as const }]),
            ],
            recommendations: [
              {
                action: `Hold deployments to ${envoy.name}`,
                detail: `Avoid deploying to this envoy while its health is ${isDegraded ? "degraded" : "unknown"}. Deployments may fail or produce inconsistent results.`,
                priority: "high",
              },
              {
                action: isDegraded ? "Check envoy process and resources" : "Verify host reachability",
                detail: isDegraded
                  ? `SSH into the host running ${envoy.name} and check CPU, memory, and disk. Look for the envoy process in the process list.`
                  : `Ping the host at ${envoy.url} and verify that network routing is intact. Check if the host itself is reachable before investigating the envoy process.`,
                priority: isDegraded ? "medium" : "high",
              },
              {
                action: "Review envoy logs",
                detail: `Check the envoy's log output for errors or warnings. ${isDegraded ? "Degraded status often indicates a resource constraint or failed health sub-check." : "The last log entries before the outage may indicate the cause."}`,
                priority: "medium",
              },
            ],
            timeline: [
              { time: lastCheckTime, event: `Health check returned ${isDegraded ? "degraded" : "unreachable"} status` },
              { time: nowTime(), event: "Signal raised" },
            ],
            relatedDeployments: recentToEnvoy.map((d) => {
              const artName = allArtifacts.find((a) => a.id === d.artifactId)?.name ?? d.artifactId.slice(0, 8);
              const envName = allEnvironments.find((e) => e.id === d.environmentId)?.name ?? "unknown";
              return {
                artifact: artName,
                version: d.version,
                target: envName,
                status: d.status,
                time: timeAgo(d.createdAt),
              };
            }),
          },
        });
      }
    }

    // 2. Deployment failures in last 24h without subsequent success
    for (const failedDep of failed24h) {
      const hasSubsequentSuccess = allDeployments.some(
        (d) =>
          d.artifactId === failedDep.artifactId &&
          d.environmentId === failedDep.environmentId &&
          d.status === "succeeded" &&
          new Date(d.createdAt).getTime() > new Date(failedDep.createdAt).getTime(),
      );

      if (!hasSubsequentSuccess) {
        const envName = allEnvironments.find((e) => e.id === failedDep.environmentId)?.name ?? "unknown";
        const artifactName = allArtifacts.find((a) => a.id === failedDep.artifactId)?.name ?? "unknown";
        const hasReason = Boolean(failedDep.failureReason);

        const prevSuccessful = allDeployments
          .filter(
            (d) =>
              d.artifactId === failedDep.artifactId &&
              d.environmentId === failedDep.environmentId &&
              d.status === "succeeded",
          )
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 1);

        signals.push({
          type: "deployment-failure",
          severity: "critical",
          title: `Failed deployment: ${artifactName} v${failedDep.version}`,
          detail: `Deployment to ${envName} failed${failedDep.failureReason ? `: ${failedDep.failureReason}` : ""} — no successful retry yet.`,
          relatedEntity: { type: "deployment", id: failedDep.id, name: `${artifactName} v${failedDep.version}` },
          investigation: {
            title: `Failed Deployment — ${artifactName} v${failedDep.version}`,
            entity: artifactName,
            entityType: "artifact",
            status: "active",
            detectedAt: failedDep.createdAt ? new Date(failedDep.createdAt).toISOString().replace("T", " ").slice(0, 19) + " UTC" : nowIso(),
            synthAssessment: {
              confidence: hasReason ? 0.85 : 0.62,
              summary: hasReason
                ? `Deployment of ${artifactName} v${failedDep.version} to ${envName} failed with: ${failedDep.failureReason}. No successful retry has been attempted. ${prevSuccessful.length > 0 ? `The previous successful deployment to this environment was ${timeAgo(prevSuccessful[0].createdAt)}.` : "This was the first deployment to this environment."}`
                : `Deployment of ${artifactName} v${failedDep.version} to ${envName} failed without a specific reason recorded. This may indicate an infrastructure issue, a timeout, or an envoy-side failure. Review the debrief logs for the full execution trace.`,
            },
            evidence: [
              { label: "Deployment status", value: `Failed · ${timeAgo(failedDep.createdAt)}`, status: "warning" },
              { label: "Target environment", value: `${envName} — no successful retry`, status: "info" },
              { label: "Version deployed", value: `v${failedDep.version}`, status: "info" },
              ...(failedDep.failureReason
                ? [{ label: "Failure reason", value: failedDep.failureReason, status: "warning" as const }]
                : [{ label: "Failure reason", value: "Unknown — check debrief for trace", status: "warning" as const }]),
              ...(prevSuccessful.length > 0
                ? [{ label: "Last successful deploy", value: `${timeAgo(prevSuccessful[0].createdAt)} (${artifactName} v${prevSuccessful[0].version})`, status: "info" as const }]
                : [{ label: "Prior deployments", value: "None to this environment", status: "info" as const }]),
            ],
            recommendations: [
              {
                action: "Review the deployment debrief",
                detail: `Open the deployment detail for ${artifactName} v${failedDep.version} to review the full execution trace, including which step failed and what the envoy logged.`,
                priority: "high",
              },
              {
                action: "Check the target environment",
                detail: `Verify that the ${envName} environment is reachable and that its envoy is healthy before attempting a retry.`,
                priority: "medium",
              },
              {
                action: "Fix root cause before retrying",
                detail: hasReason
                  ? `Address the reported failure reason before deploying again. Retrying without fixing the root cause will likely produce the same result.`
                  : "Identify the root cause from the debrief logs before retrying. Blind retries rarely succeed and may leave the environment in an inconsistent state.",
                priority: "high",
              },
            ],
            timeline: [
              { time: fmtTime(failedDep.createdAt), event: `Deployment started: ${artifactName} v${failedDep.version} → ${envName}` },
              { time: fmtTime(failedDep.createdAt), event: failedDep.failureReason ? `Deployment failed: ${failedDep.failureReason}` : "Deployment failed" },
              { time: nowTime(), event: "Signal raised — no successful retry detected" },
            ],
            relatedDeployments: [
              {
                artifact: artifactName,
                version: failedDep.version,
                target: envName,
                status: "failed",
                time: timeAgo(failedDep.createdAt),
              },
              ...prevSuccessful.map((d) => ({
                artifact: artifactName,
                version: d.version,
                target: envName,
                status: d.status,
                time: timeAgo(d.createdAt),
              })),
            ],
          },
        });
      }
    }

    // 3. Configuration drift signals
    for (const partition of allPartitions) {
      for (const env of allEnvironments) {
        const conflicts = detectDrift(partition, env);
        if (conflicts.length > 0) {
          const n = conflicts.length;
          const recentToEnv = allDeployments
            .filter((d) => d.environmentId === env.id)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 2);

          signals.push({
            type: "drift",
            severity: "warning",
            title: `Config drift: ${partition.name} / ${env.name}`,
            detail: `${n} variable${n > 1 ? "s" : ""} may conflict: ${conflicts.join(", ")}`,
            relatedEntity: { type: "environment", id: env.id, name: env.name },
            investigation: {
              title: "Configuration Drift Detected",
              entity: `${partition.name} / ${env.name}`,
              entityType: "partition",
              status: "active",
              detectedAt: nowIso(),
              synthAssessment: {
                confidence: 0.9,
                summary: `${n} variable${n > 1 ? "s" : ""} in partition "${partition.name}" contain${n === 1 ? "s" : ""} values that don't match the expected pattern for the "${env.name}" environment. This was detected through environment-pattern analysis — the values reference identifiers (like hostnames or URLs) that suggest a different tier. This could cause runtime failures if deployed as-is.`,
              },
              evidence: [
                { label: "Partition", value: `${partition.name} · ${Object.keys(partition.variables).length} variables defined`, status: "info" },
                { label: "Environment", value: `${env.name} · ${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""} detected`, status: "info" },
                ...conflicts.map((key) => ({
                  label: `Variable: ${key}`,
                  value: `"${String(partition.variables[key] ?? "(empty)")}" — conflicts with ${env.name} tier`,
                  status: "warning" as const,
                })),
              ],
              recommendations: [
                {
                  action: "Review the drifted variables",
                  detail: `Open the partition detail for "${partition.name}" and inspect: ${conflicts.join(", ")}. Confirm whether they contain the correct values for the "${env.name}" environment.`,
                  priority: "high",
                },
                {
                  action: "Update partition variables",
                  detail: `If the values reference the wrong environment tier, correct them in the partition before the next deployment. The next deploy will apply the corrected values.`,
                  priority: "medium",
                },
                {
                  action: "Redeploy after correction",
                  detail: "Once variables are corrected, trigger a fresh deployment to apply them. The previous deployment used the drifted values.",
                  priority: "low",
                },
              ],
              timeline: [
                { time: nowTime(), event: `Routine config scan detected ${n} variable${n > 1 ? "s" : ""} with environment mismatch` },
                { time: nowTime(), event: "Signal raised" },
              ],
              relatedDeployments: recentToEnv.map((d) => {
                const artName = allArtifacts.find((a) => a.id === d.artifactId)?.name ?? d.artifactId.slice(0, 8);
                return {
                  artifact: artName,
                  version: d.version,
                  target: env.name,
                  status: d.status,
                  time: timeAgo(d.createdAt),
                };
              }),
            },
          });
        }
      }
    }

    const state = signals.length > 0 ? "alert" : "normal";

    // Derive editorial assessment
    let headline: string;
    let detail: string;

    const critical = signals.filter((s) => s.severity === "critical");
    const warnings = signals.filter((s) => s.severity === "warning");

    if (critical.length > 0) {
      headline = critical.length === 1 ? "One thing before you deploy." : `${critical.length} issues need your attention.`;
      detail = critical[0].detail;
    } else if (warnings.length > 0) {
      headline = warnings.length === 1 ? "One thing to keep in mind." : `${warnings.length} signals worth reviewing.`;
      detail = warnings[0].detail;
    } else if (activeDeployments.length > 0) {
      const d = activeDeployments[0];
      const artName = allArtifacts.find((a) => a.id === d.artifactId)?.name ?? "A deployment";
      const envName = allEnvironments.find((e) => e.id === d.environmentId)?.name ?? "target";
      headline = "Deployment in progress.";
      detail = `${artName} is being deployed to ${envName}. All other environments are stable.`;
    } else {
      const totalDeps = allDeployments.length;
      headline = "Looking good. Systems are clear.";
      detail = totalDeps > 0
        ? `No active alerts. ${stats.deployments.failed24h === 0 ? "All recent deployments succeeded." : `${stats.deployments.failed24h} failure${stats.deployments.failed24h > 1 ? "s" : ""} in the last 24h.`}`
        : "No active alerts. Ready for your first deployment.";
    }

    return {
      state,
      signals,
      stats,
      assessment: { headline, detail },
    } satisfies SystemStateResponse;
  });
}
