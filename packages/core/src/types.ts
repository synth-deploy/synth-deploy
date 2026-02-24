import { z } from "zod";

// --- Identifiers ---

export type TenantId = string;
export type DeploymentId = string;
export type ProjectId = string;
export type EnvironmentId = string;
export type DiaryEntryId = string;

// --- Deployment ---

export const DeploymentStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export const DeploymentTriggerSchema = z.object({
  projectId: z.string(),
  tenantId: z.string(),
  environmentId: z.string(),
  version: z.string(),
  variables: z.record(z.string()).optional(),
});
export type DeploymentTrigger = z.infer<typeof DeploymentTriggerSchema>;

export interface Deployment {
  id: DeploymentId;
  projectId: ProjectId;
  tenantId: TenantId;
  environmentId: EnvironmentId;
  version: string;
  status: DeploymentStatus;
  variables: Record<string, string>;
  diaryEntryIds: DiaryEntryId[];
  createdAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
}

// --- Decision Diary ---

export const AgentType = z.enum(["server", "tentacle"]);
export type AgentType = z.infer<typeof AgentType>;

export const DecisionType = z.enum([
  "pipeline-plan",
  "configuration-resolved",
  "variable-conflict",
  "health-check",
  "deployment-execution",
  "deployment-verification",
  "deployment-completion",
  "deployment-failure",
  "system",
]);
export type DecisionType = z.infer<typeof DecisionType>;

export interface DiaryEntry {
  id: DiaryEntryId;
  timestamp: Date;
  tenantId: TenantId | null;
  deploymentId: DeploymentId | null;
  agent: AgentType;
  decisionType: DecisionType;
  decision: string;
  reasoning: string;
  context: Record<string, unknown>;
}

// --- Tenant ---

export interface Tenant {
  id: TenantId;
  name: string;
  variables: Record<string, string>;
  createdAt: Date;
}

// --- Environment ---

export interface Environment {
  id: EnvironmentId;
  name: string;
  variables: Record<string, string>;
}

// --- Project ---

export interface Project {
  id: ProjectId;
  name: string;
  environmentIds: EnvironmentId[];
}
