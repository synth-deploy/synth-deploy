import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { EnvoyAgent, DeploymentInstruction, PlanningInstruction, LifecycleState } from "./agent/envoy-agent.js";
import type { EnvoyKnowledgeStore } from "./state/knowledge-store.js";
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
  progressCallbackUrl: z.string().url().optional(),
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

const PlanRequestSchema = z.object({
  deploymentId: z.string(),
  artifact: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    analysis: z.object({
      summary: z.string(),
      dependencies: z.array(z.string()),
      configurationExpectations: z.record(z.string()),
      deploymentIntent: z.string().optional(),
      confidence: z.number(),
    }),
  }),
  environment: z.object({
    id: z.string(),
    name: z.string(),
    variables: z.record(z.string()),
  }),
  partition: z.object({
    id: z.string(),
    name: z.string(),
    variables: z.record(z.string()),
  }).optional(),
  version: z.string(),
  resolvedVariables: z.record(z.string()),
});

const ExecuteRequestSchema = z.object({
  deploymentId: z.string(),
  artifactType: z.string(),
  artifactName: z.string(),
  environmentId: z.string(),
  progressCallbackUrl: z.string().url().optional(),
  plan: z.object({
    steps: z.array(z.object({
      description: z.string(),
      action: z.string(),
      target: z.string(),
      reversible: z.boolean(),
      rollbackAction: z.string().optional(),
    })),
    reasoning: z.string(),
    diffFromCurrent: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })).optional(),
    diffFromPreviousPlan: z.string().optional(),
  }),
  rollbackPlan: z.object({
    steps: z.array(z.object({
      description: z.string(),
      action: z.string(),
      target: z.string(),
      reversible: z.boolean(),
      rollbackAction: z.string().optional(),
    })),
    reasoning: z.string(),
    diffFromCurrent: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })).optional(),
    diffFromPreviousPlan: z.string().optional(),
  }),
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
 *   GET  /lifecycle             — current lifecycle state and in-flight count
 *   POST /lifecycle/drain       — drain: reject new deployments, finish in-flight
 *   POST /lifecycle/pause       — pause: reject all new deployments
 *   POST /lifecycle/resume      — resume: accept deployments normally
 */
export function createEnvoyServer(
  agent: EnvoyAgent,
  state: EnvoyKnowledgeStore,
  queryEngine?: QueryEngine,
  escalationPackager?: EscalationPackager,
): FastifyInstance {
  const app = Fastify({ logger: true });

  // -- Health check -----------------------------------------------------------

  app.get("/health", async () => {
    const status = agent.getStatus();
    const capabilities = agent.getCapabilities();
    return {
      status: status.healthy ? "healthy" : "degraded",
      service: "synth-envoy",
      hostname: status.hostname,
      os: status.os,
      timestamp: new Date().toISOString(),
      readiness: status.readiness,
      summary: status.summary,
      lifecycle: status.lifecycle,
      capabilities,
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

  // -- Plan deployment (Phase 1: read-only reasoning) -------------------------

  app.post("/plan", async (request, reply) => {
    const parsed = PlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid planning instruction",
        details: parsed.error.format(),
      });
    }

    const instruction: PlanningInstruction = parsed.data;

    try {
      const result = await agent.planDeployment(instruction);
      return reply.status(200).send(result);
    } catch (err) {
      return reply.status(500).send({
        error: "Planning failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // -- Execute approved plan (Phase 2: deterministic execution) ---------------

  app.post("/execute", async (request, reply) => {
    const parsed = ExecuteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid execution request",
        details: parsed.error.format(),
      });
    }

    const { deploymentId, artifactType, artifactName, environmentId, plan, rollbackPlan, progressCallbackUrl } = parsed.data;
    const result = await agent.executeApprovedPlan(deploymentId, plan, rollbackPlan, {
      artifactType,
      artifactName,
      environmentId,
    }, progressCallbackUrl);

    return reply.status(result.success ? 200 : 500).send(result);
  });

  // -- Validate plan (boundary check only, no execution) ---------------------

  app.post("/validate-plan", async (request, reply) => {
    const body = request.body as { steps?: unknown; boundaries?: unknown };
    if (!body?.steps || !Array.isArray(body.steps)) {
      return reply.status(400).send({ error: "Request must include steps array" });
    }

    const boundaries = Array.isArray(body.boundaries) ? body.boundaries : [];
    const result = await agent.validatePlanSteps(body.steps, boundaries);
    return reply.status(200).send(result);
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

    const result = await queryEngine.queryAsync(parsed.data.query);
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

  // -- Lifecycle management ---------------------------------------------------

  app.get("/lifecycle", async () => {
    const status = agent.getStatus();
    return {
      state: agent.lifecycleState,
      inFlightDeployments: status.summary.executing,
    };
  });

  app.post("/lifecycle/drain", async () => {
    agent.drain();
    const status = agent.getStatus();
    return {
      state: agent.lifecycleState,
      inFlightDeployments: status.summary.executing,
    };
  });

  app.post("/lifecycle/pause", async () => {
    agent.pause();
    const status = agent.getStatus();
    return {
      state: agent.lifecycleState,
      inFlightDeployments: status.summary.executing,
    };
  });

  app.post("/lifecycle/resume", async () => {
    agent.resume();
    const status = agent.getStatus();
    return {
      state: agent.lifecycleState,
      inFlightDeployments: status.summary.executing,
    };
  });

  return app;
}
