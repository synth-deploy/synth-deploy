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
  "shelved",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled",
]);
export type OperationStatus = z.infer<typeof OperationStatus>;
/** @deprecated Use OperationStatus */
export const DeploymentStatus = OperationStatus;
/** @deprecated Use OperationStatus */
export type DeploymentStatus = OperationStatus;

// OperationInput — discriminated union describing what the operation does
export type OperationInput =
  | { type: "deploy"; artifactId: string; artifactVersionId?: string }
  | { type: "maintain"; intent: string }
  | { type: "query"; intent: string }
  | { type: "investigate"; intent: string; allowWrite?: boolean }
  | { type: "trigger"; condition: string; responseIntent: string }
  | { type: "composite"; steps: CompositeStep[] };

export type OperationType = OperationInput["type"];

/** A single step within a composite operation */
export interface CompositeStep {
  /** The operation to execute for this step */
  input: OperationInput;
  /** Target a specific envoy for this step (overrides parent's envoy) */
  envoyId?: EnvoyId;
  /** Step indices within this composite that must succeed before this step starts */
  waitForSteps?: number[];
  /** External operation dependencies — this step blocks until all conditions are met */
  waitFor?: WaitCondition[];
}

/** A dependency on another operation reaching a specific status */
export interface WaitCondition {
  operationId: OperationId;
  status: OperationStatus;
}

// OperationTrigger — who/what initiated this operation and where it targets
export const OperationTriggerSchema = z.object({
  environmentId: z.string(),
  partitionId: z.string().optional(),
  triggeredBy: z.enum(["user", "agent", "webhook", "trigger"]).default("user"),
  variables: z.record(z.string()).optional(),
});
export type OperationTrigger = z.infer<typeof OperationTriggerSchema>;

// --- Operation Plan & Execution ---

export interface ConfigChange {
  key: string;
  from: string;
  to: string;
}

/** Human-readable description of what a portion of the script does */
export interface StepSummary {
  /** Human-readable description of what this portion of the script does */
  description: string;
  /** Whether this step is reversible (reflected in rollback script) */
  reversible: boolean;
}

/** LLM-generated scripted plan — replaces structured PlannedStep[] */
export interface ScriptedPlan {
  /** Platform the scripts target */
  platform: "bash" | "powershell";
  /** The executable script — approved and run verbatim */
  executionScript: string;
  /** Read-only probes predicting execution outcome. Null for ops that don't need it */
  dryRunScript: string | null;
  /** Reversal script. Null for read-only operations */
  rollbackScript: string | null;
  /** Plain-english explanation of what the scripts do and why */
  reasoning: string;
  /** Structured summary for UI display — derived from the script, not a parallel data structure */
  stepSummary: StepSummary[];
  /** What configuration will change */
  diffFromCurrent?: ConfigChange[];
}

export interface OperationPlan {
  /** Scripted plan — LLM-generated scripts for execution */
  scriptedPlan: ScriptedPlan;
  reasoning: string;
  diffFromCurrent?: ConfigChange[];
  diffFromPreviousPlan?: string;
}
/** @deprecated Use OperationPlan */
export type DeploymentPlan = OperationPlan;

/** @deprecated Replaced by ScriptedPlan — kept for migration compatibility */
export interface PlannedStep {
  description: string;
  action: string;
  target: string;
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
  recentOperationsToEnv: number;
  previouslyRolledBack: boolean;
  conflictingOperations: string[];
  lastOperationToEnv?: {
    id: string;
    status: string;
    version: string;
    completedAt?: Date;
  };
  /** Prior shelved plan for the same artifact+environment+type — injected as context during replanning */
  shelvedPlan?: {
    reasoning: string;
    shelvedAt: string;
    shelvedReason?: string;
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
  };
}

export const QueryFindingsSchema = z.object({
  targetsSurveyed: z.array(z.string()),
  summary: z.string(),
  findings: z.array(z.object({
    target: z.string(),
    observations: z.array(z.string()),
  })),
});

export const InvestigationFindingsSchema = QueryFindingsSchema.extend({
  rootCause: z.string().nullable().optional(),
  proposedResolution: z.object({
    intent: z.string(),
    operationType: z.enum(["maintain", "deploy"]),
  }).optional(),
});

// --- Trigger / Health Monitoring ---

export type TriggerStatus = "active" | "paused" | "disabled";

/** A monitoring directive installed on an envoy by an approved trigger operation. */
export interface MonitoringDirective {
  /** Unique ID for this directive (usually the trigger operation ID) */
  id: string;
  /** The trigger operation that produced this directive */
  operationId: OperationId;
  /** Probes to run — shell commands executed via ProbeExecutor */
  probes: MonitoringProbe[];
  /** How often to run the probes (milliseconds) */
  intervalMs: number;
  /** Cooldown after firing before the trigger can fire again (milliseconds) */
  cooldownMs: number;
  /** Condition expression — evaluated against probe results */
  condition: string;
  /** What to do when the condition fires — becomes the intent for the child operation */
  responseIntent: string;
  /** Operation type for the spawned child operation */
  responseType: "deploy" | "maintain";
  /** Target scope */
  environmentId?: string;
  partitionId?: string;
  /** Current status */
  status: TriggerStatus;
}

export interface MonitoringProbe {
  /** Shell command to execute (read-only, via ProbeExecutor) */
  command: string;
  /** Human-readable label for this probe */
  label: string;
  /** What to extract from the output — "exitCode", "numeric" (parse number), or "raw" */
  parseAs: "exitCode" | "numeric" | "raw";
}

/** Health report sent from envoy to server when a trigger condition fires. */
export interface HealthReport {
  /** The monitoring directive that fired */
  directiveId: string;
  /** The trigger operation that owns the directive */
  triggerOperationId: OperationId;
  /** Envoy that detected the condition */
  envoyId: EnvoyId;
  /** Probe results that caused the trigger to fire */
  probeResults: Array<{
    label: string;
    command: string;
    output: string;
    exitCode?: number;
    parsedValue?: number;
  }>;
  /** Human-readable summary of what was detected */
  summary: string;
  /** When the condition was detected */
  detectedAt: Date;
  /** Target scope from the directive */
  environmentId?: string;
  partitionId?: string;
}

export const HealthReportSchema = z.object({
  directiveId: z.string(),
  triggerOperationId: z.string(),
  envoyId: z.string(),
  probeResults: z.array(z.object({
    label: z.string(),
    command: z.string(),
    output: z.string(),
    exitCode: z.number().optional(),
    parsedValue: z.number().optional(),
  })),
  summary: z.string(),
  detectedAt: z.string().transform((s) => new Date(s)),
  environmentId: z.string().optional(),
  partitionId: z.string().optional(),
});

export const MonitoringProbeSchema = z.object({
  command: z.string(),
  label: z.string(),
  parseAs: z.enum(["exitCode", "numeric", "raw"]),
});

export const MonitoringDirectiveSchema = z.object({
  id: z.string(),
  operationId: z.string(),
  probes: z.array(MonitoringProbeSchema),
  intervalMs: z.number().int().positive(),
  cooldownMs: z.number().int().nonnegative(),
  condition: z.string(),
  responseIntent: z.string(),
  responseType: z.enum(["deploy", "maintain"]),
  environmentId: z.string().optional(),
  partitionId: z.string().optional(),
  status: z.enum(["active", "paused", "disabled"]),
});

// --- Operation (unified lifecycle) ---

export interface Operation {
  id: OperationId;
  input: OperationInput;
  /** Natural language objective — populated for non-deploy types; optional context for deploy */
  intent?: string;
  /** Parent operation that spawned this one (e.g. trigger → child operation) */
  lineage?: OperationId;
  /** Dependencies that must be satisfied before this operation executes */
  waitFor?: WaitCondition[];
  /** Who/what initiated this operation */
  triggeredBy?: "user" | "agent" | "webhook" | "trigger";
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
  shelvedAt?: Date;
  shelvedReason?: string;
  enrichment?: OperationEnrichment;
  recommendation?: OperationRecommendation;
  retryOf?: OperationId;
  /** When true, manual approval is required even if resolveApprovalMode() returns 'auto' */
  forceManualApproval?: boolean;
  /** Trigger-specific: installed monitoring directive (populated after approval) */
  monitoringDirective?: MonitoringDirective;
  /** Trigger-specific: current trigger status */
  triggerStatus?: TriggerStatus;
  /** Trigger-specific: last time the trigger fired */
  triggerLastFiredAt?: Date;
  /** Trigger-specific: total number of times the trigger has fired */
  triggerFireCount?: number;
  /** Trigger-specific: number of times firing was suppressed by deduplication */
  triggerSuppressedCount?: number;
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
  "trigger-activated",
  "trigger-fired",
  "trigger-suppressed",
  "trigger-paused",
  "trigger-resumed",
  "trigger-disabled",
  "health-report-received",
  "alert-webhook-received",
  "alert-webhook-suppressed",
  "composite-started",
  "composite-plan-generation",
  "composite-plan-ready",
  "composite-child-started",
  "composite-child-completed",
  "composite-child-failed",
  "composite-failed",
  "composite-completed",
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

// --- Approval Model ---

export type ApprovalMode = 'auto' | 'required';

export interface ApprovalDefaults {
  query: ApprovalMode;
  investigate: ApprovalMode;
  trigger: ApprovalMode;
  deploy: ApprovalMode;
  maintain: ApprovalMode;
  composite: ApprovalMode;
  environmentOverrides: Record<string, Partial<Record<OperationType, ApprovalMode>>>;
}

export const DEFAULT_APPROVAL_DEFAULTS: ApprovalDefaults = {
  query: 'auto',
  investigate: 'auto',
  trigger: 'required',
  deploy: 'required',
  maintain: 'required',
  composite: 'required',
  environmentOverrides: {},
};

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

export interface OperationDefaults {
  defaultHealthCheckEnabled: boolean;
  defaultHealthCheckRetries: number;
  defaultTimeoutMs: number;
  defaultVerificationStrategy: "basic" | "full" | "none";
}
/** @deprecated Use OperationDefaults */
export type DeploymentDefaults = OperationDefaults;

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
  operationDefaults: OperationDefaults;
  envoy: EnvoyEndpointConfig;
  coBranding?: CoBrandingConfig;
  mcpServers?: McpServerConfig[];
  llm?: LlmProviderConfig;
  approvalDefaults?: ApprovalDefaults;
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
  | "operation.shelved"
  | "operation.activated"
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
  | "agent.recommendation.overridden"
  | "trigger.activated"
  | "trigger.fired"
  | "trigger.suppressed"
  | "trigger.paused"
  | "trigger.resumed"
  | "trigger.disabled"
  | "alert-webhook.created"
  | "alert-webhook.fired"
  | "envoy.context.updated";

export const DEFAULT_APP_SETTINGS: AppSettings = {
  environmentsEnabled: true,
  agent: {
    defaultHealthCheckRetries: 1,
    defaultTimeoutMs: 30000,
    conflictPolicy: "permissive",
    defaultVerificationStrategy: "basic",
    llmEntityExposure: "names",
  },
  operationDefaults: {
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
  approvalDefaults: DEFAULT_APPROVAL_DEFAULTS,
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

// --- Alert Webhooks (external monitoring triggers) ---

export type AlertWebhookSource = "prometheus" | "pagerduty" | "datadog" | "grafana" | "generic";

export interface AlertWebhookChannel {
  id: string;
  name: string;
  source: AlertWebhookSource;
  enabled: boolean;
  authToken: string;
  /** Default operation type for spawned operations */
  defaultOperationType: "maintain" | "deploy" | "query" | "investigate";
  /** Default intent template — {{alert.name}}, {{alert.summary}} are interpolated */
  defaultIntent?: string;
  /** Default target environment */
  environmentId?: string;
  /** Default target partition */
  partitionId?: string;
  /** Default target envoy */
  envoyId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NormalizedAlert {
  /** Alert name/rule (e.g. "HighDiskUsage") */
  name: string;
  /** Human-readable summary */
  summary: string;
  /** Severity level */
  severity: "critical" | "warning" | "info";
  /** Alert status */
  status: "firing" | "resolved";
  /** Labels/tags from the alerting system */
  labels: Record<string, string>;
  /** Additional annotations/details */
  annotations: Record<string, string>;
  /** Source system identifier */
  source: string;
  /** When the alert started firing */
  startsAt?: Date;
  /** Raw payload for debrief context */
  rawPayload: Record<string, unknown>;
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
