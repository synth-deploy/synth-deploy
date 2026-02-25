import type { FastifyInstance } from "fastify";
import { DeploymentTriggerSchema, generatePostmortem } from "@deploystack/core";
import type { TenantStore, DecisionDiary } from "@deploystack/core";
import type { ServerAgent, DeploymentStore } from "../agent/server-agent.js";

interface EnvironmentStore {
  get(id: string): { id: string; name: string; variables: Record<string, string> } | undefined;
}

/**
 * REST API routes for deployments. These are the traditional (non-MCP) interface
 * for the web UI and integrations. They call the same ServerAgent as MCP tools.
 */
export function registerDeploymentRoutes(
  app: FastifyInstance,
  agent: ServerAgent,
  tenants: TenantStore,
  environments: EnvironmentStore,
  deployments: DeploymentStore,
  diary: DecisionDiary,
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

    const tenant = tenants.get(trigger.tenantId);
    if (!tenant) {
      return reply.status(404).send({ error: `Tenant not found: ${trigger.tenantId}` });
    }

    const environment = environments.get(trigger.environmentId);
    if (!environment) {
      return reply.status(404).send({ error: `Environment not found: ${trigger.environmentId}` });
    }

    const deployment = await agent.triggerDeployment(trigger, tenant, environment);

    return reply.status(201).send({
      deployment,
      diary: diary.getByDeployment(deployment.id),
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
      diary: diary.getByDeployment(deployment.id),
    };
  });

  // List deployments (optionally filtered by tenant)
  app.get("/api/deployments", async (request) => {
    const { tenantId } = request.query as { tenantId?: string };
    const list = tenantId ? deployments.getByTenant(tenantId) : deployments.list();

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

      const entries = diary.getByDeployment(deployment.id);
      const postmortem = generatePostmortem(entries, deployment);
      return { postmortem };
    },
  );

  // Get recent diary entries
  app.get("/api/diary", async (request) => {
    const { limit } = request.query as { limit?: string };
    return { entries: diary.getRecent(limit ? parseInt(limit, 10) : 50) };
  });
}
