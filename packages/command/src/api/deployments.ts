import type { FastifyInstance } from "fastify";
import { DeploymentTriggerSchema, generatePostmortem } from "@deploystack/core";
import type { IPartitionStore, IEnvironmentStore, IOperationStore, IOrderStore, ISettingsStore, DebriefWriter, DebriefReader } from "@deploystack/core";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";

/**
 * REST API routes for deployments. These are the traditional (non-MCP) interface
 * for the web UI and integrations. They call the same CommandAgent as MCP tools.
 */
export function registerDeploymentRoutes(
  app: FastifyInstance,
  agent: CommandAgent,
  partitions: IPartitionStore,
  environments: IEnvironmentStore,
  deployments: DeploymentStore,
  debrief: DebriefWriter & DebriefReader,
  operations: IOperationStore,
  orders: IOrderStore,
  settings: ISettingsStore,
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
    const envEnabled = settings.get().environmentsEnabled;

    // Validate operation exists
    const operation = operations.get(trigger.operationId);
    if (!operation) {
      return reply.status(404).send({ error: `Operation not found: ${trigger.operationId}` });
    }

    const partition = partitions.get(trigger.partitionId);
    if (!partition) {
      return reply.status(404).send({ error: `Partition not found: ${trigger.partitionId}` });
    }

    // Resolve environment — skip validation when environments are disabled
    let environment: { id: string; name: string; variables: Record<string, string> };
    if (envEnabled && trigger.environmentId) {
      if (!operation.environmentIds.includes(trigger.environmentId)) {
        return reply.status(400).send({
          error: `Environment ${trigger.environmentId} is not linked to operation "${operation.name}". ` +
            `Available environments: ${operation.environmentIds.join(", ") || "none"}`,
        });
      }
      const env = environments.get(trigger.environmentId);
      if (!env) {
        return reply.status(404).send({ error: `Environment not found: ${trigger.environmentId}` });
      }
      environment = env;
    } else {
      environment = { id: "", name: "(none)", variables: {} };
    }

    // If an orderId was provided, load the existing Order for re-execution
    let existingOrder;
    if (typeof orderId === "string") {
      existingOrder = orders.get(orderId);
      if (!existingOrder) {
        return reply.status(404).send({ error: `Order not found: ${orderId}` });
      }
    }

    const deployment = await agent.triggerDeployment(trigger, partition, environment, operation, existingOrder);

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

  // List deployments filtered by operation
  app.get("/api/operations/:operationId/deployments", async (request) => {
    const { operationId } = request.params as { operationId: string };
    const all = deployments.list();
    const filtered = all.filter((d) => d.operationId === operationId);
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
