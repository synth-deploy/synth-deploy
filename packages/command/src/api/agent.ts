import type { FastifyInstance } from "fastify";
import type { PartitionStore, DebriefWriter, DebriefReader, Operation, Partition, Environment, SettingsStore, LlmResult } from "@deploystack/core";
import type { LlmClient } from "@deploystack/core";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IntentRequest {
  intent: string;
  conversationId?: string;
  partialConfig?: {
    operationId?: string;
    partitionId?: string;
    environmentId?: string;
    version?: string;
    variables?: Record<string, string>;
  };
}

interface ResolvedField {
  value: string;
  confidence: "exact" | "inferred" | "missing";
  matchedFrom?: string;
}

interface IntentResult {
  resolved: {
    operationId: ResolvedField;
    partitionId: ResolvedField;
    environmentId: ResolvedField;
    version: ResolvedField;
    variables: Record<string, string>;
  };
  ready: boolean;
  missingFields: string[];
  uiUpdates: Array<{
    field: string;
    action: "set" | "highlight" | "warn";
    value?: string;
    message?: string;
  }>;
}

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
// Entity stores interface (matches what index.ts exposes)
// ---------------------------------------------------------------------------

interface OperationStore {
  get(id: string): Operation | undefined;
  list(): Operation[];
  create(name: string, environmentIds?: string[]): Operation;
}

interface EnvironmentStore {
  get(id: string): Environment | undefined;
  list(): Environment[];
}

// ---------------------------------------------------------------------------
// LLM intent response schema (what the LLM returns as JSON)
// ---------------------------------------------------------------------------

interface LlmEntityMatch {
  id: string;
  confidence: "exact" | "inferred";
  matchedFrom: string;
}

interface LlmIntentResponse {
  operationId: LlmEntityMatch | null;
  partitionId: LlmEntityMatch | null;
  environmentId: LlmEntityMatch | null;
  version: { value: string; confidence: "exact" | "inferred"; matchedFrom: string } | null;
  variables: Record<string, string>;
  disambiguation?: Array<{
    field: string;
    candidates: Array<{ id: string; name: string; reason: string }>;
  }>;
}

// ---------------------------------------------------------------------------
// Conversation context for follow-up intents
// ---------------------------------------------------------------------------

interface ConversationEntry {
  intent: string;
  resolved: IntentResult["resolved"];
  timestamp: number;
}

const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONVERSATION_ENTRIES = 5;

/** @internal Exported for testing only */
export const conversations = new Map<string, ConversationEntry[]>();

function getConversationHistory(conversationId: string | undefined): ConversationEntry[] {
  if (!conversationId) return [];

  const entries = conversations.get(conversationId);
  if (!entries) return [];

  // Prune expired entries
  const now = Date.now();
  const valid = entries.filter((e) => now - e.timestamp < CONVERSATION_TTL_MS);
  if (valid.length !== entries.length) {
    conversations.set(conversationId, valid);
  }

  return valid.slice(-3); // Last 3 entries for LLM context
}

function recordConversation(conversationId: string | undefined, intent: string, resolved: IntentResult["resolved"]): void {
  if (!conversationId) return;

  const entries = conversations.get(conversationId) ?? [];
  entries.push({ intent, resolved, timestamp: Date.now() });

  // Cap at max entries
  if (entries.length > MAX_CONVERSATION_ENTRIES) {
    entries.splice(0, entries.length - MAX_CONVERSATION_ENTRIES);
  }

  conversations.set(conversationId, entries);
}

// ---------------------------------------------------------------------------
// LLM-powered intent interpretation
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are a deployment intent parser for DeployStack. Your job is to extract structured entities from natural language deployment intents.

You will receive:
- An intent string from a deployment engineer
- Lists of known operations, partitions, and environments (with IDs and names)
- Optionally, partial configuration already provided by the user
- Optionally, previous conversation context for follow-up intents

Return a JSON object with this exact schema:
{
  "operationId": { "id": "<operation-id>", "confidence": "exact"|"inferred", "matchedFrom": "<explanation>" } | null,
  "partitionId": { "id": "<partition-id>", "confidence": "exact"|"inferred", "matchedFrom": "<explanation>" } | null,
  "environmentId": { "id": "<environment-id>", "confidence": "exact"|"inferred", "matchedFrom": "<explanation>" } | null,
  "version": { "value": "<semver>", "confidence": "exact"|"inferred", "matchedFrom": "<explanation>" } | null,
  "variables": { "<KEY>": "<value>", ... },
  "disambiguation": [{ "field": "<field>", "candidates": [{ "id": "<id>", "name": "<name>", "reason": "<why>" }] }]
}

Rules:
- ONLY use IDs from the provided entity lists. Never invent IDs.
- "exact" confidence: the intent text directly mentions or clearly refers to the entity
- "inferred" confidence: you deduced the entity from context, abbreviations, or follow-up references
- If an entity cannot be determined, set it to null
- If multiple entities match ambiguously, pick the best match but also populate "disambiguation"
- Handle abbreviations, synonyms, and partial matches (e.g., "prod" → production, "stg" → staging)
- For follow-up intents like "same thing but for staging", use conversation context to carry forward resolved entities
- Extract key=value variable assignments from the intent
- Return ONLY valid JSON, no markdown, no explanation`;
}

function buildUserPrompt(
  intent: string,
  partialConfig: IntentRequest["partialConfig"],
  allOperations: Operation[],
  allPartitions: Partition[],
  allEnvironments: Environment[],
  history: ConversationEntry[],
): string {
  const parts: string[] = [];

  parts.push(`Intent: "${intent}"`);

  parts.push(`\nKnown operations:`);
  for (const p of allOperations) {
    parts.push(`  - id: "${p.id}", name: "${p.name}"`);
  }
  if (allOperations.length === 0) parts.push("  (none configured)");

  parts.push(`\nKnown partitions:`);
  for (const t of allPartitions) {
    parts.push(`  - id: "${t.id}", name: "${t.name}"`);
  }
  if (allPartitions.length === 0) parts.push("  (none configured)");

  parts.push(`\nKnown environments:`);
  for (const e of allEnvironments) {
    parts.push(`  - id: "${e.id}", name: "${e.name}"`);
  }
  if (allEnvironments.length === 0) parts.push("  (none configured)");

  if (partialConfig) {
    parts.push(`\nPre-filled fields (already selected by user):`);
    if (partialConfig.operationId) parts.push(`  operationId: "${partialConfig.operationId}"`);
    if (partialConfig.partitionId) parts.push(`  partitionId: "${partialConfig.partitionId}"`);
    if (partialConfig.environmentId) parts.push(`  environmentId: "${partialConfig.environmentId}"`);
    if (partialConfig.version) parts.push(`  version: "${partialConfig.version}"`);
  }

  if (history.length > 0) {
    parts.push(`\nPrevious intents in this conversation (for follow-up context):`);
    for (const entry of history) {
      const resolved: string[] = [];
      if (entry.resolved.operationId.confidence !== "missing") resolved.push(`operation=${entry.resolved.operationId.value}`);
      if (entry.resolved.partitionId.confidence !== "missing") resolved.push(`partition=${entry.resolved.partitionId.value}`);
      if (entry.resolved.environmentId.confidence !== "missing") resolved.push(`environment=${entry.resolved.environmentId.value}`);
      if (entry.resolved.version.confidence !== "missing") resolved.push(`version=${entry.resolved.version.value}`);
      parts.push(`  - "${entry.intent}" → resolved: ${resolved.join(", ") || "nothing"}`);
    }
  }

  return parts.join("\n");
}

function parseLlmResponse(
  llmResult: LlmResult,
  allOperations: Operation[],
  allPartitions: Partition[],
  allEnvironments: Environment[],
  partialConfig: IntentRequest["partialConfig"],
): IntentResult | null {
  if (!llmResult.ok) return null;

  let parsed: LlmIntentResponse;
  try {
    // Strip markdown code fences if present
    let text = llmResult.text.trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    parsed = JSON.parse(text);
  } catch {
    return null; // JSON parse failure → fall back to regex
  }

  const operationIds = new Set(allOperations.map((p) => p.id));
  const partitionIds = new Set(allPartitions.map((t) => t.id));
  const environmentIds = new Set(allEnvironments.map((e) => e.id));

  // Validate and convert each field
  const operationField = convertLlmEntity(parsed.operationId, operationIds, partialConfig?.operationId);
  const partitionField = convertLlmEntity(parsed.partitionId, partitionIds, partialConfig?.partitionId);
  const envField = convertLlmEntity(parsed.environmentId, environmentIds, partialConfig?.environmentId);
  const versionField = convertLlmVersion(parsed.version, partialConfig?.version);
  const variables = { ...(partialConfig?.variables ?? {}), ...(parsed.variables ?? {}) };

  // If any field that the LLM claimed to resolve has an invalid ID, reject the whole response
  if (
    (parsed.operationId && !operationIds.has(parsed.operationId.id)) ||
    (parsed.partitionId && !partitionIds.has(parsed.partitionId.id)) ||
    (parsed.environmentId && !environmentIds.has(parsed.environmentId.id))
  ) {
    return null; // Hallucination detected → fall back to regex
  }

  const missingFields: string[] = [];
  const uiUpdates: IntentResult["uiUpdates"] = [];

  for (const [name, field] of Object.entries({
    operationId: operationField,
    partitionId: partitionField,
    environmentId: envField,
    version: versionField,
  })) {
    if (field.confidence === "missing") {
      missingFields.push(name);
    } else if (field.confidence === "exact") {
      uiUpdates.push({ field: name, action: "set", value: field.value, message: `Matched: ${field.matchedFrom}` });
    } else {
      uiUpdates.push({ field: name, action: "set", value: field.value, message: `Inferred: ${field.matchedFrom}` });
    }
  }

  // Add disambiguation warnings
  if (parsed.disambiguation) {
    for (const d of parsed.disambiguation) {
      const names = d.candidates.map((c) => c.name).join(", ");
      uiUpdates.push({
        field: d.field,
        action: "warn",
        message: `Multiple matches: ${names}. Selected best match — verify this is correct.`,
      });
    }
  }

  return {
    resolved: {
      operationId: operationField,
      partitionId: partitionField,
      environmentId: envField,
      version: versionField,
      variables,
    },
    ready: missingFields.length === 0,
    missingFields,
    uiUpdates,
  };
}

function convertLlmEntity(
  entity: LlmEntityMatch | null,
  validIds: Set<string>,
  partialId?: string,
): ResolvedField {
  // Partial config takes precedence (user already selected)
  if (partialId && validIds.has(partialId)) {
    return { value: partialId, confidence: "exact", matchedFrom: `pre-selected by user` };
  }

  if (!entity) return { value: "", confidence: "missing" };
  if (!validIds.has(entity.id)) return { value: "", confidence: "missing" };

  return {
    value: entity.id,
    confidence: entity.confidence,
    matchedFrom: entity.matchedFrom,
  };
}

function convertLlmVersion(
  version: { value: string; confidence: "exact" | "inferred"; matchedFrom: string } | null,
  partialVersion?: string,
): ResolvedField {
  if (partialVersion) {
    return { value: partialVersion, confidence: "exact", matchedFrom: `provided: ${partialVersion}` };
  }

  if (!version) return { value: "", confidence: "missing" };

  return {
    value: version.value,
    confidence: version.confidence,
    matchedFrom: version.matchedFrom,
  };
}

// ---------------------------------------------------------------------------
// Intent interpretation — pattern-based (fallback when LLM unavailable)
// ---------------------------------------------------------------------------

function interpretIntent(
  intent: string,
  partialConfig: IntentRequest["partialConfig"],
  operations: OperationStore,
  partitionStore: PartitionStore,
  environmentStore: EnvironmentStore,
): IntentResult {
  const lower = intent.toLowerCase();
  const allOperations = operations.list();
  const allPartitions = partitionStore.list();
  const allEnvironments = environmentStore.list();

  // --- Resolve operation ---
  const operationField = resolveOperation(lower, partialConfig?.operationId, allOperations);

  // --- Resolve partition ---
  const partitionField = resolvePartition(lower, partialConfig?.partitionId, allPartitions);

  // --- Resolve environment ---
  let envField = resolveEnvironment(lower, partialConfig?.environmentId, allEnvironments);

  // --- Resolve version ---
  const versionField = resolveVersion(lower, partialConfig?.version);

  // --- Resolve variables from intent ---
  const variables = partialConfig?.variables ?? {};
  const varPattern = /(?:with|set|using)\s+(\w+)\s*=\s*"?([^",\s]+)"?/gi;
  let varMatch;
  while ((varMatch = varPattern.exec(intent)) !== null) {
    variables[varMatch[1]] = varMatch[2];
  }

  const missingFields: string[] = [];
  const uiUpdates: IntentResult["uiUpdates"] = [];

  for (const [name, field] of Object.entries({
    operationId: operationField,
    partitionId: partitionField,
    environmentId: envField,
    version: versionField,
  })) {
    if (field.confidence === "missing") {
      missingFields.push(name);
    } else if (field.confidence === "exact") {
      uiUpdates.push({ field: name, action: "set", value: field.value, message: `Matched: ${field.matchedFrom}` });
    } else {
      uiUpdates.push({ field: name, action: "set", value: field.value, message: `Inferred: ${field.matchedFrom}` });
    }
  }

  return {
    resolved: {
      operationId: operationField,
      partitionId: partitionField,
      environmentId: envField,
      version: versionField,
      variables,
    },
    ready: missingFields.length === 0,
    missingFields,
    uiUpdates,
  };
}

function resolveOperation(
  lower: string,
  partialId: string | undefined,
  operations: Operation[],
): ResolvedField {
  if (partialId) {
    const p = operations.find((p) => p.id === partialId);
    if (p) return { value: p.id, confidence: "exact", matchedFrom: p.name };
  }

  for (const p of operations) {
    if (lower.includes(p.name.toLowerCase())) {
      return { value: p.id, confidence: "exact", matchedFrom: p.name };
    }
  }

  // If only one operation exists, infer it
  if (operations.length === 1) {
    return { value: operations[0].id, confidence: "inferred", matchedFrom: `only operation: ${operations[0].name}` };
  }

  return { value: "", confidence: "missing" };
}

function resolvePartition(
  lower: string,
  partialId: string | undefined,
  partitions: Partition[],
): ResolvedField {
  if (partialId) {
    const t = partitions.find((t) => t.id === partialId);
    if (t) return { value: t.id, confidence: "exact", matchedFrom: t.name };
  }

  for (const t of partitions) {
    if (lower.includes(t.name.toLowerCase())) {
      return { value: t.id, confidence: "exact", matchedFrom: t.name };
    }
  }

  if (partitions.length === 1) {
    return { value: partitions[0].id, confidence: "inferred", matchedFrom: `only partition: ${partitions[0].name}` };
  }

  return { value: "", confidence: "missing" };
}

function resolveEnvironment(
  lower: string,
  partialId: string | undefined,
  environments: Environment[],
): ResolvedField {
  if (partialId) {
    const e = environments.find((e) => e.id === partialId);
    if (e) return { value: e.id, confidence: "exact", matchedFrom: e.name };
  }

  // Match environment names and common aliases
  const aliases: Record<string, string[]> = {
    production: ["production", "prod"],
    staging: ["staging", "stage", "stg"],
    development: ["development", "dev"],
  };

  for (const env of environments) {
    const names = aliases[env.name.toLowerCase()] ?? [env.name.toLowerCase()];
    for (const name of names) {
      if (lower.includes(name)) {
        return { value: env.id, confidence: "exact", matchedFrom: env.name };
      }
    }
  }

  return { value: "", confidence: "missing" };
}

function resolveVersion(
  lower: string,
  partialVersion: string | undefined,
): ResolvedField {
  if (partialVersion) {
    return { value: partialVersion, confidence: "exact", matchedFrom: `provided: ${partialVersion}` };
  }

  // Match semver patterns: v1.2.3, 1.2.3, v2.0
  const semverPattern = /v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/;
  const match = lower.match(semverPattern);
  if (match) {
    return { value: match[1], confidence: "exact", matchedFrom: `version in intent: ${match[1]}` };
  }

  return { value: "", confidence: "missing" };
}

// ---------------------------------------------------------------------------
// Context generation — signals from deployment data
// ---------------------------------------------------------------------------

function generateContext(
  deployments: DeploymentStore,
  environmentStore: EnvironmentStore,
  partitionStore: PartitionStore,
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
  partitions: PartitionStore,
  environments: EnvironmentStore,
  operations: OperationStore,
  deployments: DeploymentStore,
  debrief: DebriefWriter & DebriefReader,
  settings: SettingsStore,
  llm?: LlmClient,
): void {
  /**
   * Interpret a plain-language deployment intent.
   * Uses LLM when available, falls back to regex extraction.
   * Returns resolved fields + UI update instructions.
   * Does NOT trigger a deployment — the UI confirms first.
   */
  app.post("/api/agent/interpret-intent", async (request, reply) => {
    const body = request.body as IntentRequest;

    if (!body.intent || typeof body.intent !== "string") {
      return reply.status(400).send({ error: "Intent string is required" });
    }

    const allOperations = operations.list();
    const allPartitions = partitions.list();
    const allEnvironments = environments.list();

    let result: IntentResult;
    let method: "llm" | "regex" = "regex";

    // Try LLM-powered interpretation first
    if (llm && llm.isAvailable()) {
      const history = getConversationHistory(body.conversationId);
      const llmResult = await llm.classify({
        prompt: buildUserPrompt(
          body.intent,
          body.partialConfig,
          allOperations,
          allPartitions,
          allEnvironments,
          history,
        ),
        systemPrompt: buildSystemPrompt(),
        promptSummary: `Intent interpretation: "${body.intent}"`,
        partitionId: body.partialConfig?.partitionId ?? null,
        maxTokens: 1024,
      });

      const llmParsed = parseLlmResponse(
        llmResult,
        allOperations,
        allPartitions,
        allEnvironments,
        body.partialConfig,
      );

      if (llmParsed) {
        result = llmParsed;
        method = "llm";
      } else {
        // LLM failed or returned invalid data — fall back to regex
        result = interpretIntent(
          body.intent,
          body.partialConfig,
          operations,
          partitions,
          environments,
        );
      }
    } else {
      // LLM not available — use regex
      result = interpretIntent(
        body.intent,
        body.partialConfig,
        operations,
        partitions,
        environments,
      );
    }

    // Validate environment belongs to operation (runs for both LLM and regex paths)
    if (
      result.resolved.operationId.confidence !== "missing" &&
      result.resolved.environmentId.confidence !== "missing"
    ) {
      const operation = allOperations.find((p) => p.id === result.resolved.operationId.value);
      if (operation && !operation.environmentIds.includes(result.resolved.environmentId.value)) {
        result.uiUpdates.push({
          field: "environmentId",
          action: "warn",
          message: `Environment is not linked to operation "${operation.name}". Choose a linked environment.`,
        });
        if (!result.missingFields.includes("environmentId")) {
          result.missingFields.push("environmentId");
        }
        result.resolved.environmentId = { value: "", confidence: "missing", matchedFrom: `not linked to operation "${operation.name}"` };
        result.ready = false;
      }
    }

    // When environments are disabled, auto-resolve environmentId
    const envEnabled = settings.get().environmentsEnabled;
    if (!envEnabled) {
      result.resolved.environmentId = { value: "", confidence: "exact", matchedFrom: "environments-disabled" };
      result.missingFields = result.missingFields.filter((f) => f !== "environmentId");
      result.uiUpdates = result.uiUpdates.filter((u) => u.field !== "environmentId");
      result.ready = result.missingFields.length === 0;
    }

    // Record conversation for follow-up support
    recordConversation(body.conversationId, body.intent, result.resolved);

    // Build actionable reasoning that explains WHY fields are missing
    const reasoningParts = [`Interpreted intent "${body.intent}" via ${method}.`];

    const fieldEntries: Array<[string, ResolvedField, string[]]> = [
      ["Operation", result.resolved.operationId, allOperations.map((p: Operation) => p.name)],
      ["Partition", result.resolved.partitionId, allPartitions.map((t: Partition) => t.name)],
      ["Environment", result.resolved.environmentId, allEnvironments.map((e: Environment) => e.name)],
      ["Version", result.resolved.version, []],
    ];
    for (const [name, field, availableNames] of fieldEntries) {
      if (field.confidence === "missing") {
        const available = name === "Version"
          ? "Include a semver version (e.g. v1.2.3) in the intent."
          : `Available ${name.toLowerCase()}s: ${availableNames.length > 0 ? availableNames.join(", ") : "none configured"}.`;
        reasoningParts.push(`${name}: MISSING — no match found in intent text. ${available}`);
      } else {
        reasoningParts.push(`${name}: ${field.confidence} (${field.matchedFrom ?? "resolved"}).`);
      }
    }

    debrief.record({
      partitionId: result.resolved.partitionId.confidence !== "missing" ? result.resolved.partitionId.value : null,
      deploymentId: null,
      agent: "command",
      decisionType: "system",
      decision: result.ready
        ? `Intent fully resolved: ready to deploy ${result.resolved.operationId.matchedFrom ?? result.resolved.operationId.value} v${result.resolved.version.value}`
        : `Intent partially resolved: missing ${result.missingFields.join(", ")}`,
      reasoning: reasoningParts.join(" "),
      context: {
        intent: body.intent,
        ready: result.ready,
        missingFields: result.missingFields,
        method,
        conversationId: body.conversationId ?? null,
      },
    });

    return result;
  });

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
   * Deploy intents delegate to interpret-intent logic.
   * Navigation/data intents resolve entities and return view params.
   */
  app.post("/api/agent/query", async (request, reply) => {
    const body = request.body as { query: string; conversationId?: string };

    if (!body.query || typeof body.query !== "string") {
      return reply.status(400).send({ error: "Query string is required" });
    }

    const query = body.query.trim();
    const lower = query.toLowerCase();
    const allOperations = operations.list();
    const allPartitions = partitions.list();
    const allEnvironments = environments.list();

    // --- LLM classification (when available) ---
    if (llm && llm.isAvailable()) {
      const llmAction = await classifyQueryWithLlm(
        llm, query, allOperations, allPartitions, allEnvironments,
        deployments, debrief,
      );
      if (llmAction) {
        // Handle create actions: perform the creation, then navigate to the result
        if (llmAction.action === "create" && llmAction.params?.name) {
          const entityName = llmAction.params.name;
          if (llmAction.view === "partition-list" || llmAction.view === "partition-detail") {
            const created = partitions.create(entityName);
            debrief.record({
              partitionId: created.id,
              deploymentId: null,
              agent: "command",
              decisionType: "system",
              decision: `Created partition "${created.name}" via intent bar`,
              reasoning: `LLM classified "${query}" as create-partition`,
              context: { query, partitionId: created.id },
            });
            return { action: "navigate" as const, view: "partition-detail", params: { id: created.id }, title: created.name };
          }
          if (llmAction.view === "operation-list") {
            const created = operations.create(entityName, []);
            debrief.record({
              partitionId: null,
              deploymentId: null,
              agent: "command",
              decisionType: "system",
              decision: `Created operation "${created.name}" via intent bar`,
              reasoning: `LLM classified "${query}" as create-operation`,
              context: { query, operationId: created.id },
            });
            return { action: "navigate" as const, view: "operation-list", params: {}, title: "Operations" };
          }
        }

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

    // Create partition: "create partition Acme Corp" → create and navigate to detail
    const createPartitionMatch = query.match(/\bcreate\s+partition\s+(.+)/i);
    if (createPartitionMatch) {
      const partitionName = createPartitionMatch[1].trim();
      const created = partitions.create(partitionName);
      debrief.record({
        partitionId: created.id,
        deploymentId: null,
        agent: "command",
        decisionType: "system",
        decision: `Created partition "${created.name}" via intent bar`,
        reasoning: `User requested partition creation: "${query}"`,
        context: { query, partitionId: created.id },
      });
      return { action: "navigate" as const, view: "partition-detail", params: { id: created.id }, title: created.name };
    }

    // Create operation: "create operation api-service" → create and navigate to operation list
    const createOperationMatch = query.match(/\bcreate\s+operation\s+(.+)/i);
    if (createOperationMatch) {
      const operationName = createOperationMatch[1].trim();
      const created = operations.create(operationName, []);
      debrief.record({
        partitionId: null,
        deploymentId: null,
        agent: "command",
        decisionType: "system",
        decision: `Created operation "${created.name}" via intent bar`,
        reasoning: `User requested operation creation: "${query}"`,
        context: { query, operationId: created.id },
      });
      return { action: "navigate" as const, view: "operation-list", params: {}, title: "Operations" };
    }

    // Deploy intents: contains "deploy" or version-like patterns with entity names
    const deployPatterns = /\b(deploy|release|ship|push|rollout)\b/;
    if (deployPatterns.test(lower)) {
      return { action: "deploy" as const, view: "deployment-authoring", params: { intent: query } };
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

    // Operations list
    if (/\b(operations|operation list|manage operations)\b/.test(lower)) {
      return { action: "navigate" as const, view: "operation-list", params: {}, title: "Operations" };
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

    // Orders list
    if (/\b(orders|order list|all orders|manage orders)\b/.test(lower)) {
      const orderParams: Record<string, string> = {};
      for (const p of allOperations) {
        if (lower.includes(p.name.toLowerCase())) {
          orderParams.operationId = p.id;
          break;
        }
      }
      return { action: "navigate" as const, view: "order-list", params: orderParams, title: "Orders" };
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

    // Fallback: treat as deploy intent
    return { action: "deploy" as const, view: "deployment-authoring", params: { intent: query } };
  });
}

// ---------------------------------------------------------------------------
// LLM-powered query classification
// ---------------------------------------------------------------------------

function buildQueryClassificationPrompt(): string {
  return `You are a query classifier for DeployStack's agent canvas. Given a natural language query from a deployment engineer, classify it into one of these actions:

1. "deploy" — The user wants to trigger a deployment (e.g., "deploy Acme to staging", "release v1.2.3")
2. "navigate" — The user wants to see details about a specific entity (e.g., "show partition Alpha", "environment staging")
3. "data" — The user wants to see a list or filtered view of data (e.g., "what failed", "recent deployments", "deployment history for Alpha")
4. "create" — The user wants to create a new entity (e.g., "create partition Acme Corp", "create operation api-service")

Return a JSON object with this exact schema:
{
  "action": "deploy" | "navigate" | "data" | "create",
  "view": "<view-name>",
  "params": { ... },
  "title": "<human-readable title for the panel>"
}

View names:
- "deployment-authoring" — for deploy actions
- "partition-detail" — show specific partition (params: { "id": "<partition-id>" })
- "environment-detail" — show specific environment (params: { "id": "<environment-id>" })
- "deployment-detail" — show specific deployment (params: { "id": "<deployment-id>" })
- "deployment-list" — show list of deployments (params: { "partitionId"?: "...", "status"?: "failed"|"succeeded" })
- "overview" — show the operational overview (params: { "focus"?: "signals"|"partitions" })
- "operation-list" — show all operations (params: {})
- "partition-list" — show all partitions with create option (params: {})
- "order-list" — show deployment orders (params: { "operationId"?: "...", "partitionId"?: "..." })
- "order-detail" — show a specific order (params: { "id": "<order-id>" })
- "debrief" — show the decision diary / debrief timeline (params: { "partitionId"?: "...", "decisionType"?: "..." })
- "settings" — show application settings and configuration (params: {})

Rules:
- ONLY use entity IDs from the provided lists. Never invent IDs.
- If the query mentions an entity by name, resolve it to its ID.
- If the query is ambiguous, default to "overview".
- For "create" actions, include the entity name in params: { "name": "..." } and use view "partition-list" for partitions or "operation-list" for operations.
- Return ONLY valid JSON, no markdown, no explanation.`;
}

async function classifyQueryWithLlm(
  llm: LlmClient,
  query: string,
  allOperations: Operation[],
  allPartitions: Partition[],
  allEnvironments: Environment[],
  deploymentStore: DeploymentStore,
  _debrief: DebriefReader,
): Promise<{ action: string; view: string; params: Record<string, string>; title?: string } | null> {
  const parts: string[] = [`Query: "${query}"`];

  parts.push(`\nKnown partitions:`);
  for (const t of allPartitions) parts.push(`  - id: "${t.id}", name: "${t.name}"`);
  if (allPartitions.length === 0) parts.push("  (none)");

  parts.push(`\nKnown environments:`);
  for (const e of allEnvironments) parts.push(`  - id: "${e.id}", name: "${e.name}"`);
  if (allEnvironments.length === 0) parts.push("  (none)");

  parts.push(`\nKnown operations:`);
  for (const p of allOperations) parts.push(`  - id: "${p.id}", name: "${p.name}"`);
  if (allOperations.length === 0) parts.push("  (none)");

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

    // Validate entity IDs if present
    const partitionIds = new Set(allPartitions.map((t) => t.id));
    const environmentIds = new Set(allEnvironments.map((e) => e.id));
    if (parsed.params?.id) {
      if (parsed.view === "partition-detail" && !partitionIds.has(parsed.params.id)) return null;
      if (parsed.view === "environment-detail" && !environmentIds.has(parsed.params.id)) return null;
    }
    if (parsed.params?.partitionId && !partitionIds.has(parsed.params.partitionId)) {
      delete parsed.params.partitionId;
    }

    return parsed;
  } catch {
    return null;
  }
}
