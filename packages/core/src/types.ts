import { z } from "zod";

// --- Identifiers ---

export type PartitionId = string;
export type OperationId = string;
/** @deprecated Use OperationId */
export type DeploymentId = OperationId;
export type EnvironmentId = string;
export type DebriefEntryId = string;
export type EnvoyId = string;
export type ArtifactId = string;
export type ArtifactVersionId = string;
export type SecurityBoundaryId = string;
export type UserId = string & { readonly __brand: "UserId" };
export type RoleId = string & { readonly __brand: "RoleId" };

// --- Operation ---

export const OperationStatus = z.enum([
  "pending",
  "planning",
  "awaiting_approval",
  "approved",
  "rejected",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
]);
export type OperationStatus = z.infer<typeof OperationStatus>;
/** @deprecated Use OperationStatus */
export const DeploymentStatus = OperationStatus;
/** @deprecated Use OperationStatus */
export type DeploymentStatus = OperationStatus;

// OperationInput — discriminated union describing what the operation does
export type OperationInput =
  | { type: "deploy"; artifactId: string; artifactVersionId?: string }
  | { type: "maintain"; intent: string; parameters?: Record<string, unknown> }
  | { type: "query"; intent: string }
  | { type: "investigate"; intent: string; allowWrite?: boolean }
  | { type: "trigger"; condition: string; responseIntent: string; parameters?: Record<string, unknown> }
  | { type: "composite"; operations: OperationInput[] }; // not yet implemented

export type OperationType = OperationInput["type"];

// OperationTrigger — who/what initiated this operation and where it targets
export const OperationTriggerSchema = z.object({
  environmentId: z.string(),
  partitionId: z.string().optional(),
  triggeredBy: z.enum(["user", "agent", "webhook"]).default("user"),
  variables: z.record(z.string()).optional(),
});
export type OperationTrigger = z.infer<typeof OperationTriggerSchema>;

// --- Operation Plan & Execution ---

export interface ConfigChange {
  key: string;
  from: string;
  to: string;
}

export interface OperationPlan {
  steps: PlannedStep[];
  reasoning: string;
  diffFromCurrent?: ConfigChange[];
  diffFromPreviousPlan?: string;
}
/** @deprecated Use OperationPlan */
export type DeploymentPlan = OperationPlan;

export interface PlannedStep {
  description: string;
  action: string;
  target: string;
  /** Operation-specific parameters (e.g. destination for copy, args for commands) */
  params?: Record<string, unknown>;
  reversible: boolean;
  rollbackAction?: string;
  execPreview?: string;
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

// --- Operation Enrichment (cross-system context) ---

export interface OperationEnrichment {
  recentDeploymentsToEnv: number;
  previouslyRolledBack: boolean;
  conflictingDeployments: string[];
  lastDeploymentToEnv?: {
    id: string;
    status: string;
    version: string;
    completedAt?: Date;
  };
}
/** @deprecated Use OperationEnrichment */
export type DeploymentEnrichment = OperationEnrichment;

// --- Operation Recommendation ---

export type RecommendationVerdict = "proceed" | "caution" | "hold";

export interface OperationRecommendation {
  verdict: RecommendationVerdict;
  summary: string;
  factors: string[];
}
/** @deprecated Use OperationRecommendation */
export type DeploymentRecommendation = OperationRecommendation;

export interface QueryFindings {
  /** Envoy IDs or hostnames that were probed */
  targetsSurveyed: string[];
  /** LLM narrative summary of what was found */
  summary: string;
  /** Per-target observations */
  findings: Array<{
    target: string;
    observations: string[];
  }>;
}

export interface InvestigationFindings extends QueryFindings {
  rootCause?: string;
  proposedResolution?: {
    intent: string;
    operationType: "maintain" | "deploy";
    parameters?: Record<string, unknown>;
  };
}

// --- Operation (unified lifecycle) ---

export interface Operation {
  id: OperationId;
  input: OperationInput;
  /** Natural language objective — populated for non-deploy types; optional context for deploy */
  intent?: string;
  /** Parent operation that spawned this one (e.g. trigger → child operation) */
  lineage?: OperationId;
  /** Structured findings — populated by investigate operations */
  findings?: string;
  queryFindings?: QueryFindings;
  investigationFindings?: InvestigationFindings;
  envoyId?: EnvoyId;
  environmentId?: EnvironmentId;
  partitionId?: PartitionId;
  version?: string;
  status: OperationStatus;
  variables: Record<string, string>;
  plan?: OperationPlan;
  rollbackPlan?: OperationPlan;
  executionRecord?: ExecutionRecord;
  approvedBy?: string;
  approvedAt?: Date;
  rejectionReason?: string;
  enrichment?: OperationEnrichment;
  recommendation?: OperationRecommendation;
  retryOf?: OperationId;
  debriefEntryIds: DebriefEntryId[];
  createdAt: Date;
  completedAt?: Date;
  failureReason?: string;
}
/** @deprecated Use Operation */
export type Deployment = Operation;

// --- Debrief ---

export const AgentType = z.enum(["server", "envoy"]);
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
  "plan-modification",
  "pre-flight-llm-failure",
  "environment-probe",
  "query-findings",
  "investigation-findings",
]);
export type DecisionType = z.infer<typeof DecisionType>;

export interface DebriefEntry {
  id: DebriefEntryId;
  timestamp: Date;
  partitionId: PartitionId | null;
  operationId: OperationId | null;
  agent: AgentType;
  decisionType: DecisionType;
  decision: string;
  reasoning: string;
  context: Record<string, unknown>;
  actor?: string | {
    userId: UserId;
    email: string;
    name: string;
  };
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

// --- Per-Task Model Configuration ---

export type TaskModelTask =
  | "logClassification"
  | "diagnosticSynthesis"
  | "postmortemGeneration"
  | "queryAnswering";

export interface TaskModelConfig {
  logClassification?: string;       // model ID override
  diagnosticSynthesis?: string;     // model ID override
  postmortemGeneration?: string;    // model ID override
  queryAnswering?: string;          // model ID override
}

export interface TaskModelMeta {
  label: string;
  tier: string;
  tokenBudget: string;
  reasoningDepth: string;
}

// --- Capability Gating ---

export type CapabilityLevel = "verified" | "marginal" | "insufficient" | "unverified";

export interface TaskCapabilityResult {
  task: TaskModelTask;
  model: string;
  level: CapabilityLevel;
  verifiedAt: Date;
  details?: string;
}

export interface TaskGatingResult {
  proceed: boolean;
  level: CapabilityLevel;
  notice: string | null;
  model?: string;
  task?: TaskModelTask;
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
  /** Per-task model overrides — route specific tasks to specific models */
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

// --- Telemetry ---

export interface TelemetryEvent {
  id: string;
  timestamp: Date;
  actor: string;
  action: TelemetryAction;
  target: { type: string; id: string };
  details: Record<string, unknown>;
}

export type TelemetryAction =
  | "operation.created"
  | "operation.approved"
  | "operation.rejected"
  | "operation.modified"
  | "artifact.created"
  | "artifact.annotated"
  | "partition.created"
  | "partition.variables.updated"
  | "environment.created"
  | "environment.updated"
  | "settings.updated"
  | "envoy.registered"
  | "envoy.connection.added"
  | "envoy.connection.removed"
  | "security-boundary.updated"
  | "agent.pre-flight.generated"
  | "agent.recommendation.followed"
  | "agent.recommendation.overridden";

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
    url: "http://localhost:9411",
    timeoutMs: 10000,
  },
  mcpServers: [],
};

// --- Auth types ---

export type Permission =
  | "deployment.create" | "deployment.approve" | "deployment.reject" | "deployment.view" | "deployment.rollback"
  | "artifact.create" | "artifact.update" | "artifact.annotate" | "artifact.delete" | "artifact.view"
  | "environment.create" | "environment.update" | "environment.delete" | "environment.view"
  | "partition.create" | "partition.update" | "partition.delete" | "partition.view"
  | "envoy.register" | "envoy.configure" | "envoy.view"
  | "settings.manage" | "users.manage" | "roles.manage";

export type AuthSource = "local" | "oidc" | "saml" | "ldap";

export interface User {
  id: UserId;
  email: string;
  name: string;
  passwordHash: string; // bcrypt — never sent to frontend
  authSource?: AuthSource;
  externalId?: string;
  createdAt: Date;
  updatedAt: Date;
}

// --- Identity Provider types ---

export type IdpProviderType = "oidc" | "saml" | "ldap";

export interface IdpProvider {
  id: string;
  type: IdpProviderType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>; // type-specific config
  createdAt: Date;
  updatedAt: Date;
}

export interface IdpUser {
  externalId: string;
  email: string;
  displayName: string;
  groups: string[];
  provider: string;
}

export interface RoleMappingRule {
  id: string;
  providerId: string;
  idpGroup: string;
  synthRole: string;
}

export interface Role {
  id: RoleId;
  name: string; // "admin", "deployer", "viewer", or custom
  permissions: Permission[];
  isBuiltIn: boolean;
  createdAt: Date;
}

export interface UserRole {
  userId: UserId;
  roleId: RoleId;
  assignedAt: Date;
  assignedBy: UserId;
}

export interface Session {
  id: string;
  userId: UserId;
  token: string;
  refreshToken: string;
  expiresAt: Date;
  createdAt: Date;
  userAgent?: string;
  ipAddress?: string;
}

export type UserPublic = Omit<User, "passwordHash" | "externalId">;

// --- OIDC-specific config ---

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  groupsClaim: string;
}

// --- Fleet Deployment (large-scale orchestration) ---

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
  createdAt: Date;
  updatedAt: Date;
}

export type FleetDeploymentStatus =
  | "selecting_representatives"
  | "planning"
  | "awaiting_approval"
  | "validating"
  | "validated"
  | "validation_failed"
  | "executing"
  | "paused"
  | "completed"
  | "failed"
  | "rolled_back";

export interface RolloutConfig {
  strategy: "all-at-once" | "batched" | "canary";
  batchSize?: number;
  batchPercent?: number;
  pauseBetweenBatches: boolean;
  haltOnFailureCount: number;
  healthCheckWaitMs: number;
}

export interface FleetValidationResult {
  total: number;
  validated: number;
  failed: number;
  results: EnvoyValidationResult[];
}

export interface EnvoyValidationResult {
  envoyId: string;
  envoyName: string;
  validated: boolean;
  issues?: string[];
}

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

// --- Artifact Intake ---

export type IntakeChannelType = "webhook" | "registry" | "api" | "manual";

export interface IntakeChannel {
  id: string;
  type: IntakeChannelType;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  authToken?: string;
  lastPolledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookConfig {
  source: "github-actions" | "azure-devops" | "jenkins" | "gitlab-ci" | "circleci" | "generic";
  secretToken: string;
}

export interface RegistryConfig {
  type: "docker" | "npm" | "nuget";
  url: string;
  credentials?: { username: string; password: string };
  trackedImages?: string[];
  trackedPackages?: string[];
  pollIntervalMs: number;
}

export interface IntakeEvent {
  id: string;
  channelId: string;
  artifactId?: string;
  status: "received" | "processing" | "completed" | "failed";
  payload: Record<string, unknown>;
  error?: string;
  createdAt: Date;
  processedAt?: Date;
}

// --- Deployment Graphs ---

export interface DeploymentGraph {
  id: string;
  name: string;
  partitionId?: string;
  nodes: DeploymentGraphNode[];
  edges: DeploymentGraphEdge[];
  status: DeploymentGraphStatus;
  approvalMode: "per-node" | "graph";
  createdAt: Date;
  updatedAt: Date;
}

export type DeploymentGraphStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "failed"
  | "rolled_back";

export interface DeploymentGraphNode {
  id: string;
  artifactId: string;
  envoyId: string;
  outputBindings?: OutputBinding[];
  inputBindings?: InputBinding[];
  deploymentId?: string;
  status:
    | "pending"
    | "planning"
    | "awaiting_approval"
    | "executing"
    | "completed"
    | "failed";
}

export interface DeploymentGraphEdge {
  from: string;
  to: string;
  type: "depends_on" | "data_flow";
  dataBinding?: { outputName: string; inputVariable: string };
}

export interface OutputBinding {
  name: string;
  source: "plan_step_output" | "manual";
  stepIndex?: number;
  outputKey?: string;
  value?: string;
}

export interface InputBinding {
  variable: string;
  sourceNodeId: string;
  sourceOutputName: string;
  resolvedValue?: string;
}

// --- API Keys ---

export type ApiKeyId = string & { readonly __brand: "ApiKeyId" };

export interface ApiKey {
  id: ApiKeyId;
  userId: UserId;
  name: string;
  keyPrefix: string;  // first 8 chars after "synth_" prefix, for display
  keySuffix: string;  // last 4 chars, for display
  keyHash: string;    // bcrypt hash
  permissions: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}
