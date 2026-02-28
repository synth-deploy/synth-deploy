import type {
  Project,
  Partition,
  Environment,
  Deployment,
  DebriefEntry,
  PostmortemReport,
  ProjectHistory,
  DeploymentStep,
  DeploymentStepType,
  DeployConfig,
  AppSettings,
  CommandInfo,
  Order,
} from "./types.js";

const BASE = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

// --- Projects ---

export async function listProjects(): Promise<Project[]> {
  const data = await fetchJson<{ projects: Project[] }>("/api/projects");
  return data.projects;
}

export async function getProject(id: string): Promise<{ project: Project; environments: Environment[] }> {
  return fetchJson(`/api/projects/${id}`);
}

export async function createProject(name: string, environmentIds: string[]): Promise<Project> {
  const data = await fetchJson<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, environmentIds }),
  });
  return data.project;
}

export async function updateProject(id: string, updates: { name?: string }): Promise<Project> {
  const data = await fetchJson<{ project: Project }>(`/api/projects/${id}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.project;
}

export async function deleteProject(id: string): Promise<void> {
  await fetchJson(`/api/projects/${id}`, { method: "DELETE" });
}

export async function addProjectEnvironment(projectId: string, environmentId: string): Promise<Project> {
  const data = await fetchJson<{ project: Project }>(`/api/projects/${projectId}/environments`, {
    method: "POST",
    body: JSON.stringify({ environmentId }),
  });
  return data.project;
}

export async function removeProjectEnvironment(projectId: string, environmentId: string): Promise<Project> {
  const data = await fetchJson<{ project: Project }>(`/api/projects/${projectId}/environments/${environmentId}`, {
    method: "DELETE",
  });
  return data.project;
}

export async function listProjectSteps(projectId: string): Promise<DeploymentStep[]> {
  const data = await fetchJson<{ steps: DeploymentStep[] }>(`/api/projects/${projectId}/steps`);
  return data.steps;
}

export async function createProjectStep(
  projectId: string,
  step: { name: string; type: DeploymentStepType; command: string; order?: number },
): Promise<DeploymentStep> {
  const data = await fetchJson<{ step: DeploymentStep }>(`/api/projects/${projectId}/steps`, {
    method: "POST",
    body: JSON.stringify(step),
  });
  return data.step;
}

export async function updateProjectStep(
  projectId: string,
  stepId: string,
  updates: Partial<{ name: string; type: DeploymentStepType; command: string; order: number }>,
): Promise<DeploymentStep> {
  const data = await fetchJson<{ step: DeploymentStep }>(`/api/projects/${projectId}/steps/${stepId}`, {
    method: "PUT",
    body: JSON.stringify(updates),
  });
  return data.step;
}

export async function deleteProjectStep(projectId: string, stepId: string): Promise<void> {
  await fetchJson(`/api/projects/${projectId}/steps/${stepId}`, { method: "DELETE" });
}

export async function reorderProjectSteps(projectId: string, stepIds: string[]): Promise<DeploymentStep[]> {
  const data = await fetchJson<{ steps: DeploymentStep[] }>(`/api/projects/${projectId}/steps/reorder`, {
    method: "POST",
    body: JSON.stringify({ stepIds }),
  });
  return data.steps;
}

export async function getProjectDeployConfig(projectId: string): Promise<DeployConfig> {
  const data = await fetchJson<{ deployConfig: DeployConfig }>(`/api/projects/${projectId}/deploy-config`);
  return data.deployConfig;
}

export async function updateProjectDeployConfig(projectId: string, config: Partial<DeployConfig>): Promise<DeployConfig> {
  const data = await fetchJson<{ deployConfig: DeployConfig }>(`/api/projects/${projectId}/deploy-config`, {
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

export async function listProjectDeployments(projectId: string): Promise<Deployment[]> {
  const data = await fetchJson<{ deployments: Deployment[] }>(`/api/projects/${projectId}/deployments`);
  return data.deployments;
}

export async function getDeployment(id: string): Promise<{ deployment: Deployment; debrief: DebriefEntry[] }> {
  return fetchJson(`/api/deployments/${id}`);
}

export async function triggerDeployment(trigger: {
  projectId: string;
  partitionId: string;
  environmentId: string;
  version: string;
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

export async function getPartitionHistory(partitionId: string): Promise<ProjectHistory> {
  const data = await fetchJson<{ history: ProjectHistory }>(`/api/partitions/${partitionId}/history`);
  return data.history;
}

// --- Orders ---

export async function listOrders(filters?: {
  projectId?: string;
  partitionId?: string;
}): Promise<Order[]> {
  const params = new URLSearchParams();
  if (filters?.projectId) params.set("projectId", filters.projectId);
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
  projectId: string;
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

// --- Agent Mode ---

export interface ResolvedField {
  value: string;
  confidence: "exact" | "inferred" | "missing";
  matchedFrom?: string;
}

export interface IntentResult {
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

export async function interpretIntent(
  intent: string,
  partialConfig?: {
    projectId?: string;
    partitionId?: string;
    environmentId?: string;
    version?: string;
    variables?: Record<string, string>;
  },
  conversationId?: string,
): Promise<IntentResult> {
  return fetchJson("/api/agent/interpret-intent", {
    method: "POST",
    body: JSON.stringify({ intent, partialConfig, conversationId }),
  });
}

export async function getDeploymentContext(): Promise<DeploymentContext> {
  return fetchJson("/api/agent/context");
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
