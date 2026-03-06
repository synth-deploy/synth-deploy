import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Deployment, FleetDeployment, FleetProgress, IDeploymentStore, DebriefWriter } from "@synth-deploy/core";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";
import type { FleetDeploymentStore } from "../fleet/fleet-store.js";
import type { FleetExecutor, FleetProgressEvent } from "../fleet/fleet-executor.js";
import { selectRepresentatives } from "../fleet/representative-selector.js";
import { requirePermission } from "../middleware/permissions.js";

/**
 * REST API routes for fleet (large-scale) deployments.
 * Provides create, list, get, approve, execute, pause, and resume endpoints.
 */
export function registerFleetRoutes(
  app: FastifyInstance,
  fleetStore: FleetDeploymentStore,
  envoyRegistry: EnvoyRegistry,
  deploymentStore: IDeploymentStore,
  fleetExecutor: FleetExecutor,
  debrief: DebriefWriter,
): void {
  // -----------------------------------------------------------------------
  // POST /api/fleet-deployments — create a fleet deployment
  // -----------------------------------------------------------------------
  app.post(
    "/api/fleet-deployments",
    { preHandler: [requirePermission("deployment.create")] },
    async (request, reply) => {
      const body = request.body as {
        artifactId?: string;
        artifactVersionId?: string;
        environmentId?: string;
        envoyFilter?: string[];
        rolloutConfig?: {
          strategy?: "all-at-once" | "batched" | "canary";
          batchSize?: number;
          batchPercent?: number;
          pauseBetweenBatches?: boolean;
          haltOnFailureCount?: number;
          healthCheckWaitMs?: number;
        };
      };

      if (!body.artifactId || !body.environmentId) {
        return reply.status(400).send({ error: "artifactId and environmentId are required" });
      }

      // Identify target envoys for the environment
      const allEnvoys = await envoyRegistry.probeAll();
      const targetEnvoys = body.envoyFilter
        ? allEnvoys.filter((e) => body.envoyFilter!.includes(e.id))
        : allEnvoys.filter(
            (e) =>
              e.assignedEnvironments.length === 0 ||
              e.assignedEnvironments.includes(body.environmentId!),
          );

      if (targetEnvoys.length === 0) {
        return reply.status(422).send({ error: "No envoys found for the specified environment" });
      }

      // Select representative envoys for plan validation
      const representativeIds = selectRepresentatives(targetEnvoys, body.artifactId);

      const rolloutConfig = {
        strategy: body.rolloutConfig?.strategy ?? "batched",
        batchSize: body.rolloutConfig?.batchSize,
        batchPercent: body.rolloutConfig?.batchPercent ?? 10,
        pauseBetweenBatches: body.rolloutConfig?.pauseBetweenBatches ?? false,
        haltOnFailureCount: body.rolloutConfig?.haltOnFailureCount ?? 1,
        healthCheckWaitMs: body.rolloutConfig?.healthCheckWaitMs ?? 5000,
      };

      const now = new Date();
      const fleetDeployment: FleetDeployment = {
        id: crypto.randomUUID(),
        artifactId: body.artifactId,
        artifactVersionId: body.artifactVersionId ?? "",
        environmentId: body.environmentId,
        envoyFilter: body.envoyFilter,
        rolloutConfig,
        representativeEnvoyIds: representativeIds,
        status: "selecting_representatives",
        progress: {
          totalEnvoys: targetEnvoys.length,
          validated: 0,
          executing: 0,
          succeeded: 0,
          failed: 0,
          pending: targetEnvoys.length,
        },
        createdAt: now,
        updatedAt: now,
      };

      fleetStore.create(fleetDeployment);

      debrief.record({
        partitionId: null,
        deploymentId: fleetDeployment.id,
        agent: "command",
        decisionType: "system",
        decision: `Fleet deployment created for ${targetEnvoys.length} envoys with ${rolloutConfig.strategy} strategy`,
        reasoning: `Selected ${representativeIds.length} representative envoy(s) from ${targetEnvoys.length} total. Strategy: ${rolloutConfig.strategy}.`,
        context: {
          fleetId: fleetDeployment.id,
          totalEnvoys: targetEnvoys.length,
          representatives: representativeIds.length,
          strategy: rolloutConfig.strategy,
        },
      });

      return reply.status(201).send({ fleetDeployment });
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/fleet-deployments/:id/plan — create representative plan
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/fleet-deployments/:id/plan",
    { preHandler: [requirePermission("deployment.create")] },
    async (request, reply) => {
      const fleet = fleetStore.getById(request.params.id);
      if (!fleet) {
        return reply.status(404).send({ error: "Fleet deployment not found" });
      }

      if (fleet.status !== "selecting_representatives") {
        return reply.status(409).send({
          error: `Cannot create plan in "${fleet.status}" status — must be "selecting_representatives"`,
        });
      }

      const body = request.body as { envoyId?: string } | undefined;
      const targetEnvoyId = body?.envoyId ?? fleet.representativeEnvoyIds[0];

      if (!targetEnvoyId || !fleet.representativeEnvoyIds.includes(targetEnvoyId)) {
        return reply.status(422).send({
          error: "Invalid or missing representative envoy ID",
        });
      }

      const deployment: Deployment = {
        id: crypto.randomUUID(),
        artifactId: fleet.artifactId,
        artifactVersionId: fleet.artifactVersionId,
        envoyId: targetEnvoyId,
        environmentId: fleet.environmentId,
        version: "",
        status: "pending",
        variables: {},
        debriefEntryIds: [],
        createdAt: new Date(),
      };

      deploymentStore.save(deployment);

      fleet.representativePlanId = deployment.id;
      fleet.status = "planning";
      fleetStore.update(fleet);

      debrief.record({
        partitionId: null,
        deploymentId: fleet.id,
        agent: "command",
        decisionType: "system",
        decision: `Representative plan created for envoy ${targetEnvoyId}`,
        reasoning: `Created deployment ${deployment.id} as the representative plan for fleet ${fleet.id}. The plan can be reviewed and approved via the standard deployment surface.`,
        context: { fleetId: fleet.id, deploymentId: deployment.id, envoyId: targetEnvoyId },
      });

      return reply.status(201).send({ deployment });
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/fleet-deployments — list all fleet deployments
  // -----------------------------------------------------------------------
  app.get(
    "/api/fleet-deployments",
    { preHandler: [requirePermission("deployment.view")] },
    async () => {
      return { fleetDeployments: fleetStore.list() };
    },
  );

  // -----------------------------------------------------------------------
  // GET /api/fleet-deployments/:id — get fleet deployment with progress
  // -----------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/api/fleet-deployments/:id",
    { preHandler: [requirePermission("deployment.view")] },
    async (request, reply) => {
      const fleet = fleetStore.getById(request.params.id);
      if (!fleet) {
        return reply.status(404).send({ error: "Fleet deployment not found" });
      }
      return { fleetDeployment: fleet };
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/fleet-deployments/:id/approve — approve plan, trigger validation
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/fleet-deployments/:id/approve",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const fleet = fleetStore.getById(request.params.id);
      if (!fleet) {
        return reply.status(404).send({ error: "Fleet deployment not found" });
      }

      if (
        fleet.status !== "selecting_representatives" &&
        fleet.status !== "awaiting_approval"
      ) {
        return reply.status(409).send({
          error: `Cannot approve fleet deployment in "${fleet.status}" status`,
        });
      }

      // Look up the representative plan from the linked deployment
      const plan = fleet.representativePlanId
        ? deploymentStore.get(fleet.representativePlanId)?.plan
        : undefined;

      if (!plan) {
        return reply.status(422).send({
          error: "No approved plan found. Submit a plan for a representative deployment first.",
        });
      }

      // Transition to validating
      fleet.status = "validating";
      fleetStore.update(fleet);

      const actor = (request.user?.email) ?? "anonymous";

      debrief.record({
        partitionId: null,
        deploymentId: fleet.id,
        agent: "command",
        decisionType: "system",
        decision: `Fleet deployment approved by ${actor}, starting fleet validation`,
        reasoning: `Validating plan across ${fleet.progress.totalEnvoys} envoys before execution.`,
        context: { approvedBy: actor, fleetId: fleet.id },
        actor: request.user?.email,
      });

      // Run validation asynchronously
      fleetExecutor
        .validateFleet(fleet, plan)
        .then((validationResult) => {
          fleet.validationResult = validationResult;
          fleet.progress.validated = validationResult.validated;
          fleet.status = validationResult.failed > 0
            ? "validation_failed"
            : "validated";
          fleetStore.update(fleet);

          debrief.record({
            partitionId: null,
            deploymentId: fleet.id,
            agent: "command",
            decisionType: "system",
            decision: `Fleet validation complete: ${validationResult.validated}/${validationResult.total} envoys passed`,
            reasoning: validationResult.failed > 0
              ? `${validationResult.failed} envoy(s) failed validation. Review issues before proceeding.`
              : "All envoys passed validation. Ready for execution.",
            context: { validated: validationResult.validated, failed: validationResult.failed, total: validationResult.total },
          });
        })
        .catch((err) => {
          fleet.status = "failed";
          fleetStore.update(fleet);

          debrief.record({
            partitionId: null,
            deploymentId: fleet.id,
            agent: "command",
            decisionType: "deployment-failure",
            decision: "Fleet validation failed unexpectedly",
            reasoning: err instanceof Error ? err.message : String(err),
            context: { error: err instanceof Error ? err.message : String(err) },
          });
        });

      return { fleetDeployment: fleet, validating: true };
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/fleet-deployments/:id/execute — start rollout execution
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/fleet-deployments/:id/execute",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const fleet = fleetStore.getById(request.params.id);
      if (!fleet) {
        return reply.status(404).send({ error: "Fleet deployment not found" });
      }

      if (fleet.status !== "validated" && fleet.status !== "validation_failed" && fleet.status !== "paused") {
        return reply.status(409).send({
          error: `Cannot execute fleet deployment in "${fleet.status}" status — must be "validated", "validation_failed", or "paused"`,
        });
      }

      const plan = fleet.representativePlanId
        ? deploymentStore.get(fleet.representativePlanId)?.plan
        : undefined;

      if (!plan) {
        return reply.status(422).send({ error: "No plan found for execution" });
      }

      const rollbackPlan = fleet.representativePlanId
        ? deploymentStore.get(fleet.representativePlanId)?.rollbackPlan
        : undefined;

      fleet.status = "executing";
      fleetStore.update(fleet);

      const actor = (request.user?.email) ?? "anonymous";

      debrief.record({
        partitionId: null,
        deploymentId: fleet.id,
        agent: "command",
        decisionType: "system",
        decision: `Fleet rollout started by ${actor}`,
        reasoning: `Executing ${fleet.rolloutConfig.strategy} rollout across ${fleet.progress.totalEnvoys} envoys.`,
        context: { strategy: fleet.rolloutConfig.strategy, totalEnvoys: fleet.progress.totalEnvoys },
        actor: request.user?.email,
      });

      // Execute rollout asynchronously
      (async () => {
        const startTime = Date.now();
        try {
          for await (const event of fleetExecutor.executeRollout(fleet, plan, rollbackPlan)) {
            // Update fleet progress from each event
            fleet.progress = event.progress;

            if (event.type === "fleet-completed") {
              fleet.status = "completed";
            } else if (event.type === "fleet-failed") {
              fleet.status = "failed";
            } else if (event.type === "fleet-paused") {
              fleet.status = "paused";
            }

            fleetStore.update(fleet);

            // Record significant events in debrief
            if (event.type === "envoy-failed") {
              debrief.record({
                partitionId: null,
                deploymentId: fleet.id,
                agent: "command",
                decisionType: "deployment-failure",
                decision: `Envoy ${event.envoyName ?? event.envoyId} failed during fleet rollout`,
                reasoning: event.error ?? "Unknown error",
                context: { envoyId: event.envoyId, batchIndex: event.batchIndex, error: event.error },
              });
            } else if (event.type === "fleet-completed") {
              debrief.record({
                partitionId: null,
                deploymentId: fleet.id,
                agent: "command",
                decisionType: "deployment-completion",
                decision: `Fleet rollout completed: ${event.progress.succeeded}/${event.progress.totalEnvoys} succeeded`,
                reasoning: `Rollout finished with ${event.progress.failed} failure(s).`,
                context: { succeeded: event.progress.succeeded, failed: event.progress.failed, total: event.progress.totalEnvoys },
              });
            } else if (event.type === "fleet-failed") {
              debrief.record({
                partitionId: null,
                deploymentId: fleet.id,
                agent: "command",
                decisionType: "deployment-failure",
                decision: `Fleet rollout halted: failure threshold reached`,
                reasoning: event.error ?? "Failure count exceeded haltOnFailureCount",
                context: { succeeded: event.progress.succeeded, failed: event.progress.failed },
              });
            }
          }

          // Fleet-level summary debrief entry
          const durationMs = Date.now() - startTime;
          const durationSec = Math.round(durationMs / 1000);
          debrief.record({
            partitionId: null,
            deploymentId: fleet.id,
            agent: "command",
            decisionType: "deployment-completion",
            decision: `Fleet deployment ${fleet.status}: ${fleet.progress.succeeded}/${fleet.progress.totalEnvoys} envoys succeeded, ${fleet.progress.failed} failed`,
            reasoning: `Strategy: ${fleet.rolloutConfig.strategy}. Total duration: ${durationSec}s.`,
            context: {
              succeeded: fleet.progress.succeeded,
              failed: fleet.progress.failed,
              total: fleet.progress.totalEnvoys,
              strategy: fleet.rolloutConfig.strategy,
              durationMs,
              finalStatus: fleet.status,
            },
          });
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const durationSec = Math.round(durationMs / 1000);

          fleet.status = "failed";
          fleetStore.update(fleet);

          debrief.record({
            partitionId: null,
            deploymentId: fleet.id,
            agent: "command",
            decisionType: "deployment-failure",
            decision: `Fleet rollout failed with unexpected error after ${durationSec}s`,
            reasoning: err instanceof Error ? err.message : String(err),
            context: { error: err instanceof Error ? err.message : String(err), durationMs },
          });
        }
      })();

      return { fleetDeployment: fleet, executing: true };
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/fleet-deployments/:id/pause — pause rollout
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/fleet-deployments/:id/pause",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const fleet = fleetStore.getById(request.params.id);
      if (!fleet) {
        return reply.status(404).send({ error: "Fleet deployment not found" });
      }

      if (fleet.status !== "executing") {
        return reply.status(409).send({
          error: `Cannot pause fleet deployment in "${fleet.status}" status — must be "executing"`,
        });
      }

      fleet.status = "paused";
      fleetStore.update(fleet);

      const actor = (request.user?.email) ?? "anonymous";

      debrief.record({
        partitionId: null,
        deploymentId: fleet.id,
        agent: "command",
        decisionType: "system",
        decision: `Fleet rollout paused by ${actor}`,
        reasoning: `Paused at batch ${(fleet.progress.currentBatch ?? 0) + 1}/${fleet.progress.totalBatches ?? "?"}. ${fleet.progress.succeeded} succeeded, ${fleet.progress.failed} failed so far.`,
        context: { pausedBy: actor, progress: fleet.progress },
        actor: request.user?.email,
      });

      return { fleetDeployment: fleet, paused: true };
    },
  );

  // -----------------------------------------------------------------------
  // POST /api/fleet-deployments/:id/resume — resume paused rollout
  // -----------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/api/fleet-deployments/:id/resume",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const fleet = fleetStore.getById(request.params.id);
      if (!fleet) {
        return reply.status(404).send({ error: "Fleet deployment not found" });
      }

      if (fleet.status !== "paused") {
        return reply.status(409).send({
          error: `Cannot resume fleet deployment in "${fleet.status}" status — must be "paused"`,
        });
      }

      // Transition back to validated so the execute endpoint can be called again
      fleet.status = "validated";
      fleetStore.update(fleet);

      const actor = (request.user?.email) ?? "anonymous";

      debrief.record({
        partitionId: null,
        deploymentId: fleet.id,
        agent: "command",
        decisionType: "system",
        decision: `Fleet rollout resumed by ${actor}`,
        reasoning: "Fleet deployment transitioned back to validated for re-execution.",
        context: { resumedBy: actor },
        actor: request.user?.email,
      });

      return { fleetDeployment: fleet, resumed: true };
    },
  );
}
