/**
 * Store interfaces — consumed by route handlers, MCP tools, and agents.
 * Both in-memory and persistent implementations satisfy these interfaces.
 */

import type {
  Partition,
  PartitionId,
  Environment,
  EnvironmentId,
  Operation,
  OperationId,
  Order,
  OrderId,
  Deployment,
  DeploymentId,
  DeploymentStep,
  DeploymentStepType,
  DeployConfig,
  AppSettings,
} from "./types.js";
import type { CreateOrderParams } from "./order-store.js";

export interface IPartitionStore {
  create(name: string, variables?: Record<string, string>): Partition;
  get(id: PartitionId): Partition | undefined;
  list(): Partition[];
  setVariables(id: PartitionId, variables: Record<string, string>): Partition;
  update(id: PartitionId, updates: { name?: string }): Partition;
  delete(id: PartitionId): boolean;
}

export interface IEnvironmentStore {
  create(name: string, variables?: Record<string, string>): Environment;
  get(id: EnvironmentId): Environment | undefined;
  list(): Environment[];
  update(
    id: EnvironmentId,
    updates: { name?: string; variables?: Record<string, string> },
  ): Environment;
  delete(id: EnvironmentId): boolean;
}

export interface IOperationStore {
  create(name: string, environmentIds?: EnvironmentId[]): Operation;
  get(id: OperationId): Operation | undefined;
  list(): Operation[];
  update(id: OperationId, updates: { name?: string }): Operation;
  delete(id: OperationId): boolean;
  addEnvironment(id: OperationId, environmentId: EnvironmentId): Operation;
  removeEnvironment(id: OperationId, environmentId: EnvironmentId): Operation;
  addStep(id: OperationId, step: DeploymentStep): Operation;
  updateStep(
    id: OperationId,
    stepId: string,
    updates: { name?: string; type?: DeploymentStepType; command?: string; order?: number },
  ): Operation;
  removeStep(id: OperationId, stepId: string): Operation;
  reorderSteps(id: OperationId, orderedStepIds: string[]): Operation;
  updateDeployConfig(id: OperationId, config: Partial<DeployConfig>): Operation;
}

export interface IOrderStore {
  create(params: CreateOrderParams): Order;
  get(id: OrderId): Order | undefined;
  list(): Order[];
  getByOperation(operationId: OperationId): Order[];
  getByPartition(partitionId: PartitionId): Order[];
}

export interface IDeploymentStore {
  save(deployment: Deployment): void;
  get(id: DeploymentId): Deployment | undefined;
  getByPartition(partitionId: string): Deployment[];
  list(): Deployment[];
}

export interface ISettingsStore {
  get(): AppSettings;
  update(partial: Partial<AppSettings>): AppSettings;
}
