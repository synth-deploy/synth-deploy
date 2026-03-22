import type { FastifyInstance } from "fastify";
import type { IPartitionStore, IEnvironmentStore, IArtifactStore, ISettingsStore, ITelemetryStore, DebriefWriter, DebriefReader, Partition, Environment, OperationInput } from "@synth-deploy/core";
import type { LlmClient } from "@synth-deploy/core";
import type { SynthAgent, DeploymentStore } from "../agent/synth-agent.js";

const getArtifactId = (op: { input: OperationInput }): string =>
  op.input.type === "deploy" ? op.input.artifactId : "";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";
import type { ArtifactAnalyzer } from "../artifact-analyzer.js";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContextSignal {
  type: "trend" | "health" | "drift";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  relatedEntity?: { type: string; id: string; name: string };
}

interface DeploymentContext {
  signals: ContextSignal[];
  recentActivity: {
    deploymentsLast24h: number;
    successRate: string;
    lastDeployment: { version: string; environment: string; status: string; ago: string } | null;
  };
  environmentSummary: Array<{
    id: string;
    name: string;
    lastDeployStatus: string | null;
    deployCount: number;
    variableCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Context generation — signals from deployment data
// ---------------------------------------------------------------------------

function generateContext(
  deployments: DeploymentStore,
  environmentStore: IEnvironmentStore,
  partitionStore: IPartitionStore,
): DeploymentContext {
  const allDeployments = deployments.list();
  const allEnvironments = environmentStore.list();

  const signals: ContextSignal[] = [];

  // --- Deployment trends ---
  const now = Date.now();
  const last24h = allDeployments.filter(
    (d) => now - new Date(d.createdAt).getTime() < 24 * 60 * 60 * 1000,
  );
  const recentFailed = last24h.filter((d) => d.status === "failed");

  if (recentFailed.length > 0) {
    const rate = Math.round((recentFailed.length / Math.max(last24h.length, 1)) * 100);
    signals.push({
      type: "trend",
      severity: rate > 50 ? "critical" : "warning",
      title: `${recentFailed.length} failed deployment${recentFailed.length > 1 ? "s" : ""} in last 24h`,
      detail: `${rate}% failure rate across ${last24h.length} recent deployments`,
    });
  }

  if (last24h.length === 0 && allDeployments.length > 0) {
    signals.push({
      type: "trend",
      severity: "info",
      title: "No deployments in last 24 hours",
      detail: `Last deployment was ${allDeployments.length > 0 ? formatAgo(new Date(allDeployments[allDeployments.length - 1].createdAt)) : "never"}`,
    });
  }

  // --- Environment health signals ---
  for (const env of allEnvironments) {
    const envDeployments = allDeployments
      .filter((d) => d.environmentId === env.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (envDeployments.length > 0 && envDeployments[0].status === "failed") {
      signals.push({
        type: "health",
        severity: "warning",
        title: `Last deployment to ${env.name} failed`,
        detail: envDeployments[0].failureReason ?? "Unknown failure",
        relatedEntity: { type: "environment", id: env.id, name: env.name },
      });
    }

    // Consecutive failures
    const consecutiveFails = envDeployments.filter((d, i) => {
      if (i > 2) return false;
      return d.status === "failed";
    }).length;

    if (consecutiveFails >= 2) {
      signals.push({
        type: "health",
        severity: "critical",
        title: `${env.name}: ${consecutiveFails} consecutive failures`,
        detail: `Environment may have an infrastructure issue. Last ${consecutiveFails} deployments all failed.`,
        relatedEntity: { type: "environment", id: env.id, name: env.name },
      });
    }
  }

  // --- Configuration drift warnings ---
  const partitions = partitionStore.list();
  for (const partition of partitions) {
    for (const env of allEnvironments) {
      const conflicts = detectDrift(partition, env);
      if (conflicts.length > 0) {
        signals.push({
          type: "drift",
          severity: "warning",
          title: `Config drift: ${partition.name} / ${env.name}`,
          detail: `${conflicts.length} variable${conflicts.length > 1 ? "s" : ""} may conflict: ${conflicts.join(", ")}`,
          relatedEntity: { type: "partition", id: partition.id, name: partition.name },
        });
      }
    }
  }

  // --- Recent activity summary ---
  const sorted = [...allDeployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const lastDeploy = sorted[0];
  const succeeded = allDeployments.filter((d) => d.status === "succeeded").length;

  const environmentSummary = allEnvironments.map((env) => {
    const envDeploys = allDeployments.filter((d) => d.environmentId === env.id);
    const lastEnvDeploy = envDeploys.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];

    return {
      id: env.id,
      name: env.name,
      lastDeployStatus: lastEnvDeploy?.status ?? null,
      deployCount: envDeploys.length,
      variableCount: Object.keys(env.variables).length,
    };
  });

  return {
    signals,
    recentActivity: {
      deploymentsLast24h: last24h.length,
      successRate: allDeployments.length > 0
        ? `${Math.round((succeeded / allDeployments.length) * 100)}%`
        : "—",
      lastDeployment: lastDeploy
        ? {
            version: lastDeploy.version ?? "",
            environment: allEnvironments.find((e) => e.id === lastDeploy.environmentId)?.name ?? lastDeploy.environmentId ?? "—",
            status: lastDeploy.status,
            ago: formatAgo(new Date(lastDeploy.createdAt)),
          }
        : null,
    },
    environmentSummary,
  };
}

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

function formatAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAgentRoutes(
  app: FastifyInstance,
  agent: SynthAgent,
  partitions: IPartitionStore,
  environments: IEnvironmentStore,
  artifacts: IArtifactStore,
  deployments: DeploymentStore,
  debrief: DebriefWriter & DebriefReader,
  settings: ISettingsStore,
  llm?: LlmClient,
  envoyRegistry?: EnvoyRegistry,
  telemetry?: ITelemetryStore,
  analyzer?: ArtifactAnalyzer,
): void {
  /**
   * Get deployment context — signals, trends, health, drift.
   * Fills the space where manual action buttons collapse.
   */
  app.get("/api/agent/context", { preHandler: [requirePermission("deployment.view")] }, async () => {
    return generateContext(deployments, environments, partitions);
  });

  // -------------------------------------------------------------------------
  // Pre-flight context — deterministic data + LLM editorialization
  // -------------------------------------------------------------------------

  const PreFlightRequestSchema = z.object({
    artifactId: z.string().min(1),
    environmentId: z.string().min(1),
    partitionId: z.string().optional(),
    version: z.string().optional(),
  });

  app.post("/api/agent/pre-flight", { preHandler: [requirePermission("deployment.view")] }, async (request, reply) => {
    const parsed = PreFlightRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const { artifactId, environmentId, partitionId, version } = parsed.data;

    // --- 1. Target health: check envoy health for the environment ---
    let targetHealth: PreFlightContext["targetHealth"] = {
      status: "healthy",
      details: "No envoys registered — health check not applicable",
    };

    if (envoyRegistry) {
      const envName = environments.get(environmentId)?.name ?? environmentId;
      const envoy = envoyRegistry.findForEnvironment(envName);
      if (envoy) {
        const healthStatus = envoy.lastHealthStatus;
        if (healthStatus === "healthy") {
          targetHealth = { status: "healthy", details: `Envoy "${envoy.name}" is healthy` };
        } else if (healthStatus === "degraded") {
          targetHealth = { status: "degraded", details: `Envoy "${envoy.name}" is degraded` };
        } else if (healthStatus === "unreachable") {
          targetHealth = { status: "unreachable", details: `Envoy "${envoy.name}" is unreachable` };
        } else {
          targetHealth = { status: "healthy", details: `Envoy "${envoy.name}" registered, health not yet checked` };
        }
      }
    }

    // --- 2. Recent history ---
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const latestToEnv = deployments.findLatestByEnvironment(environmentId);
    const deploymentsToday = deployments.countByEnvironment(environmentId, twentyFourHoursAgo);
    const recentArtifactDeploys = deployments.findRecentByArtifact(artifactId, sevenDaysAgo);
    const recentFailures = recentArtifactDeploys.filter((d) => d.status === "failed").length;

    const recentHistory: PreFlightContext["recentHistory"] = {
      lastDeployment: latestToEnv
        ? {
            status: latestToEnv.status,
            completedAt: (latestToEnv.completedAt ?? latestToEnv.createdAt).toISOString(),
            version: latestToEnv.version ?? "",
          }
        : undefined,
      recentFailures,
      deploymentsToday,
    };

    // --- 3. Cross-system context queries ---
    const crossSystemContext: string[] = [];

    // Check if this version was rolled back anywhere
    if (version) {
      const rolledBack = deployments.findByArtifactVersion(artifactId, version, "rolled_back");
      if (rolledBack.length > 0) {
        const envNames = rolledBack.map((d) => environments.get(d.environmentId ?? "")?.name ?? d.environmentId ?? "unknown");
        crossSystemContext.push(
          `This version (${version}) was rolled back from ${envNames.join(", ")} previously`,
        );
      }

      const failed = deployments.findByArtifactVersion(artifactId, version, "failed");
      if (failed.length > 0) {
        const envNames = failed.map((d) => environments.get(d.environmentId ?? "")?.name ?? d.environmentId ?? "unknown");
        crossSystemContext.push(
          `This version (${version}) failed deployment to ${envNames.join(", ")}`,
        );
      }
    }

    // Check recent failure patterns for this artifact
    if (recentFailures > 2) {
      crossSystemContext.push(
        `${recentFailures} failed deployments for this artifact in the last 7 days — investigate before proceeding`,
      );
    }

    // Check if the last deployment to this environment failed
    if (latestToEnv && latestToEnv.status === "failed") {
      crossSystemContext.push(
        `The last deployment to this environment failed (${latestToEnv.failureReason ?? "unknown reason"})`,
      );
    }

    // Check deployment volume
    if (deploymentsToday >= 5) {
      crossSystemContext.push(
        `High deployment volume: ${deploymentsToday} deployments to this environment in the last 24 hours`,
      );
    }

    // --- 4. LLM recommendation ---
    let recommendation: PreFlightContext["recommendation"] = {
      action: "proceed",
      reasoning: "Agent recommendation unavailable — review the context above and decide.",
      confidence: 0,
    };
    let llmAvailable = false;

    if (llm && llm.isAvailable()) {
      const artifactName = artifacts.get(artifactId)?.name ?? artifactId;
      const envName = environments.get(environmentId)?.name ?? environmentId;
      const partitionName = partitionId ? (partitions.get(partitionId)?.name ?? partitionId) : null;

      const promptParts = [
        `You are an intelligent deployment advisor. Analyze the following pre-flight context and provide a directional recommendation.`,
        `\nArtifact: ${artifactName}`,
        `Target environment: ${envName}`,
        partitionName ? `Partition: ${partitionName}` : null,
        version ? `Version: ${version}` : null,
        `\nTarget health: ${targetHealth.status} — ${targetHealth.details}`,
        `\nRecent history:`,
        `  Deployments to this environment in last 24h: ${deploymentsToday}`,
        `  Recent failures for this artifact (7d): ${recentFailures}`,
        latestToEnv
          ? `  Last deployment to this env: ${latestToEnv.status} (${latestToEnv.version}, ${formatAgo(latestToEnv.completedAt ?? latestToEnv.createdAt)})`
          : `  No previous deployments to this environment`,
        crossSystemContext.length > 0
          ? `\nCross-system observations:\n${crossSystemContext.map((c) => `  - ${c}`).join("\n")}`
          : `\nNo cross-system concerns detected.`,
      ].filter(Boolean);

      const systemPrompt = `You are a deployment advisor for Synth. Given pre-flight context, you MUST respond with ONLY a JSON object (no markdown, no explanation) with this schema:
{
  "action": "proceed" | "wait" | "investigate",
  "reasoning": "<1-2 sentences, directional — 'I recommend proceeding' / 'I'd wait' / 'Investigate first' style>",
  "confidence": <0-1 number>
}

Be directional: say what you recommend, not "here are some data points." Use first person. Be specific.`;

      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Pre-flight LLM timeout (15s)")), 15000),
        );

        const llmResult = await Promise.race([
          llm.classify({
            prompt: promptParts.join("\n"),
            systemPrompt,
            promptSummary: `Pre-flight recommendation for ${artifactName} → ${envName}`,
            partitionId: partitionId ?? null,
            maxTokens: 512,
          }),
          timeout,
        ]);

        if (llmResult.ok) {
          try {
            let text = llmResult.text.trim();
            if (text.startsWith("```")) {
              text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
            }
            const parsed = JSON.parse(text);
            if (parsed.action && parsed.reasoning && typeof parsed.confidence === "number") {
              recommendation = {
                action: parsed.action,
                reasoning: parsed.reasoning,
                confidence: Math.max(0, Math.min(1, parsed.confidence)),
              };
              llmAvailable = true;
            }
          } catch {
            // JSON parse failed — use deterministic fallback
          }
        }
      } catch (llmError) {
        // LLM call failed or timed out — record to debrief and use deterministic fallback
        debrief.record({
          partitionId: partitionId ?? null,
          operationId: null,
          agent: "server",
          decisionType: "pre-flight-llm-failure",
          decision: "Pre-flight LLM recommendation failed",
          reasoning: llmError instanceof Error ? llmError.message : String(llmError),
          context: { artifactId, environmentId, partitionId: partitionId ?? null },
        });
      }
    }

    // --- 5. Deterministic fallback recommendation if LLM was unavailable ---
    if (!llmAvailable) {
      if (targetHealth.status === "unreachable") {
        recommendation = {
          action: "investigate",
          reasoning: "The target envoy is unreachable. Investigate infrastructure health before deploying.",
          confidence: 0,
        };
      } else if (recentFailures > 2 || (latestToEnv && latestToEnv.status === "failed")) {
        recommendation = {
          action: "investigate",
          reasoning: "Recent failures detected. Review the failure history before proceeding.",
          confidence: 0,
        };
      } else if (targetHealth.status === "degraded") {
        recommendation = {
          action: "wait",
          reasoning: "The target envoy is degraded. Consider waiting for it to stabilize.",
          confidence: 0,
        };
      }
    }

    const result: PreFlightContext = {
      targetHealth,
      recentHistory,
      crossSystemContext,
      recommendation,
      llmAvailable,
    };

    // --- 6. Debrief + telemetry ---
    debrief.record({
      partitionId: partitionId ?? null,
      operationId: null,
      agent: "server",
      decisionType: "cross-system-context",
      decision: `Pre-flight context generated: ${recommendation.action} (confidence: ${recommendation.confidence})`,
      reasoning: recommendation.reasoning,
      context: {
        artifactId,
        environmentId,
        partitionId: partitionId ?? null,
        version: version ?? null,
        targetHealth: targetHealth.status,
        recentFailures,
        deploymentsToday,
        crossSystemSignals: crossSystemContext.length,
        llmAvailable,
      },
    });

    if (telemetry) {
      telemetry.record({
        actor: "agent",
        action: "agent.pre-flight.generated",
        target: { type: "deployment", id: `${artifactId}:${environmentId}` },
        details: {
          recommendation: recommendation.action,
          confidence: recommendation.confidence,
          llmAvailable,
        },
      });
    }

    return result;
  });

  // -------------------------------------------------------------------------
  // Pre-flight user response — records what the user did after seeing context
  // -------------------------------------------------------------------------

  const PreFlightResponseSchema = z.object({
    artifactId: z.string().min(1),
    environmentId: z.string().min(1),
    partitionId: z.string().optional(),
    action: z.enum(["proceeded", "waited", "canceled"]),
    recommendedAction: z.enum(["proceed", "wait", "investigate"]),
  });

  app.post("/api/agent/pre-flight/response", { preHandler: [requirePermission("deployment.view")] }, async (request, reply) => {
    const parsed = PreFlightResponseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const { artifactId, environmentId, partitionId, action, recommendedAction } = parsed.data;

    debrief.record({
      partitionId: partitionId ?? null,
      operationId: null,
      agent: "server",
      decisionType: "cross-system-context",
      decision: `User ${action} after pre-flight recommendation to ${recommendedAction}`,
      reasoning: `System recommended "${recommendedAction}", user chose to "${action}".`,
      context: { artifactId, environmentId, partitionId: partitionId ?? null, recommendedAction, userAction: action },
    });

    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Pre-flight context types
// ---------------------------------------------------------------------------

export interface PreFlightContext {
  targetHealth: {
    status: "healthy" | "degraded" | "unreachable";
    details: string;
  };
  recentHistory: {
    lastDeployment?: {
      status: string;
      completedAt: string;
      version: string;
    };
    recentFailures: number;
    deploymentsToday: number;
  };
  crossSystemContext: string[];
  recommendation: {
    action: "proceed" | "wait" | "investigate";
    reasoning: string;
    confidence: number;
  };
  llmAvailable: boolean;
}


