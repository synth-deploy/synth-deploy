import crypto from "node:crypto";
import type {
  PartitionId,
  Partition,
  Operation,
  OperationId,
  DebriefEntry,
} from "./types.js";
import type { DebriefReader } from "./debrief.js";
import {
  PartitionContainer,
  type ScopedDeploymentReader,
  type ScopedDebriefReader,
} from "./partition-container.js";

// ---------------------------------------------------------------------------
// Backing store interfaces -- what PartitionManager wraps
// ---------------------------------------------------------------------------

/**
 * The deployment store interface that PartitionManager needs to create
 * scoped views. Matches the existing DeploymentStore shape.
 */
export interface DeploymentStoreReader {
  get(id: OperationId): Operation | undefined;
  list(): Operation[];
}

// ---------------------------------------------------------------------------
// Scoped store implementations -- the isolation enforcement layer
// ---------------------------------------------------------------------------

/**
 * Wraps a full deployment store and enforces partition-scoped access.
 * A get() for a deployment belonging to another partition returns undefined.
 * A list() only returns deployments for the bound partition.
 */
class PartitionScopedDeployments implements ScopedDeploymentReader {
  constructor(
    private partitionId: PartitionId,
    private backing: DeploymentStoreReader,
  ) {}

  get(id: OperationId): Operation | undefined {
    const d = this.backing.get(id);
    if (d && d.partitionId !== this.partitionId) return undefined;
    return d;
  }

  list(): Operation[] {
    return this.backing.list().filter((d) => d.partitionId === this.partitionId);
  }
}

/**
 * Wraps a full debrief reader and enforces partition-scoped access.
 */
class PartitionScopedDebrief implements ScopedDebriefReader {
  constructor(
    private partitionId: PartitionId,
    private backing: DebriefReader,
  ) {}

  list(): DebriefEntry[] {
    return this.backing.getByPartition(this.partitionId);
  }
}

// ---------------------------------------------------------------------------
// PartitionManager -- the single entry point for partition lifecycle
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of PartitionContainers and wires up scoped store views.
 *
 * Cross-partition data access is impossible through the container interface:
 * each container only sees deployments and debrief entries belonging to its
 * partition. Variables are owned copies within each container -- modifying
 * one partition's variables has zero effect on any other partition.
 *
 * Usage:
 *   const manager = new PartitionManager(deploymentStore, debrief);
 *   const partitionA = manager.createPartition("Acme Corp", { DB_HOST: "acme-db" });
 *   const partitionB = manager.createPartition("Beta Inc", { DB_HOST: "beta-db" });
 *
 *   // partitionA.getDeployments() -- only Acme's deployments
 *   // partitionB.getDebriefEntries() -- only Beta's debrief entries
 *   // partitionA.setVariables({...}) -- no effect on partitionB
 */
export class PartitionManager {
  private containers: Map<PartitionId, PartitionContainer> = new Map();

  constructor(
    private deploymentStore: DeploymentStoreReader,
    private debriefReader: DebriefReader,
  ) {}

  createPartition(
    name: string,
    variables: Record<string, string> = {},
  ): PartitionContainer {
    const partition: Partition = {
      id: crypto.randomUUID(),
      name,
      variables,
      createdAt: new Date(),
    };

    const container = new PartitionContainer(
      partition,
      new PartitionScopedDeployments(partition.id, this.deploymentStore),
      new PartitionScopedDebrief(partition.id, this.debriefReader),
    );
    this.containers.set(partition.id, container);
    return container;
  }

  getPartition(id: PartitionId): PartitionContainer | undefined {
    return this.containers.get(id);
  }

  listPartitions(): Array<{ id: PartitionId; name: string }> {
    return [...this.containers.values()].map((c) => ({
      id: c.id,
      name: c.name,
    }));
  }

  get size(): number {
    return this.containers.size;
  }
}
