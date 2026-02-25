import type { FastifyInstance } from "fastify";

interface EnvironmentStore {
  get(id: string): { id: string; name: string; variables: Record<string, string> } | undefined;
  create(name: string, variables?: Record<string, string>): { id: string; name: string; variables: Record<string, string> };
  list(): Array<{ id: string; name: string; variables: Record<string, string> }>;
}

export function registerEnvironmentRoutes(
  app: FastifyInstance,
  environments: EnvironmentStore,
): void {
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
}
