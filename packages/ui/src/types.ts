// Frontend type definitions mirroring @deploystack/core types.
// Dates come as ISO strings from the API.

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

export interface Project {
  id: string;
  name: string;
  environmentIds: string[];
  steps: DeploymentStep[];
  pipelineConfig: PipelineConfig;
}

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

export interface ServerInfo {
  version: string;
  host: string;
  port: number;
  startedAt: string;
}

export interface Tenant {
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
  projectId: string;
  tenantId: string;
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

export type AgentType = "server" | "tentacle";

export interface DebriefEntry {
  id: string;
  timestamp: string;
  tenantId: string | null;
  deploymentId: string | null;
  agent: AgentType;
  decisionType: DecisionType;
  decision: string;
  reasoning: string;
  context: Record<string, unknown>;
}

export interface Order {
  id: string;
  projectId: string;
  projectName: string;
  tenantId: string;
  environmentId: string;
  environmentName: string;
  version: string;
  steps: DeploymentStep[];
  pipelineConfig: PipelineConfig;
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

export interface ProjectHistory {
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
