// Frontend type definitions mirroring @deploystack/core types.
// Dates come as ISO strings from the API.

export type DeploymentStepType = "pre-deploy" | "post-deploy" | "verification";

export interface DeploymentStep {
  id: string;
  name: string;
  type: DeploymentStepType;
  command: string;
  order: number;
  stepTypeId?: string;
  stepTypeConfig?: Record<string, unknown>;
}

export type StepTypeParameterType = "string" | "number" | "boolean" | "select";

export interface StepTypeParameter {
  name: string;
  label: string;
  type: StepTypeParameterType;
  required: boolean;
  default?: string | number | boolean;
  options?: string[];
  description?: string;
  validation?: {
    pattern?: string;
    min?: number;
    max?: number;
  };
}

export type StepTypeSource = "predefined" | "custom" | "community";

export type StepTypeCategory =
  | "General"
  | "File & Artifact"
  | "Service"
  | "Verification"
  | "Database"
  | "Container"
  | "Networking & Traffic"
  | "Cloud & Infrastructure"
  | "Configuration & Secrets"
  | "Monitoring & Observability"
  | "Rollback & Recovery"
  | "Git & Versioning"
  | "Security & Compliance"
  | "Package & Artifact Management"
  | "SSH & Remote Execution";

export interface StepTypeDefinition {
  id: string;
  name: string;
  category: StepTypeCategory;
  description: string;
  parameters: StepTypeParameter[];
  commandTemplate: string;
  source: StepTypeSource;
  partitionId?: string;
}

export interface DeployConfig {
  healthCheckEnabled: boolean;
  healthCheckRetries: number;
  timeoutMs: number;
  verificationStrategy: "basic" | "full" | "none";
}

export interface Operation {
  id: string;
  name: string;
  environmentIds: string[];
  steps: DeploymentStep[];
  deployConfig: DeployConfig;
}

export type ConflictPolicy = "strict" | "permissive";

export type TaskModelTask =
  | "logClassification"
  | "diagnosticSynthesis"
  | "postmortemGeneration"
  | "queryAnswering";

export interface TaskModelConfig {
  logClassification?: string;
  diagnosticSynthesis?: string;
  postmortemGeneration?: string;
  queryAnswering?: string;
}

export interface TaskModelMeta {
  label: string;
  tier: string;
  tokenBudget: string;
  reasoningDepth: string;
}

export const TASK_MODEL_META: Record<TaskModelTask, TaskModelMeta> = {
  logClassification: {
    label: "Log pattern classification",
    tier: "Lightweight",
    tokenBudget: "~1,024",
    reasoningDepth: "Structured classification",
  },
  diagnosticSynthesis: {
    label: "Diagnostic report synthesis",
    tier: "Mid-range",
    tokenBudget: "~2,048",
    reasoningDepth: "Evidence \u2192 narrative",
  },
  postmortemGeneration: {
    label: "Postmortem generation",
    tier: "Capable",
    tokenBudget: "~4,096",
    reasoningDepth: "Multi-event causal chain",
  },
  queryAnswering: {
    label: "Query answering",
    tier: "Mid-range",
    tokenBudget: "~1,024",
    reasoningDepth: "Data-grounded synthesis",
  },
};

export interface CapabilityVerificationResult {
  task: string;
  model: string;
  status: "verified" | "marginal" | "insufficient";
  explanation: string;
}

export interface AgentSettings {
  defaultHealthCheckRetries: number;
  defaultTimeoutMs: number;
  conflictPolicy: ConflictPolicy;
  defaultVerificationStrategy: "basic" | "full" | "none";
  taskModels?: TaskModelConfig;
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
  lastChecked?: string;
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

export interface CommandInfo {
  version: string;
  host: string;
  port: number;
  startedAt: string;
}

export interface Partition {
  id: string;
  name: string;
  variables: Record<string, string>;
  createdAt: string;
}

export interface Environment {
  id: string;
  name: string;
  variables: Record<string, string>;
}

export type DeploymentStatus = "pending" | "running" | "succeeded" | "failed" | "rolled_back";

export interface Deployment {
  id: string;
  operationId: string;
  partitionId: string;
  environmentId: string;
  version: string;
  status: DeploymentStatus;
  variables: Record<string, string>;
  debriefEntryIds: string[];
  orderId: string | null;
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
}

export type DecisionType =
  | "pipeline-plan"
  | "configuration-resolved"
  | "variable-conflict"
  | "health-check"
  | "deployment-execution"
  | "deployment-verification"
  | "deployment-completion"
  | "deployment-failure"
  | "diagnostic-investigation"
  | "environment-scan"
  | "system"
  | "order-created";

export type AgentType = "command" | "envoy";

export interface DebriefEntry {
  id: string;
  timestamp: string;
  partitionId: string | null;
  deploymentId: string | null;
  agent: AgentType;
  decisionType: DecisionType;
  decision: string;
  reasoning: string;
  context: Record<string, unknown>;
}

export interface Order {
  id: string;
  operationId: string;
  operationName: string;
  partitionId: string;
  environmentId: string;
  environmentName: string;
  version: string;
  steps: DeploymentStep[];
  deployConfig: DeployConfig;
  variables: Record<string, string>;
  createdAt: string;
}

export interface PostmortemReport {
  summary: string;
  timeline: Array<{
    timestamp: string;
    step: string;
    decision: string;
    reasoning: string;
  }>;
  configuration: {
    variableCount: number;
    conflictCount: number;
    conflicts: Array<{
      description: string;
      riskLevel: string;
      resolution: string;
    }>;
  };
  failureAnalysis: {
    failedStep: string;
    whatHappened: string;
    whyItFailed: string;
    suggestedFix: string;
  } | null;
  outcome: string;
  formatted: string;
}

export interface OperationHistory {
  overview: {
    totalDeployments: number;
    succeeded: number;
    failed: number;
    successRate: string;
    environments: string[];
    versions: string[];
  };
  deployments: Array<{
    deploymentId: string;
    version: string;
    environment: string;
    outcome: "succeeded" | "failed";
    durationMs: number | null;
    conflictCount: number;
    keyDecision: string;
  }>;
  formatted: string;
}
