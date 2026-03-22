import type { FastifyInstance } from "fastify";
import type { IPartitionStore, IEnvironmentStore, IArtifactStore, ISettingsStore, ITelemetryStore, DebriefWriter, DebriefReader, Artifact, Partition, Environment, Deployment, OperationInput } from "@synth-deploy/core";
import type { LlmClient } from "@synth-deploy/core";
import type { SynthAgent, DeploymentStore } from "../agent/synth-agent.js";

const getArtifactId = (op: { input: OperationInput }): string =>
  op.input.type === "deploy" ? op.input.artifactId : "";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";
import type { ArtifactAnalyzer } from "../artifact-analyzer.js";
import { z } from "zod";
import { QueryRequestSchema } from "./schemas.js";
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
// Input sanitization — prevent prompt injection and control character abuse
// ---------------------------------------------------------------------------

/** @internal Exported for testing only */
export function sanitizeUserInput(text: string): string {
  // Strip control characters except newline and tab
  let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  // Truncate to prevent prompt stuffing
  if (sanitized.length > 1000) {
    sanitized = sanitized.slice(0, 1000);
  }
  // Escape angle brackets to prevent XML tag injection
  sanitized = sanitized.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return sanitized;
}

/** @internal Exported for testing only */
export function validateExtractedVersion(version: string): boolean {
  // Accept semver and common pre-release formats
  return /^\d+\.\d+\.\d+(-[a-zA-Z0-9._]+)?$/.test(version);
}

/** @internal Exported for testing only */
export function validateExtractedVariables(vars: Record<string, string>): Record<string, string> {
  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    // Key must be alphanumeric + underscore, value max 500 chars
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && value.length <= 500) {
      validated[key] = value;
    }
  }
  return validated;
}

const MAX_ENTITY_LIST_SIZE = 100;

function appendEntityNames(
  parts: string[],
  label: string,
  entities: { name: string }[],
  includeEntities: boolean,
): void {
  if (!includeEntities) {
    parts.push(`\n${label}: (entity data omitted by configuration)`);
    return;
  }
  parts.push(`\n${label}:`);
  const capped = entities.slice(0, MAX_ENTITY_LIST_SIZE);
  for (const e of capped) {
    parts.push(`  - "${e.name}"`);
  }
  if (entities.length > MAX_ENTITY_LIST_SIZE) {
    parts.push(`  (… and ${entities.length - MAX_ENTITY_LIST_SIZE} more)`);
  }
  if (entities.length === 0) parts.push("  (none configured)");
}

/** Build a case-insensitive name→ID map for a list of entities. */
function buildNameMap(entities: { id: string; name: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entities) {
    const key = e.name.toLowerCase();
    // First match wins — duplicates are inherently ambiguous
    if (!map.has(key)) map.set(key, e.id);
  }
  return map;
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

  /**
   * Canvas query — classifies a natural language query and returns
   * a structured action telling the UI what view to render.
   * Navigation/data intents resolve entities and return view params.
   */
  app.post("/api/agent/query", { preHandler: [requirePermission("deployment.view")] }, async (request, reply) => {
    const parsed = QueryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const query = parsed.data.query.trim();
    const lower = query.toLowerCase();
    const allArtifacts = artifacts.list();
    const allPartitions = partitions.list();
    const allEnvironments = environments.list();
    const artifactMap = new Map(allArtifacts.map((a) => [a.id, a.name]));
    const environmentMap = new Map(allEnvironments.map((e) => [e.id, e.name]));
    const partitionMap = new Map(allPartitions.map((p) => [p.id, p.name]));

    // --- LLM classification (when available) ---
    const queryEntityExposure = settings.get().agent.llmEntityExposure ?? "names";
    if (llm && llm.isAvailable()) {
      const llmAction = await classifyQueryWithLlm(
        llm, query, allArtifacts, allPartitions, allEnvironments,
        deployments, debrief, queryEntityExposure !== "none",
      );
      if (llmAction) {
        // For "annotate" action: save annotation to artifact, trigger re-analysis
        if (llmAction.action === "annotate") {
          const { artifactName, field, correction } = llmAction.params as Record<string, string>;
          const target = allArtifacts.find(
            (a) => a.name.toLowerCase() === (artifactName ?? "").toLowerCase(),
          );
          if (target && correction) {
            artifacts.addAnnotation(target.id, {
              field: field || "summary",
              correction,
              annotatedBy: "channel",
              annotatedAt: new Date(),
            });
            debrief.record({
              partitionId: null,
              operationId: null,
              agent: "server",
              decisionType: "artifact-analysis",
              decision: `User correction recorded for "${target.name}" via channel: ${correction}`,
              reasoning: `Operator typed a natural-language correction into the Synth Channel. Field: ${field || "summary"}.`,
              context: { artifactName: target.name, field: field || "summary", correction, source: "channel" },
            });
            // Trigger async re-analysis with the new annotation
            if (analyzer) {
              const updated = artifacts.get(target.id);
              if (updated) {
                analyzer.reanalyzeWithAnnotations(updated).then((revised) => {
                  if (revised) artifacts.update(target.id, { analysis: revised });
                }).catch(() => {});
              }
            }
            return {
              action: "answer" as const,
              view: "",
              params: {},
              title: "Correction recorded",
              content: `Got it — I've noted that **${target.name}** ${correction}. Re-analyzing now to update my understanding.`,
            };
          }
          // Artifact not found — fall through to answer
        }

        // For "answer" action: fetch real data and generate a markdown response
        if (llmAction.action === "answer") {
          const answered = await answerQueryWithData(
            llm, query, deployments.list(), allArtifacts, allPartitions, allEnvironments,
          );
          if (answered) {
            debrief.record({
              partitionId: null,
              operationId: null,
              agent: "server",
              decisionType: "system",
              decision: `Canvas query answered analytically`,
              reasoning: `LLM classified "${query}" as analytical answer, responded with ${answered.content.length} chars of markdown`,
              context: { query, action: "answer" },
            });
            return answered;
          }
          // Fall through to regex fallback if answer generation failed
        } else {
          debrief.record({
            partitionId: null,
            operationId: null,
            agent: "server",
            decisionType: "system",
            decision: `Canvas query classified as ${llmAction.action}: ${llmAction.view}`,
            reasoning: `LLM classified "${query}" → ${llmAction.action}/${llmAction.view}`,
            context: { query, action: llmAction },
          });
          return llmAction;
        }
      }
    }

    // --- Regex fallback classification ---

    // Artifact correction: "Dockerfile.server is actually for nginx", "api-service is a nodejs app"
    const correctionPatterns = [
      /\b(?:is\s+actually|is\s+really|should\s+be|is\s+a|is\s+an)\b/i,
      /\bcorrect(?:ion)?:/i,
      /\bactually\s+(?:a|an|the)\b/i,
    ];
    if (correctionPatterns.some((p) => p.test(query))) {
      for (const art of allArtifacts) {
        if (query.toLowerCase().includes(art.name.toLowerCase())) {
          artifacts.addAnnotation(art.id, {
            field: "summary",
            correction: query,
            annotatedBy: "channel",
            annotatedAt: new Date(),
          });
          if (analyzer) {
            const updated = artifacts.get(art.id);
            if (updated) {
              analyzer.reanalyzeWithAnnotations(updated).then((revised) => {
                if (revised) artifacts.update(art.id, { analysis: revised });
              }).catch(() => {});
            }
          }
          return {
            action: "answer" as const,
            view: "",
            params: {},
            title: "Correction recorded",
            content: `Got it — I've noted your correction about **${art.name}**. Re-analyzing now.`,
          };
        }
      }
    }

    // Create partition: "create partition Acme Corp" → return create intent for UI confirmation
    const createPartitionMatch = query.match(/\bcreate\s+partition\s+(.+)/i);
    if (createPartitionMatch) {
      const name = createPartitionMatch[1].trim();
      return { action: "create" as const, view: "partition-detail", params: { name }, title: `Create "${name}"` };
    }

    // Create artifact: "create artifact api-service" or "create operation api-service" → return create intent for UI confirmation
    const createArtifactMatch = query.match(/\bcreate\s+(?:artifact|operation)\s+(.+)/i);
    if (createArtifactMatch) {
      const name = createArtifactMatch[1].trim();
      return { action: "create" as const, view: "artifact-list", params: { name }, title: `Create "${name}"` };
    }

    // Show specific partition
    for (const p of allPartitions) {
      const name = p.name.toLowerCase();
      if (lower.includes(name) && (lower.includes("partition") || lower.includes("show"))) {
        return { action: "navigate" as const, view: "partition-detail", params: { id: p.id }, title: p.name };
      }
    }

    // Show specific environment
    for (const e of allEnvironments) {
      const name = e.name.toLowerCase();
      if (lower.includes(name) && (lower.includes("environment") || lower.includes("env"))) {
        return { action: "navigate" as const, view: "environment-detail", params: { id: e.id }, title: e.name };
      }
    }

    // Show specific deployment by ID
    const deployIdMatch = lower.match(/(?:deployment|deploy)\s+([a-f0-9-]{36})/);
    if (deployIdMatch) {
      return { action: "navigate" as const, view: "deployment-detail", params: { id: deployIdMatch[1] }, title: "Deployment" };
    }

    // Failed deployments / what failed → markdown table
    if (/\b(fail|failed|failures|what failed|broken)\b/.test(lower)) {
      const failed = deployments.list().filter((d) => d.status === "failed")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const content = buildDeploymentTable(failed, artifactMap, environmentMap, partitionMap);
      return { action: "answer" as const, view: "", params: {}, title: "Failed Deployments", content };
    }

    // Settings / configuration
    if (/\b(settings|preferences|configure)\b/.test(lower) || (lower.includes("config") && !/\bconfiguration-resolved\b/.test(lower))) {
      return { action: "navigate" as const, view: "settings", params: {}, title: "Settings" };
    }

    // Artifacts list → markdown table
    if (/\b(artifacts|artifact list|operations|operation list|manage artifacts)\b/.test(lower)) {
      const rows = allArtifacts.map((a) => `| ${a.name} | ${a.type} |`).join("\n");
      const content = allArtifacts.length > 0
        ? `| Artifact | Type |\n|----------|------|\n${rows}`
        : "_No artifacts configured._";
      return { action: "answer" as const, view: "", params: {}, title: "Artifacts", content };
    }

    // Debrief / decision diary
    if (/\b(debrief|decision diary|decisions|decision log|decision history)\b/.test(lower)) {
      return { action: "navigate" as const, view: "debrief", params: {}, title: "Debrief" };
    }

    // Deployment history / recent deployments → markdown table
    if (/\b(deployment|history|recent|deployments)\b/.test(lower)) {
      let deps = deployments.list()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      // Scope to a specific artifact if mentioned
      for (const a of allArtifacts) {
        if (lower.includes(a.name.toLowerCase())) {
          deps = deps.filter((d) => getArtifactId(d) === a.id);
          break;
        }
      }
      const content = buildDeploymentTable(deps, artifactMap, environmentMap, partitionMap);
      const title = deps.length < deployments.list().length ? "Deployment History" : "Recent Deployments";
      return { action: "answer" as const, view: "", params: {}, title, content };
    }

    // Signals / drift / health
    if (/\b(signal|signals|drift|health|alert|alerts)\b/.test(lower)) {
      return { action: "navigate" as const, view: "overview", params: { focus: "signals" }, title: "Signals" };
    }

    // Show all partitions
    if (/\b(partitions|all partitions|partition list|manage partitions)\b/.test(lower)) {
      return { action: "navigate" as const, view: "partition-list", params: {}, title: "Partitions" };
    }

    // Fallback: navigate to overview
    return { action: "navigate" as const, view: "overview", params: {}, title: "Overview" };
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

// ---------------------------------------------------------------------------
// Deterministic markdown table builders (used in regex fallback)
// ---------------------------------------------------------------------------

function buildDeploymentTable(
  deps: Deployment[],
  artifactMap: Map<string, string>,
  environmentMap: Map<string, string>,
  partitionMap: Map<string, string>,
): string {
  if (deps.length === 0) return "_No matching deployments found._";
  const rows = deps
    .slice(0, 50)
    .map((d) => {
      const art = artifactMap.get(getArtifactId(d)) ?? getArtifactId(d);
      const env = (d.environmentId ? environmentMap.get(d.environmentId) : undefined) ?? d.environmentId ?? "—";
      const part = d.partitionId ? (partitionMap.get(d.partitionId) ?? d.partitionId) : "—";
      const date = new Date(d.createdAt).toLocaleString();
      // Embed a synth:// deep-link so the UI can navigate to the deployment detail
      const versionLink = `[v${d.version}](synth://deployment-detail?id=${d.id})`;
      return `| ${d.status} | ${art} | ${versionLink} | ${env} | ${part} | ${date} |`;
    })
    .join("\n");
  return [
    "| Status | Artifact | Version | Environment | Partition | Date |",
    "|--------|----------|---------|-------------|-----------|------|",
    rows,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// LLM-powered query classification
// ---------------------------------------------------------------------------

function buildQueryClassificationPrompt(): string {
  return `You are a query classifier for Synth's agent canvas. Given a natural language query from a deployment engineer, classify it into one of these actions:

1. "navigate" — The user wants to drill into a specific named entity (e.g., "show partition Alpha", "open environment staging", "view deployment abc-123"). Only use this when there is a specific entity to navigate to.
2. "create" — The user wants to create a new entity (e.g., "create partition Acme Corp", "create operation api-service")
3. "answer" — Use this for EVERYTHING ELSE: data requests, lists, filters, analysis, comparisons, summaries. Examples: "show me failed deployments", "what failed", "recent deployments", "how many succeeded last week", "give me all deployments for api-service", "compare environments", "summarize activity". The response will be rendered as a formatted markdown table or narrative — NOT a navigation panel.
4. "annotate" — The user is providing a correction or clarification about a specific artifact. Examples: "Dockerfile.server is actually for nginx", "that artifact is a Node.js app not a docker image", "the api-service type should be nodejs", "correct: Dockerfile.envoy is the load balancer". Use this when the user is teaching Synth something about an artifact.

Return a JSON object with this exact schema:
{
  "action": "navigate" | "create" | "answer" | "annotate",
  "view": "<view-name or empty string for answer/create/annotate>",
  "params": { ... },
  "title": "<human-readable title, e.g. 'Failed Deployments' or 'Deployment History'>"
}

View names (for navigate only):
- "partition-detail" — show specific partition (params: { "id": "<partition-name>" })
- "environment-detail" — show specific environment (params: { "id": "<environment-name>" })
- "deployment-detail" — show specific deployment (params: { "id": "<deployment-id>" })
- "overview" — show the operational overview (params: {})
- "settings" — show application settings (params: {})

For "annotate" actions, set view to "" and params to:
{ "artifactName": "<exact artifact name from the known artifacts list>", "field": "summary|type|deploymentIntent", "correction": "<the user's correction in their own words>" }

Rules:
- ONLY use entity names from the provided lists. Never invent names.
- If the query is a data/list/filter request, ALWAYS use "answer" — never "navigate".
- If the query is ambiguous between navigation and data, prefer "answer".
- For "create" actions, include the entity name in params: { "name": "..." }.
- For "answer" and "create" actions, set view to "" and params to {}.
- For "annotate", artifactName MUST match an artifact from the known list exactly.
- Return ONLY valid JSON, no markdown, no explanation.`;
}

async function classifyQueryWithLlm(
  llm: LlmClient,
  query: string,
  allArtifacts: Artifact[],
  allPartitions: Partition[],
  allEnvironments: Environment[],
  deploymentStore: DeploymentStore,
  _debrief: DebriefReader,
  includeEntities: boolean,
): Promise<{ action: string; view: string; params: Record<string, string>; title?: string } | null> {
  const parts: string[] = [`<user-query>${sanitizeUserInput(query)}</user-query>`];

  appendEntityNames(parts, "Known partitions", allPartitions, includeEntities);
  appendEntityNames(parts, "Known environments", allEnvironments, includeEntities);
  appendEntityNames(parts, "Known artifacts", allArtifacts, includeEntities);

  const llmResult = await llm.classify({
    prompt: parts.join("\n"),
    systemPrompt: buildQueryClassificationPrompt(),
    promptSummary: `Canvas query classification: "${query}"`,
    partitionId: null,
    maxTokens: 512,
  });

  if (!llmResult.ok) return null;

  try {
    let text = llmResult.text.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(text);
    if (!parsed.action || !parsed.view) return null;

    // Build name→ID maps for local resolution
    const partitionNameMap = buildNameMap(allPartitions);
    const environmentNameMap = buildNameMap(allEnvironments);

    // The LLM now returns names in params — resolve to IDs locally
    if (parsed.params?.id) {
      const idLower = parsed.params.id.toLowerCase();
      if (parsed.view === "partition-detail") {
        const resolvedId = partitionNameMap.get(idLower);
        if (!resolvedId) return null;
        parsed.params.id = resolvedId;
      } else if (parsed.view === "environment-detail") {
        const resolvedId = environmentNameMap.get(idLower);
        if (!resolvedId) return null;
        parsed.params.id = resolvedId;
      }
    }
    if (parsed.params?.partitionId) {
      const resolvedId = partitionNameMap.get(parsed.params.partitionId.toLowerCase());
      if (!resolvedId) {
        delete parsed.params.partitionId;
      } else {
        parsed.params.partitionId = resolvedId;
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM-powered analytical answer with real DB data
// ---------------------------------------------------------------------------

async function answerQueryWithData(
  llm: LlmClient,
  query: string,
  allDeployments: Deployment[],
  allArtifacts: Artifact[],
  allPartitions: Partition[],
  allEnvironments: Environment[],
): Promise<{ action: "answer"; view: string; params: Record<string, string>; title: string; content: string } | null> {
  const now = Date.now();

  // Build a concise data context from real records (last 50 deployments)
  const recentDeployments = [...allDeployments]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);

  const artifactMap = new Map(allArtifacts.map((a) => [a.id, a.name]));
  const environmentMap = new Map(allEnvironments.map((e) => [e.id, e.name]));
  const partitionMap = new Map(allPartitions.map((p) => [p.id, p.name]));

  const deploymentRows = recentDeployments.map((d) => {
    const ageMs = now - new Date(d.createdAt).getTime();
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    const age = ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`;
    const art = artifactMap.get(getArtifactId(d)) ?? getArtifactId(d);
    const env = (d.environmentId ? environmentMap.get(d.environmentId) : undefined) ?? d.environmentId ?? "—";
    const part = d.partitionId ? ` (${partitionMap.get(d.partitionId) ?? d.partitionId})` : "";
    // Include synth:// deep-link for UI navigation
    return `- id:${d.id} | ${art} v${d.version} → ${env}${part}: ${d.status} (${age})`;
  }).join("\n");

  const artifactRows = allArtifacts.map((a) => `- ${a.name} (${a.type})`).join("\n");
  const partitionRows = allPartitions.map((p) => `- ${p.name}`).join("\n");
  const environmentRows = allEnvironments.map((e) => `- ${e.name}`).join("\n");

  const contextBlock = [
    `<deployments-recent count="${recentDeployments.length}">`,
    deploymentRows || "(none)",
    `</deployments-recent>`,
    `<artifacts count="${allArtifacts.length}">`,
    artifactRows || "(none)",
    `</artifacts>`,
    `<environments count="${allEnvironments.length}">`,
    environmentRows || "(none)",
    `</environments>`,
    `<partitions count="${allPartitions.length}">`,
    partitionRows || "(none)",
    `</partitions>`,
  ].join("\n");

  const systemPrompt = `You are Synth, an intelligent deployment system. A deployment engineer has asked you a question. Answer it using the real deployment data provided — do not fabricate records or invent names.

Format your response as markdown:
- Use tables for tabular/comparative data. When a deployment is listed in a table, make its version a markdown link using the format: [v1.2.3](synth://deployment-detail?id=<deployment-id>) — use the actual id from the data (the id: prefix in each row).
- For partition or environment rows, you may link using: [Name](synth://partition-detail?id=<partition-name>) or [Name](synth://environment-detail?id=<env-name>)
- Use numbered lists for sequences or steps
- Use code blocks for configs, IDs, or technical strings
- Be specific and factual — reference actual artifact names, environments, and statuses from the data
- If the data doesn't contain enough information to answer precisely, say so clearly

Keep the response concise and directly useful to an engineer.`;

  const prompt = [
    `<user-query>${sanitizeUserInput(query)}</user-query>`,
    contextBlock,
  ].join("\n");

  const llmResult = await llm.reason({
    prompt,
    systemPrompt,
    promptSummary: `Analytical answer for: "${query}"`,
    partitionId: null,
    maxTokens: 2048,
  });

  if (!llmResult.ok) return null;

  const content = llmResult.text.trim();
  const title = query.length > 60 ? query.slice(0, 57) + "..." : query;

  return { action: "answer", view: "", params: {}, title, content };
}
