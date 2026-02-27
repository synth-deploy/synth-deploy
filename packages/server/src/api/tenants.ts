import type { FastifyInstance } from "fastify";
import type { TenantStore, DecisionDebrief } from "@deploystack/core";
import { generateProjectHistory } from "@deploystack/core";
import type { DeploymentStore } from "../agent/server-agent.js";

export function registerTenantRoutes(
  app: FastifyInstance,
  tenants: TenantStore,
  deployments: DeploymentStore,
  debrief: DecisionDebrief,
): void {
  // List all tenants
  app.get("/api/tenants", async () => {
    return { tenants: tenants.list() };
  });

  // Create a tenant
  app.post("/api/tenants", async (request, reply) => {
    const { name, variables } = request.body as {
      name?: string;
      variables?: Record<string, string>;
    };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.status(400).send({ error: "name is required" });
    }

    const tenant = tenants.create(name.trim(), variables ?? {});
    return reply.status(201).send({ tenant });
  });

  // Get tenant by ID
  app.get<{ Params: { id: string } }>("/api/tenants/:id", async (request, reply) => {
    const tenant = tenants.get(request.params.id);
    if (!tenant) {
      return reply.status(404).send({ error: "Tenant not found" });
    }
    return { tenant };
  });

  // Update tenant (name)
  app.put<{ Params: { id: string } }>("/api/tenants/:id", async (request, reply) => {
    const { name } = request.body as { name?: string };

    try {
      const tenant = tenants.update(request.params.id, {
        name: name?.trim(),
      });
      return { tenant };
    } catch {
      return reply.status(404).send({ error: "Tenant not found" });
    }
  });

  // Delete tenant
  app.delete<{ Params: { id: string } }>("/api/tenants/:id", async (request, reply) => {
    const tenant = tenants.get(request.params.id);
    if (!tenant) {
      return reply.status(404).send({ error: "Tenant not found" });
    }
    tenants.delete(request.params.id);
    return { deleted: true };
  });

  // Update tenant variables
  app.put<{ Params: { id: string } }>(
    "/api/tenants/:id/variables",
    async (request, reply) => {
      const { variables } = request.body as {
        variables?: Record<string, string>;
      };

      if (!variables || typeof variables !== "object") {
        return reply.status(400).send({ error: "variables object is required" });
      }

      try {
        const tenant = tenants.setVariables(request.params.id, variables);
        return { tenant };
      } catch {
        return reply.status(404).send({ error: "Tenant not found" });
      }
    },
  );

  // Get tenant deployment history / project history
  app.get<{ Params: { id: string } }>(
    "/api/tenants/:id/history",
    async (request, reply) => {
      const tenant = tenants.get(request.params.id);
      if (!tenant) {
        return reply.status(404).send({ error: "Tenant not found" });
      }

      const tenantDeployments = deployments.getByTenant(request.params.id);
      const tenantEntries = debrief.getByTenant(request.params.id);
      const history = generateProjectHistory(tenantEntries, tenantDeployments);

      return { history };
    },
  );
}
