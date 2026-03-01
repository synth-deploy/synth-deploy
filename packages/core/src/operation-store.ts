import crypto from "node:crypto";
import type { Operation, OperationId, EnvironmentId, DeploymentStep, DeploymentStepType, DeployConfig } from "./types.js";
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

  addStep(id: OperationId, step: DeploymentStep): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error(`Operation not found: ${id}`);
    operation.steps.push(step);
    operation.steps.sort((a, b) => a.order - b.order);
    return operation;
  }

  updateStep(
    id: OperationId,
    stepId: string,
    updates: { name?: string; type?: DeploymentStepType; command?: string; order?: number; stepTypeId?: string; stepTypeConfig?: Record<string, unknown> },
  ): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error(`Operation not found: ${id}`);
    const step = operation.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step not found: ${stepId}`);
    if (updates.name !== undefined) step.name = updates.name;
    if (updates.type !== undefined) step.type = updates.type;
    if (updates.command !== undefined) step.command = updates.command;
    if (updates.order !== undefined) step.order = updates.order;
    if (updates.stepTypeId !== undefined) step.stepTypeId = updates.stepTypeId;
    if (updates.stepTypeConfig !== undefined) step.stepTypeConfig = updates.stepTypeConfig;
    operation.steps.sort((a, b) => a.order - b.order);
    return operation;
  }

  removeStep(id: OperationId, stepId: string): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error(`Operation not found: ${id}`);
    operation.steps = operation.steps.filter((s) => s.id !== stepId);
    return operation;
  }

  reorderSteps(id: OperationId, orderedStepIds: string[]): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error(`Operation not found: ${id}`);
    const stepMap = new Map(operation.steps.map((s) => [s.id, s]));
    for (let i = 0; i < orderedStepIds.length; i++) {
      const step = stepMap.get(orderedStepIds[i]);
      if (!step) throw new Error(`Step not found: ${orderedStepIds[i]}`);
      step.order = i;
    }
    operation.steps.sort((a, b) => a.order - b.order);
    return operation;
  }

  updateDeployConfig(id: OperationId, config: Partial<DeployConfig>): Operation {
    const operation = this.operations.get(id);
    if (!operation) throw new Error(`Operation not found: ${id}`);
    operation.deployConfig = { ...operation.deployConfig, ...config };
    return operation;
  }
}
