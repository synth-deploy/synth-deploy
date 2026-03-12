// Frontend type definitions mirroring @synth-deploy/core types.
// Dates come as ISO strings from the API.

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

export type LlmEntityExposure = "names" | "none";

export interface AgentSettings {
  defaultHealthCheckRetries: number;
  defaultTimeoutMs: number;
  conflictPolicy: ConflictPolicy;
  defaultVerificationStrategy: "basic" | "full" | "none";
  llmEntityExposure?: LlmEntityExposure;
  taskModels?: TaskModelConfig;
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
  defaultTheme?: "dark" | "light" | "system";
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

// --- Partition ---

export interface Partition {
  id: string;
  name: string;
  variables: Record<string, string>;
  createdAt: string;
}

// --- Environment ---

export interface Environment {
  id: string;
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
  annotatedAt: string;
}

export interface LearningHistoryEntry {
  timestamp: string;
  event: string;
  details: string;
}

export interface Artifact {
  id: string;
  name: string;
  type: string;
  analysis: ArtifactAnalysis;
  annotations: ArtifactAnnotation[];
  learningHistory: LearningHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  version: string;
  source: string;
  metadata: Record<string, string>;
  createdAt: string;
}

// --- Security Boundaries ---

export type SecurityBoundaryType =
  | "filesystem"
  | "service"
  | "network"
  | "credential"
  | "execution";

export interface SecurityBoundary {
  id: string;
  envoyId: string;
  boundaryType: SecurityBoundaryType;
  config: Record<string, unknown>;
}

// --- Deployment ---

export type DeploymentStatus = "pending" | "planning" | "awaiting_approval" | "approved" | "rejected" | "running" | "succeeded" | "failed" | "rolled_back";

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
  execPreview?: string;
}

export interface ExecutionRecord {
  startedAt: string;
  completedAt?: string;
  steps: ExecutedStep[];
}

export interface ExecutedStep {
  description: string;
  status: "completed" | "failed" | "rolled_back";
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
}

export interface DeploymentEnrichment {
  recentDeploymentsToEnv: number;
  previouslyRolledBack: boolean;
  conflictingDeployments: string[];
  lastDeploymentToEnv?: {
    id: string;
    status: string;
    version: string;
    completedAt?: string;
  };
}

export interface Deployment {
  id: string;
  artifactId: string;
  artifactVersionId?: string;
  envoyId?: string;
  partitionId?: string;
  environmentId: string;
  version: string;
  status: DeploymentStatus;
  variables: Record<string, string>;
  plan?: DeploymentPlan;
  rollbackPlan?: DeploymentPlan;
  executionRecord?: ExecutionRecord;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
  enrichment?: DeploymentEnrichment;
  recommendation?: DeploymentRecommendation;
  retryOf?: string;
  debriefEntryIds: string[];
  createdAt: string;
  completedAt: string | null;
  failureReason: string | null;
}

export type RecommendationVerdict = "proceed" | "caution" | "hold";

export interface DeploymentRecommendation {
  verdict: RecommendationVerdict;
  summary: string;
  factors: string[];
}

// --- Debrief ---

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
  | "llm-call"
  | "artifact-analysis"
  | "plan-generation"
  | "plan-approval"
  | "plan-rejection"
  | "rollback-execution"
  | "cross-system-context"
  | "plan-modification"
  | "environment-probe"
  | "pre-flight-llm-failure";

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
  actor?: string;
}

// --- Postmortem ---

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

// --- Identity Provider ---

export type IdpProviderType = "oidc" | "saml" | "ldap";

export interface IdpProvider {
  id: string;
  type: IdpProviderType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RoleMappingRule {
  id: string;
  providerId: string;
  idpGroup: string;
  synthRole: string;
}

export interface IdpProviderPublic {
  id: string;
  type: IdpProviderType;
  name: string;
}

// --- Artifact Intake ---

export type IntakeChannelType = "webhook" | "registry" | "api" | "manual";

export interface IntakeChannel {
  id: string;
  type: IntakeChannelType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  authToken?: string;
  lastPolledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntakeEvent {
  id: string;
  channelId: string;
  artifactId?: string;
  status: "received" | "processing" | "completed" | "failed";
  payload: Record<string, unknown>;
  error?: string;
  createdAt: string;
  processedAt?: string;
}
