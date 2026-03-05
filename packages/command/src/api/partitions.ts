import type { FastifyInstance } from "fastify";
import type { IPartitionStore, ITelemetryStore, DebriefReader, DebriefWriter, IOrderStore } from "@deploystack/core";
import { generateOperationHistory } from "@deploystack/core";
import type { DeploymentStore } from "../agent/command-agent.js";
import { CreatePartitionSchema, UpdatePartitionSchema, SetVariablesSchema } from "./schemas.js";
import { requirePermission } from "../middleware/permissions.js";

export function registerPartitionRoutes(
  app: FastifyInstance,
  partitions: IPartitionStore,
  deployments: DeploymentStore,
  debrief: DebriefReader & DebriefWriter,
  orders: IOrderStore,
  telemetry: ITelemetryStore,
): void {
  // List all partitions
  app.get("/api/partitions", { preHandler: [requirePermission("partition.view")] }, async () => {
    return { partitions: partitions.list() };
  });

  // Create a partition
  app.post("/api/partitions", { preHandler: [requirePermission("partition.create")] }, async (request, reply) => {
    const parsed = CreatePartitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const partition = partitions.create(parsed.data.name.trim(), parsed.data.variables ?? {});
    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "partition.created", target: { type: "partition", id: partition.id }, details: { name: parsed.data.name } });
    return reply.status(201).send({ partition });
  });

  // Get partition by ID
  app.get<{ Params: { id: string } }>("/api/partitions/:id", { preHandler: [requirePermission("partition.view")] }, async (request, reply) => {
    const partition = partitions.get(request.params.id);
    if (!partition) {
      return reply.status(404).send({ error: "Partition not found" });
    }
    return { partition };
  });

  // Update partition (name)
  app.put<{ Params: { id: string } }>("/api/partitions/:id", { preHandler: [requirePermission("partition.update")] }, async (request, reply) => {
    const parsed = UpdatePartitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    try {
      const partition = partitions.update(request.params.id, {
        name: parsed.data.name?.trim(),
      });
      return { partition };
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes("not found")) {
        return reply.status(404).send({ error: "Partition not found" });
      }
      app.log.error(err, "Failed to update partition");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // Delete partition
  app.delete<{ Params: { id: string }; Querystring: { cascade?: string } }>(
    "/api/partitions/:id",
    { preHandler: [requirePermission("partition.delete")] },
    async (request, reply) => {
      const { id } = request.params;
      const partition = partitions.get(id);
      if (!partition) {
        return reply.status(404).send({ error: "Partition not found" });
      }

      const linkedDeployments = deployments.getByPartition(id);
      const linkedOrders = orders.getByPartition(id);
      const hasLinks = linkedDeployments.length > 0 || linkedOrders.length > 0;

      if (hasLinks && request.query.cascade !== "true") {
        return reply.status(409).send({
          error: "Partition has linked records",
          deployments: linkedDeployments.length,
          orders: linkedOrders.length,
          hint: "Add ?cascade=true to force-delete with all linked records",
        });
      }

      if (hasLinks && request.query.cascade === "true") {
        // Log cascade deletion to Decision Diary
        debrief.record({
          partitionId: id,
          deploymentId: null,
          agent: "command",
          decisionType: "system",
          decision: `Cascade-deleted partition "${partition.name}" with ${linkedDeployments.length} deployments and ${linkedOrders.length} orders`,
          reasoning: "User requested cascade deletion via ?cascade=true query parameter",
          context: {
            partitionId: id,
            partitionName: partition.name,
            deploymentCount: linkedDeployments.length,
            orderCount: linkedOrders.length,
          },
        });
      }

      partitions.delete(id);
      return { deleted: true, cascade: hasLinks };
    },
  );

  // Update partition variables
  app.put<{ Params: { id: string } }>(
    "/api/partitions/:id/variables",
    { preHandler: [requirePermission("partition.update")] },
    async (request, reply) => {
      const parsed = SetVariablesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
      }

      try {
        const partition = partitions.setVariables(request.params.id, parsed.data.variables);
        telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "partition.variables.updated", target: { type: "partition", id: request.params.id }, details: { variableCount: Object.keys(parsed.data.variables).length } });
        return { partition };
      } catch (err) {
        if (err instanceof Error && err.message.toLowerCase().includes("not found")) {
          return reply.status(404).send({ error: "Partition not found" });
        }
        app.log.error(err, "Failed to set partition variables");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  // Get partition deployment history / operation history
  app.get<{ Params: { id: string } }>(
    "/api/partitions/:id/history",
    { preHandler: [requirePermission("partition.view")] },
    async (request, reply) => {
      const partition = partitions.get(request.params.id);
      if (!partition) {
        return reply.status(404).send({ error: "Partition not found" });
      }

      const partitionDeployments = deployments.getByPartition(request.params.id);
      const partitionEntries = debrief.getByPartition(request.params.id);
      const history = generateOperationHistory(partitionEntries, partitionDeployments);

      return { history };
    },
  );
}
