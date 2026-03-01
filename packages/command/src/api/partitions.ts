import type { FastifyInstance } from "fastify";
import type { IPartitionStore, DebriefReader } from "@deploystack/core";
import { generateOperationHistory } from "@deploystack/core";
import type { DeploymentStore } from "../agent/command-agent.js";
import { CreatePartitionSchema, UpdatePartitionSchema, SetVariablesSchema } from "./schemas.js";

export function registerPartitionRoutes(
  app: FastifyInstance,
  partitions: IPartitionStore,
  deployments: DeploymentStore,
  debrief: DebriefReader,
): void {
  // List all partitions
  app.get("/api/partitions", async () => {
    return { partitions: partitions.list() };
  });

  // Create a partition
  app.post("/api/partitions", async (request, reply) => {
    const parsed = CreatePartitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const partition = partitions.create(parsed.data.name.trim(), parsed.data.variables ?? {});
    return reply.status(201).send({ partition });
  });

  // Get partition by ID
  app.get<{ Params: { id: string } }>("/api/partitions/:id", async (request, reply) => {
    const partition = partitions.get(request.params.id);
    if (!partition) {
      return reply.status(404).send({ error: "Partition not found" });
    }
    return { partition };
  });

  // Update partition (name)
  app.put<{ Params: { id: string } }>("/api/partitions/:id", async (request, reply) => {
    const parsed = UpdatePartitionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    try {
      const partition = partitions.update(request.params.id, {
        name: parsed.data.name?.trim(),
      });
      return { partition };
    } catch {
      return reply.status(404).send({ error: "Partition not found" });
    }
  });

  // Delete partition
  app.delete<{ Params: { id: string } }>("/api/partitions/:id", async (request, reply) => {
    const partition = partitions.get(request.params.id);
    if (!partition) {
      return reply.status(404).send({ error: "Partition not found" });
    }
    partitions.delete(request.params.id);
    return { deleted: true };
  });

  // Update partition variables
  app.put<{ Params: { id: string } }>(
    "/api/partitions/:id/variables",
    async (request, reply) => {
      const parsed = SetVariablesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
      }

      try {
        const partition = partitions.setVariables(request.params.id, parsed.data.variables);
        return { partition };
      } catch {
        return reply.status(404).send({ error: "Partition not found" });
      }
    },
  );

  // Get partition deployment history / operation history
  app.get<{ Params: { id: string } }>(
    "/api/partitions/:id/history",
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
