import crypto from "node:crypto";
import type {
  Order,
  OrderId,
  ProjectId,
  TenantId,
  EnvironmentId,
  DeploymentStep,
  PipelineConfig,
} from "./types.js";

export interface CreateOrderParams {
  projectId: ProjectId;
  projectName: string;
  tenantId: TenantId;
  environmentId: EnvironmentId;
  environmentName: string;
  version: string;
  steps: DeploymentStep[];
  pipelineConfig: PipelineConfig;
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
      projectId: params.projectId,
      projectName: params.projectName,
      tenantId: params.tenantId,
      environmentId: params.environmentId,
      environmentName: params.environmentName,
      version: params.version,
      steps: structuredClone(params.steps),
      pipelineConfig: structuredClone(params.pipelineConfig),
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

  getByProject(projectId: ProjectId): Order[] {
    return [...this.orders.values()]
      .filter((o) => o.projectId === projectId)
      .map((o) => structuredClone(o));
  }

  getByTenant(tenantId: TenantId): Order[] {
    return [...this.orders.values()]
      .filter((o) => o.tenantId === tenantId)
      .map((o) => structuredClone(o));
  }
}
