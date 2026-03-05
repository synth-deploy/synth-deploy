import type { FastifyInstance } from "fastify";
import type { IPartitionStore, IEnvironmentStore, IArtifactStore, ISettingsStore, DebriefWriter, DebriefReader, Artifact, Partition, Environment } from "@deploystack/core";
import type { LlmClient } from "@deploystack/core";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";
import { QueryRequestSchema } from "./schemas.js";

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
            version: lastDeploy.version,
            environment: allEnvironments.find((e) => e.id === lastDeploy.environmentId)?.name ?? lastDeploy.environmentId,
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
  agent: CommandAgent,
  partitions: IPartitionStore,
  environments: IEnvironmentStore,
  artifacts: IArtifactStore,
  deployments: DeploymentStore,
  debrief: DebriefWriter & DebriefReader,
  settings: ISettingsStore,
  llm?: LlmClient,
): void {
  /**
   * Get deployment context — signals, trends, health, drift.
   * Fills the space where manual action buttons collapse.
   */
  app.get("/api/agent/context", async () => {
    return generateContext(deployments, environments, partitions);
  });

  /**
   * Canvas query — classifies a natural language query and returns
   * a structured action telling the UI what view to render.
   * Navigation/data intents resolve entities and return view params.
   */
  app.post("/api/agent/query", async (request, reply) => {
    const parsed = QueryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const query = parsed.data.query.trim();
    const lower = query.toLowerCase();
    const allArtifacts = artifacts.list();
    const allPartitions = partitions.list();
    const allEnvironments = environments.list();

    // --- LLM classification (when available) ---
    const queryEntityExposure = settings.get().agent.llmEntityExposure ?? "names";
    if (llm && llm.isAvailable()) {
      const llmAction = await classifyQueryWithLlm(
        llm, query, allArtifacts, allPartitions, allEnvironments,
        deployments, debrief, queryEntityExposure !== "none",
      );
      if (llmAction) {
        debrief.record({
          partitionId: null,
          deploymentId: null,
          agent: "command",
          decisionType: "system",
          decision: `Canvas query classified as ${llmAction.action}: ${llmAction.view}`,
          reasoning: `LLM classified "${query}" → ${llmAction.action}/${llmAction.view}`,
          context: { query, action: llmAction },
        });
        return llmAction;
      }
    }

    // --- Regex fallback classification ---

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

    // Failed deployments / what failed
    if (/\b(fail|failed|failures|what failed|broken)\b/.test(lower)) {
      return { action: "navigate" as const, view: "deployment-list", params: { status: "failed" }, title: "Failed Deployments" };
    }

    // Settings / configuration
    if (/\b(settings|preferences|configure)\b/.test(lower) || (lower.includes("config") && !/\bconfiguration-resolved\b/.test(lower))) {
      return { action: "navigate" as const, view: "settings", params: {}, title: "Settings" };
    }

    // Artifacts list (legacy "operations" query also matches)
    if (/\b(artifacts|artifact list|operations|operation list|manage artifacts)\b/.test(lower)) {
      return { action: "navigate" as const, view: "artifact-list", params: {}, title: "Artifacts" };
    }

    // Debrief / decision diary
    if (/\b(debrief|decision diary|decisions|decision log|decision history)\b/.test(lower)) {
      const debriefParams: Record<string, string> = {};
      for (const p of allPartitions) {
        if (lower.includes(p.name.toLowerCase())) {
          debriefParams.partitionId = p.id;
          break;
        }
      }
      return { action: "navigate" as const, view: "debrief", params: debriefParams, title: "Debrief" };
    }

    // Specific order by ID
    const orderIdMatch = lower.match(/\border\s+([a-f0-9-]{8,36})\b/);
    if (orderIdMatch) {
      return { action: "navigate" as const, view: "order-detail", params: { id: orderIdMatch[1] }, title: "Order" };
    }

    // Artifact deployments list
    if (/\b(orders|order list|all orders|manage orders)\b/.test(lower)) {
      const orderParams: Record<string, string> = {};
      for (const a of allArtifacts) {
        if (lower.includes(a.name.toLowerCase())) {
          orderParams.artifactId = a.id;
          break;
        }
      }
      return { action: "navigate" as const, view: "deployment-list", params: orderParams, title: "Deployments" };
    }

    // Deployment history / recent deployments
    if (/\b(deployment|history|recent|deployments)\b/.test(lower)) {
      const partitionParam: Record<string, string> = {};
      for (const p of allPartitions) {
        if (lower.includes(p.name.toLowerCase())) {
          partitionParam.partitionId = p.id;
          break;
        }
      }
      return { action: "navigate" as const, view: "deployment-list", params: partitionParam, title: "Deployments" };
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
}

// ---------------------------------------------------------------------------
// LLM-powered query classification
// ---------------------------------------------------------------------------

function buildQueryClassificationPrompt(): string {
  return `You are a query classifier for DeployStack's agent canvas. Given a natural language query from a deployment engineer, classify it into one of these actions:

1. "navigate" — The user wants to see details about a specific entity (e.g., "show partition Alpha", "environment staging")
2. "data" — The user wants to see a list or filtered view of data (e.g., "what failed", "recent deployments", "deployment history for Alpha")
3. "create" — The user wants to create a new entity (e.g., "create partition Acme Corp", "create operation api-service")

Return a JSON object with this exact schema:
{
  "action": "navigate" | "data" | "create",
  "view": "<view-name>",
  "params": { ... },
  "title": "<human-readable title for the panel>"
}

View names:
- "partition-detail" — show specific partition (params: { "id": "<partition-name>" })
- "environment-detail" — show specific environment (params: { "id": "<environment-name>" })
- "deployment-detail" — show specific deployment (params: { "id": "<deployment-id>" })
- "deployment-list" — show list of deployments (params: { "partitionId"?: "<partition-name>", "status"?: "failed"|"succeeded" })
- "overview" — show the operational overview (params: { "focus"?: "signals"|"partitions" })
- "operation-list" — show all operations (params: {})
- "partition-list" — show all partitions with create option (params: {})
- "order-list" — show deployment orders (params: { "operationId"?: "<operation-name>", "partitionId"?: "<partition-name>" })
- "order-detail" — show a specific order (params: { "id": "<order-id>" })
- "debrief" — show the decision diary / debrief timeline (params: { "partitionId"?: "<partition-name>", "decisionType"?: "..." })
- "settings" — show application settings and configuration (params: {})

Rules:
- ONLY use entity names from the provided lists. Never invent names.
- If the query mentions an entity, return its name in the params.
- If the query is ambiguous, default to "overview".
- For "create" actions, include the entity name in params: { "name": "..." } and use view "partition-list" for partitions or "operation-list" for operations.
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
