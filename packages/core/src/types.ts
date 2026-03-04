import { z } from "zod";

// --- Identifiers ---

export type PartitionId = string;
export type DeploymentId = string;
export type EnvironmentId = string;
export type DebriefEntryId = string;
export type EnvoyId = string;
export type ArtifactId = string;
export type ArtifactVersionId = string;
export type SecurityBoundaryId = string;

// --- Deployment ---

export const DeploymentStatus = z.enum([
  "pending",
  "planning",
  "approved",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
]);
export type DeploymentStatus = z.infer<typeof DeploymentStatus>;

export const DeploymentTriggerSchema = z.object({
  artifactId: z.string(),
  artifactVersionId: z.string().optional(),
  environmentId: z.string(),
  partitionId: z.string().optional(),
  triggeredBy: z.enum(["user", "agent"]).default("user"),
  variables: z.record(z.string()).optional(),
});
export type DeploymentTrigger = z.infer<typeof DeploymentTriggerSchema>;

// --- Deployment Plan & Execution ---

export interface DeploymentPlan {
  steps: PlannedStep[];
  reasoning: string;
  diffFromCurrent?: string;
  diffFromPreviousPlan?: string;
}

export interface PlannedStep {
  description: string;
  action: string;
  target: string;
  reversible: boolean;
  rollbackAction?: string;
}

export interface ExecutionRecord {
  startedAt: Date;
  completedAt?: Date;
  steps: ExecutedStep[];
}

export interface ExecutedStep {
  description: string;
  status: "completed" | "failed" | "rolled_back";
  startedAt: Date;
  completedAt?: Date;
  output?: string;
  error?: string;
}

// --- Deployment (unified lifecycle) ---

export interface Deployment {
  id: DeploymentId;
  artifactId: ArtifactId;
  artifactVersionId?: ArtifactVersionId;
  envoyId?: EnvoyId;
  environmentId: EnvironmentId;
  partitionId?: PartitionId;
  version: string;
  status: DeploymentStatus;
  variables: Record<string, string>;
  plan?: DeploymentPlan;
  rollbackPlan?: DeploymentPlan;
  executionRecord?: ExecutionRecord;
  approvedBy?: string;
  approvedAt?: Date;
  debriefEntryIds: DebriefEntryId[];
  createdAt: Date;
  completedAt?: Date;
  failureReason?: string;
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
  "artifact-analysis",
  "plan-generation",
  "plan-approval",
  "plan-rejection",
  "rollback-execution",
  "cross-system-context",
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
  actor?: string;
}

// --- Partition ---

export interface Partition {
  id: PartitionId;
  name: string;
  variables: Record<string, string>;
  constraints?: Record<string, unknown>;
  createdAt: Date;
}

// --- Environment ---

export interface Environment {
  id: EnvironmentId;
  name: string;
  variables: Record<string, string>;
}

// --- Artifact ---

export interface ArtifactAnalysis {
  summary: string;
  dependencies: string[];
  configurationExpectations: Record<string, string>;
  deploymentIntent?: string;
  confidence: number;
}

export interface ArtifactAnnotation {
  field: string;
  correction: string;
  annotatedBy: string;
  annotatedAt: Date;
}

export interface LearningHistoryEntry {
  timestamp: Date;
  event: string;
  details: string;
}

export interface Artifact {
  id: ArtifactId;
  name: string;
  type: string;
  analysis: ArtifactAnalysis;
  annotations: ArtifactAnnotation[];
  learningHistory: LearningHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactVersion {
  id: ArtifactVersionId;
  artifactId: ArtifactId;
  version: string;
  source: string;
  metadata: Record<string, string>;
  createdAt: Date;
}

// --- Security Boundaries ---

export type SecurityBoundaryType =
  | "filesystem"
  | "service"
  | "network"
  | "credential"
  | "execution";

export interface SecurityBoundary {
  id: SecurityBoundaryId;
  envoyId: EnvoyId;
  boundaryType: SecurityBoundaryType;
  config: Record<string, unknown>;
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
  defaultHealthCheckEnabled: boolean;
  defaultHealthCheckRetries: number;
  defaultTimeoutMs: number;
  defaultVerificationStrategy: "basic" | "full" | "none";
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
    defaultHealthCheckEnabled: true,
    defaultHealthCheckRetries: 1,
    defaultTimeoutMs: 30000,
    defaultVerificationStrategy: "basic",
  },
  envoy: {
    url: "http://localhost:3001",
    timeoutMs: 10000,
  },
  mcpServers: [],
};
