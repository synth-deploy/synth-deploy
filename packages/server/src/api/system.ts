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

export interface AlertSignal {
  type: "envoy-health" | "deployment-failure" | "drift";
  severity: "warning" | "critical";
  title: string;
  detail: string;
  relatedEntity?: { type: string; id: string; name: string };
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

    // 1. Envoy health: check for degraded/unreachable envoys
    for (const envoy of allEnvoys) {
      if (envoy.lastHealthStatus === "degraded") {
        signals.push({
          type: "envoy-health",
          severity: "warning",
          title: `Envoy "${envoy.name}" is degraded`,
          detail: `Health check returned degraded status. Last checked: ${envoy.lastHealthCheck ?? "never"}.`,
          relatedEntity: { type: "envoy", id: envoy.id, name: envoy.name },
        });
      } else if (envoy.lastHealthStatus === "unreachable") {
        signals.push({
          type: "envoy-health",
          severity: "critical",
          title: `Envoy "${envoy.name}" is unreachable`,
          detail: `Cannot reach envoy at ${envoy.url}. Last checked: ${envoy.lastHealthCheck ?? "never"}.`,
          relatedEntity: { type: "envoy", id: envoy.id, name: envoy.name },
        });
      }
    }

    // 2. Deployment failures in last 24h without subsequent success to same target
    for (const failedDep of failed24h) {
      const hasSubsequentSuccess = allDeployments.some(
        (d) =>
          d.artifactId === failedDep.artifactId &&
          d.environmentId === failedDep.environmentId &&
          d.status === "succeeded" &&
          new Date(d.createdAt).getTime() >
            new Date(failedDep.createdAt).getTime(),
      );

      if (!hasSubsequentSuccess) {
        const envName =
          allEnvironments.find((e) => e.id === failedDep.environmentId)
            ?.name ?? "unknown";
        const artifactName =
          allArtifacts.find((a) => a.id === failedDep.artifactId)?.name ??
          "unknown";

        signals.push({
          type: "deployment-failure",
          severity: "critical",
          title: `Failed deployment: ${artifactName} v${failedDep.version}`,
          detail: `Deployment to ${envName} failed${failedDep.failureReason ? `: ${failedDep.failureReason}` : ""} — no successful retry yet.`,
          relatedEntity: {
            type: "deployment",
            id: failedDep.id,
            name: `${artifactName} v${failedDep.version}`,
          },
        });
      }
    }

    // 3. Configuration drift signals
    for (const partition of allPartitions) {
      for (const env of allEnvironments) {
        const conflicts = detectDrift(partition, env);
        if (conflicts.length > 0) {
          signals.push({
            type: "drift",
            severity: "warning",
            title: `Config drift: ${partition.name} / ${env.name}`,
            detail: `${conflicts.length} variable${conflicts.length > 1 ? "s" : ""} may conflict: ${conflicts.join(", ")}`,
            relatedEntity: {
              type: "environment",
              id: env.id,
              name: env.name,
            },
          });
        }
      }
    }

    const state = signals.length > 0 ? "alert" : "normal";

    // Derive editorial assessment from signals and context
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
