import type { FastifyInstance } from "fastify";
import type {
  OrderStore,
  ProjectStore,
  PartitionStore,
  DebriefWriter,
  DebriefReader,
  SettingsStore,
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
  settings: SettingsStore,
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

    const envEnabled = settings.get().environmentsEnabled;

    if (!projectId || !partitionId || !version || (envEnabled && !environmentId)) {
      return reply.status(400).send({
        error: envEnabled
          ? "Missing required fields: projectId, partitionId, environmentId, version"
          : "Missing required fields: projectId, partitionId, version",
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
      projectId: project.id,
      projectName: project.name,
      partitionId: partition.id,
      environmentId: environment.id,
      environmentName: environment.name,
      version,
      steps: project.steps,
      deployConfig: project.deployConfig,
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
