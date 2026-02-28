import type { FastifyInstance } from "fastify";
import type {
  OrderStore,
  ProjectStore,
  PartitionStore,
  DebriefWriter,
  DebriefReader,
} from "@deploystack/core";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";

interface EnvironmentStore {
  get(id: string): { id: string; name: string; variables: Record<string, string> } | undefined;
}

/**
 * REST API routes for Orders (immutable deployment snapshots).
 * Orders are read-only after creation — no PUT or DELETE endpoints.
 */
export function registerOrderRoutes(
  app: FastifyInstance,
  orders: OrderStore,
  agent: CommandAgent,
  partitions: PartitionStore,
  environments: EnvironmentStore,
  projects: ProjectStore,
  deployments: DeploymentStore,
  debrief: DebriefWriter & DebriefReader,
): void {
  // List orders (supports ?projectId and ?partitionId filters)
  app.get("/api/orders", async (request) => {
    const { projectId, partitionId } = request.query as {
      projectId?: string;
      partitionId?: string;
    };

    let list;
    if (projectId) {
      list = orders.getByProject(projectId);
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
    const { projectId, partitionId, environmentId, version } = request.body as {
      projectId?: string;
      partitionId?: string;
      environmentId?: string;
      version?: string;
    };

    if (!projectId || !partitionId || !environmentId || !version) {
      return reply.status(400).send({
        error: "Missing required fields: projectId, partitionId, environmentId, version",
      });
    }

    const project = projects.get(projectId);
    if (!project) {
      return reply.status(404).send({ error: `Project not found: ${projectId}` });
    }

    const partition = partitions.get(partitionId);
    if (!partition) {
      return reply.status(404).send({ error: `Partition not found: ${partitionId}` });
    }

    const environment = environments.get(environmentId);
    if (!environment) {
      return reply.status(404).send({ error: `Environment not found: ${environmentId}` });
    }

    // Resolve variables using the same precedence as deployments
    const resolved: Record<string, string> = { ...environment.variables };
    for (const [key, value] of Object.entries(partition.variables)) {
      resolved[key] = value;
    }

    const order = orders.create({
      projectId: project.id,
      projectName: project.name,
      partitionId: partition.id,
      environmentId: environment.id,
      environmentName: environment.name,
      version,
      steps: project.steps,
      pipelineConfig: project.pipelineConfig,
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

    const environment = environments.get(order.environmentId);
    if (!environment) {
      return reply.status(404).send({ error: `Environment not found: ${order.environmentId}` });
    }

    const project = projects.get(order.projectId);
    if (!project) {
      return reply.status(404).send({ error: `Project not found: ${order.projectId}` });
    }

    const trigger = {
      projectId: order.projectId,
      partitionId: order.partitionId,
      environmentId: order.environmentId,
      version: order.version,
    };

    const deployment = await agent.triggerDeployment(
      trigger,
      partition,
      environment,
      project,
      order,
    );

    return reply.status(201).send({
      deployment,
      debrief: debrief.getByDeployment(deployment.id),
    });
  });
}
