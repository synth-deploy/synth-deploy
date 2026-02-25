import type {
  Project,
  Tenant,
  Environment,
  Deployment,
  DiaryEntry,
  PostmortemReport,
  ProjectHistory,
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

// --- Tenants ---

export async function listTenants(): Promise<Tenant[]> {
  const data = await fetchJson<{ tenants: Tenant[] }>("/api/tenants");
  return data.tenants;
}

export async function getTenant(id: string): Promise<Tenant> {
  const data = await fetchJson<{ tenant: Tenant }>(`/api/tenants/${id}`);
  return data.tenant;
}

export async function createTenant(name: string, variables?: Record<string, string>): Promise<Tenant> {
  const data = await fetchJson<{ tenant: Tenant }>("/api/tenants", {
    method: "POST",
    body: JSON.stringify({ name, variables: variables ?? {} }),
  });
  return data.tenant;
}

export async function updateTenantVariables(id: string, variables: Record<string, string>): Promise<Tenant> {
  const data = await fetchJson<{ tenant: Tenant }>(`/api/tenants/${id}/variables`, {
    method: "PUT",
    body: JSON.stringify({ variables }),
  });
  return data.tenant;
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

// --- Deployments ---

export async function listDeployments(tenantId?: string): Promise<Deployment[]> {
  const url = tenantId ? `/api/deployments?tenantId=${tenantId}` : "/api/deployments";
  const data = await fetchJson<{ deployments: Deployment[] }>(url);
  return data.deployments;
}

export async function listProjectDeployments(projectId: string): Promise<Deployment[]> {
  const data = await fetchJson<{ deployments: Deployment[] }>(`/api/projects/${projectId}/deployments`);
  return data.deployments;
}

export async function getDeployment(id: string): Promise<{ deployment: Deployment; diary: DiaryEntry[] }> {
  return fetchJson(`/api/deployments/${id}`);
}

export async function triggerDeployment(trigger: {
  projectId: string;
  tenantId: string;
  environmentId: string;
  version: string;
  variables?: Record<string, string>;
}): Promise<{ deployment: Deployment; diary: DiaryEntry[] }> {
  return fetchJson("/api/deployments", {
    method: "POST",
    body: JSON.stringify(trigger),
  });
}

// --- Diary / Reports ---

export async function getRecentDiary(limit?: number): Promise<DiaryEntry[]> {
  const url = limit ? `/api/diary?limit=${limit}` : "/api/diary";
  const data = await fetchJson<{ entries: DiaryEntry[] }>(url);
  return data.entries;
}

export async function getPostmortem(deploymentId: string): Promise<PostmortemReport> {
  const data = await fetchJson<{ postmortem: PostmortemReport }>(`/api/deployments/${deploymentId}/postmortem`);
  return data.postmortem;
}

export async function getTenantHistory(tenantId: string): Promise<ProjectHistory> {
  const data = await fetchJson<{ history: ProjectHistory }>(`/api/tenants/${tenantId}/history`);
  return data.history;
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
    tenantId: ResolvedField;
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
    tenantId?: string;
    environmentId?: string;
    version?: string;
    variables?: Record<string, string>;
  },
): Promise<IntentResult> {
  return fetchJson("/api/agent/interpret-intent", {
    method: "POST",
    body: JSON.stringify({ intent, partialConfig }),
  });
}

export async function getDeploymentContext(): Promise<DeploymentContext> {
  return fetchJson("/api/agent/context");
}
