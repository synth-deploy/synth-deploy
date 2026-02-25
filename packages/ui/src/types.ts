// Frontend type definitions mirroring @deploystack/core types.
// Dates come as ISO strings from the API.

export interface Project {
  id: string;
  name: string;
  environmentIds: string[];
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
  diaryEntryIds: string[];
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
  | "system";

export type AgentType = "server" | "tentacle";

export interface DiaryEntry {
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
