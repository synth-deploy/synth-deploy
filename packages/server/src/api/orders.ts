import type { FastifyInstance } from "fastify";
import type {
  OrderStore,
  ProjectStore,
  TenantStore,
  DecisionDebrief,
} from "@deploystack/core";
import type { ServerAgent, DeploymentStore } from "../agent/server-agent.js";

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
  agent: ServerAgent,
  tenants: TenantStore,
  environments: EnvironmentStore,
  projects: ProjectStore,
  deployments: DeploymentStore,
  debrief: DecisionDebrief,
): void {
  // List orders (supports ?projectId and ?tenantId filters)
  app.get("/api/orders", async (request) => {
    const { projectId, tenantId } = request.query as {
      projectId?: string;
      tenantId?: string;
    };

    let list;
    if (projectId) {
      list = orders.getByProject(projectId);
    } else if (tenantId) {
      list = orders.getByTenant(tenantId);
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
    const { projectId, tenantId, environmentId, version } = request.body as {
      projectId?: string;
      tenantId?: string;
      environmentId?: string;
      version?: string;
    };

    if (!projectId || !tenantId || !environmentId || !version) {
      return reply.status(400).send({
        error: "Missing required fields: projectId, tenantId, environmentId, version",
      });
    }

    const project = projects.get(projectId);
    if (!project) {
      return reply.status(404).send({ error: `Project not found: ${projectId}` });
    }

    const tenant = tenants.get(tenantId);
    if (!tenant) {
      return reply.status(404).send({ error: `Tenant not found: ${tenantId}` });
    }

    const environment = environments.get(environmentId);
    if (!environment) {
      return reply.status(404).send({ error: `Environment not found: ${environmentId}` });
    }

    // Resolve variables using the same precedence as deployments
    const resolved: Record<string, string> = { ...environment.variables };
    for (const [key, value] of Object.entries(tenant.variables)) {
      resolved[key] = value;
    }

    const order = orders.create({
      projectId: project.id,
      projectName: project.name,
      tenantId: tenant.id,
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

    const tenant = tenants.get(order.tenantId);
    if (!tenant) {
      return reply.status(404).send({ error: `Tenant not found: ${order.tenantId}` });
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
      tenantId: order.tenantId,
      environmentId: order.environmentId,
      version: order.version,
    };

    const deployment = await agent.triggerDeployment(
      trigger,
      tenant,
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
