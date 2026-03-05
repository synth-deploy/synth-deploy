import type { FastifyInstance } from "fastify";
import type { IEnvironmentStore, IArtifactStore, ITelemetryStore } from "@deploystack/core";
import { CreateEnvironmentSchema, UpdateEnvironmentSchema } from "./schemas.js";
import { requirePermission } from "../middleware/permissions.js";
import type { DeploymentStore } from "../agent/command-agent.js";

export function registerEnvironmentRoutes(
  app: FastifyInstance,
  environments: IEnvironmentStore,
  deployments: DeploymentStore,
  telemetry: ITelemetryStore,
): void {
  // List all environments
  app.get("/api/environments", { preHandler: [requirePermission("environment.view")] }, async () => {
    return { environments: environments.list() };
  });

  // Create an environment
  app.post("/api/environments", { preHandler: [requirePermission("environment.create")] }, async (request, reply) => {
    const parsed = CreateEnvironmentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const environment = environments.create(parsed.data.name.trim(), parsed.data.variables ?? {});
    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "environment.created", target: { type: "environment", id: environment.id }, details: { name: parsed.data.name } });
    return reply.status(201).send({ environment });
  });

  // Get environment by ID
  app.get<{ Params: { id: string } }>(
    "/api/environments/:id",
    { preHandler: [requirePermission("environment.view")] },
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
    { preHandler: [requirePermission("environment.update")] },
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
        telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "environment.updated", target: { type: "environment", id: request.params.id }, details: { name: parsed.data.name } });
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
    { preHandler: [requirePermission("environment.delete")] },
    async (request, reply) => {
      const envId = request.params.id;
      const env = environments.get(envId);
      if (!env) {
        return reply.status(404).send({ error: "Environment not found" });
      }

      // Check if any deployments reference this environment
      const linkedDeployments = deployments
        .list()
        .filter((d) => d.environmentId === envId);

      if (linkedDeployments.length > 0) {
        return reply.status(409).send({
          error: `Environment has ${linkedDeployments.length} deployment(s). Cannot delete an environment with deployment history.`,
          deploymentCount: linkedDeployments.length,
        });
      }

      environments.delete(envId);
      return { deleted: true };
    },
  );
}
