import { z } from "zod";

// --- Identifiers ---

export type PartitionId = string;
export type DeploymentId = string;
export type OperationId = string;
export type EnvironmentId = string;
export type DebriefEntryId = string;
export type OrderId = string;

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
  orderId: z.string(),
  partitionId: z.string(),
  environmentId: z.string(),
  triggeredBy: z.enum(["user", "agent"]).default("user"),
  variables: z.record(z.string()).optional(),
});
export type DeploymentTrigger = z.infer<typeof DeploymentTriggerSchema>;

export interface Deployment {
  id: DeploymentId;
  operationId: OperationId;
  partitionId: PartitionId;
  environmentId: EnvironmentId;
  version: string;
  status: DeploymentStatus;
  variables: Record<string, string>;
  debriefEntryIds: DebriefEntryId[];
  orderId: OrderId | null;
  createdAt: Date;
  completedAt: Date | null;
  failureReason: string | null;
}

// --- Debrief ---

export const AgentType = z.enum(["command", "envoy"]);
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
  "order-created",
]);
export type DecisionType = z.infer<typeof DecisionType>;

export interface DebriefEntry {
  id: DebriefEntryId;
  timestamp: Date;
  partitionId: PartitionId | null;
  deploymentId: DeploymentId | null;
  agent: AgentType;
  decisionType: DecisionType;
  decision: string;
  reasoning: string;
  context: Record<string, unknown>;
}

// --- Partition ---

export interface Partition {
  id: PartitionId;
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

// --- Deployment Steps & Configuration ---

export type DeploymentStepType = "pre-deploy" | "post-deploy" | "verification";

export interface DeploymentStep {
  id: string;
  name: string;
  type: DeploymentStepType;
  command: string;
  order: number;
  /** ID of the step type used to create this step (if any) */
  stepTypeId?: string;
  /** Parameter values supplied when creating from a step type */
  stepTypeConfig?: Record<string, unknown>;
}

export interface DeployConfig {
  healthCheckEnabled: boolean;
  healthCheckRetries: number;
  timeoutMs: number;
  verificationStrategy: "basic" | "full" | "none";
}

export const DEFAULT_DEPLOY_CONFIG: DeployConfig = {
  healthCheckEnabled: true,
  healthCheckRetries: 1,
  timeoutMs: 30000,
  verificationStrategy: "basic",
};

// --- Operation ---

export interface Operation {
  id: OperationId;
  name: string;
  environmentIds: EnvironmentId[];
  steps: DeploymentStep[];
  deployConfig: DeployConfig;
}

// --- Order (immutable deployment snapshot) ---

export interface Order {
  id: OrderId;
  operationId: OperationId;
  operationName: string;
  partitionId: PartitionId;
  environmentId: EnvironmentId;
  environmentName: string;
  version: string;
  steps: DeploymentStep[];
  deployConfig: DeployConfig;
  variables: Record<string, string>;
  createdAt: Date;
}

// --- Settings ---

export type ConflictPolicy = "strict" | "permissive";

export type LlmEntityExposure = "names" | "none";

// --- LLM Provider Configuration ---

export type LlmProvider = "claude" | "openai" | "gemini" | "grok" | "deepseek" | "ollama" | "custom";

export interface LlmFallbackConfig {
  provider: LlmProvider;
  apiKeyConfigured: boolean;
  baseUrl?: string;
  model: string;
  timeoutMs: number;
}

export interface LlmProviderConfig {
  provider: LlmProvider;
  apiKeyConfigured: boolean;
  baseUrl?: string;
  reasoningModel: string;
  classificationModel: string;
  timeoutMs: number;
  rateLimitPerMin: number;
  fallbacks?: LlmFallbackConfig[];
}

export interface LlmHealthStatus {
  configured: boolean;
  healthy: boolean;
  provider?: string;
  lastChecked?: Date;
}

export interface AgentSettings {
  defaultHealthCheckRetries: number;
  defaultTimeoutMs: number;
  conflictPolicy: ConflictPolicy;
  defaultVerificationStrategy: "basic" | "full" | "none";
  /** Controls what entity data is sent to the LLM provider.
   *  "names" — send entity names only (IDs resolved locally)
   *  "none"  — omit entity lists entirely (regex-only resolution) */
  llmEntityExposure: LlmEntityExposure;
  /** Envoy-level LLM overrides — merged on top of app-level llm config */
  llmOverride?: Partial<LlmProviderConfig>;
}

export interface DeploymentDefaults {
  defaultDeployConfig: DeployConfig;
}

export interface EnvoyEndpointConfig {
  url: string;
  timeoutMs: number;
}

export interface CoBrandingConfig {
  operatorName: string;
  logoUrl: string;
  accentColor?: string;
}

export interface McpServerConfig {
  name: string;
  url: string;
  description?: string;
}

export interface AppSettings {
  environmentsEnabled: boolean;
  agent: AgentSettings;
  deploymentDefaults: DeploymentDefaults;
  envoy: EnvoyEndpointConfig;
  coBranding?: CoBrandingConfig;
  mcpServers?: McpServerConfig[];
  llm?: LlmProviderConfig;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  environmentsEnabled: true,
  agent: {
    defaultHealthCheckRetries: 1,
    defaultTimeoutMs: 30000,
    conflictPolicy: "permissive",
    defaultVerificationStrategy: "basic",
    llmEntityExposure: "names",
  },
  deploymentDefaults: {
    defaultDeployConfig: DEFAULT_DEPLOY_CONFIG,
  },
  envoy: {
    url: "http://localhost:3001",
    timeoutMs: 10000,
  },
  mcpServers: [],
};
