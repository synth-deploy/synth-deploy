import crypto from "node:crypto";
import type { Operation, OperationId, EnvironmentId } from "./types.js";
import { DEFAULT_DEPLOY_CONFIG } from "./types.js";

/**
 * In-memory operation store. Same pattern as PartitionStore —
 * interface designed for later migration to persistent storage.
 */
export class OperationStore {
  private operations: Map<OperationId, Operation> = new Map();

  create(name: string, environmentIds: EnvironmentId[] = []): Operation {
    const operation: Operation = {
      id: crypto.randomUUID(),
      name,
      environmentIds,
      steps: [],
      deployConfig: { ...DEFAULT_DEPLOY_CONFIG },
    };
    this.operations.set(operation.id, operation);
    return operation;
  }

  get(id: OperationId): Operation | undefined {
    return this.operations.get(id);
  }

  list(): Operation[] {
    return [...this.operations.values()];
  }

  update(id: OperationId, updates: { name?: string }): Operation {
    const operation = this.operations.get(id);
    if (!operation) {
      throw new Error(`Operation not found: ${id}`);
    }
    if (updates.name !== undefined) {
      operation.name = updates.name;
    }
    return operation;
  }

  delete(id: OperationId): boolean {
    return this.operations.delete(id);
  }

  addEnvironment(id: OperationId, environmentId: EnvironmentId): Operation {
    const operation = this.operations.get(id);
    if (!operation) {
      throw new Error(`Operation not found: ${id}`);
    }
    if (!operation.environmentIds.includes(environmentId)) {
      operation.environmentIds.push(environmentId);
    }
    return operation;
  }

  removeEnvironment(id: OperationId, environmentId: EnvironmentId): Operation {
    const operation = this.operations.get(id);
    if (!operation) {
      throw new Error(`Operation not found: ${id}`);
    }
    operation.environmentIds = operation.environmentIds.filter(
      (eid) => eid !== environmentId,
    );
    return operation;
  }
}
