import type { FastifyInstance } from "fastify";
import type { IEnvironmentStore, IOperationStore, ITelemetryStore } from "@deploystack/core";
import { CreateEnvironmentSchema, UpdateEnvironmentSchema } from "./schemas.js";

export function registerEnvironmentRoutes(
  app: FastifyInstance,
  environments: IEnvironmentStore,
  operations: IOperationStore,
  telemetry: ITelemetryStore,
): void {
  // List all environments
  app.get("/api/environments", async () => {
    return { environments: environments.list() };
  });

  // Create an environment
  app.post("/api/environments", async (request, reply) => {
    const parsed = CreateEnvironmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const environment = environments.create(parsed.data.name.trim(), parsed.data.variables ?? {});
    telemetry.record({ actor: "anonymous", action: "environment.created", target: { type: "environment", id: environment.id }, details: { name: parsed.data.name } });
    return reply.status(201).send({ environment });
  });

  // Get environment by ID
  app.get<{ Params: { id: string } }>(
    "/api/environments/:id",
    async (request, reply) => {
      const environment = environments.get(request.params.id);
      if (!environment) {
        return reply.status(404).send({ error: "Environment not found" });
      }
      return { environment };
    },
  );

  // Update environment
  app.put<{ Params: { id: string } }>(
    "/api/environments/:id",
    async (request, reply) => {
      const parsed = UpdateEnvironmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
      }

      try {
        const environment = environments.update(request.params.id, {
          name: parsed.data.name?.trim(),
          variables: parsed.data.variables,
        });
        telemetry.record({ actor: "anonymous", action: "environment.updated", target: { type: "environment", id: request.params.id }, details: { name: parsed.data.name } });
        return { environment };
      } catch (err) {
        if (err instanceof Error && err.message.toLowerCase().includes("not found")) {
          return reply.status(404).send({ error: "Environment not found" });
        }
        app.log.error(err, "Failed to update environment");
        return reply.status(500).send({ error: "Internal server error" });
      }
    },
  );

  // Delete environment (with linked-operations safety check)
  app.delete<{ Params: { id: string } }>(
    "/api/environments/:id",
    async (request, reply) => {
      const envId = request.params.id;
      const env = environments.get(envId);
      if (!env) {
        return reply.status(404).send({ error: "Environment not found" });
      }

      // Check if any operations reference this environment
      const linkedOperations = operations
        .list()
        .filter((p) => p.environmentIds.includes(envId))
        .map((p) => ({ id: p.id, name: p.name }));

      if (linkedOperations.length > 0) {
        return reply.status(409).send({
          error: `Environment is linked to ${linkedOperations.length} operation(s). Unlink before deleting.`,
          linkedOperations,
        });
      }

      environments.delete(envId);
      return { deleted: true };
    },
  );
}
