import type { FastifyInstance } from "fastify";
import type { PartitionStore, DebriefWriter, DebriefReader, Project, Partition, Environment, SettingsStore } from "@deploystack/core";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IntentRequest {
  intent: string;
  partialConfig?: {
    projectId?: string;
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
    projectId: ResolvedField;
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

interface ProjectStore {
  get(id: string): Project | undefined;
  list(): Project[];
}

interface EnvironmentStore {
  get(id: string): Environment | undefined;
  list(): Environment[];
}

// ---------------------------------------------------------------------------
// Intent interpretation — pattern-based (LLM-replaceable in future phase)
// ---------------------------------------------------------------------------

function interpretIntent(
  intent: string,
  partialConfig: IntentRequest["partialConfig"],
  projects: ProjectStore,
  partitionStore: PartitionStore,
  environmentStore: EnvironmentStore,
): IntentResult {
  const lower = intent.toLowerCase();
  const allProjects = projects.list();
  const allPartitions = partitionStore.list();
  const allEnvironments = environmentStore.list();

  // --- Resolve project ---
  const projectField = resolveProject(lower, partialConfig?.projectId, allProjects);

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
    projectId: projectField,
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

  // Validate environment belongs to project if both resolved
  if (
    projectField.confidence !== "missing" &&
    envField.confidence !== "missing"
  ) {
    const project = projects.list().find((p) => p.id === projectField.value);
    if (project && !project.environmentIds.includes(envField.value)) {
      uiUpdates.push({
        field: "environmentId",
        action: "warn",
        message: `Environment is not linked to project "${project.name}". Choose a linked environment.`,
      });
      missingFields.push("environmentId");
      envField = { value: "", confidence: "missing", matchedFrom: `not linked to project "${project.name}"` };
    }
  }

  return {
    resolved: {
      projectId: projectField,
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

function resolveProject(
  lower: string,
  partialId: string | undefined,
  projects: Project[],
): ResolvedField {
  if (partialId) {
    const p = projects.find((p) => p.id === partialId);
    if (p) return { value: p.id, confidence: "exact", matchedFrom: p.name };
  }

  for (const p of projects) {
    if (lower.includes(p.name.toLowerCase())) {
      return { value: p.id, confidence: "exact", matchedFrom: p.name };
    }
  }

  // If only one project exists, infer it
  if (projects.length === 1) {
    return { value: projects[0].id, confidence: "inferred", matchedFrom: `only project: ${projects[0].name}` };
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
  projects: ProjectStore,
  deployments: DeploymentStore,
  debrief: DebriefWriter & DebriefReader,
  settings: SettingsStore,
): void {
  /**
   * Interpret a plain-language deployment intent.
   * Returns resolved fields + UI update instructions.
   * Does NOT trigger a deployment — the UI confirms first.
   */
  app.post("/api/agent/interpret-intent", async (request, reply) => {
    const body = request.body as IntentRequest;

    if (!body.intent || typeof body.intent !== "string") {
      return reply.status(400).send({ error: "Intent string is required" });
    }

    const result = interpretIntent(
      body.intent,
      body.partialConfig,
      projects,
      partitions,
      environments,
    );

    // When environments are disabled, auto-resolve environmentId
    const envEnabled = settings.get().environmentsEnabled;
    if (!envEnabled) {
      result.resolved.environmentId = { value: "", confidence: "exact", matchedFrom: "environments-disabled" };
      result.missingFields = result.missingFields.filter((f) => f !== "environmentId");
      result.uiUpdates = result.uiUpdates.filter((u) => u.field !== "environmentId");
      result.ready = result.missingFields.length === 0;
    }

    // Build actionable reasoning that explains WHY fields are missing
    const reasoningParts = [`Interpreted intent "${body.intent}".`];
    const allProjects = projects.list();
    const allPartitions = partitions.list();
    const allEnvironments = environments.list();

    const fieldEntries: Array<[string, ResolvedField, string[]]> = [
      ["Project", result.resolved.projectId, allProjects.map((p: Project) => p.name)],
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
        ? `Intent fully resolved: ready to deploy ${result.resolved.projectId.matchedFrom ?? result.resolved.projectId.value} v${result.resolved.version.value}`
        : `Intent partially resolved: missing ${result.missingFields.join(", ")}`,
      reasoning: reasoningParts.join(" "),
      context: {
        intent: body.intent,
        ready: result.ready,
        missingFields: result.missingFields,
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
}
