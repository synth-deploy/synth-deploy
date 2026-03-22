import type {
  Partition,
  Environment,
  Deployment,
  DeploymentEnrichment,
  DeploymentPlan,
  DeploymentRecommendation,
  PlannedStep,
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

export function getAuthToken(): string | null {
  return authToken;
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

/** Like fetchJson but does NOT set Content-Type — lets the browser set multipart boundaries. */
async function fetchJsonRaw<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
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

export async function authMe(): Promise<{ user: { id: string; email: string; name: string; authSource: string; createdAt: string; updatedAt: string }; permissions: string[] }> {
  return fetchJson("/api/auth/me");
}

export async function authStatus(): Promise<{ needsSetup: boolean }> {
  return fetchJson("/api/auth/status");
}

export async function authUpdateMe(data: { name?: string; email?: string }): Promise<{ user: { id: string; email: string; name: string; authSource: string; createdAt: string; updatedAt: string } }> {
  return fetchJson("/api/auth/me", { method: "PUT", body: JSON.stringify(data) });
}

export async function authChangePassword(data: { currentPassword: string; newPassword: string }): Promise<void> {
  await fetchJson("/api/auth/me/password", { method: "POST", body: JSON.stringify(data) });
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

export async function listDeployments(filters?: { partitionId?: string; artifactId?: string; envoyId?: string }): Promise<Deployment[]> {
  const params = new URLSearchParams();
  if (filters?.partitionId) params.set("partitionId", filters.partitionId);
  if (filters?.artifactId) params.set("artifactId", filters.artifactId);
  if (filters?.envoyId) params.set("envoyId", filters.envoyId);
  const qs = params.toString();
  const url = qs ? `/api/operations?${qs}` : "/api/operations";
  const data = await fetchJson<{ deployments: Deployment[] }>(url);
  return data.deployments;
}

export async function getDeployment(id: string): Promise<{ deployment: Deployment; debrief: DebriefEntry[] }> {
  return fetchJson(`/api/operations/${id}`);
}

export interface WhatsNewResult {
  deployedVersion: string;
  latestVersion: string | null;
  isLatest: boolean;
  latestCreatedAt: string | null;
}

export async function getWhatsNew(deploymentId: string): Promise<WhatsNewResult> {
  return fetchJson(`/api/operations/${deploymentId}/whats-new`);
}

export async function createDeployment(trigger: {
  artifactId: string;
  environmentId?: string;
  partitionId?: string;
  envoyId?: string;
  version?: string;
}): Promise<{ deployment: Deployment }> {
  return fetchJson("/api/operations", {
    method: "POST",
    body: JSON.stringify(trigger),
  });
}

export async function approveDeployment(
  id: string,
  data: { approvedBy: string; modifications?: string },
): Promise<{ deployment: Deployment; approved: boolean }> {
  return fetchJson(`/api/operations/${id}/approve`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function rejectDeployment(
  id: string,
  data: { reason: string },
): Promise<{ deployment: Deployment; rejected: boolean }> {
  return fetchJson(`/api/operations/${id}/reject`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function modifyDeploymentPlan(
  id: string,
  data: { steps: PlannedStep[]; reason: string },
): Promise<{ deployment: Deployment; modified: boolean }> {
  return fetchJson(`/api/operations/${id}/modify`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getDeploymentEnrichment(
  id: string,
): Promise<{ enrichment: DeploymentEnrichment; recommendation?: DeploymentRecommendation }> {
  return fetchJson(`/api/operations/${id}/context`);
}

export async function requestRollbackPlan(
  id: string,
): Promise<{ deployment: Deployment; rollbackPlan: DeploymentPlan }> {
  return fetchJson(`/api/operations/${id}/request-rollback-plan`, { method: "POST", body: JSON.stringify({}) });
}

export async function executeRollback(
  id: string,
): Promise<{ deployment: Deployment; accepted: boolean }> {
  return fetchJson(`/api/operations/${id}/execute-rollback`, { method: "POST", body: JSON.stringify({}) });
}

export async function retryDeployment(
  id: string,
): Promise<{ deployment: Deployment; sourceDeploymentId: string; attemptNumber: number }> {
  return fetchJson(`/api/operations/${id}/retry`, { method: "POST", body: JSON.stringify({}) });
}

export async function replanDeployment(deploymentId: string, feedback: string): Promise<{ deployment: Deployment } | { mode: "response"; message: string }> {
  return fetchJson(`/api/operations/${deploymentId}/replan`, {
    method: "POST",
    body: JSON.stringify({ feedback }),
  });
}

// --- Postmortem types ---

export interface LlmPostmortem {
  executiveSummary: string;
  timeline: Array<{ timestamp: string; event: string; significance: string }>;
  rootCause: string;
  contributingFactors: string[];
  remediationSteps: string[];
  lessonsLearned: string[];
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

export async function getPostmortem(deploymentId: string): Promise<{ postmortem: PostmortemReport; llmPostmortem?: LlmPostmortem }> {
  return fetchJson(`/api/operations/${deploymentId}/postmortem`);
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
  investigation: {
    title: string;
    entity: string;
    entityType: string;
    status: string;
    detectedAt: string;
    synthAssessment: { confidence: number; summary: string };
    evidence: Array<{ label: string; value: string; status: "healthy" | "warning" | "info" }>;
    recommendations: Array<{ action: string; detail: string; priority: "high" | "medium" | "low" }>;
    timeline: Array<{ time: string; event: string }>;
    relatedDeployments: Array<{ artifact: string; version: string; target: string; status: string; time: string }>;
    driftConflicts?: Array<{ variable: string; partitionValue: string; violatedRule: string; affectedEnvoy: string }>;
  };
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
  assessment: {
    headline: string;
    detail: string;
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

export async function recordPreFlightResponse(params: {
  artifactId: string;
  environmentId: string;
  partitionId?: string;
  action: "proceeded" | "waited" | "canceled";
  recommendedAction: "proceed" | "wait" | "investigate";
}): Promise<void> {
  await fetchJson("/api/agent/pre-flight/response", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// --- Canvas Query ---

export interface CanvasQueryResult {
  action: "navigate" | "data" | "create" | "answer";
  view: string;
  params: Record<string, string>;
  title?: string;
  content?: string;
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
  name: string;
  url: string;
  health: "OK" | "Degraded" | "Unreachable";
  hostname: string | null;
  os: string | null;
  lastSeen: string | null;
  assignedEnvironments: string[];
  assignedPartitions: string[];
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

export async function registerEnvoy(name: string, url: string): Promise<EnvoyRegistryEntry> {
  const data = await fetchJson<{ envoy: EnvoyRegistryEntry }>("/api/envoys", {
    method: "POST",
    body: JSON.stringify({ name, url }),
  });
  return data.envoy;
}

export async function getEnvoyHealth(id: string): Promise<EnvoyRegistryEntry> {
  const data = await fetchJson<{ envoy: EnvoyRegistryEntry }>(`/api/envoys/${id}/health`);
  return data.envoy;
}

export async function updateEnvoy(
  id: string,
  updates: { assignedEnvironments?: string[]; assignedPartitions?: string[]; name?: string; url?: string },
): Promise<EnvoyRegistryEntry> {
  const data = await fetchJson<{ envoy: EnvoyRegistryEntry }>(`/api/envoys/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.envoy;
}

export interface EnvoySecurityBoundary {
  id: string;
  envoyId: string;
  boundaryType: "filesystem" | "service" | "network" | "credential" | "execution";
  config: Record<string, unknown>;
}

export async function getEnvoySecurityBoundaries(envoyId: string): Promise<EnvoySecurityBoundary[]> {
  const data = await fetchJson<{ boundaries: EnvoySecurityBoundary[] }>(`/api/envoys/${envoyId}/security-boundaries`);
  return data.boundaries;
}

export interface EnvoyKnowledgeItem {
  id: string;
  timestamp: string;
  text: string;
}

export async function getEnvoyKnowledge(envoyId: string): Promise<EnvoyKnowledgeItem[]> {
  const data = await fetchJson<{ knowledge: EnvoyKnowledgeItem[] }>(`/api/envoys/${envoyId}/knowledge`);
  return data.knowledge;
}

// --- Identity Providers ---

import type { IdpProvider, RoleMappingRule, IdpProviderPublic, IntakeChannel, IntakeEvent } from "./types.js";

export async function listIdpProviders(): Promise<IdpProvider[]> {
  const data = await fetchJson<{ providers: IdpProvider[] }>("/api/idp/providers");
  return data.providers;
}

export async function createIdpProvider(params: {
  type: string;
  name: string;
  enabled?: boolean;
  config: Record<string, unknown>;
}): Promise<IdpProvider> {
  const data = await fetchJson<{ provider: IdpProvider }>("/api/idp/providers", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return data.provider;
}

export async function updateIdpProvider(
  id: string,
  updates: { name?: string; enabled?: boolean; config?: Record<string, unknown> },
): Promise<IdpProvider> {
  const data = await fetchJson<{ provider: IdpProvider }>(`/api/idp/providers/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.provider;
}

export async function deleteIdpProvider(id: string): Promise<void> {
  await fetchJson(`/api/idp/providers/${id}`, { method: "DELETE" });
}

export async function testIdpProvider(id: string): Promise<{ success: boolean; error?: string }> {
  return fetchJson(`/api/idp/providers/${id}/test`, { method: "POST" });
}

export async function listRoleMappings(providerId: string): Promise<RoleMappingRule[]> {
  const data = await fetchJson<{ mappings: RoleMappingRule[] }>(`/api/idp/providers/${providerId}/mappings`);
  return data.mappings;
}

export async function createRoleMapping(
  providerId: string,
  params: { idpGroup: string; synthRole: string },
): Promise<RoleMappingRule> {
  const data = await fetchJson<{ mapping: RoleMappingRule }>(`/api/idp/providers/${providerId}/mappings`, {
    method: "POST",
    body: JSON.stringify(params),
  });
  return data.mapping;
}

export async function deleteRoleMapping(id: string): Promise<void> {
  await fetchJson(`/api/idp/mappings/${id}`, { method: "DELETE" });
}

export async function listEnabledAuthProviders(): Promise<IdpProviderPublic[]> {
  const data = await fetchJson<{ providers: IdpProviderPublic[] }>("/api/auth/providers");
  return data.providers;
}

// --- LDAP ---

export async function testLdapUser(
  providerId: string,
  username: string,
): Promise<{ found: boolean; userDn?: string; email?: string; displayName?: string; error?: string }> {
  return fetchJson(`/api/idp/providers/${providerId}/test-ldap-user`, {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export async function ldapLogin(
  providerId: string,
  username: string,
  password: string,
): Promise<AuthLoginResult> {
  return fetchJson(`/api/auth/ldap/${providerId}/login`, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

// --- Fleet Deployments ---

export interface FleetProgress {
  totalEnvoys: number;
  validated: number;
  executing: number;
  succeeded: number;
  failed: number;
  pending: number;
  currentBatch?: number;
  totalBatches?: number;
}

export interface EnvoyValidationResult {
  envoyId: string;
  envoyName: string;
  validated: boolean;
  issues?: string[];
}

export interface FleetValidationResult {
  total: number;
  validated: number;
  failed: number;
  results: EnvoyValidationResult[];
}

export interface RolloutConfig {
  strategy: "all-at-once" | "batched" | "canary";
  batchSize?: number;
  batchPercent?: number;
  pauseBetweenBatches: boolean;
  haltOnFailureCount: number;
  healthCheckWaitMs: number;
}

export type FleetDeploymentStatus =
  | "selecting_representatives"
  | "planning"
  | "awaiting_approval"
  | "validating"
  | "executing"
  | "validated"
  | "paused"
  | "completed"
  | "failed"
  | "rolled_back";

export interface FleetDeployment {
  id: string;
  artifactId: string;
  artifactVersionId: string;
  environmentId: string;
  envoyFilter?: string[];
  rolloutConfig: RolloutConfig;
  representativeEnvoyIds: string[];
  representativePlanId?: string;
  status: FleetDeploymentStatus;
  validationResult?: FleetValidationResult;
  progress: FleetProgress;
  createdAt: string;
  updatedAt: string;
}

export async function listFleetDeployments(): Promise<FleetDeployment[]> {
  const data = await fetchJson<{ fleetDeployments: FleetDeployment[] }>("/api/fleet-deployments");
  return data.fleetDeployments;
}

export async function getFleetDeployment(id: string): Promise<FleetDeployment> {
  const data = await fetchJson<{ fleetDeployment: FleetDeployment }>(`/api/fleet-deployments/${id}`);
  return data.fleetDeployment;
}

export async function createFleetDeployment(params: {
  artifactId: string;
  environmentId: string;
  artifactVersionId?: string;
  envoyFilter?: string[];
  rolloutConfig?: Partial<RolloutConfig>;
}): Promise<FleetDeployment> {
  const data = await fetchJson<{ fleetDeployment: FleetDeployment }>("/api/fleet-deployments", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return data.fleetDeployment;
}

export async function approveFleetDeployment(id: string): Promise<FleetDeployment> {
  const data = await fetchJson<{ fleetDeployment: FleetDeployment }>(`/api/fleet-deployments/${id}/approve`, {
    method: "POST",
  });
  return data.fleetDeployment;
}

export async function executeFleetDeployment(id: string): Promise<FleetDeployment> {
  const data = await fetchJson<{ fleetDeployment: FleetDeployment }>(`/api/fleet-deployments/${id}/execute`, {
    method: "POST",
  });
  return data.fleetDeployment;
}

export async function pauseFleetDeployment(id: string): Promise<FleetDeployment> {
  const data = await fetchJson<{ fleetDeployment: FleetDeployment }>(`/api/fleet-deployments/${id}/pause`, {
    method: "POST",
  });
  return data.fleetDeployment;
}

export async function resumeFleetDeployment(id: string): Promise<FleetDeployment> {
  const data = await fetchJson<{ fleetDeployment: FleetDeployment }>(`/api/fleet-deployments/${id}/resume`, {
    method: "POST",
  });
  return data.fleetDeployment;
}

// --- Artifact Intake ---

export async function listIntakeChannels(): Promise<IntakeChannel[]> {
  const data = await fetchJson<{ channels: IntakeChannel[] }>("/api/intake/channels");
  return data.channels;
}

export async function createIntakeChannel(params: {
  type: string;
  name: string;
  enabled?: boolean;
  config: Record<string, unknown>;
}): Promise<IntakeChannel> {
  const data = await fetchJson<{ channel: IntakeChannel }>("/api/intake/channels", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return data.channel;
}

export async function updateIntakeChannel(
  id: string,
  updates: { name?: string; enabled?: boolean; config?: Record<string, unknown> },
): Promise<IntakeChannel> {
  const data = await fetchJson<{ channel: IntakeChannel }>(`/api/intake/channels/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.channel;
}

export async function deleteIntakeChannel(id: string): Promise<void> {
  await fetchJson(`/api/intake/channels/${id}`, { method: "DELETE" });
}

export async function testIntakeChannel(id: string): Promise<{ success: boolean; error?: string; status?: number }> {
  return fetchJson(`/api/intake/channels/${id}/test`, { method: "POST" });
}

export async function manualUploadArtifact(data: {
  artifactName: string;
  artifactType: string;
  version: string;
}): Promise<{ eventId: string; artifactId: string; versionId: string }> {
  return fetchJson("/api/intake/manual", {
    method: "POST",
    body: JSON.stringify({ ...data, source: "manual-upload" }),
  });
}

export async function uploadArtifactFile(
  file: File,
  existingArtifactId?: string,
): Promise<{ eventId: string; artifactId: string; versionId: string }> {
  const form = new FormData();
  form.append("file", file);
  if (existingArtifactId) form.append("existingArtifactId", existingArtifactId);
  return fetchJsonRaw("/api/intake/upload", { method: "POST", body: form });
}

export async function listIntakeEvents(params?: { channelId?: string; limit?: number }): Promise<IntakeEvent[]> {
  const qs = new URLSearchParams();
  if (params?.channelId) qs.set("channelId", params.channelId);
  if (params?.limit) qs.set("limit", String(params.limit));
  const query = qs.toString();
  const data = await fetchJson<{ events: IntakeEvent[] }>(`/api/intake/events${query ? `?${query}` : ""}`);
  return data.events;
}

// --- Sessions ---

export interface SessionPublic {
  id: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
}

export async function listSessions(): Promise<SessionPublic[]> {
  const data = await fetchJson<{ sessions: SessionPublic[] }>("/api/auth/sessions");
  return data.sessions;
}

export async function revokeSession(id: string): Promise<void> {
  await fetchJson(`/api/auth/sessions/${id}`, { method: "DELETE" });
}

export async function revokeOtherSessions(): Promise<void> {
  await fetchJson("/api/auth/sessions", { method: "DELETE" });
}

// --- API Keys ---

export interface ApiKeyPublic {
  id: string;
  name: string;
  keyPrefix: string;
  keySuffix: string;
  permissions: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listApiKeys(): Promise<ApiKeyPublic[]> {
  const data = await fetchJson<{ apiKeys: ApiKeyPublic[] }>("/api/auth/api-keys");
  return data.apiKeys;
}

export async function createApiKey(data: { name: string; permissions: string[] }): Promise<{ key: ApiKeyPublic; fullKey: string }> {
  return fetchJson("/api/auth/api-keys", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function revokeApiKey(id: string): Promise<void> {
  await fetchJson(`/api/auth/api-keys/${id}`, { method: "DELETE" });
}

export async function regenerateApiKey(id: string): Promise<{ key: ApiKeyPublic; fullKey: string }> {
  return fetchJson(`/api/auth/api-keys/${id}/regenerate`, { method: "POST" });
}
