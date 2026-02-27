import { z } from "zod";

// --- Identifiers ---

export type TenantId = string;
export type DeploymentId = string;
export type ProjectId = string;
export type EnvironmentId = string;
export type DebriefEntryId = string;

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
  debriefEntryIds: DebriefEntryId[];
  createdAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
}

// --- Debrief ---

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
  "diagnostic-investigation",
  "environment-scan",
  "system",
  "llm-call",
]);
export type DecisionType = z.infer<typeof DecisionType>;

export interface DebriefEntry {
  id: DebriefEntryId;
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

// --- Deployment Steps & Pipeline ---

export type DeploymentStepType = "pre-deploy" | "post-deploy" | "verification";

export interface DeploymentStep {
  id: string;
  name: string;
  type: DeploymentStepType;
  command: string;
  order: number;
}

export interface PipelineConfig {
  healthCheckEnabled: boolean;
  healthCheckRetries: number;
  timeoutMs: number;
  verificationStrategy: "basic" | "full" | "none";
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  healthCheckEnabled: true,
  healthCheckRetries: 1,
  timeoutMs: 30000,
  verificationStrategy: "basic",
};

// --- Project ---

export interface Project {
  id: ProjectId;
  name: string;
  environmentIds: EnvironmentId[];
  steps: DeploymentStep[];
  pipelineConfig: PipelineConfig;
}

// --- Settings ---

export type ConflictPolicy = "strict" | "permissive";

export interface AgentSettings {
  defaultHealthCheckRetries: number;
  defaultTimeoutMs: number;
  conflictPolicy: ConflictPolicy;
  defaultVerificationStrategy: "basic" | "full" | "none";
}

export interface DeploymentDefaults {
  defaultVariableTemplates: Record<string, string>;
  defaultPipelineConfig: PipelineConfig;
}

export interface TentacleEndpointConfig {
  url: string;
  timeoutMs: number;
}

export interface AppSettings {
  agent: AgentSettings;
  deploymentDefaults: DeploymentDefaults;
  tentacle: TentacleEndpointConfig;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  agent: {
    defaultHealthCheckRetries: 1,
    defaultTimeoutMs: 30000,
    conflictPolicy: "permissive",
    defaultVerificationStrategy: "basic",
  },
  deploymentDefaults: {
    defaultVariableTemplates: {},
    defaultPipelineConfig: DEFAULT_PIPELINE_CONFIG,
  },
  tentacle: {
    url: "http://localhost:3001",
    timeoutMs: 10000,
  },
};
