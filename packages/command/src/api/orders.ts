import type { FastifyInstance } from "fastify";
import type {
  IOrderStore,
  IOperationStore,
  IPartitionStore,
  IEnvironmentStore,
  ISettingsStore,
  DebriefWriter,
  DebriefReader,
} from "@deploystack/core";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";
import { OrderListQuerySchema, CreateOrderSchema } from "./schemas.js";

/**
 * REST API routes for Orders (immutable deployment snapshots).
 * Orders are read-only after creation — no PUT or DELETE endpoints.
 */
export function registerOrderRoutes(
  app: FastifyInstance,
  orders: IOrderStore,
  agent: CommandAgent,
  partitions: IPartitionStore,
  environments: IEnvironmentStore,
  operations: IOperationStore,
  deployments: DeploymentStore,
  debrief: DebriefWriter & DebriefReader,
  settings: ISettingsStore,
): void {
  // List orders (supports ?operationId and ?partitionId filters)
  app.get("/api/orders", async (request) => {
    const parsed = OrderListQuerySchema.safeParse(request.query);
    const { operationId, partitionId } = parsed.success ? parsed.data : {};

    let list;
    if (operationId) {
      list = orders.getByOperation(operationId);
    } else if (partitionId) {
      list = orders.getByPartition(partitionId);
    } else {
      list = orders.list();
    }

    return { orders: list };
  });

  // Get a single order
  app.get<{ Params: { id: string } }>("/api/orders/:id", async (request, reply) => {
    const order = orders.get(request.params.id);
    if (!order) {
      return reply.status(404).send({ error: "Order not found" });
    }

    // Include deployments that used this order
    const relatedDeployments = deployments
      .list()
      .filter((d) => d.orderId === order.id);

    return { order, deployments: relatedDeployments };
  });

  // Create an order manually (pre-stage without deploying)
  app.post("/api/orders", async (request, reply) => {
    const parsed = CreateOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const { operationId, partitionId, environmentId, version } = parsed.data;
    const envEnabled = settings.get().environmentsEnabled;

    if (envEnabled && !environmentId) {
      return reply.status(400).send({
        error: "Missing required field: environmentId (environments are enabled)",
      });
    }

    const operation = operations.get(operationId);
    if (!operation) {
      return reply.status(404).send({ error: `Operation not found: ${operationId}` });
    }

    const partition = partitions.get(partitionId);
    if (!partition) {
      return reply.status(404).send({ error: `Partition not found: ${partitionId}` });
    }

    let environment: { id: string; name: string; variables: Record<string, string> };
    if (envEnabled && environmentId) {
      const env = environments.get(environmentId);
      if (!env) {
        return reply.status(404).send({ error: `Environment not found: ${environmentId}` });
      }
      environment = env;
    } else {
      environment = { id: "", name: "(none)", variables: {} };
    }

    // Resolve variables using the same precedence as deployments
    const resolved: Record<string, string> = { ...environment.variables };
    for (const [key, value] of Object.entries(partition.variables)) {
      resolved[key] = value;
    }

    const order = orders.create({
      operationId: operation.id,
      operationName: operation.name,
      partitionId: partition.id,
      environmentId: environment.id,
      environmentName: environment.name,
      version,
      steps: operation.steps,
      deployConfig: operation.deployConfig,
      variables: resolved,
    });

    return reply.status(201).send({ order });
  });

  // Re-execute an existing order
  app.post<{ Params: { id: string } }>("/api/orders/:id/execute", async (request, reply) => {
    const order = orders.get(request.params.id);
    if (!order) {
      return reply.status(404).send({ error: "Order not found" });
    }

    const partition = partitions.get(order.partitionId);
    if (!partition) {
      return reply.status(404).send({ error: `Partition not found: ${order.partitionId}` });
    }

    let environment: { id: string; name: string; variables: Record<string, string> };
    if (order.environmentId) {
      const env = environments.get(order.environmentId);
      if (!env) {
        return reply.status(404).send({ error: `Environment not found: ${order.environmentId}` });
      }
      environment = env;
    } else {
      environment = { id: "", name: "(none)", variables: {} };
    }

    const operation = operations.get(order.operationId);
    if (!operation) {
      return reply.status(404).send({ error: `Operation not found: ${order.operationId}` });
    }

    const trigger = {
      operationId: order.operationId,
      partitionId: order.partitionId,
      environmentId: order.environmentId,
      version: order.version,
    };

    const deployment = await agent.triggerDeployment(
      trigger,
      partition,
      environment,
      operation,
      order,
    );

    return reply.status(201).send({
      deployment,
      debrief: debrief.getByDeployment(deployment.id),
    });
  });
}
