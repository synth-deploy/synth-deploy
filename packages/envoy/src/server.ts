import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MonitoringDirectiveSchema } from "@synth-deploy/core";
import type { EnvoyAgent, DeploymentInstruction, PlanningInstruction, LifecycleState, RollbackPlanningInstruction } from "./agent/envoy-agent.js";
import type { EnvoyKnowledgeStore } from "./state/knowledge-store.js";
import type { QueryEngine } from "./agent/query-engine.js";
import type { EscalationPackager } from "./agent/escalation-packager.js";
import type { HealthCheckScheduler } from "./agent/health-check-scheduler.js";

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const DeployRequestSchema = z.object({
  deploymentId: z.string(),
  operationId: z.string(),
  partitionId: z.string(),
  environmentId: z.string(),
  version: z.string(),
  variables: z.record(z.string()),
  environmentName: z.string(),
  partitionName: z.string(),
  progressCallbackUrl: z.string().optional(),
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
  operationId: z.string(),
  /** Operation type — determines which planning path to use. Defaults to "deploy". */
  operationType: z.enum(["deploy", "query", "investigate", "maintain", "trigger"]).optional(),
  /** Natural language objective for non-deploy operations */
  intent: z.string().optional(),
  /** Whether the investigation is allowed to run write probes (default false) */
  allowWrite: z.boolean().optional(),
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
  }).optional(),
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
  /** Forwarded from Server runtime config — never logged or persisted */
  llmApiKey: z.string().optional(),
  refinementFeedback: z.string().optional(),
  /** Prior shelved plan for this same artifact+environment — injected as soft context */
  shelvedPlanContext: z.object({
    reasoning: z.string(),
    shelvedAt: z.string(),
    shelvedReason: z.string().optional(),
  }).optional(),
  /** Trigger-specific: the condition expression (e.g. "disk_usage > 85") */
  triggerCondition: z.string().optional(),
  /** Trigger-specific: what to do when the condition fires */
  triggerResponseIntent: z.string().optional(),
  /** User-provided context about this envoy's environment */
  envoyContext: z.string().optional(),
});

const StepSummarySchema = z.object({
  description: z.string(),
  reversible: z.boolean(),
});

const ScriptedPlanSchema = z.object({
  platform: z.enum(["bash", "powershell"]),
  executionScript: z.string(),
  dryRunScript: z.string().nullable(),
  rollbackScript: z.string().nullable(),
  reasoning: z.string(),
  stepSummary: z.array(StepSummarySchema),
  diffFromCurrent: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })).optional(),
});

const PlanSchema = z.object({
  scriptedPlan: ScriptedPlanSchema,
  reasoning: z.string(),
  diffFromCurrent: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })).optional(),
  diffFromPreviousPlan: z.string().optional(),
});

const ExecuteRequestSchema = z.object({
  operationId: z.string(),
  artifactType: z.string(),
  artifactName: z.string(),
  environmentId: z.string(),
  progressCallbackUrl: z.string().url().optional(),
  callbackToken: z.string().optional(),
  plan: PlanSchema,
  rollbackPlan: PlanSchema,
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
  healthScheduler?: HealthCheckScheduler,
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
      console.error("[envoy] /execute schema validation failed:", JSON.stringify(parsed.error.format(), null, 2));
      return reply.status(400).send({
        error: "Invalid execution request",
        details: parsed.error.format(),
      });
    }

    const { operationId, artifactType, artifactName, environmentId, plan, rollbackPlan, progressCallbackUrl, callbackToken } = parsed.data;
    // Fall back to envoy's own auth token if no callback token provided by server
    const effectiveToken = callbackToken ?? process.env.SYNTH_ENVOY_TOKEN;
    const result = await agent.executeApprovedPlan(operationId, plan, rollbackPlan, {
      artifactType,
      artifactName,
      environmentId,
    }, progressCallbackUrl, effectiveToken);

    return reply.status(result.success ? 200 : 500).send(result);
  });

  // -- Rollback plan generation (post-hoc, based on what actually ran) --------

  const RollbackPlanRequestSchema = z.object({
    operationId: z.string(),
    artifact: z.object({
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
    }),
    completedSteps: z.array(z.object({
      description: z.string(),
      action: z.string(),
      target: z.string(),
      status: z.enum(["completed", "failed", "rolled_back"]),
      output: z.string().optional(),
    })),
    deployedVariables: z.record(z.string()),
    version: z.string(),
    failureReason: z.string().optional(),
    /** Forwarded from Server runtime config — never logged or persisted */
    llmApiKey: z.string().optional(),
    /** User-provided context about this envoy's environment */
    envoyContext: z.string().optional(),
  });

  app.post("/rollback-plan", async (request, reply) => {
    const parsed = RollbackPlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid rollback plan request",
        details: parsed.error.format(),
      });
    }

    const instruction: RollbackPlanningInstruction = parsed.data;

    try {
      const rollbackPlan = await agent.planRollback(instruction);
      return reply.status(200).send({ rollbackPlan });
    } catch (err) {
      return reply.status(500).send({
        error: "Rollback plan generation failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // -- Validate refinement feedback (cheap LLM call, no probe loop) ----------

  const ValidateRefinementSchema = z.object({
    feedback: z.string().min(1),
    currentPlanSummary: z.array(z.object({
      description: z.string(),
      reversible: z.boolean(),
    })),
    artifactName: z.string(),
    environmentName: z.string(),
    llmApiKey: z.string().optional(),
  });

  app.post("/validate-refinement", async (request, reply) => {
    const parsed = ValidateRefinementSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid request", details: parsed.error.format() });
    }
    try {
      const result = await agent.validateRefinementFeedback(parsed.data);
      return reply.status(200).send(result);
    } catch (err) {
      return reply.status(500).send({ error: "Validation failed", details: err instanceof Error ? err.message : String(err) });
    }
  });

  // -- Validate plan (boundary check only, no execution) ---------------------

  app.post("/validate-plan", async (request, reply) => {
    const body = request.body as { plan?: unknown; boundaries?: unknown };
    if (!body?.plan || typeof body.plan !== "object") {
      return reply.status(400).send({ error: "Request must include plan object (ScriptedPlan)" });
    }

    const boundaries = Array.isArray(body.boundaries) ? body.boundaries : [];
    const result = await agent.validateScriptedPlan(body.plan as import("@synth-deploy/core").ScriptedPlan, boundaries);
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

  // -- Monitoring directives ---------------------------------------------------

  app.post("/monitor", async (request, reply) => {
    if (!healthScheduler) {
      return reply.status(501).send({ error: "Health monitoring not configured on this Envoy" });
    }
    const parsed = MonitoringDirectiveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid monitoring directive", details: parsed.error.format() });
    }
    healthScheduler.install(parsed.data);
    return reply.status(201).send({ installed: true, id: parsed.data.id });
  });

  app.delete<{ Params: { id: string } }>("/monitor/:id", async (request, reply) => {
    if (!healthScheduler) {
      return reply.status(501).send({ error: "Health monitoring not configured on this Envoy" });
    }
    healthScheduler.remove(request.params.id);
    return reply.status(200).send({ removed: true, id: request.params.id });
  });

  app.post<{ Params: { id: string } }>("/monitor/:id/pause", async (request, reply) => {
    if (!healthScheduler) {
      return reply.status(501).send({ error: "Health monitoring not configured on this Envoy" });
    }
    const ok = healthScheduler.pause(request.params.id);
    if (!ok) return reply.status(404).send({ error: `Directive ${request.params.id} not found or not pausable` });
    return reply.status(200).send({ paused: true, id: request.params.id });
  });

  app.post<{ Params: { id: string } }>("/monitor/:id/resume", async (request, reply) => {
    if (!healthScheduler) {
      return reply.status(501).send({ error: "Health monitoring not configured on this Envoy" });
    }
    const ok = healthScheduler.resume(request.params.id);
    if (!ok) return reply.status(404).send({ error: `Directive ${request.params.id} not found or not resumable` });
    return reply.status(200).send({ resumed: true, id: request.params.id });
  });

  app.get("/monitor", async (_request, reply) => {
    if (!healthScheduler) {
      return reply.status(200).send({ directives: [] });
    }
    return reply.status(200).send({ directives: healthScheduler.list() });
  });

  return app;
}
