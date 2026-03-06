import crypto from "node:crypto";
import type {
  DeploymentId,
  PartitionId,
  EnvironmentId,
} from "@synth-deploy/core";
import type {
  EnvoyKnowledgeStore,
  LocalDeploymentRecord,
  EnvironmentSnapshot,
  StoredPlan,
  SystemKnowledgeEntry,
} from "./knowledge-store.js";

// Re-export types so existing imports continue to work
export type { LocalDeploymentRecord, EnvironmentSnapshot } from "./knowledge-store.js";

/**
 * Environment key — unique identifier for a partition+environment pair.
 * The Envoy tracks state per environment per partition.
 */
function envKey(partitionId: PartitionId, environmentId: EnvironmentId): string {
  return `${partitionId}:${environmentId}`;
}

// ---------------------------------------------------------------------------
// LocalStateStore — in-memory implementation of EnvoyKnowledgeStore
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of EnvoyKnowledgeStore. Used for testing and
 * development. Same interface as the SQLite-backed PersistentEnvoyKnowledgeStore
 * — swap freely depending on context.
 */
export class LocalStateStore implements EnvoyKnowledgeStore {
  private deployments = new Map<DeploymentId, LocalDeploymentRecord>();
  private environments = new Map<string, EnvironmentSnapshot>();
  private plans: StoredPlan[] = [];
  private systemKnowledge = new Map<string, SystemKnowledgeEntry>();

  // -- Deployment records ---------------------------------------------------

  recordDeployment(params: {
    deploymentId: DeploymentId;
    partitionId: PartitionId;
    environmentId: EnvironmentId;
    operationId: string;
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

  // -- Plan retention -------------------------------------------------------

  storePlan(plan: StoredPlan): void {
    this.plans.push(plan);
  }

  getSuccessfulPlans(
    artifactType: string,
    environmentId?: string,
  ): StoredPlan[] {
    return this.plans.filter(
      (p) =>
        p.artifactType === artifactType &&
        p.outcome === "succeeded" &&
        (environmentId === undefined || p.environmentId === environmentId),
    );
  }

  getFailedPlans(
    artifactType: string,
    environmentId?: string,
  ): StoredPlan[] {
    return this.plans.filter(
      (p) =>
        p.artifactType === artifactType &&
        p.outcome === "failed" &&
        (environmentId === undefined || p.environmentId === environmentId),
    );
  }

  getLatestPlan(
    artifactType: string,
    environmentId: string,
  ): StoredPlan | undefined {
    const matching = this.plans
      .filter(
        (p) =>
          p.artifactType === artifactType &&
          p.environmentId === environmentId,
      )
      .sort(
        (a, b) => b.executedAt.getTime() - a.executedAt.getTime(),
      );
    return matching[0];
  }

  // -- System knowledge -----------------------------------------------------

  recordSystemKnowledge(knowledge: SystemKnowledgeEntry): void {
    const key = `${knowledge.category}:${knowledge.key}`;
    this.systemKnowledge.set(key, knowledge);
  }

  getSystemKnowledge(category: string): SystemKnowledgeEntry[] {
    return [...this.systemKnowledge.values()].filter(
      (k) => k.category === category,
    );
  }

  getAllSystemKnowledge(): SystemKnowledgeEntry[] {
    return [...this.systemKnowledge.values()];
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
