import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EnvoyAgent, DeploymentInstruction } from "./agent/envoy-agent.js";
import type { LocalStateStore } from "./state/local-state.js";
import type { QueryEngine } from "./agent/query-engine.js";
import type { EscalationPackager } from "./agent/escalation-packager.js";

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const DeployRequestSchema = z.object({
  deploymentId: z.string(),
  partitionId: z.string(),
  environmentId: z.string(),
  operationId: z.string(),
  version: z.string(),
  variables: z.record(z.string()),
  environmentName: z.string(),
  partitionName: z.string(),
});

const QueryRequestSchema = z.object({
  query: z.string().min(1),
});

const EscalateDeploymentSchema = z.object({
  deploymentId: z.string(),
  reason: z.string().min(1),
});

const EscalateGeneralSchema = z.object({
  reason: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Envoy HTTP Server
// ---------------------------------------------------------------------------

/**
 * The Envoy's HTTP interface. This is how the Server communicates with
 * the Envoy — sending deployment instructions and checking health.
 *
 * Endpoints:
 *   GET  /health                — is this Envoy alive and ready?
 *   POST /deploy                — execute a deployment on this machine
 *   GET  /status                — what's deployed, what's running
 *   GET  /deployments/:id       — details of a specific local deployment
 *   POST /query                 — ask a natural language question
 *   POST /escalate/deployment   — escalate a specific deployment issue
 *   POST /escalate              — escalate a general issue
 */
export function createEnvoyServer(
  agent: EnvoyAgent,
  state: LocalStateStore,
  queryEngine?: QueryEngine,
  escalationPackager?: EscalationPackager,
): FastifyInstance {
  const app = Fastify({ logger: true });

  // -- Health check -----------------------------------------------------------

  app.get("/health", async () => {
    const status = agent.getStatus();
    return {
      status: status.healthy ? "healthy" : "degraded",
      service: "deploystack-envoy",
      hostname: status.hostname,
      timestamp: new Date().toISOString(),
      readiness: status.readiness,
      summary: status.summary,
    };
  });

  // -- Execute deployment -----------------------------------------------------

  app.post("/deploy", async (request, reply) => {
    const parsed = DeployRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid deployment instruction",
        details: parsed.error.format(),
      });
    }

    const instruction: DeploymentInstruction = parsed.data;
    const result = await agent.executeDeployment(instruction);

    return reply.status(result.success ? 200 : 500).send(result);
  });

  // -- Status -----------------------------------------------------------------

  app.get("/status", async () => {
    const status = agent.getStatus();
    const environments = state.listEnvironments();
    const recentDeployments = state.listDeployments().slice(0, 10);

    return {
      healthy: status.healthy,
      hostname: status.hostname,
      environments: environments.map((env) => ({
        environmentId: env.environmentId,
        partitionId: env.partitionId,
        currentVersion: env.currentVersion,
        currentDeploymentId: env.currentDeploymentId,
        lastUpdated: env.lastUpdated.toISOString(),
      })),
      recentDeployments: recentDeployments.map((d) => ({
        deploymentId: d.deploymentId,
        operationId: d.operationId,
        version: d.version,
        status: d.status,
        receivedAt: d.receivedAt.toISOString(),
        completedAt: d.completedAt?.toISOString() ?? null,
      })),
      summary: status.summary,
    };
  });

  // -- Deployment details -----------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/deployments/:id",
    async (request, reply) => {
      const record = state.getDeployment(request.params.id);
      if (!record) {
        return reply.status(404).send({
          error: `Deployment ${request.params.id} not found on this Envoy`,
        });
      }

      return {
        ...record,
        receivedAt: record.receivedAt.toISOString(),
        completedAt: record.completedAt?.toISOString() ?? null,
      };
    },
  );

  // -- Query interface ---------------------------------------------------------

  app.post("/query", async (request, reply) => {
    if (!queryEngine) {
      return reply.status(501).send({
        error: "Query engine not configured on this Envoy",
      });
    }

    const parsed = QueryRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid query request",
        details: parsed.error.format(),
      });
    }

    const result = queryEngine.query(parsed.data.query);
    return {
      ...result,
      answeredAt: result.answeredAt.toISOString(),
    };
  });

  // -- Escalation — specific deployment --------------------------------------

  app.post("/escalate/deployment", async (request, reply) => {
    if (!escalationPackager) {
      return reply.status(501).send({
        error: "Escalation packager not configured on this Envoy",
      });
    }

    const parsed = EscalateDeploymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid escalation request",
        details: parsed.error.format(),
      });
    }

    const pkg = escalationPackager.packageForDeployment(
      parsed.data.deploymentId,
      parsed.data.reason,
    );

    return {
      ...pkg,
      createdAt: pkg.createdAt.toISOString(),
      recentDeployments: pkg.recentDeployments.map((d) => ({
        ...d,
        receivedAt: d.receivedAt.toISOString(),
        completedAt: d.completedAt?.toISOString() ?? null,
      })),
      relevantDebriefEntries: pkg.relevantDebriefEntries.map((e) => ({
        ...e,
        timestamp: e.timestamp.toISOString(),
      })),
    };
  });

  // -- Escalation — general ---------------------------------------------------

  app.post("/escalate", async (request, reply) => {
    if (!escalationPackager) {
      return reply.status(501).send({
        error: "Escalation packager not configured on this Envoy",
      });
    }

    const parsed = EscalateGeneralSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid escalation request",
        details: parsed.error.format(),
      });
    }

    const pkg = escalationPackager.packageGeneral(parsed.data.reason);

    return {
      ...pkg,
      createdAt: pkg.createdAt.toISOString(),
      recentDeployments: pkg.recentDeployments.map((d) => ({
        ...d,
        receivedAt: d.receivedAt.toISOString(),
        completedAt: d.completedAt?.toISOString() ?? null,
      })),
      relevantDebriefEntries: pkg.relevantDebriefEntries.map((e) => ({
        ...e,
        timestamp: e.timestamp.toISOString(),
      })),
    };
  });

  return app;
}
