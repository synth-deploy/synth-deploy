import type { FastifyInstance } from "fastify";
import type { EnvironmentStore, OperationStore } from "@deploystack/core";

export function registerEnvironmentRoutes(
  app: FastifyInstance,
  environments: EnvironmentStore,
  operations: OperationStore,
): void {
  // List all environments
  app.get("/api/environments", async () => {
    return { environments: environments.list() };
  });

  // Create an environment
  app.post("/api/environments", async (request, reply) => {
    const { name, variables } = request.body as {
      name?: string;
      variables?: Record<string, string>;
    };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.status(400).send({ error: "name is required" });
    }

    const environment = environments.create(name.trim(), variables ?? {});
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
      const { name, variables } = request.body as {
        name?: string;
        variables?: Record<string, string>;
      };

      try {
        const environment = environments.update(request.params.id, {
          name: name?.trim(),
          variables,
        });
        return { environment };
      } catch {
        return reply.status(404).send({ error: "Environment not found" });
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
