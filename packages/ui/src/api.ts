import type {
  Operation,
  Partition,
  Environment,
  Deployment,
  DebriefEntry,
  PostmortemReport,
  OperationHistory,
  DeploymentStep,
  DeploymentStepType,
  DeployConfig,
  AppSettings,
  CommandInfo,
  Order,
  StepTypeDefinition,
} from "./types.js";

export type { OperationHistory };

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

// --- Operations ---

export async function listOperations(): Promise<Operation[]> {
  const data = await fetchJson<{ operations: Operation[] }>("/api/operations");
  return data.operations;
}

export async function getOperation(id: string): Promise<{ operation: Operation; environments: Environment[] }> {
  return fetchJson(`/api/operations/${id}`);
}

export async function createOperation(name: string, environmentIds: string[]): Promise<Operation> {
  const data = await fetchJson<{ operation: Operation }>("/api/operations", {
    method: "POST",
    body: JSON.stringify({ name, environmentIds }),
  });
  return data.operation;
}

export async function updateOperation(id: string, updates: { name?: string }): Promise<Operation> {
  const data = await fetchJson<{ operation: Operation }>(`/api/operations/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.operation;
}

export async function deleteOperation(id: string): Promise<void> {
  await fetchJson(`/api/operations/${id}`, { method: "DELETE" });
}

export async function addOperationEnvironment(operationId: string, environmentId: string): Promise<Operation> {
  const data = await fetchJson<{ operation: Operation }>(`/api/operations/${operationId}/environments`, {
    method: "POST",
    body: JSON.stringify({ environmentId }),
  });
  return data.operation;
}

export async function removeOperationEnvironment(operationId: string, environmentId: string): Promise<Operation> {
  const data = await fetchJson<{ operation: Operation }>(`/api/operations/${operationId}/environments/${environmentId}`, {
    method: "DELETE",
  });
  return data.operation;
}

export async function listOperationSteps(operationId: string): Promise<DeploymentStep[]> {
  const data = await fetchJson<{ steps: DeploymentStep[] }>(`/api/operations/${operationId}/steps`);
  return data.steps;
}

export async function createOperationStep(
  operationId: string,
  step: { name: string; type: DeploymentStepType; command?: string; order?: number; stepTypeId?: string; stepTypeConfig?: Record<string, unknown> },
): Promise<DeploymentStep> {
  const data = await fetchJson<{ step: DeploymentStep }>(`/api/operations/${operationId}/steps`, {
    method: "POST",
    body: JSON.stringify(step),
  });
  return data.step;
}

export async function updateOperationStep(
  operationId: string,
  stepId: string,
  updates: Partial<{ name: string; type: DeploymentStepType; command: string; order: number }>,
): Promise<DeploymentStep> {
  const data = await fetchJson<{ step: DeploymentStep }>(`/api/operations/${operationId}/steps/${stepId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.step;
}

export async function deleteOperationStep(operationId: string, stepId: string): Promise<void> {
  await fetchJson(`/api/operations/${operationId}/steps/${stepId}`, { method: "DELETE" });
}

export async function reorderOperationSteps(operationId: string, stepIds: string[]): Promise<DeploymentStep[]> {
  const data = await fetchJson<{ steps: DeploymentStep[] }>(`/api/operations/${operationId}/steps/reorder`, {
    method: "POST",
    body: JSON.stringify({ stepIds }),
  });
  return data.steps;
}

export async function getOperationDeployConfig(operationId: string): Promise<DeployConfig> {
  const data = await fetchJson<{ deployConfig: DeployConfig }>(`/api/operations/${operationId}/deploy-config`);
  return data.deployConfig;
}

export async function updateOperationDeployConfig(operationId: string, config: Partial<DeployConfig>): Promise<DeployConfig> {
  const data = await fetchJson<{ deployConfig: DeployConfig }>(`/api/operations/${operationId}/deploy-config`, {
    method: "PUT",
    body: JSON.stringify(config),
  });
  return data.deployConfig;
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

export async function listDeployments(partitionId?: string): Promise<Deployment[]> {
  const url = partitionId ? `/api/deployments?partitionId=${partitionId}` : "/api/deployments";
  const data = await fetchJson<{ deployments: Deployment[] }>(url);
  return data.deployments;
}

export async function listOperationDeployments(operationId: string): Promise<Deployment[]> {
  const data = await fetchJson<{ deployments: Deployment[] }>(`/api/operations/${operationId}/deployments`);
  return data.deployments;
}

export async function getDeployment(id: string): Promise<{ deployment: Deployment; debrief: DebriefEntry[] }> {
  return fetchJson(`/api/deployments/${id}`);
}

export async function triggerDeployment(trigger: {
  orderId: string;
  partitionId: string;
  environmentId: string;
  triggeredBy?: "user" | "agent";
  variables?: Record<string, string>;
}): Promise<{ deployment: Deployment; debrief: DebriefEntry[] }> {
  return fetchJson("/api/deployments", {
    method: "POST",
    body: JSON.stringify(trigger),
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

export async function getPartitionHistory(partitionId: string): Promise<OperationHistory> {
  const data = await fetchJson<{ history: OperationHistory }>(`/api/partitions/${partitionId}/history`);
  return data.history;
}

// --- Orders ---

export async function listOrders(filters?: {
  operationId?: string;
  partitionId?: string;
}): Promise<Order[]> {
  const params = new URLSearchParams();
  if (filters?.operationId) params.set("operationId", filters.operationId);
  if (filters?.partitionId) params.set("partitionId", filters.partitionId);
  const qs = params.toString();
  const url = qs ? `/api/orders?${qs}` : "/api/orders";
  const data = await fetchJson<{ orders: Order[] }>(url);
  return data.orders;
}

export async function getOrder(id: string): Promise<{ order: Order; deployments: Deployment[] }> {
  return fetchJson(`/api/orders/${id}`);
}

export async function createOrder(params: {
  operationId: string;
  partitionId: string;
  environmentId: string;
  version: string;
}): Promise<Order> {
  const data = await fetchJson<{ order: Order }>("/api/orders", {
    method: "POST",
    body: JSON.stringify(params),
  });
  return data.order;
}

export async function executeOrder(id: string): Promise<{ deployment: Deployment; debrief: DebriefEntry[] }> {
  return fetchJson(`/api/orders/${id}/execute`, { method: "POST" });
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

// --- Step Types ---

export async function listStepTypes(partitionId?: string): Promise<StepTypeDefinition[]> {
  const url = partitionId ? `/api/step-types?partitionId=${partitionId}` : "/api/step-types";
  const data = await fetchJson<{ stepTypes: StepTypeDefinition[] }>(url);
  return data.stepTypes;
}

export async function getStepType(id: string): Promise<StepTypeDefinition> {
  const data = await fetchJson<{ stepType: StepTypeDefinition }>(`/api/step-types/${id}`);
  return data.stepType;
}

export async function createStepType(stepType: {
  name: string;
  category: StepTypeDefinition["category"];
  description: string;
  parameters: StepTypeDefinition["parameters"];
  commandTemplate: string;
  partitionId?: string;
}): Promise<StepTypeDefinition> {
  const data = await fetchJson<{ stepType: StepTypeDefinition }>("/api/step-types", {
    method: "POST",
    body: JSON.stringify(stepType),
  });
  return data.stepType;
}

export async function deleteStepType(id: string): Promise<void> {
  await fetchJson(`/api/step-types/${id}`, { method: "DELETE" });
}

export async function exportStepType(id: string): Promise<unknown> {
  return fetchJson(`/api/step-types/${id}/export`);
}

export async function importStepType(data: unknown): Promise<StepTypeDefinition> {
  const result = await fetchJson<{ stepType: StepTypeDefinition }>("/api/step-types/import", {
    method: "POST",
    body: JSON.stringify(data),
  });
  return result.stepType;
}
