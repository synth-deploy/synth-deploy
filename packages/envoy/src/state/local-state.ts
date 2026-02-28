import crypto from "node:crypto";
import type {
  DeploymentId,
  PartitionId,
  EnvironmentId,
} from "@deploystack/core";

// ---------------------------------------------------------------------------
// Types — what the Envoy remembers about its local environment
// ---------------------------------------------------------------------------

export interface LocalDeploymentRecord {
  /** The deployment ID assigned by the Server */
  deploymentId: DeploymentId;
  partitionId: PartitionId;
  environmentId: EnvironmentId;
  projectId: string;
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

/**
 * Environment key — unique identifier for a partition+environment pair.
 * The Envoy tracks state per environment per partition.
 */
function envKey(partitionId: PartitionId, environmentId: EnvironmentId): string {
  return `${partitionId}:${environmentId}`;
}

// ---------------------------------------------------------------------------
// LocalStateStore — the Envoy's memory of what it has done
// ---------------------------------------------------------------------------

/**
 * Persists the Envoy's local knowledge: what deployments have been
 * executed, what the current state of each environment looks like, and
 * the history of everything that has happened on this machine.
 *
 * In-memory for now. Same interface pattern as core — swap to SQLite
 * when the in-memory version proves itself.
 */
export class LocalStateStore {
  private deployments = new Map<DeploymentId, LocalDeploymentRecord>();
  private environments = new Map<string, EnvironmentSnapshot>();

  // -- Deployment records ---------------------------------------------------

  recordDeployment(params: {
    deploymentId: DeploymentId;
    partitionId: PartitionId;
    environmentId: EnvironmentId;
    projectId: string;
    version: string;
    variables: Record<string, string>;
    workspacePath: string;
  }): LocalDeploymentRecord {
    const record: LocalDeploymentRecord = {
      ...params,
      status: "executing",
      receivedAt: new Date(),
      completedAt: null,
      failureReason: null,
    };
    this.deployments.set(params.deploymentId, record);
    return record;
  }

  completeDeployment(
    deploymentId: DeploymentId,
    status: "succeeded" | "failed",
    failureReason: string | null = null,
  ): LocalDeploymentRecord | undefined {
    const record = this.deployments.get(deploymentId);
    if (!record) return undefined;

    record.status = status;
    record.completedAt = new Date();
    record.failureReason = failureReason;
    return record;
  }

  getDeployment(id: DeploymentId): LocalDeploymentRecord | undefined {
    return this.deployments.get(id);
  }

  getDeploymentsByPartition(partitionId: PartitionId): LocalDeploymentRecord[] {
    return [...this.deployments.values()].filter(
      (d) => d.partitionId === partitionId,
    );
  }

  getDeploymentsByEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
  ): LocalDeploymentRecord[] {
    return [...this.deployments.values()].filter(
      (d) => d.partitionId === partitionId && d.environmentId === environmentId,
    );
  }

  listDeployments(): LocalDeploymentRecord[] {
    return [...this.deployments.values()].sort(
      (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime(),
    );
  }

  // -- Environment snapshots ------------------------------------------------

  updateEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
    update: {
      currentVersion: string;
      currentDeploymentId: DeploymentId;
      activeVariables: Record<string, string>;
    },
  ): EnvironmentSnapshot {
    const key = envKey(partitionId, environmentId);
    const existing = this.environments.get(key);

    const snapshot: EnvironmentSnapshot = {
      id: existing?.id ?? crypto.randomUUID(),
      environmentId,
      partitionId,
      currentVersion: update.currentVersion,
      currentDeploymentId: update.currentDeploymentId,
      activeVariables: { ...update.activeVariables },
      lastUpdated: new Date(),
    };

    this.environments.set(key, snapshot);
    return snapshot;
  }

  getEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
  ): EnvironmentSnapshot | undefined {
    return this.environments.get(envKey(partitionId, environmentId));
  }

  listEnvironments(): EnvironmentSnapshot[] {
    return [...this.environments.values()];
  }

  // -- Summary for health reporting -----------------------------------------

  getSummary(): {
    totalDeployments: number;
    succeeded: number;
    failed: number;
    executing: number;
    environments: number;
  } {
    const all = [...this.deployments.values()];
    return {
      totalDeployments: all.length,
      succeeded: all.filter((d) => d.status === "succeeded").length,
      failed: all.filter((d) => d.status === "failed").length,
      executing: all.filter((d) => d.status === "executing").length,
      environments: this.environments.size,
    };
  }
}
