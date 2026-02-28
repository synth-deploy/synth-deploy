import type { FastifyInstance } from "fastify";
import { DeploymentTriggerSchema, generatePostmortem } from "@deploystack/core";
import type { PartitionStore, DebriefWriter, DebriefReader, OrderStore, Project } from "@deploystack/core";
import type { ServerAgent, DeploymentStore } from "../agent/server-agent.js";

interface EnvironmentStore {
  get(id: string): { id: string; name: string; variables: Record<string, string> } | undefined;
}

interface ProjectStore {
  get(id: string): Project | undefined;
}

/**
 * REST API routes for deployments. These are the traditional (non-MCP) interface
 * for the web UI and integrations. They call the same ServerAgent as MCP tools.
 */
export function registerDeploymentRoutes(
  app: FastifyInstance,
  agent: ServerAgent,
  partitions: PartitionStore,
  environments: EnvironmentStore,
  deployments: DeploymentStore,
  debrief: DebriefWriter & DebriefReader,
  projects: ProjectStore,
  orders: OrderStore,
): void {
  // Trigger a deployment
  app.post("/api/deployments", async (request, reply) => {
    const parsed = DeploymentTriggerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid deployment trigger",
        details: parsed.error.issues,
      });
    }

    const trigger = parsed.data;
    const { orderId } = (request.body as Record<string, unknown>) ?? {};

    // Validate project exists
    const project = projects.get(trigger.projectId);
    if (!project) {
      return reply.status(404).send({ error: `Project not found: ${trigger.projectId}` });
    }
    // Validate environment belongs to project
    if (!project.environmentIds.includes(trigger.environmentId)) {
      return reply.status(400).send({
        error: `Environment ${trigger.environmentId} is not linked to project "${project.name}". ` +
          `Available environments: ${project.environmentIds.join(", ") || "none"}`,
      });
    }

    const partition = partitions.get(trigger.partitionId);
    if (!partition) {
      return reply.status(404).send({ error: `Partition not found: ${trigger.partitionId}` });
    }

    const environment = environments.get(trigger.environmentId);
    if (!environment) {
      return reply.status(404).send({ error: `Environment not found: ${trigger.environmentId}` });
    }

    // If an orderId was provided, load the existing Order for re-execution
    let existingOrder;
    if (typeof orderId === "string") {
      existingOrder = orders.get(orderId);
      if (!existingOrder) {
        return reply.status(404).send({ error: `Order not found: ${orderId}` });
      }
    }

    const deployment = await agent.triggerDeployment(trigger, partition, environment, project, existingOrder);

    return reply.status(201).send({
      deployment,
      debrief: debrief.getByDeployment(deployment.id),
    });
  });

  // Get deployment by ID
  app.get<{ Params: { id: string } }>("/api/deployments/:id", async (request, reply) => {
    const deployment = deployments.get(request.params.id);
    if (!deployment) {
      return reply.status(404).send({ error: "Deployment not found" });
    }

    return {
      deployment,
      debrief: debrief.getByDeployment(deployment.id),
    };
  });

  // List deployments (optionally filtered by partition)
  app.get("/api/deployments", async (request) => {
    const { partitionId } = request.query as { partitionId?: string };
    const list = partitionId ? deployments.getByPartition(partitionId) : deployments.list();

    return { deployments: list };
  });

  // List deployments filtered by project
  app.get("/api/projects/:projectId/deployments", async (request) => {
    const { projectId } = request.params as { projectId: string };
    const all = deployments.list();
    const filtered = all.filter((d) => d.projectId === projectId);
    return { deployments: filtered };
  });

  // Get deployment postmortem
  app.get<{ Params: { id: string } }>(
    "/api/deployments/:id/postmortem",
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const entries = debrief.getByDeployment(deployment.id);
      const postmortem = generatePostmortem(entries, deployment);
      return { postmortem };
    },
  );

  // Get recent debrief entries (supports filtering by partition and decision type)
  app.get("/api/debrief", async (request) => {
    const { limit, partitionId, decisionType } = request.query as {
      limit?: string;
      partitionId?: string;
      decisionType?: string;
    };

    const max = limit ? parseInt(limit, 10) : 50;

    // No filters — fast path
    if (!partitionId && !decisionType) {
      return { entries: debrief.getRecent(max) };
    }

    // Start with the most selective filter, then narrow
    let entries: ReturnType<typeof debrief.getByPartition>;
    if (partitionId && decisionType) {
      entries = debrief.getByPartition(partitionId).filter(
        (e) => e.decisionType === decisionType,
      );
    } else if (partitionId) {
      entries = debrief.getByPartition(partitionId);
    } else {
      entries = debrief.getByType(decisionType as Parameters<typeof debrief.getByType>[0]);
    }

    entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return { entries: entries.slice(0, max) };
  });
}
