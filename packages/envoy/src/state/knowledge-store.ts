import type {
  DeploymentId,
  PartitionId,
  EnvironmentId,
  DeploymentPlan,
} from "@deploystack/core";

// ---------------------------------------------------------------------------
// Types — what the Envoy remembers about deployments and its environment
// ---------------------------------------------------------------------------

export interface LocalDeploymentRecord {
  /** The deployment ID assigned by the Server */
  deploymentId: DeploymentId;
  partitionId: PartitionId;
  environmentId: EnvironmentId;
  operationId: string;
  version: string;
  variables: Record<string, string>;
  status: "executing" | "succeeded" | "failed";
  receivedAt: Date;
  completedAt: Date | null;
  /** Where the deployment artifacts were written locally */
  workspacePath: string;
  failureReason: string | null;
}

export interface EnvironmentSnapshot {
  id: string;
  environmentId: EnvironmentId;
  partitionId: PartitionId;
  /** What version is currently deployed in this environment */
  currentVersion: string | null;
  currentDeploymentId: DeploymentId | null;
  /** Variables that are active in this environment */
  activeVariables: Record<string, string>;
  /** When this snapshot was last updated */
  lastUpdated: Date;
}

// ---------------------------------------------------------------------------
// NEW: Plan retention — stored plans from completed deployments
// ---------------------------------------------------------------------------

export interface StoredPlan {
  id: string;
  deploymentId: string;
  artifactType: string;
  artifactName: string;
  environmentId: string;
  plan: DeploymentPlan;
  rollbackPlan: DeploymentPlan;
  outcome: "succeeded" | "failed";
  failureAnalysis?: string;
  executedAt: Date;
  executionDurationMs: number;
}

// ---------------------------------------------------------------------------
// NEW: System knowledge — what the Envoy has learned about its host
// ---------------------------------------------------------------------------

export type SystemKnowledgeCategory =
  | "directory-structure"
  | "running-services"
  | "config-locations"
  | "available-resources"
  | "os-info"
  | "installed-packages";

export interface SystemKnowledgeEntry {
  id: string;
  category: SystemKnowledgeCategory;
  key: string;
  value: Record<string, unknown>;
  discoveredAt: Date;
  lastVerifiedAt: Date;
  source: string;
}

// ---------------------------------------------------------------------------
// EnvoyKnowledgeStore — unified interface for all Envoy local state
// ---------------------------------------------------------------------------

/**
 * The Envoy's persistent memory. Tracks everything the Envoy knows:
 * deployment history, environment state, plan outcomes, and system
 * knowledge discovered during operations.
 *
 * Two implementations exist:
 * - `LocalStateStore`: in-memory, for testing and development
 * - `PersistentEnvoyKnowledgeStore`: SQLite-backed, for production
 */
export interface EnvoyKnowledgeStore {
  // -- Deployment records ---------------------------------------------------

  recordDeployment(params: {
    deploymentId: DeploymentId;
    partitionId: PartitionId;
    environmentId: EnvironmentId;
    operationId: string;
    version: string;
    variables: Record<string, string>;
    workspacePath: string;
  }): LocalDeploymentRecord;

  completeDeployment(
    deploymentId: DeploymentId,
    status: "succeeded" | "failed",
    failureReason?: string | null,
  ): LocalDeploymentRecord | undefined;

  getDeployment(id: DeploymentId): LocalDeploymentRecord | undefined;

  getDeploymentsByPartition(partitionId: PartitionId): LocalDeploymentRecord[];

  getDeploymentsByEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
  ): LocalDeploymentRecord[];

  listDeployments(): LocalDeploymentRecord[];

  // -- Environment snapshots ------------------------------------------------

  updateEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
    update: {
      currentVersion: string;
      currentDeploymentId: DeploymentId;
      activeVariables: Record<string, string>;
    },
  ): EnvironmentSnapshot;

  getEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
  ): EnvironmentSnapshot | undefined;

  listEnvironments(): EnvironmentSnapshot[];

  // -- Plan retention -------------------------------------------------------

  storePlan(plan: StoredPlan): void;

  getSuccessfulPlans(
    artifactType: string,
    environmentId?: string,
  ): StoredPlan[];

  getFailedPlans(
    artifactType: string,
    environmentId?: string,
  ): StoredPlan[];

  getLatestPlan(
    artifactType: string,
    environmentId: string,
  ): StoredPlan | undefined;

  // -- System knowledge -----------------------------------------------------

  recordSystemKnowledge(knowledge: SystemKnowledgeEntry): void;

  getSystemKnowledge(category: string): SystemKnowledgeEntry[];

  getAllSystemKnowledge(): SystemKnowledgeEntry[];

  // -- Summary for health reporting -----------------------------------------

  getSummary(): {
    totalDeployments: number;
    succeeded: number;
    failed: number;
    executing: number;
    environments: number;
  };
}
