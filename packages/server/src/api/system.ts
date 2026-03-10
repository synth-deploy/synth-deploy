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
  driftConflicts?: Array<{
    variable: string;
    partitionValue: string;
    violatedRule: string;
    affectedEnvoy: string;
  }>;
}

export interface AlertSignal {
  type:
    | "envoy-health"
    | "deployment-failure-pattern"
    | "drift"
    | "new-version-failure-context"
    | "cross-environment-inconsistency"
    | "security-boundary-violation"
    | "dependency-conflict"
    | "stale-deployment"
    | "envoy-knowledge-gap"
    | "scheduled-maintenance-conflict";
  severity: "critical" | "warning" | "info";
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

    // 2. Deployment failure pattern signals — only raised when multiple failures occur to the
    // same artifact+environment without a successful recovery (not on individual failures,
    // which are visible in the deployment list and debrief).
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentFailures = allDeployments.filter(
      (d) => d.status === "failed" && new Date(d.createdAt).getTime() > sevenDaysAgo,
    );

    // Group by artifactId+environmentId
    type FailureGroup = { artifactId: string; environmentId: string | undefined; failures: typeof recentFailures };
    const failureGroups = new Map<string, FailureGroup>();
    for (const dep of recentFailures) {
      const key = `${dep.artifactId}::${dep.environmentId}`;
      if (!failureGroups.has(key)) {
        failureGroups.set(key, { artifactId: dep.artifactId, environmentId: dep.environmentId, failures: [] });
      }
      failureGroups.get(key)!.failures.push(dep);
    }

    for (const group of failureGroups.values()) {
      if (group.failures.length < 2) continue; // Single failure = not a signal

      const hasRecovery = allDeployments.some(
        (d) =>
          d.artifactId === group.artifactId &&
          d.environmentId === group.environmentId &&
          d.status === "succeeded" &&
          new Date(d.createdAt).getTime() > new Date(group.failures[0].createdAt).getTime(),
      );
      if (hasRecovery) continue;

      const envName = allEnvironments.find((e) => e.id === group.environmentId)?.name ?? "unknown";
      const artifactName = allArtifacts.find((a) => a.id === group.artifactId)?.name ?? "unknown";
      const n = group.failures.length;
      const sorted = [...group.failures].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const mostRecent = sorted[0];
      const reasons = [...new Set(sorted.map((d) => d.failureReason).filter(Boolean))];

      const prevSuccessful = allDeployments
        .filter(
          (d) =>
            d.artifactId === group.artifactId &&
            d.environmentId === group.environmentId &&
            d.status === "succeeded",
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 1);

      signals.push({
        type: "deployment-failure-pattern",
        severity: "critical",
        title: `Repeated failure: ${artifactName} → ${envName}`,
        detail: `${n} failures in 7 days with no successful recovery. ${reasons.length > 0 ? `Last reason: ${reasons[0]}` : "No failure reason recorded."}`,
        relatedEntity: { type: "artifact", id: group.artifactId, name: artifactName },
        investigation: {
          title: `Deployment Failure Pattern — ${artifactName} → ${envName}`,
          entity: artifactName,
          entityType: "artifact",
          status: "active",
          detectedAt: nowIso(),
          synthAssessment: {
            confidence: reasons.length > 0 ? 0.88 : 0.65,
            summary: `${artifactName} has failed to deploy to ${envName} ${n} times in the past 7 days without a successful recovery. ${reasons.length > 0 ? `The recurring failure reason is: ${reasons.join("; ")}. ` : ""}This is a pattern, not an isolated incident — retrying without addressing the root cause will likely produce the same result. The environment may be in a degraded state.`,
          },
          evidence: [
            { label: "Failure count", value: `${n} failures in the last 7 days`, status: "warning" },
            { label: "Most recent failure", value: timeAgo(mostRecent.createdAt), status: "warning" },
            { label: "Target environment", value: `${envName} — no successful recovery`, status: "warning" },
            ...(reasons.length > 0
              ? reasons.map((r) => ({ label: "Failure reason", value: r!, status: "warning" as const }))
              : [{ label: "Failure reason", value: "Unknown — check debrief for trace", status: "warning" as const }]),
            ...(prevSuccessful.length > 0
              ? [{ label: "Last success", value: `${timeAgo(prevSuccessful[0].createdAt)} (v${prevSuccessful[0].version})`, status: "info" as const }]
              : [{ label: "Prior successes", value: "No successful deployments on record", status: "info" as const }]),
          ],
          recommendations: [
            {
              action: "Review debriefs for all failed deployments",
              detail: `Each failed deployment has a debrief with the full execution trace. Compare them to identify whether the failure mode is consistent or varying.`,
              priority: "high",
            },
            {
              action: "Check environment health before retrying",
              detail: `Verify that the ${envName} environment is in a known good state. Repeated failures may have left partial state that will block future deployments.`,
              priority: "high",
            },
            {
              action: "Address root cause before next attempt",
              detail: reasons.length > 0
                ? `The failure reason "${reasons[0]}" has recurred. Fix it at the source before scheduling another deployment.`
                : "Identify the root cause from the debrief logs. Blind retries on a recurring failure pattern waste time and may worsen environment state.",
              priority: "medium",
            },
          ],
          timeline: [
            ...sorted.slice().reverse().map((d) => ({ time: fmtTime(d.createdAt), event: `Deployment failed: ${artifactName} v${d.version}${d.failureReason ? ` — ${d.failureReason}` : ""}` })),
            { time: nowTime(), event: `Signal raised — ${n} failures, no recovery` },
          ],
          relatedDeployments: sorted.map((d) => ({
            artifact: artifactName,
            version: d.version,
            target: envName,
            status: d.status,
            time: timeAgo(d.createdAt),
          })),
        },
      });
    }

    // 4. Stale deployment signals — artifact has been running significantly longer than
    // its average deployment lifecycle with newer versions deployed elsewhere.
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const succeededDeps = allDeployments.filter((d) => d.status === "succeeded");

    // Group succeeded deployments by artifactId+environmentId to find "currently running"
    type EnvLatest = { dep: (typeof succeededDeps)[0]; envName: string };
    const latestByTarget = new Map<string, EnvLatest>();
    for (const dep of succeededDeps) {
      const key = `${dep.artifactId}::${dep.environmentId}`;
      const existing = latestByTarget.get(key);
      if (!existing || new Date(dep.createdAt) > new Date(existing.dep.createdAt)) {
        const envName = allEnvironments.find((e) => e.id === dep.environmentId)?.name ?? "unknown";
        latestByTarget.set(key, { dep, envName });
      }
    }

    for (const { dep, envName } of latestByTarget.values()) {
      if (new Date(dep.createdAt).getTime() > thirtyDaysAgo) continue; // Not stale yet

      const artifactName = allArtifacts.find((a) => a.id === dep.artifactId)?.name ?? "unknown";
      const weeksAgo = Math.floor((now - new Date(dep.createdAt).getTime()) / (7 * 24 * 60 * 60 * 1000));

      // Check if newer versions of this artifact have been deployed to any other environment
      const newerElsewhere = succeededDeps.filter(
        (d) =>
          d.artifactId === dep.artifactId &&
          d.environmentId !== dep.environmentId &&
          new Date(d.createdAt).getTime() > new Date(dep.createdAt).getTime(),
      );
      if (newerElsewhere.length === 0) continue; // No newer deployments anywhere — not actionable

      const newerVersions = [...new Set(newerElsewhere.map((d) => d.version))];

      signals.push({
        type: "stale-deployment",
        severity: "info",
        title: `Stale deployment: ${artifactName} in ${envName}`,
        detail: `v${dep.version} deployed ${weeksAgo}w ago. ${newerVersions.length} newer version${newerVersions.length > 1 ? "s" : ""} running elsewhere. May be intentional.`,
        relatedEntity: { type: "artifact", id: dep.artifactId, name: artifactName },
        investigation: {
          title: `Stale Deployment — ${artifactName} in ${envName}`,
          entity: `${artifactName} in ${envName}`,
          entityType: "artifact",
          status: "active",
          detectedAt: nowIso(),
          synthAssessment: {
            confidence: 0.72,
            summary: `${artifactName} v${dep.version} has been running in ${envName} for ${weeksAgo} weeks without an update. ${newerVersions.length} newer version${newerVersions.length > 1 ? "s have" : " has"} been deployed to other environments: ${newerVersions.join(", ")}. This may be intentional for stable workloads, or it may indicate a missed promotion. Synth is not recommending action — only confirming you're aware.`,
          },
          evidence: [
            { label: "Running version", value: `v${dep.version} — deployed ${weeksAgo}w ago`, status: "info" },
            { label: "Environment", value: envName, status: "info" },
            { label: "Newer versions elsewhere", value: newerVersions.join(", "), status: "info" },
            { label: "Last deployment", value: timeAgo(dep.createdAt), status: "info" },
          ],
          recommendations: [
            {
              action: "Confirm this is intentional",
              detail: `If ${artifactName} in ${envName} is a stable workload that intentionally lags behind, no action needed. If newer versions should have been promoted, schedule a deployment.`,
              priority: "low",
            },
            {
              action: "Review changes in newer versions",
              detail: `Check what changed between v${dep.version} and ${newerVersions[newerVersions.length - 1]} before promoting to ${envName}.`,
              priority: "low",
            },
          ],
          timeline: [
            { time: fmtTime(dep.createdAt), event: `${artifactName} v${dep.version} deployed to ${envName}` },
            { time: nowTime(), event: `Signal raised — ${weeksAgo}w without update, newer versions exist` },
          ],
          relatedDeployments: [
            { artifact: artifactName, version: dep.version, target: envName, status: "succeeded", time: timeAgo(dep.createdAt) },
            ...newerElsewhere.slice(0, 3).map((d) => {
              const env = allEnvironments.find((e) => e.id === d.environmentId)?.name ?? "unknown";
              return { artifact: artifactName, version: d.version, target: env, status: d.status, time: timeAgo(d.createdAt) };
            }),
          ],
        },
      });
    }

    // 5. Cross-environment inconsistency — same artifact running across environments in a
    // pattern that suggests a missed or skipped promotion.
    const artifactEnvVersions = new Map<string, Map<string, { version: string; deployedAt: Date }>>();
    for (const { dep, envName } of latestByTarget.values()) {
      if (!artifactEnvVersions.has(dep.artifactId)) {
        artifactEnvVersions.set(dep.artifactId, new Map());
      }
      artifactEnvVersions.get(dep.artifactId)!.set(envName, {
        version: dep.version,
        deployedAt: new Date(dep.createdAt),
      });
    }

    for (const [artifactId, envMap] of artifactEnvVersions.entries()) {
      if (envMap.size < 2) continue; // Only relevant with 2+ environments

      const entries = [...envMap.entries()];
      const artifactName = allArtifacts.find((a) => a.id === artifactId)?.name ?? "unknown";

      // Find the most-recently-updated environment (the "ahead" env)
      const sorted = entries.sort((a, b) => b[1].deployedAt.getTime() - a[1].deployedAt.getTime());
      const [aheadEnv, aheadData] = sorted[0];
      const [behindEnv, behindData] = sorted[sorted.length - 1];

      if (aheadData.version === behindData.version) continue; // Same version everywhere — OK

      // Only flag if the behind environment hasn't been updated in 14+ days while the ahead env has newer
      const daysBehind = Math.floor((aheadData.deployedAt.getTime() - behindData.deployedAt.getTime()) / (24 * 60 * 60 * 1000));
      if (daysBehind < 14) continue;

      // Also require that the ahead env has more recent deployments of this artifact (not just same artifact)
      const aheadHasMultiple = succeededDeps.filter(
        (d) => d.artifactId === artifactId &&
          allEnvironments.find((e) => e.id === d.environmentId)?.name === aheadEnv,
      ).length >= 2;
      if (!aheadHasMultiple) continue;

      signals.push({
        type: "cross-environment-inconsistency",
        severity: "warning",
        title: `Version gap: ${artifactName} (${behindEnv} vs ${aheadEnv})`,
        detail: `${behindEnv} is on v${behindData.version}, ${aheadEnv} has v${aheadData.version} (${daysBehind}d ahead). Promotion may have been missed.`,
        relatedEntity: { type: "artifact", id: artifactId, name: artifactName },
        investigation: {
          title: `Cross-Environment Version Gap — ${artifactName}`,
          entity: artifactName,
          entityType: "artifact",
          status: "active",
          detectedAt: nowIso(),
          synthAssessment: {
            confidence: 0.76,
            summary: `${artifactName} is running different versions across environments in a pattern that may indicate a missed promotion. ${aheadEnv} has v${aheadData.version} (updated ${timeAgo(aheadData.deployedAt)}), while ${behindEnv} is still on v${behindData.version} (updated ${timeAgo(behindData.deployedAt)}, ${daysBehind} days behind). Normal staging-to-production lag is expected, but a ${daysBehind}-day gap with active updates in ${aheadEnv} suggests the ${behindEnv} promotion may have been overlooked.`,
          },
          evidence: [
            { label: `${aheadEnv} version`, value: `v${aheadData.version} — updated ${timeAgo(aheadData.deployedAt)}`, status: "healthy" },
            { label: `${behindEnv} version`, value: `v${behindData.version} — updated ${timeAgo(behindData.deployedAt)}`, status: "warning" },
            { label: "Version gap", value: `${daysBehind} days between last promotions`, status: "warning" },
            ...entries.slice(2).map(([env, data]) => ({
              label: `${env} version`,
              value: `v${data.version} — updated ${timeAgo(data.deployedAt)}`,
              status: "info" as const,
            })),
          ],
          recommendations: [
            {
              action: `Review changes before promoting to ${behindEnv}`,
              detail: `Check what changed between v${behindData.version} and v${aheadData.version} before scheduling the promotion. ${daysBehind} days of changes may require careful review.`,
              priority: "medium",
            },
            {
              action: `Promote ${artifactName} to ${behindEnv}`,
              detail: `If the version gap is unintentional, schedule a deployment of ${artifactName} v${aheadData.version} to ${behindEnv}.`,
              priority: "low",
            },
          ],
          timeline: [
            { time: fmtTime(behindData.deployedAt), event: `${artifactName} v${behindData.version} deployed to ${behindEnv}` },
            { time: fmtTime(aheadData.deployedAt), event: `${artifactName} v${aheadData.version} deployed to ${aheadEnv}` },
            { time: nowTime(), event: `Signal raised — ${daysBehind}-day version gap detected` },
          ],
          relatedDeployments: entries.map(([env, data]) => ({
            artifact: artifactName,
            version: data.version,
            target: env,
            status: "succeeded",
            time: timeAgo(data.deployedAt),
          })),
        },
      });
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
              driftConflicts: conflicts.map((key) => {
                const val = String(partition.variables[key] ?? "(empty)");
                const envLower = env.name.toLowerCase();
                const hasProd = /\bprod/i.test(val);
                const hasStag = /\bstag/i.test(val);
                let rule: string;
                if (envLower === "development") {
                  rule = hasProd ? `Must not reference production tier in development` : `Must not reference staging tier in development`;
                } else if (envLower === "staging") {
                  rule = `Must not reference production tier in staging`;
                } else if (envLower === "production") {
                  rule = hasStag ? `Must not reference staging tier in production` : `Must not reference development tier in production`;
                } else {
                  rule = `Value conflicts with expected ${env.name} environment pattern`;
                }
                // Find most recent envoy that executed a deployment to this environment
                const affectedEnvoyName = recentToEnv
                  .map((d) => d.envoyId ? allEnvoys.find((e) => e.id === d.envoyId)?.name : null)
                  .find(Boolean) ?? env.name;
                return {
                  variable: key,
                  partitionValue: val,
                  violatedRule: rule,
                  affectedEnvoy: affectedEnvoyName,
                };
              }),
            },
          });
        }
      }
    }

    const critical = signals.filter((s) => s.severity === "critical");
    const warnings = signals.filter((s) => s.severity === "warning");
    const infos = signals.filter((s) => s.severity === "info");

    const state = (critical.length > 0 || warnings.length > 0) ? "alert" : "normal";

    // Derive editorial assessment
    let headline: string;
    let detail: string;

    if (critical.length > 0) {
      headline = critical.length === 1 ? "One thing before you deploy." : `${critical.length} issues need your attention.`;
      detail = critical[0].detail;
    } else if (warnings.length > 0) {
      headline = warnings.length === 1 ? "One thing to keep in mind." : `${warnings.length} signals worth reviewing.`;
      detail = warnings[0].detail;
    } else if (infos.length > 0) {
      headline = "Systems clear. A few things worth knowing.";
      detail = infos[0].detail;
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
