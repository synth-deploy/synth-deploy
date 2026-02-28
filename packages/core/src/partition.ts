import crypto from "node:crypto";
import type { Partition, PartitionId } from "./types.js";

/**
 * In-memory partition store. Enforces isolation by partitioning all access by partitionId.
 * The interface is designed so the backing store can move to containers/databases
 * without changing consuming code.
 */
export class PartitionStore {
  private partitions: Map<PartitionId, Partition> = new Map();

  create(name: string, variables: Record<string, string> = {}): Partition {
    const partition: Partition = {
      id: crypto.randomUUID(),
      name,
      variables,
      createdAt: new Date(),
    };
    this.partitions.set(partition.id, partition);
    return partition;
  }

  get(id: PartitionId): Partition | undefined {
    return this.partitions.get(id);
  }

  list(): Partition[] {
    return [...this.partitions.values()];
  }

  setVariables(id: PartitionId, variables: Record<string, string>): Partition {
    const partition = this.partitions.get(id);
    if (!partition) {
      throw new Error(`Partition not found: ${id}`);
    }
    partition.variables = { ...partition.variables, ...variables };
    return partition;
  }

  update(id: PartitionId, updates: { name?: string }): Partition {
    const partition = this.partitions.get(id);
    if (!partition) {
      throw new Error(`Partition not found: ${id}`);
    }
    if (updates.name !== undefined) {
      partition.name = updates.name;
    }
    return partition;
  }

  delete(id: PartitionId): boolean {
    return this.partitions.delete(id);
  }
}
