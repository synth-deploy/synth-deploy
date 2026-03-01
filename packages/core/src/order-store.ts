import crypto from "node:crypto";
import type {
  Order,
  OrderId,
  OperationId,
  PartitionId,
  EnvironmentId,
  DeploymentStep,
  DeployConfig,
} from "./types.js";

export interface CreateOrderParams {
  operationId: OperationId;
  operationName: string;
  partitionId: PartitionId;
  environmentId: EnvironmentId;
  environmentName: string;
  version: string;
  steps: DeploymentStep[];
  deployConfig: DeployConfig;
  variables: Record<string, string>;
}

/**
 * In-memory store for Orders (immutable deployment snapshots).
 *
 * Orders are frozen at creation time. There are no update or delete
 * operations — immutability is enforced at the store level.
 * All reads return defensive copies to prevent external mutation.
 */
export class OrderStore {
  private orders: Map<OrderId, Order> = new Map();

  create(params: CreateOrderParams): Order {
    const order: Order = {
      id: crypto.randomUUID(),
      operationId: params.operationId,
      operationName: params.operationName,
      partitionId: params.partitionId,
      environmentId: params.environmentId,
      environmentName: params.environmentName,
      version: params.version,
      steps: structuredClone(params.steps),
      deployConfig: structuredClone(params.deployConfig),
      variables: { ...params.variables },
      createdAt: new Date(),
    };
    this.orders.set(order.id, order);
    return structuredClone(order);
  }

  get(id: OrderId): Order | undefined {
    const order = this.orders.get(id);
    return order ? structuredClone(order) : undefined;
  }

  list(): Order[] {
    return [...this.orders.values()].map((o) => structuredClone(o));
  }

  getByOperation(operationId: OperationId): Order[] {
    return [...this.orders.values()]
      .filter((o) => o.operationId === operationId)
      .map((o) => structuredClone(o));
  }

  getByPartition(partitionId: PartitionId): Order[] {
    return [...this.orders.values()]
      .filter((o) => o.partitionId === partitionId)
      .map((o) => structuredClone(o));
  }
}
