import type {
  Partition,
  Environment,
  Deployment,
  DebriefEntry,
  PostmortemReport,
  Artifact,
  ArtifactVersion,
  SecurityBoundary,
  AppSettings,
  CommandInfo,
} from "./types.js";

const BASE = "";

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${BASE}${url}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

// --- Auth ---

interface AuthLoginResult {
  user: { id: string; email: string; name: string; createdAt: string; updatedAt: string };
  token: string;
  refreshToken: string;
  permissions: string[];
}

export async function authLogin(email: string, password: string): Promise<AuthLoginResult> {
  return fetchJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function authRegister(email: string, name: string, password: string): Promise<AuthLoginResult> {
  return fetchJson("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, name, password }),
  });
}

export async function authRefresh(refreshToken: string): Promise<{ token: string; refreshToken: string; expiresAt: string }> {
  return fetchJson("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
}

export async function authMe(): Promise<{ user: { id: string; email: string; name: string; createdAt: string; updatedAt: string }; permissions: string[] }> {
  return fetchJson("/api/auth/me");
}

export async function authStatus(): Promise<{ needsSetup: boolean }> {
  return fetchJson("/api/auth/status");
}

// --- Artifacts ---

export async function listArtifacts(): Promise<Artifact[]> {
  const data = await fetchJson<{ artifacts: Artifact[] }>("/api/artifacts");
  return data.artifacts;
}

export async function getArtifact(id: string): Promise<{ artifact: Artifact; versions: ArtifactVersion[] }> {
  return fetchJson(`/api/artifacts/${id}`);
}

export async function createArtifact(params: { name: string; type: string }): Promise<Artifact> {
  const data = await fetchJson<{ artifact: Artifact }>("/api/artifacts", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return data.artifact;
}

export async function updateArtifact(id: string, updates: { name?: string; type?: string }): Promise<Artifact> {
  const data = await fetchJson<{ artifact: Artifact }>(`/api/artifacts/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.artifact;
}

export async function deleteArtifact(id: string): Promise<void> {
  await fetchJson(`/api/artifacts/${id}`, { method: "DELETE" });
}

export async function addArtifactAnnotation(
  id: string,
  annotation: { field: string; correction: string },
): Promise<Artifact> {
  const data = await fetchJson<{ artifact: Artifact }>(`/api/artifacts/${id}/annotations`, {
    method: "POST",
    body: JSON.stringify(annotation),
  });
  return data.artifact;
}

export async function listArtifactVersions(id: string): Promise<ArtifactVersion[]> {
  const data = await fetchJson<{ versions: ArtifactVersion[] }>(`/api/artifacts/${id}/versions`);
  return data.versions;
}

export async function addArtifactVersion(
  id: string,
  version: { version: string; source: string; metadata?: Record<string, string> },
): Promise<ArtifactVersion> {
  const data = await fetchJson<{ version: ArtifactVersion }>(`/api/artifacts/${id}/versions`, {
    method: "POST",
    body: JSON.stringify(version),
  });
  return data.version;
}

// --- Security Boundaries ---

export async function getSecurityBoundaries(envoyId: string): Promise<SecurityBoundary[]> {
  const data = await fetchJson<{ boundaries: SecurityBoundary[] }>(`/api/envoys/${envoyId}/security-boundaries`);
  return data.boundaries;
}

export async function setSecurityBoundaries(
  envoyId: string,
  boundaries: Array<{ boundaryType: string; config: Record<string, unknown> }>,
): Promise<SecurityBoundary[]> {
  const data = await fetchJson<{ boundaries: SecurityBoundary[] }>(`/api/envoys/${envoyId}/security-boundaries`, {
    method: "PUT",
    body: JSON.stringify({ boundaries }),
  });
  return data.boundaries;
}

export async function deleteSecurityBoundaries(envoyId: string): Promise<void> {
  await fetchJson(`/api/envoys/${envoyId}/security-boundaries`, { method: "DELETE" });
}

// --- Partitions ---

export async function listPartitions(): Promise<Partition[]> {
  const data = await fetchJson<{ partitions: Partition[] }>("/api/partitions");
  return data.partitions;
}

export async function getPartition(id: string): Promise<Partition> {
  const data = await fetchJson<{ partition: Partition }>(`/api/partitions/${id}`);
  return data.partition;
}

export async function createPartition(name: string, variables?: Record<string, string>): Promise<Partition> {
  const data = await fetchJson<{ partition: Partition }>("/api/partitions", {
    method: "POST",
    body: JSON.stringify({ name, variables: variables ?? {} }),
  });
  return data.partition;
}

export async function updatePartitionVariables(id: string, variables: Record<string, string>): Promise<Partition> {
  const data = await fetchJson<{ partition: Partition }>(`/api/partitions/${id}/variables`, {
    method: "PUT",
    body: JSON.stringify({ variables }),
  });
  return data.partition;
}

export async function updatePartition(id: string, updates: { name?: string }): Promise<Partition> {
  const data = await fetchJson<{ partition: Partition }>(`/api/partitions/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.partition;
}

export async function deletePartition(id: string): Promise<void> {
  await fetchJson(`/api/partitions/${id}`, { method: "DELETE" });
}

// --- Environments ---

export async function listEnvironments(): Promise<Environment[]> {
  const data = await fetchJson<{ environments: Environment[] }>("/api/environments");
  return data.environments;
}

export async function createEnvironment(name: string, variables?: Record<string, string>): Promise<Environment> {
  const data = await fetchJson<{ environment: Environment }>("/api/environments", {
    method: "POST",
    body: JSON.stringify({ name, variables: variables ?? {} }),
  });
  return data.environment;
}

export async function getEnvironment(id: string): Promise<Environment> {
  const data = await fetchJson<{ environment: Environment }>(`/api/environments/${id}`);
  return data.environment;
}

export async function updateEnvironment(
  id: string,
  updates: { name?: string; variables?: Record<string, string> },
): Promise<Environment> {
  const data = await fetchJson<{ environment: Environment }>(`/api/environments/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.environment;
}

export async function deleteEnvironment(id: string): Promise<void> {
  await fetchJson(`/api/environments/${id}`, { method: "DELETE" });
}

// --- Deployments ---

export async function listDeployments(filters?: { partitionId?: string; artifactId?: string }): Promise<Deployment[]> {
  const params = new URLSearchParams();
  if (filters?.partitionId) params.set("partitionId", filters.partitionId);
  if (filters?.artifactId) params.set("artifactId", filters.artifactId);
  const qs = params.toString();
  const url = qs ? `/api/deployments?${qs}` : "/api/deployments";
  const data = await fetchJson<{ deployments: Deployment[] }>(url);
  return data.deployments;
}

export async function getDeployment(id: string): Promise<{ deployment: Deployment; debrief: DebriefEntry[] }> {
  return fetchJson(`/api/deployments/${id}`);
}

export async function createDeployment(trigger: {
  artifactId: string;
  environmentId?: string;
  partitionId?: string;
  version?: string;
}): Promise<{ deployment: Deployment }> {
  return fetchJson("/api/deployments", {
    method: "POST",
    body: JSON.stringify(trigger),
  });
}

export async function approveDeployment(
  id: string,
  data: { approvedBy: string; modifications?: string },
): Promise<{ deployment: Deployment; approved: boolean }> {
  return fetchJson(`/api/deployments/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function rejectDeployment(
  id: string,
  data: { reason: string },
): Promise<{ deployment: Deployment; rejected: boolean }> {
  return fetchJson(`/api/deployments/${id}/reject`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// --- Debrief / Reports ---

export async function getRecentDebrief(filters?: {
  limit?: number;
  partitionId?: string;
  decisionType?: string;
}): Promise<DebriefEntry[]> {
  const params = new URLSearchParams();
  if (filters?.limit) params.set("limit", String(filters.limit));
  if (filters?.partitionId) params.set("partitionId", filters.partitionId);
  if (filters?.decisionType) params.set("decisionType", filters.decisionType);
  const qs = params.toString();
  const url = qs ? `/api/debrief?${qs}` : "/api/debrief";
  const data = await fetchJson<{ entries: DebriefEntry[] }>(url);
  return data.entries;
}

export async function getPostmortem(deploymentId: string): Promise<PostmortemReport> {
  const data = await fetchJson<{ postmortem: PostmortemReport }>(`/api/deployments/${deploymentId}/postmortem`);
  return data.postmortem;
}

// --- Health ---

export async function getHealth(): Promise<{ status: string; service: string; timestamp: string }> {
  return fetchJson("/health");
}

export interface LlmHealthStatus {
  configured: boolean;
  healthy: boolean;
  provider?: string;
  lastChecked?: string;
}

export async function getLlmHealth(): Promise<LlmHealthStatus> {
  return fetchJson("/api/health/llm");
}

export interface CapabilityVerificationResult {
  task: string;
  model: string;
  status: "verified" | "marginal" | "insufficient";
  explanation: string;
}

export async function verifyTaskModel(
  task: string,
  model: string,
): Promise<CapabilityVerificationResult> {
  const data = await fetchJson<{ result: CapabilityVerificationResult }>(
    "/api/health/llm/verify-task",
    {
      method: "POST",
      body: JSON.stringify({ task, model }),
    },
  );
  return data.result;
}

// --- System State ---

export interface AlertSignal {
  type: "envoy-health" | "deployment-failure" | "drift";
  severity: "warning" | "critical";
  title: string;
  detail: string;
  relatedEntity?: { type: string; id: string; name: string };
}

export interface SystemState {
  state: "empty" | "normal" | "alert";
  signals: AlertSignal[];
  stats: {
    artifacts: number;
    envoys: number;
    deployments: { total: number; active: number; failed24h: number };
    environments: number;
  };
}

export async function getSystemState(): Promise<SystemState> {
  return fetchJson("/api/system/state");
}

// --- Agent Mode ---

export interface ContextSignal {
  type: "trend" | "health" | "drift";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  relatedEntity?: { type: string; id: string; name: string };
}

export interface DeploymentContext {
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

export async function getDeploymentContext(): Promise<DeploymentContext> {
  return fetchJson("/api/agent/context");
}

// --- Pre-flight Context ---

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

export async function getPreFlightContext(params: {
  artifactId: string;
  environmentId: string;
  partitionId?: string;
  version?: string;
}): Promise<PreFlightContext> {
  return fetchJson("/api/agent/pre-flight", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// --- Canvas Query ---

export interface CanvasQueryResult {
  action: "navigate" | "data";
  view: string;
  params: Record<string, string>;
  title?: string;
}

export async function queryAgent(query: string, conversationId?: string): Promise<CanvasQueryResult> {
  return fetchJson("/api/agent/query", {
    method: "POST",
    body: JSON.stringify({ query, conversationId }),
  });
}

// --- Settings ---

export async function getSettings(): Promise<AppSettings> {
  const data = await fetchJson<{ settings: AppSettings }>("/api/settings");
  return data.settings;
}

export async function updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
  const data = await fetchJson<{ settings: AppSettings }>("/api/settings", {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.settings;
}

export async function getCommandInfo(): Promise<CommandInfo> {
  const data = await fetchJson<{ info: CommandInfo }>("/api/settings/command-info");
  return data.info;
}

// --- Envoys ---

export interface EnvoyRegistryEntry {
  id: string;
  url: string;
  health: "OK" | "Degraded" | "Unreachable";
  hostname: string | null;
  lastSeen: string | null;
  summary: {
    totalDeployments: number;
    succeeded: number;
    failed: number;
    executing: number;
    environments: number;
  } | null;
  readiness: {
    ready: boolean;
    reason: string;
  } | null;
}

export async function listEnvoys(): Promise<EnvoyRegistryEntry[]> {
  const data = await fetchJson<{ envoys: EnvoyRegistryEntry[] }>("/api/envoys");
  return data.envoys;
}

export async function getEnvoyHealth(id: string): Promise<EnvoyRegistryEntry> {
  const data = await fetchJson<{ envoy: EnvoyRegistryEntry }>(`/api/envoys/${id}/health`);
  return data.envoy;
}
