import type { FastifyInstance } from "fastify";
import { generatePostmortem, generatePostmortemAsync, resolveApprovalMode } from "@synth-deploy/core";
import type { LlmClient, IPartitionStore, IEnvironmentStore, IArtifactStore, ISettingsStore, IDeploymentStore, ITelemetryStore, DebriefWriter, DebriefReader, DebriefPinStore, DeploymentEnrichment, RecommendationVerdict, TelemetryAction } from "@synth-deploy/core";
import { requirePermission } from "../middleware/permissions.js";
import {
  CreateOperationSchema,
  ApproveDeploymentSchema,
  RejectDeploymentSchema,
  ShelveDeploymentSchema,
  ModifyDeploymentPlanSchema,
  SubmitPlanSchema,
  DeploymentListQuerySchema,
  DebriefQuerySchema,
  ProgressEventSchema,
  ReplanDeploymentSchema,
} from "./schemas.js";
import type { ProgressEventStore } from "./progress-event-store.js";
import { EnvoyClient } from "../agent/envoy-client.js";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";

/**
 * REST API routes for deployments. These are the traditional (non-MCP) interface
 * for the web UI and integrations.
 */
function getArtifactId(op: { input: import("@synth-deploy/core").OperationInput }): string | undefined {
  return op.input.type === "deploy" ? op.input.artifactId : undefined;
}

export function registerOperationRoutes(
  app: FastifyInstance,
  deployments: IDeploymentStore,
  debrief: DebriefWriter & DebriefReader & DebriefPinStore,
  partitions: IPartitionStore,
  environments: IEnvironmentStore,
  artifactStore: IArtifactStore,
  settings: ISettingsStore,
  telemetry: ITelemetryStore,
  progressStore?: ProgressEventStore,
  envoyClient?: EnvoyClient,
  envoyRegistry?: EnvoyRegistry,
  llm?: LlmClient,
): void {

  // Create a deployment (plan phase)
  app.post("/api/operations", { preHandler: [requirePermission("deployment.create")] }, async (request, reply) => {
    const parsed = CreateOperationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const { artifactId, environmentId, partitionId, envoyId, version, type: operationType, intent, allowWrite, condition, responseIntent, parentOperationId, requireApproval } = parsed.data;

    // Validate artifact exists (required for deploy operations)
    if (operationType === "deploy" && !artifactId) {
      return reply.status(400).send({ error: "artifactId is required for deploy operations" });
    }
    const artifact = artifactId ? artifactStore.get(artifactId) : undefined;
    if (operationType === "deploy" && !artifact) {
      return reply.status(404).send({ error: `Artifact not found: ${artifactId}` });
    }

    // Validate environment exists (optional when targeting a partition or envoy)
    const environment = environmentId ? environments.get(environmentId) : undefined;
    if (environmentId && !environment) {
      return reply.status(404).send({ error: `Environment not found: ${environmentId}` });
    }

    // Validate partition if provided
    const partition = partitionId ? partitions.get(partitionId) : undefined;
    if (partitionId && !partition) {
      return reply.status(404).send({ error: `Partition not found: ${partitionId}` });
    }

    // Validate envoy if provided
    const targetEnvoy = envoyId ? envoyRegistry?.get(envoyId) : undefined;
    if (envoyId && !targetEnvoy) {
      return reply.status(404).send({ error: `Envoy not found: ${envoyId}` });
    }

    // Resolve variables — partition vars are base, environment vars take precedence if present
    const envVars = environment ? environment.variables : {};
    const partitionVars = partition?.variables ?? {};
    const resolved: Record<string, string> = { ...partitionVars, ...envVars };

    const operationInput = operationType === "deploy"
      ? { type: "deploy" as const, artifactId: artifactId!, ...(version ? { artifactVersionId: version } : {}) }
      : operationType === "trigger"
        ? { type: "trigger" as const, condition: condition ?? intent ?? "", responseIntent: responseIntent ?? intent ?? "" }
        : operationType === "composite"
          ? { type: "composite" as const, operations: (parsed.data.operations ?? []) as import("@synth-deploy/core").OperationInput[] }
          : operationType === "investigate"
            ? { type: "investigate" as const, intent: intent ?? "", ...(allowWrite !== undefined ? { allowWrite } : {}) }
            : { type: operationType as "maintain" | "query", intent: intent ?? "" };

    const deployment = {
      id: crypto.randomUUID(),
      input: operationInput,
      intent,
      lineage: parentOperationId,
      triggeredBy: parentOperationId ? ("user" as const) : undefined,
      environmentId,
      partitionId,
      envoyId: targetEnvoy?.id,
      version: version ?? "",
      status: "pending" as const,
      variables: resolved,
      debriefEntryIds: [] as string[],
      createdAt: new Date(),
      ...(requireApproval ? { forceManualApproval: true } : {}),
    };

    deployments.save(deployment);
    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "operation.created", target: { type: "deployment", id: deployment.id }, details: { artifactId, environmentId, partitionId, envoyId } });

    // Dispatch planning to the appropriate envoy asynchronously.
    // The envoy reasons about the deployment (read-only) and POSTs back a plan,
    // which transitions the deployment to awaiting_approval.
    if (envoyRegistry) {
      // Find the target envoy: explicit envoyId > environment-assigned > first available
      const planningEnvoy = targetEnvoy
        ?? (environment ? envoyRegistry.findForEnvironment(environment.name) : undefined)
        ?? envoyRegistry.list()[0];

      const needsArtifact = deployment.input.type === "deploy";
      if (planningEnvoy && (!needsArtifact || artifact)) {
        const planningClient = new EnvoyClient(planningEnvoy.url);
        const environmentForPlanning = environment
          ? { id: environment.id, name: environment.name, variables: environment.variables }
          : { id: `direct:${planningEnvoy.id}`, name: planningEnvoy.name, variables: {} };

        // Composite: orchestrate child planning separately — do not send composite to envoy directly
        if (deployment.input.type === "composite") {
          planCompositeChildren(deployment, envoyRegistry, planningEnvoy).catch((err) => {
            const dep = deployments.get(deployment.id);
            if (dep && (dep.status === "pending" || dep.status === "planning")) {
              dep.status = "failed" as typeof dep.status;
              dep.failureReason = `Composite planning failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
              deployments.save(dep);
            }
          });
          return;
        }

        // Look for a prior shelved plan for the same context — inject as soft context for the LLM
        const shelvedForContext = deployments.findShelvedByContext(
          deployment.input.type === "deploy" ? (deployment.input as { artifactId: string }).artifactId : undefined,
          deployment.environmentId,
          deployment.input.type,
        )[0];

        planningClient.requestPlan({
          operationId: deployment.id,
          operationType: deployment.input.type as "deploy" | "query" | "investigate" | "maintain" | "trigger",
          intent: deployment.intent ?? (deployment.input.type === "trigger"
            ? `Monitor: ${(deployment.input as { condition: string }).condition}. When triggered: ${(deployment.input as { responseIntent: string }).responseIntent}`
            : undefined),
          ...(deployment.input.type === "trigger" ? {
            triggerCondition: (deployment.input as { condition: string }).condition,
            triggerResponseIntent: (deployment.input as { responseIntent: string }).responseIntent,
          } : {}),
          ...(artifact ? {
            artifact: {
              id: artifact.id,
              name: artifact.name,
              type: artifact.type,
              analysis: {
                summary: artifact.analysis.summary,
                dependencies: artifact.analysis.dependencies,
                configurationExpectations: artifact.analysis.configurationExpectations,
                deploymentIntent: artifact.analysis.deploymentIntent,
                confidence: artifact.analysis.confidence,
              },
            },
          } : {}),
          ...(deployment.input.type === "investigate" && "allowWrite" in deployment.input
            ? { allowWrite: deployment.input.allowWrite }
            : {}),
          environment: environmentForPlanning,
          partition: partition
            ? { id: partition.id, name: partition.name, variables: partition.variables }
            : undefined,
          version: deployment.version ?? "",
          resolvedVariables: resolved,
          ...(shelvedForContext?.plan?.reasoning ? {
            shelvedPlanContext: {
              reasoning: shelvedForContext.plan.reasoning,
              shelvedAt: shelvedForContext.shelvedAt?.toISOString() ?? new Date().toISOString(),
              shelvedReason: shelvedForContext.shelvedReason,
            },
          } : {}),
          envoyContext: planningEnvoy.envoyContext ?? undefined,
        }).then((result) => {
          const dep = deployments.get(deployment.id);
          if (!dep || dep.status !== "pending") return;

          dep.plan = result.plan;
          dep.rollbackPlan = result.rollbackPlan;
          dep.envoyId = planningEnvoy.id;

          // Trigger operations: construct MonitoringDirective from plan, present for approval
          if (dep.input.type === "trigger" && !result.blocked) {
            const triggerInput = dep.input as { type: "trigger"; condition: string; responseIntent: string };
            // Use probes from the envoy's trigger planning response (embedded in scriptedPlan reasoning),
            // or fall back to a default probe. The envoy's planTrigger generates these.
            const directive: import("@synth-deploy/core").MonitoringDirective = {
              id: dep.id,
              operationId: dep.id,
              probes: [{
                command: "echo 0",
                label: "default-probe",
                parseAs: "numeric" as const,
              }],
              intervalMs: result.intervalMs ?? 60_000,
              cooldownMs: result.cooldownMs ?? 300_000,
              condition: triggerInput.condition,
              responseIntent: triggerInput.responseIntent,
              responseType: "maintain",
              environmentId: dep.environmentId,
              partitionId: dep.partitionId,
              status: "active",
            };
            dep.monitoringDirective = directive;
            dep.triggerStatus = "active";
            dep.status = "awaiting_approval" as typeof dep.status;
            dep.recommendation = computeRecommendation(dep, deployments, result.assessmentSummary);
            deployments.save(dep);
            // Debrief plan-generation entry is recorded by the envoy's planTrigger — no duplicate here.
            return;
          }

          // Check approval mode for query/investigate operations with findings
          if ((dep.input.type === "query" || dep.input.type === "investigate") &&
              (result.queryFindings || result.investigationFindings)) {
            if (result.queryFindings) dep.queryFindings = result.queryFindings;
            if (result.investigationFindings) dep.investigationFindings = result.investigationFindings;

            const currentSettings = settings.get();
            const envLookup = (id: string) => environments.get(id)?.name;
            const approvalMode = dep.forceManualApproval
              ? "required"
              : resolveApprovalMode(dep.input.type, dep.environmentId, currentSettings, envLookup);

            if (approvalMode === "auto") {
              // Auto-approve — findings are the deliverable
              dep.status = "succeeded" as typeof dep.status;
              dep.completedAt = new Date();
              deployments.save(dep);

              const decisionType = dep.input.type === "query"
                ? "query-findings" as const
                : "investigation-findings" as const;
              const findings = result.queryFindings ?? result.investigationFindings!;
              debrief.record({
                partitionId: dep.partitionId ?? null,
                operationId: dep.id,
                agent: "envoy",
                decisionType,
                decision: `${dep.input.type === "query" ? "Query" : "Investigation"} complete — ${findings.targetsSurveyed.length} target(s) surveyed`,
                reasoning: findings.summary,
                context: { targetsSurveyed: findings.targetsSurveyed, findingCount: findings.findings.length },
              });
              return;
            }
            // approvalMode === "required" — fall through to standard approval gate
          }

          if (result.blocked) {
            // Unrecoverable precondition failures — block execution, do not present for approval
            dep.status = "failed" as typeof dep.status;
            dep.failureReason = result.blockReason ?? "Plan blocked due to unrecoverable precondition failures";
            deployments.save(dep);

            debrief.record({
              partitionId: dep.partitionId ?? null,
              operationId: dep.id,
              agent: "envoy",
              decisionType: "plan-generation",
              decision: `Operation plan blocked — infrastructure prerequisites not met`,
              reasoning: result.blockReason ?? result.plan.reasoning,
              context: { stepCount: result.plan.scriptedPlan.stepSummary.length, envoyId: planningEnvoy.id, blocked: true },
            });
          } else {
            // Plan is valid — transition to awaiting_approval
            dep.status = "awaiting_approval" as typeof dep.status;
            dep.recommendation = computeRecommendation(dep, deployments, result.assessmentSummary);
            deployments.save(dep);

            debrief.record({
              partitionId: dep.partitionId ?? null,
              operationId: dep.id,
              agent: "envoy",
              decisionType: "plan-generation",
              decision: `Operation plan generated with ${result.plan.scriptedPlan.stepSummary.length} steps`,
              reasoning: result.plan.reasoning,
              context: { stepCount: result.plan.scriptedPlan.stepSummary.length, envoyId: planningEnvoy.id, delta: result.delta },
            });
          }
        }).catch((err) => {
          // Planning failed — mark deployment failed so UI doesn't wait forever
          const dep = deployments.get(deployment.id);
          if (!dep || dep.status !== "pending") return;

          dep.status = "failed" as typeof dep.status;
          dep.failureReason = err instanceof Error ? err.message : "Planning failed";
          deployments.save(dep);

          debrief.record({
            partitionId: dep.partitionId ?? null,
            operationId: dep.id,
            agent: "server",
            decisionType: "deployment-failure",
            decision: "Envoy planning failed",
            reasoning: dep.failureReason!,
            context: { error: dep.failureReason, envoyId: planningEnvoy.id },
          });
        });
      }
    }

    return reply.status(201).send({ deployment });
  });

  // Get deployment by ID
  app.get<{ Params: { id: string } }>("/api/operations/:id", { preHandler: [requirePermission("deployment.view")] }, async (request, reply) => {
    const deployment = deployments.get(request.params.id);
    if (!deployment) {
      return reply.status(404).send({ error: "Operation not found" });
    }

    return {
      deployment,
      debrief: debrief.getByOperation(deployment.id),
    };
  });

  // What's New — compare deployed artifact version against catalog latest
  app.get<{ Params: { id: string } }>("/api/operations/:id/whats-new", { preHandler: [requirePermission("deployment.view")] }, async (request, reply) => {
    const deployment = deployments.get(request.params.id);
    if (!deployment) {
      return reply.status(404).send({ error: "Operation not found" });
    }

    const versions = artifactStore.getVersions(getArtifactId(deployment) ?? "");
    const sorted = versions.slice().sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const latest = sorted[0] ?? null;
    const deployedVersion = deployment.version;
    const latestVersion = latest?.version ?? null;
    const isLatest = latestVersion === null || latestVersion === deployedVersion;

    return {
      deployedVersion,
      latestVersion,
      isLatest,
      latestCreatedAt: latest?.createdAt ? new Date(latest.createdAt).toISOString() : null,
    };
  });

  // List deployments (optionally filtered by partition, artifact, or envoy)
  app.get("/api/operations", { preHandler: [requirePermission("deployment.view")] }, async (request) => {
    const qParsed = DeploymentListQuerySchema.safeParse(request.query);
    const { partitionId, artifactId, envoyId } = qParsed.success ? qParsed.data : {};

    let list;
    if (partitionId) {
      list = deployments.getByPartition(partitionId);
    } else if (artifactId) {
      list = deployments.getByArtifact(artifactId);
    } else {
      list = deployments.list();
    }

    if (envoyId) {
      list = list.filter((d) => d.envoyId === envoyId);
    }

    return { deployments: list };
  });

  // Submit a plan from envoy — transitions deployment to awaiting_approval
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/plan",
    { preHandler: [requirePermission("deployment.create")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const parsed = SubmitPlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid plan submission", details: parsed.error.format() });
      }

      if ((deployment.status) !== "pending" && (deployment.status) !== "planning") {
        return reply.status(409).send({ error: `Cannot submit plan for operation in "${deployment.status}" status` });
      }

      deployment.plan = parsed.data.plan;
      deployment.rollbackPlan = parsed.data.rollbackPlan;
      deployment.status = "awaiting_approval" as typeof deployment.status;

      // Generate recommendation from enrichment context
      deployment.recommendation = computeRecommendation(deployment, deployments);

      deployments.save(deployment);

      debrief.record({
        partitionId: deployment.partitionId ?? null,
        operationId: deployment.id,
        agent: "envoy",
        decisionType: "plan-generation",
        decision: `Operation plan submitted with ${parsed.data.plan.scriptedPlan.stepSummary.length} steps`,
        reasoning: parsed.data.plan.reasoning,
        context: { stepCount: parsed.data.plan.scriptedPlan.stepSummary.length },
      });

      return reply.status(200).send({ deployment });
    },
  );

  // Approve a deployment plan
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/approve",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const parsed = ApproveDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      if ((deployment.status) !== "awaiting_approval") {
        return reply.status(409).send({ error: `Cannot approve operation in "${deployment.status}" status — must be "awaiting_approval"` });
      }

      // Transition deployment status
      deployment.approvedBy = parsed.data.approvedBy;
      deployment.approvedAt = new Date();
      deployment.status = "approved" as typeof deployment.status;
      deployments.save(deployment);

      const actor = (request.user?.email) ?? parsed.data.approvedBy;

      // Record approval in debrief
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        operationId: deployment.id,
        agent: "server",
        decisionType: "system",
        decision: `Operation approved by ${actor}`,
        reasoning: parsed.data.modifications
          ? `Approved with modifications: ${parsed.data.modifications}`
          : "Approved without modifications",
        context: { approvedBy: actor },
        actor: request.user?.email,
      });
      telemetry.record({ actor, action: "operation.approved", target: { type: "deployment", id: deployment.id }, details: { modifications: parsed.data.modifications } });
      telemetry.record({
        actor,
        action: parsed.data.modifications ? "agent.recommendation.overridden" : "agent.recommendation.followed",
        target: { type: "deployment", id: deployment.id },
        details: parsed.data.modifications
          ? { modifications: parsed.data.modifications }
          : { planStepCount: deployment.plan?.scriptedPlan.stepSummary.length ?? 0 },
      });

      // Composite operations: execute children sequentially
      if (deployment.input.type === "composite") {
        deployment.status = "running" as typeof deployment.status;
        deployments.save(deployment);

        const compositeChildren = deployments.list()
          .filter((d) => d.lineage === deployment.id)
          .sort((a, b) => ((a as { sequenceIndex?: number }).sequenceIndex ?? 0) - ((b as { sequenceIndex?: number }).sequenceIndex ?? 0));

        // Approve all children before executing sequentially
        for (const child of compositeChildren) {
          child.approvedBy = parsed.data.approvedBy;
          child.approvedAt = new Date();
          child.status = "approved" as typeof child.status;
          deployments.save(child);
        }

        executeCompositeSequentially(deployment.id, compositeChildren.map((c) => c.id)).catch((err) => {
          const dep = deployments.get(deployment.id);
          if (dep && dep.status === "running") {
            dep.status = "failed" as typeof dep.status;
            dep.failureReason = `Composite execution failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`;
            dep.completedAt = new Date();
            deployments.save(dep);
          }
        });

        return { deployment, approved: true };
      }

      // Trigger operations: install monitoring directive on envoy
      if (deployment.input.type === "trigger" && deployment.monitoringDirective && envoyRegistry) {
        const targetEnvoyForTrigger = deployment.envoyId
          ? envoyRegistry.get(deployment.envoyId)
          : envoyRegistry.list()[0];

        if (targetEnvoyForTrigger) {
          const triggerClient = new EnvoyClient(targetEnvoyForTrigger.url);
          deployment.status = "running" as typeof deployment.status;
          deployment.triggerStatus = "active";
          deployments.save(deployment);

          triggerClient.installMonitoringDirective(deployment.monitoringDirective).then(() => {
            deployment.status = "succeeded" as typeof deployment.status;
            deployment.completedAt = new Date();
            deployments.save(deployment);

            debrief.record({
              partitionId: deployment.partitionId ?? null,
              operationId: deployment.id,
              agent: "server",
              decisionType: "trigger-activated",
              decision: `Monitoring directive installed on ${targetEnvoyForTrigger.name}`,
              reasoning: `Trigger activated: monitoring "${deployment.monitoringDirective!.condition}" every ${deployment.monitoringDirective!.intervalMs / 1000}s with ${deployment.monitoringDirective!.cooldownMs / 1000}s cooldown`,
              context: { envoyId: targetEnvoyForTrigger.id, directiveId: deployment.monitoringDirective!.id },
            });
            telemetry.record({ actor, action: "trigger.activated" as TelemetryAction, target: { type: "trigger", id: deployment.id }, details: { envoyId: targetEnvoyForTrigger.id } });
          }).catch((err) => {
            deployment.status = "failed" as typeof deployment.status;
            deployment.triggerStatus = "disabled";
            deployment.failureReason = err instanceof Error ? err.message : "Failed to install monitoring directive";
            deployments.save(deployment);

            debrief.record({
              partitionId: deployment.partitionId ?? null,
              operationId: deployment.id,
              agent: "server",
              decisionType: "deployment-failure",
              decision: "Failed to install monitoring directive on envoy",
              reasoning: deployment.failureReason!,
              context: { error: deployment.failureReason },
            });
          });
        }
      }
      // Normal operations: dispatch approved plan to envoy for execution
      else if (deployment.plan && deployment.rollbackPlan) {
        // Resolve the envoy that planned this deployment; fall back to default
        const registryEnvoy = deployment.envoyId ? envoyRegistry?.get(deployment.envoyId) : undefined;
        const execClient = registryEnvoy ? new EnvoyClient(registryEnvoy.url) : envoyClient;

        if (!execClient) {
          deployment.status = "failed" as typeof deployment.status;
          deployment.failureReason = "No envoy client available for dispatch";
          deployments.save(deployment);
          debrief.record({
            partitionId: deployment.partitionId ?? null,
            operationId: deployment.id,
            agent: "server",
            decisionType: "deployment-failure",
            decision: "Failed to dispatch approved plan to envoy",
            reasoning: deployment.failureReason,
            context: { error: deployment.failureReason },
          });
          return reply.send({ deployment, approved: true });
        }

        const artifact = artifactStore.get(getArtifactId(deployment) ?? "");
        const serverPort = process.env.PORT ?? "9410";
        const serverUrl = process.env.SYNTH_SERVER_URL ?? `http://localhost:${serverPort}`;
        const progressCallbackUrl = `${serverUrl}/api/operations/${deployment.id}/progress`;
        const callbackToken = registryEnvoy?.token;

        deployment.status = "running" as typeof deployment.status;
        deployments.save(deployment);

        // Fire-and-forget: execution runs async, progress comes via callback
        execClient.executeApprovedPlan({
          operationId: deployment.id,
          plan: deployment.plan,
          rollbackPlan: deployment.rollbackPlan,
          artifactType: artifact?.type ?? "unknown",
          artifactName: artifact?.name ?? "unknown",
          environmentId: deployment.environmentId ?? "",
          progressCallbackUrl,
          callbackToken,
        }).catch((err) => {
          // Execution dispatch failed — record failure
          deployment.status = "failed" as typeof deployment.status;
          deployment.failureReason = err instanceof Error ? err.message : "Execution dispatch failed";
          deployments.save(deployment);

          debrief.record({
            partitionId: deployment.partitionId ?? null,
            operationId: deployment.id,
            agent: "server",
            decisionType: "deployment-failure",
            decision: "Failed to dispatch approved plan to envoy",
            reasoning: deployment.failureReason!,
            context: { error: deployment.failureReason },
          });
        });
      }

      return { deployment, approved: true };
    },
  );

  // Reject a deployment plan
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/reject",
    { preHandler: [requirePermission("deployment.reject")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const parsed = RejectDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      if ((deployment.status) !== "awaiting_approval") {
        return reply.status(409).send({ error: `Cannot reject operation in "${deployment.status}" status — must be "awaiting_approval"` });
      }

      // Transition deployment status and store rejection reason
      deployment.status = "rejected" as typeof deployment.status;
      deployment.rejectionReason = parsed.data.reason;
      deployments.save(deployment);

      const actor = (request.user?.email) ?? "anonymous";

      // Record rejection in debrief
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        operationId: deployment.id,
        agent: "server",
        decisionType: "system",
        decision: "Operation plan rejected",
        reasoning: parsed.data.reason,
        context: { reason: parsed.data.reason },
        actor: request.user?.email,
      });
      telemetry.record({ actor, action: "operation.rejected", target: { type: "deployment", id: deployment.id }, details: { reason: parsed.data.reason } });

      return { deployment, rejected: true };
    },
  );

  // Shelve a deployment plan — preserve plan/reasoning for later, mark as "not now"
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/shelve",
    { preHandler: [requirePermission("deployment.reject")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const parsed = ShelveDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      if (deployment.status !== "awaiting_approval") {
        return reply.status(409).send({ error: `Cannot shelve operation in "${deployment.status}" status — must be "awaiting_approval"` });
      }

      deployment.status = "shelved" as typeof deployment.status;
      deployment.shelvedAt = new Date();
      if (parsed.data.reason) deployment.shelvedReason = parsed.data.reason;
      deployments.save(deployment);

      const actor = (request.user?.email) ?? "anonymous";

      debrief.record({
        partitionId: deployment.partitionId ?? null,
        operationId: deployment.id,
        agent: "server",
        decisionType: "system",
        decision: "Operation plan shelved",
        reasoning: parsed.data.reason ?? "Shelved without a reason — plan preserved for future use",
        context: { reason: parsed.data.reason ?? null },
        actor: request.user?.email,
      });
      telemetry.record({ actor, action: "operation.shelved", target: { type: "deployment", id: deployment.id }, details: { reason: parsed.data.reason } });

      return { deployment, shelved: true };
    },
  );

  // Activate a shelved operation — triggers replanning with the prior plan as context
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/activate",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deploymentId = request.params.id;
      const deployment = deployments.get(deploymentId);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      if (deployment.status !== "shelved") {
        return reply.status(409).send({ error: `Cannot activate operation in "${deployment.status}" status — must be "shelved"` });
      }

      const parsed = ReplanDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const artifact = artifactStore.get(getArtifactId(deployment) ?? "");
      const environment = deployment.environmentId ? environments.get(deployment.environmentId) : undefined;
      const partition = deployment.partitionId ? partitions.get(deployment.partitionId) : undefined;

      const planningEnvoy = deployment.envoyId ? envoyRegistry?.get(deployment.envoyId) : envoyRegistry?.list()[0];
      if (!planningEnvoy) {
        return reply.status(422).send({ error: "No envoy available for replanning" });
      }

      const priorReasoning = deployment.plan?.reasoning;

      deployment.status = "planning" as typeof deployment.status;
      deployments.save(deployment);

      const planningClient = new EnvoyClient(planningEnvoy.url);
      const environmentForPlanning = environment
        ? { id: environment.id, name: environment.name, variables: environment.variables }
        : { id: `direct:${planningEnvoy.id}`, name: planningEnvoy.name, variables: {} };

      let result: Awaited<ReturnType<typeof planningClient.requestPlan>>;
      try {
        result = await planningClient.requestPlan({
          operationId: deploymentId,
          operationType: deployment.input.type as "deploy" | "query" | "investigate" | "maintain" | "trigger",
          intent: deployment.intent,
          ...(artifact ? {
            artifact: {
              id: artifact.id,
              name: artifact.name,
              type: artifact.type,
              analysis: {
                summary: artifact.analysis.summary,
                dependencies: artifact.analysis.dependencies,
                configurationExpectations: artifact.analysis.configurationExpectations,
                deploymentIntent: artifact.analysis.deploymentIntent,
                confidence: artifact.analysis.confidence,
              },
            },
          } : {}),
          environment: environmentForPlanning,
          partition: partition ? { id: partition.id, name: partition.name, variables: partition.variables } : undefined,
          version: deployment.version ?? "",
          resolvedVariables: deployment.variables,
          refinementFeedback: parsed.data.feedback,
          ...(priorReasoning ? {
            shelvedPlanContext: {
              reasoning: priorReasoning,
              shelvedAt: deployment.shelvedAt?.toISOString() ?? new Date().toISOString(),
              shelvedReason: deployment.shelvedReason,
            },
          } : {}),
          envoyContext: planningEnvoy.envoyContext ?? undefined,
        });
      } catch (err) {
        const dep = deployments.get(deploymentId);
        if (dep) {
          dep.status = "shelved" as typeof dep.status;
          deployments.save(dep);
        }
        return reply.status(500).send({ error: err instanceof Error ? err.message : "Replanning failed" });
      }

      const dep = deployments.get(deploymentId);
      if (!dep) {
        return reply.status(404).send({ error: "Operation not found after replanning" });
      }

      dep.plan = result.plan;
      dep.rollbackPlan = result.rollbackPlan;
      dep.recommendation = computeRecommendation(dep, deployments, result.assessmentSummary);
      dep.status = "awaiting_approval" as typeof dep.status;
      deployments.save(dep);

      const actor = (request.user?.email) ?? "anonymous";

      debrief.record({
        partitionId: dep.partitionId ?? null,
        operationId: dep.id,
        agent: "server",
        decisionType: "system",
        decision: "Shelved operation re-activated",
        reasoning: parsed.data.feedback
          ? `Re-activated from shelf with refinement feedback: ${parsed.data.feedback}`
          : "Re-activated from shelf — plan regenerated against current infrastructure state",
        context: { feedback: parsed.data.feedback ?? null },
        actor: request.user?.email,
      });
      debrief.record({
        partitionId: dep.partitionId ?? null,
        operationId: dep.id,
        agent: "envoy",
        decisionType: "plan-generation",
        decision: `Plan regenerated from shelf (${result.plan.scriptedPlan.stepSummary.length} steps)`,
        reasoning: result.plan.reasoning,
        context: { stepCount: result.plan.scriptedPlan.stepSummary.length, envoyId: planningEnvoy.id, activatedFromShelf: true },
      });
      telemetry.record({ actor, action: "operation.activated", target: { type: "deployment", id: dep.id }, details: { feedback: parsed.data.feedback } });

      return { deployment: dep, activated: true };
    },
  );

  // Modify a deployment plan (user edits steps before approval)
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/modify",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const parsed = ModifyDeploymentPlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      if ((deployment.status) !== "awaiting_approval") {
        return reply.status(409).send({ error: `Cannot modify operation in "${deployment.status}" status — must be "awaiting_approval"` });
      }

      if (!deployment.plan) {
        return reply.status(409).send({ error: "Operation has no plan to modify" });
      }

      // Validate modified plan with envoy if available
      if (envoyClient && deployment.plan.scriptedPlan) {
        try {
          const modifiedScript: import("@synth-deploy/core").ScriptedPlan = {
            ...deployment.plan.scriptedPlan,
            executionScript: parsed.data.executionScript,
            ...(parsed.data.rollbackScript !== undefined ? { rollbackScript: parsed.data.rollbackScript } : {}),
          };
          const validation = await envoyClient.validatePlan(modifiedScript);
          if (!validation.valid) {
            return reply.status(422).send({
              error: "Modified plan failed envoy validation",
              violations: validation.violations,
            });
          }
        } catch {
          // Envoy unreachable — proceed without validation but note it
        }
      }

      // Compute diff description
      const oldScript = deployment.plan.scriptedPlan?.executionScript ?? "";
      const newScript = parsed.data.executionScript;
      const diffFromPreviousPlan = oldScript !== newScript
        ? "Execution script modified by user"
        : "Plan metadata changed (script unchanged)";

      // Apply modifications
      deployment.plan = {
        ...deployment.plan,
        scriptedPlan: {
          ...deployment.plan.scriptedPlan,
          executionScript: parsed.data.executionScript,
          ...(parsed.data.rollbackScript !== undefined ? { rollbackScript: parsed.data.rollbackScript } : {}),
        },
        diffFromPreviousPlan,
      };
      deployments.save(deployment);

      const actor = (request.user?.email) ?? "anonymous";

      // Record modification in debrief
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        operationId: deployment.id,
        agent: "server",
        decisionType: "plan-modification",
        decision: `Operation plan modified by ${actor}`,
        reasoning: parsed.data.reason,
        context: {
          modifiedBy: actor,
          reason: parsed.data.reason,
        },
        actor: request.user?.email,
      });
      telemetry.record({
        actor,
        action: "operation.modified" as Parameters<typeof telemetry.record>[0]["action"],
        target: { type: "deployment", id: deployment.id },
        details: { reason: parsed.data.reason },
      });
      telemetry.record({
        actor,
        action: "agent.recommendation.overridden",
        target: { type: "deployment", id: deployment.id },
        details: { reason: parsed.data.reason, diff: diffFromPreviousPlan },
      });

      return { deployment, modified: true };
    },
  );

  // Replan a deployment with user feedback — triggers a new LLM planning pass
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/replan",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deploymentId = request.params.id;
      const deployment = deployments.get(deploymentId);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      if (deployment.status !== "awaiting_approval" && deployment.status !== "shelved") {
        return reply.status(409).send({ error: `Cannot replan operation in "${deployment.status}" status — must be "awaiting_approval" or "shelved"` });
      }

      const parsed = ReplanDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const artifact = artifactStore.get(getArtifactId(deployment) ?? "");
      if (!artifact) {
        return reply.status(404).send({ error: `Artifact not found: ${getArtifactId(deployment)}` });
      }

      const environment = deployment.environmentId ? environments.get(deployment.environmentId) : undefined;
      const partition = deployment.partitionId ? partitions.get(deployment.partitionId) : undefined;

      const planningEnvoy = deployment.envoyId ? envoyRegistry?.get(deployment.envoyId) : envoyRegistry?.list()[0];
      if (!planningEnvoy) {
        return reply.status(422).send({ error: "No envoy available for replanning" });
      }

      // Validate feedback with LLM before triggering expensive replan
      const planningClientForValidation = new EnvoyClient(planningEnvoy.url);
      try {
        const validation = await planningClientForValidation.validateRefinementFeedback({
          feedback: parsed.data.feedback,
          currentPlanSummary: (deployment.plan?.scriptedPlan?.stepSummary ?? []).map((s) => ({
            description: s.description,
            reversible: s.reversible,
          })),
          artifactName: artifact?.name ?? "unknown",
          environmentName: environment?.name ?? "unknown",
        });
        if (validation.mode === "rejection") {
          return reply.status(422).send({ error: validation.message, mode: "rejection" });
        }
        if (validation.mode === "response") {
          return reply.status(200).send({ mode: "response", message: validation.message });
        }
        // mode === "replan" — fall through to full replan
      } catch {
        // Validation call failed — proceed with replan rather than blocking the user
      }

      const priorStatus = deployment.status;
      const priorReasoning = deployment.plan?.reasoning;

      deployment.status = "planning" as typeof deployment.status;
      deployments.save(deployment);

      const planningClient = new EnvoyClient(planningEnvoy.url);
      const environmentForPlanning = environment
        ? { id: environment.id, name: environment.name, variables: environment.variables }
        : { id: `direct:${planningEnvoy.id}`, name: planningEnvoy.name, variables: {} };

      let result: Awaited<ReturnType<typeof planningClient.requestPlan>>;
      try {
        result = await planningClient.requestPlan({
          operationId: deploymentId,
          artifact: {
            id: artifact.id,
            name: artifact.name,
            type: artifact.type,
            analysis: {
              summary: artifact.analysis.summary,
              dependencies: artifact.analysis.dependencies,
              configurationExpectations: artifact.analysis.configurationExpectations,
              deploymentIntent: artifact.analysis.deploymentIntent,
              confidence: artifact.analysis.confidence,
            },
          },
          environment: environmentForPlanning,
          partition: partition
            ? { id: partition.id, name: partition.name, variables: partition.variables }
            : undefined,
          version: deployment.version ?? "",
          resolvedVariables: deployment.variables,
          refinementFeedback: parsed.data.feedback,
          ...(priorStatus === "shelved" && priorReasoning ? {
            shelvedPlanContext: {
              reasoning: priorReasoning,
              shelvedAt: deployment.shelvedAt?.toISOString() ?? new Date().toISOString(),
              shelvedReason: deployment.shelvedReason,
            },
          } : {}),
          envoyContext: planningEnvoy.envoyContext ?? undefined,
        });
      } catch (err) {
        const dep = deployments.get(deploymentId);
        if (dep) {
          dep.status = priorStatus as typeof dep.status;
          deployments.save(dep);
        }
        return reply.status(500).send({ error: err instanceof Error ? err.message : "Replanning failed" });
      }

      const dep = deployments.get(deploymentId);
      if (!dep) {
        return reply.status(404).send({ error: "Operation not found after replanning" });
      }

      dep.plan = result.plan;
      dep.rollbackPlan = result.rollbackPlan;
      dep.recommendation = computeRecommendation(dep, deployments, result.assessmentSummary);
      dep.status = "awaiting_approval" as typeof dep.status;
      deployments.save(dep);

      debrief.record({
        partitionId: dep.partitionId ?? null,
        operationId: dep.id,
        agent: "envoy",
        decisionType: "plan-generation",
        decision: `Plan regenerated with user feedback (${result.plan.scriptedPlan.stepSummary.length} steps)`,
        reasoning: result.plan.reasoning,
        context: { stepCount: result.plan.scriptedPlan.stepSummary.length, envoyId: planningEnvoy.id, refinementFeedback: parsed.data.feedback },
      });

      return { deployment: dep, replanned: true };
    },
  );

  // Get cross-system enrichment context for a deployment
  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/context",
    { preHandler: [requirePermission("deployment.view")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const now = new Date();
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Count recent operations to the same environment (only meaningful when environmentId is set)
      const recentOperationsToEnv = deployment.environmentId
        ? deployments.countByEnvironment(deployment.environmentId, twentyFourHoursAgo)
        : 0;

      // Check if the same artifact version was previously rolled back
      const previouslyRolledBack = deployment.version
        ? deployments.findByArtifactVersion(
            getArtifactId(deployment) ?? "",
            deployment.version,
            "rolled_back",
          ).length > 0
        : false;

      // Check for other in-progress operations to the same environment
      const conflictingOperations = deployment.environmentId
        ? deployments.list()
            .filter(
              (d) =>
                d.environmentId === deployment.environmentId &&
                d.id !== deployment.id &&
                ((d.status) === "running" || (d.status) === "approved" || (d.status) === "awaiting_approval"),
            )
            .map((d) => d.id)
        : [];

      // Find last operation to the same environment
      const lastDeploy = deployment.environmentId
        ? deployments.findLatestByEnvironment(deployment.environmentId)
        : undefined;
      const lastOperationToEnv = lastDeploy && lastDeploy.id !== deployment.id
        ? {
            id: lastDeploy.id,
            status: lastDeploy.status,
            version: lastDeploy.version ?? "",
            completedAt: lastDeploy.completedAt,
          }
        : undefined;

      const enrichment: DeploymentEnrichment = {
        recentOperationsToEnv,
        previouslyRolledBack,
        conflictingOperations,
        lastOperationToEnv,
      };

      return {
        enrichment,
        recommendation: deployment.recommendation ?? computeRecommendation(deployment, deployments),
      };
    },
  );

  // Request a post-hoc rollback plan — asks the envoy to reason about
  // what actually ran and produce a targeted rollback plan
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/request-rollback-plan",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const finishedStatuses = new Set(["succeeded", "failed", "rolled_back"]);
      if (!finishedStatuses.has(deployment.status)) {
        return reply.status(409).send({
          error: `Cannot request rollback plan for operation in "${deployment.status}" status — operation must be finished`,
        });
      }

      const artifact = artifactStore.get(getArtifactId(deployment) ?? "");
      if (!artifact) {
        return reply.status(404).send({ error: "Artifact not found" });
      }

      // Determine which envoy to ask
      const targetEnvoy = deployment.envoyId
        ? envoyRegistry?.get(deployment.envoyId)
        : envoyRegistry?.list()[0];

      if (!targetEnvoy) {
        return reply.status(503).send({ error: "No envoy available to generate rollback plan" });
      }

      const environment = deployment.environmentId ? environments.get(deployment.environmentId) : undefined;

      // Build the list of completed steps from execution record (or plan step summaries as fallback)
      const completedSteps: Array<{
        description: string;
        action: string;
        target: string;
        status: "completed" | "failed" | "rolled_back";
        output?: string;
      }> = deployment.executionRecord?.steps.map((s) => ({
        description: s.description,
        action: "script-step",
        target: "",
        status: s.status,
        output: s.output ?? s.error,
      })) ?? deployment.plan?.scriptedPlan?.stepSummary.map((s) => ({
        description: s.description,
        action: "script-step",
        target: "",
        status: "completed" as const,
      })) ?? [];

      const rollbackClient = new EnvoyClient(targetEnvoy.url);

      try {
        const rollbackPlan = await rollbackClient.requestRollbackPlan({
          operationId: deployment.id,
          artifact: {
            name: artifact.name,
            type: artifact.type,
            analysis: {
              summary: artifact.analysis.summary,
              dependencies: artifact.analysis.dependencies,
              configurationExpectations: artifact.analysis.configurationExpectations,
              deploymentIntent: artifact.analysis.deploymentIntent,
              confidence: artifact.analysis.confidence,
            },
          },
          environment: {
            id: deployment.environmentId ?? "",
            name: environment?.name ?? deployment.environmentId ?? "unknown",
          },
          completedSteps,
          deployedVariables: deployment.variables,
          version: deployment.version ?? "",
          failureReason: deployment.failureReason ?? undefined,
        });

        // Store the generated rollback plan on the deployment
        deployment.rollbackPlan = rollbackPlan;
        deployments.save(deployment);

        const actor = (request.user?.email) ?? "anonymous";

        debrief.record({
          partitionId: deployment.partitionId ?? null,
          operationId: deployment.id,
          agent: "server",
          decisionType: "plan-generation",
          decision: `Rollback plan requested and generated for ${artifact.name} v${deployment.version}`,
          reasoning: rollbackPlan.reasoning,
          context: {
            requestedBy: actor,
            stepCount: rollbackPlan.scriptedPlan.stepSummary.length,
            envoyId: targetEnvoy.id,
            deploymentStatus: deployment.status,
          },
          actor: request.user?.email,
        });
        telemetry.record({
          actor,
          action: "deployment.rollback-plan-requested" as Parameters<typeof telemetry.record>[0]["action"],
          target: { type: "deployment", id: deployment.id },
          details: { stepCount: rollbackPlan.scriptedPlan.stepSummary.length },
        });

        return reply.status(200).send({ deployment, rollbackPlan });
      } catch (err) {
        return reply.status(500).send({
          error: "Failed to generate rollback plan",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // Execute rollback — runs the stored rollback plan against the envoy
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/execute-rollback",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      if (!deployment.rollbackPlan) {
        return reply.status(409).send({ error: "No rollback plan available — request one first" });
      }

      const finishedStatuses = new Set(["succeeded", "failed"]);
      if (!finishedStatuses.has(deployment.status)) {
        return reply.status(409).send({
          error: `Cannot execute rollback for operation in "${deployment.status}" status`,
        });
      }

      const artifact = artifactStore.get(getArtifactId(deployment) ?? "");
      const targetEnvoy = deployment.envoyId
        ? envoyRegistry?.get(deployment.envoyId)
        : envoyRegistry?.list()[0];

      if (!targetEnvoy) {
        return reply.status(503).send({ error: "No envoy available to execute rollback" });
      }

      const actor = (request.user?.email) ?? "anonymous";
      const serverPort = process.env.PORT ?? "9410";
      const serverUrl = process.env.SYNTH_SERVER_URL ?? `http://localhost:${serverPort}`;
      const progressCallbackUrl = `${serverUrl}/api/operations/${deployment.id}/progress`;

      deployment.status = "running" as typeof deployment.status;
      deployments.save(deployment);

      debrief.record({
        partitionId: deployment.partitionId ?? null,
        operationId: deployment.id,
        agent: "server",
        decisionType: "rollback-execution",
        decision: `Rollback execution initiated for ${artifact?.name ?? getArtifactId(deployment)} v${deployment.version}`,
        reasoning: `Rollback requested by ${actor}. Executing ${deployment.rollbackPlan.scriptedPlan.stepSummary.length} rollback step(s).`,
        context: { initiatedBy: actor, stepCount: deployment.rollbackPlan.scriptedPlan.stepSummary.length },
        actor: request.user?.email,
      });
      telemetry.record({
        actor,
        action: "deployment.rollback-executed" as Parameters<typeof telemetry.record>[0]["action"],
        target: { type: "deployment", id: deployment.id },
        details: { stepCount: deployment.rollbackPlan.scriptedPlan.stepSummary.length },
      });

      const rollbackClient = new EnvoyClient(targetEnvoy.url);

      // Execute the rollback plan as if it were a forward plan — it IS a forward plan
      // (just in the reverse direction). Use an empty no-op plan as the "rollback of rollback".
      const emptyPlan: import("@synth-deploy/core").OperationPlan = {
        scriptedPlan: {
          platform: "bash",
          executionScript: "# No rollback of rollback",
          dryRunScript: null,
          rollbackScript: null,
          reasoning: "No rollback of rollback.",
          stepSummary: [],
        },
        reasoning: "No rollback of rollback.",
      };

      rollbackClient.executeApprovedPlan({
        operationId: deployment.id,
        plan: deployment.rollbackPlan,
        rollbackPlan: emptyPlan,
        artifactType: artifact?.type ?? "unknown",
        artifactName: artifact?.name ?? "unknown",
        environmentId: deployment.environmentId ?? "",
        progressCallbackUrl,
        callbackToken: targetEnvoy.token,
      }).then((result) => {
        const dep = deployments.get(deployment.id);
        if (!dep) return;

        dep.status = result.success ? "rolled_back" as typeof dep.status : "failed" as typeof dep.status;
        if (!result.success) {
          dep.failureReason = result.failureReason ?? "Rollback execution failed";
        }
        dep.completedAt = new Date();
        deployments.save(dep);

        debrief.record({
          partitionId: dep.partitionId ?? null,
          operationId: dep.id,
          agent: "server",
          decisionType: "rollback-execution",
          decision: result.success
            ? `Rollback completed successfully for ${artifact?.name ?? getArtifactId(dep)} v${dep.version}`
            : `Rollback failed for ${artifact?.name ?? getArtifactId(dep)} v${dep.version}`,
          reasoning: result.success
            ? `All rollback steps executed successfully.`
            : `Rollback failed: ${result.failureReason}`,
          context: { success: result.success, failureReason: result.failureReason },
        });
      }).catch((err) => {
        const dep = deployments.get(deployment.id);
        if (!dep) return;

        dep.status = "failed" as typeof dep.status;
        dep.failureReason = err instanceof Error ? err.message : "Rollback execution dispatch failed";
        deployments.save(dep);
      });

      return reply.status(202).send({ deployment, accepted: true });
    },
  );

  // Retry (redeploy) — create a new deployment with the same parameters as the source
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/retry",
    { preHandler: [requirePermission("deployment.create")] },
    async (request, reply) => {
      const source = deployments.get(request.params.id);
      if (!source) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      // Calculate attempt number by following the retryOf chain
      let attemptNumber = 1;
      let cursor: typeof source | undefined = source;
      while (cursor?.retryOf) {
        attemptNumber++;
        cursor = deployments.get(cursor.retryOf);
      }
      attemptNumber++; // this new deployment is one more

      // Validate artifact still exists
      const artifact = artifactStore.get(getArtifactId(source) ?? "");
      if (!artifact) {
        return reply.status(404).send({ error: `Artifact not found: ${getArtifactId(source)}` });
      }

      // Validate environment still exists (if present on source)
      const environment = source.environmentId ? environments.get(source.environmentId) : undefined;
      if (source.environmentId && !environment) {
        return reply.status(404).send({ error: `Environment not found: ${source.environmentId}` });
      }

      // Validate partition still exists (if present on source)
      const partition = source.partitionId ? partitions.get(source.partitionId) : undefined;
      if (source.partitionId && !partition) {
        return reply.status(404).send({ error: `Partition not found: ${source.partitionId}` });
      }

      // Validate envoy still exists (if present on source)
      const targetEnvoy = source.envoyId ? envoyRegistry?.get(source.envoyId) : undefined;
      if (source.envoyId && !targetEnvoy) {
        return reply.status(404).send({ error: `Envoy not found: ${source.envoyId}` });
      }

      // Resolve variables — same logic as POST /api/deployments
      const envVars = environment ? environment.variables : {};
      const partitionVars = partition?.variables ?? {};
      const resolved: Record<string, string> = { ...partitionVars, ...envVars };

      const deployment = {
        id: crypto.randomUUID(),
        input: source.input,
        environmentId: source.environmentId,
        partitionId: source.partitionId,
        envoyId: targetEnvoy?.id,
        version: source.version ?? "",
        status: "pending" as const,
        variables: resolved,
        retryOf: source.id,
        debriefEntryIds: [] as string[],
        createdAt: new Date(),
      };

      deployments.save(deployment);

      const actor = (request.user?.email) ?? "anonymous";
      telemetry.record({ actor, action: "operation.created", target: { type: "deployment", id: deployment.id }, details: { artifactId: getArtifactId(source), environmentId: source.environmentId, partitionId: source.partitionId, envoyId: source.envoyId, retryOf: source.id } });

      // Record retry debrief entry
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        operationId: deployment.id,
        agent: "server",
        decisionType: "system",
        decision: `Retry of operation ${source.id} (attempt #${attemptNumber})`,
        reasoning: `User initiated retry of operation ${source.id}. Same artifact, version, environment, and partition.`,
        context: { retryOf: source.id, attemptNumber, actor },
        actor: request.user?.email,
      });

      // Dispatch planning — same logic as POST /api/deployments
      if (envoyRegistry) {
        const planningEnvoy = targetEnvoy
          ?? (environment ? envoyRegistry.findForEnvironment(environment.name) : undefined)
          ?? envoyRegistry.list()[0];

        if (planningEnvoy) {
          const planningClient = new EnvoyClient(planningEnvoy.url);
          const environmentForPlanning = environment
            ? { id: environment.id, name: environment.name, variables: environment.variables }
            : { id: `direct:${planningEnvoy.id}`, name: planningEnvoy.name, variables: {} };

          planningClient.requestPlan({
            operationId: deployment.id,
            artifact: {
              id: artifact.id,
              name: artifact.name,
              type: artifact.type,
              analysis: {
                summary: artifact.analysis.summary,
                dependencies: artifact.analysis.dependencies,
                configurationExpectations: artifact.analysis.configurationExpectations,
                deploymentIntent: artifact.analysis.deploymentIntent,
                confidence: artifact.analysis.confidence,
              },
            },
            environment: environmentForPlanning,
            partition: partition
              ? { id: partition.id, name: partition.name, variables: partition.variables }
              : undefined,
            version: deployment.version ?? "",
            resolvedVariables: resolved,
            envoyContext: planningEnvoy.envoyContext ?? undefined,
          }).then((result) => {
            const dep = deployments.get(deployment.id);
            if (!dep || dep.status !== "pending") return;

            dep.plan = result.plan;
            dep.rollbackPlan = result.rollbackPlan;
            dep.envoyId = planningEnvoy.id;

            if (result.blocked) {
              dep.status = "failed" as typeof dep.status;
              dep.failureReason = result.blockReason ?? "Plan blocked due to unrecoverable precondition failures";
              deployments.save(dep);

              debrief.record({
                partitionId: dep.partitionId ?? null,
                operationId: dep.id,
                agent: "envoy",
                decisionType: "plan-generation",
                decision: `Operation plan blocked — infrastructure prerequisites not met`,
                reasoning: result.blockReason ?? result.plan.reasoning,
                context: { stepCount: result.plan.scriptedPlan.stepSummary.length, envoyId: planningEnvoy.id, blocked: true },
              });
            } else {
              dep.status = "awaiting_approval" as typeof dep.status;
              dep.recommendation = computeRecommendation(dep, deployments, result.assessmentSummary);
              deployments.save(dep);

              debrief.record({
                partitionId: dep.partitionId ?? null,
                operationId: dep.id,
                agent: "envoy",
                decisionType: "plan-generation",
                decision: `Operation plan generated with ${result.plan.scriptedPlan.stepSummary.length} steps`,
                reasoning: result.plan.reasoning,
                context: { stepCount: result.plan.scriptedPlan.stepSummary.length, envoyId: planningEnvoy.id, delta: result.delta },
              });
            }
          }).catch((err) => {
            const dep = deployments.get(deployment.id);
            if (!dep || dep.status !== "pending") return;

            dep.status = "failed" as typeof dep.status;
            dep.failureReason = err instanceof Error ? err.message : "Planning failed";
            deployments.save(dep);

            debrief.record({
              partitionId: dep.partitionId ?? null,
              operationId: dep.id,
              agent: "server",
              decisionType: "deployment-failure",
              decision: "Envoy planning failed",
              reasoning: dep.failureReason!,
              context: { error: dep.failureReason, envoyId: planningEnvoy.id },
            });
          });
        }
      }

      return reply.status(201).send({ deployment, sourceDeploymentId: source.id, attemptNumber });
    },
  );

  // Get deployment postmortem
  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/postmortem",
    { preHandler: [requirePermission("deployment.view")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const entries = debrief.getByOperation(deployment.id);
      const postmortem = generatePostmortem(entries, deployment);
      const llmResult = await generatePostmortemAsync(entries, deployment, llm);
      return {
        postmortem,
        ...(llmResult.heuristicFallback ? {} : { llmPostmortem: llmResult.llmPostmortem }),
      };
    },
  );

  // Get recent debrief entries (supports filtering by partition, decision type, and full-text search)
  app.get("/api/debrief", { preHandler: [requirePermission("deployment.view")] }, async (request) => {
    const qParsed = DebriefQuerySchema.safeParse(request.query);
    const { limit, partitionId, decisionType, q: searchQuery } = qParsed.success ? qParsed.data : {};

    const max = limit ?? 50;

    // Full-text search — takes priority over filters
    if (searchQuery) {
      let entries = debrief.search(searchQuery, max);
      if (partitionId) entries = entries.filter((e) => e.partitionId === partitionId);
      if (decisionType) entries = entries.filter((e) => e.decisionType === decisionType);
      return { entries };
    }

    // No filters — fast path
    if (!partitionId && !decisionType) {
      return { entries: debrief.getRecent(max) };
    }

    // Start with the most selective filter, then narrow
    let entries: ReturnType<typeof debrief.getByPartition>;
    if (partitionId && decisionType) {
      entries = debrief.getByPartition(partitionId).filter(
        (e) => e.decisionType === decisionType,
      );
    } else if (partitionId) {
      entries = debrief.getByPartition(partitionId);
    } else {
      entries = debrief.getByType(decisionType as Parameters<typeof debrief.getByType>[0]);
    }

    entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return { entries: entries.slice(0, max) };
  });

  // Pin/unpin an operation for quick-access
  // Static route registered before parameterized :id routes to avoid shadowing
  app.get("/api/operations/pinned", { preHandler: [requirePermission("deployment.view")] }, async () => {
    const ids = debrief.getPinnedOperationIds();
    const operations = ids.map((id) => deployments.get(id)).filter(Boolean);
    return { operations, pinnedIds: ids };
  });

  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/pin",
    { preHandler: [requirePermission("deployment.view")] },
    async (request) => {
      debrief.pinOperation(request.params.id);
      return { pinned: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/operations/:id/pin",
    { preHandler: [requirePermission("deployment.view")] },
    async (request) => {
      debrief.unpinOperation(request.params.id);
      return { pinned: false };
    },
  );

  // ---------------------------------------------------------------------------
  // Progress streaming — envoy callback and SSE endpoints
  // ---------------------------------------------------------------------------

  // POST /api/deployments/:id/progress — receives progress events from envoy
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/progress",
    async (request, reply) => {
      if (!progressStore) {
        return reply.status(501).send({ error: "Progress streaming not configured" });
      }

      // Validate envoy token — this route is exempt from JWT auth
      if (envoyRegistry) {
        const authHeader = (request.headers.authorization ?? "") as string;
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        if (!token || !envoyRegistry.validateToken(token)) {
          return reply.status(401).send({ error: "Invalid or missing envoy token" });
        }
      }

      const parsed = ProgressEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid progress event", details: parsed.error.format() });
      }

      const event = parsed.data;

      // Validate the deploymentId in the URL matches the body
      if (event.deploymentId !== request.params.id) {
        return reply.status(400).send({ error: "Operation ID in URL does not match event body" });
      }

      progressStore.push(event);
      return reply.status(200).send({ received: true });
    },
  );

  // GET /api/deployments/:id/stream — SSE endpoint for live progress
  // Auth is via ?token= query param since EventSource cannot send headers
  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/stream",
    { preHandler: [requirePermission("deployment.view")] },
    (request, reply) => {
      if (!progressStore) {
        reply.status(501).send({ error: "Progress streaming not configured" });
        return;
      }

      // Hijack the connection so Fastify does not finalize the response
      reply.hijack();

      // Set SSE headers
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const deploymentId = request.params.id;

      // Check for Last-Event-ID header (reconnection with replay)
      const lastEventIdHeader = request.headers["last-event-id"];
      const lastEventId = lastEventIdHeader ? parseInt(String(lastEventIdHeader), 10) : 0;

      // Send catch-up events — either all (fresh connect) or since last ID (reconnect)
      const existing = lastEventId
        ? progressStore.getEventsSince(deploymentId, lastEventId)
        : progressStore.getEvents(deploymentId);
      for (const event of existing) {
        reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      }

      // Check if deployment already completed — if so, close after catch-up
      const lastEvent = existing[existing.length - 1];
      if (lastEvent?.type === "deployment-completed") {
        reply.raw.end();
        return;
      }

      // Subscribe to new events
      const listener = (event: { id?: number; deploymentId: string; type: string }) => {
        try {
          reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);

          // Close the stream when deployment completes
          if (event.type === "deployment-completed") {
            reply.raw.end();
          }
        } catch {
          // Client disconnected — clean up
          progressStore!.removeListener(deploymentId, listener);
        }
      };

      progressStore.addListener(deploymentId, listener);

      // Clean up on client disconnect
      request.raw.on("close", () => {
        progressStore!.removeListener(deploymentId, listener);
      });
    },
  );

  // -- Health reports from envoys (trigger system) ---------------------------

  app.post("/api/health-reports", async (request, reply) => {
    // Validate envoy token — same pattern as /api/envoy/report
    if (envoyRegistry) {
      const authHeader = (request.headers.authorization ?? "") as string;
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (!token || !envoyRegistry.validateToken(token)) {
        return reply.status(401).send({ error: "Invalid or missing envoy token" });
      }
    }

    const { HealthReportSchema } = await import("@synth-deploy/core");
    const parsed = HealthReportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid health report", details: parsed.error.format() });
    }

    const report = parsed.data;

    // Find the trigger operation
    const triggerOp = deployments.get(report.triggerOperationId);
    if (!triggerOp || triggerOp.input.type !== "trigger") {
      return reply.status(404).send({ error: `Trigger operation not found: ${report.triggerOperationId}` });
    }

    // Record the health report
    debrief.record({
      partitionId: report.partitionId ?? null,
      operationId: triggerOp.id,
      agent: "envoy",
      decisionType: "health-report-received",
      decision: `Health report: ${report.summary}`,
      reasoning: `Trigger condition met on ${report.envoyId}. Probes: ${report.probeResults.map(p => `${p.label}=${p.parsedValue ?? p.output}`).join(", ")}`,
      context: { directiveId: report.directiveId, envoyId: report.envoyId, probeResults: report.probeResults },
    });

    // Deduplication: check for active child operations from this trigger
    const allOps = deployments.list();
    const activeChild = allOps.find(
      (op) => op.lineage === triggerOp.id &&
        ["pending", "planning", "awaiting_approval", "approved", "running"].includes(op.status),
    );

    if (activeChild) {
      // Suppress — record that we suppressed
      triggerOp.triggerSuppressedCount = (triggerOp.triggerSuppressedCount ?? 0) + 1;
      deployments.save(triggerOp);

      debrief.record({
        partitionId: report.partitionId ?? null,
        operationId: triggerOp.id,
        agent: "server",
        decisionType: "trigger-suppressed",
        decision: `Trigger suppressed — child operation ${activeChild.id} is still in progress (${activeChild.status})`,
        reasoning: `Deduplication: an operation spawned by this trigger is already active. Suppressed ${triggerOp.triggerSuppressedCount} time(s) total.`,
        context: { activeChildId: activeChild.id, activeChildStatus: activeChild.status, suppressedCount: triggerOp.triggerSuppressedCount },
      });

      return reply.status(200).send({ spawned: false, reason: "deduplicated", activeChildId: activeChild.id });
    }

    // Spawn child operation
    const triggerInput = triggerOp.input as { type: "trigger"; condition: string; responseIntent: string };
    const responseType = triggerOp.monitoringDirective?.responseType ?? "maintain";
    const childOp = {
      id: crypto.randomUUID(),
      input: responseType === "deploy"
        ? { type: "deploy" as const, artifactId: "" }
        : { type: "maintain" as const, intent: triggerInput.responseIntent },
      intent: triggerInput.responseIntent,
      lineage: triggerOp.id,
      triggeredBy: "trigger" as const,
      environmentId: report.environmentId ?? triggerOp.environmentId,
      partitionId: report.partitionId ?? triggerOp.partitionId,
      envoyId: report.envoyId,
      version: "",
      status: "pending" as const,
      variables: triggerOp.variables,
      debriefEntryIds: [] as string[],
      createdAt: new Date(),
    };

    deployments.save(childOp);

    // Update trigger stats
    triggerOp.triggerFireCount = (triggerOp.triggerFireCount ?? 0) + 1;
    triggerOp.triggerLastFiredAt = new Date();
    deployments.save(triggerOp);

    debrief.record({
      partitionId: childOp.partitionId ?? null,
      operationId: childOp.id,
      agent: "server",
      decisionType: "trigger-fired",
      decision: `Trigger fired — spawned child operation ${childOp.id}`,
      reasoning: `Condition "${triggerInput.condition}" met. Response: "${triggerInput.responseIntent}". Fire count: ${triggerOp.triggerFireCount}.`,
      context: { triggerId: triggerOp.id, envoyId: report.envoyId, fireCount: triggerOp.triggerFireCount },
    });
    telemetry.record({ actor: "agent", action: "trigger.fired" as TelemetryAction, target: { type: "trigger", id: triggerOp.id }, details: { childOperationId: childOp.id } });

    // Dispatch planning for the child operation (same as new operation flow)
    if (envoyRegistry) {
      const childEnvoy = report.envoyId
        ? envoyRegistry.get(report.envoyId)
        : envoyRegistry.list()[0];

      if (childEnvoy) {
        const planningClient = new EnvoyClient(childEnvoy.url);
        const environment = childOp.environmentId ? environments.get(childOp.environmentId) : undefined;
        const environmentForPlanning = environment
          ? { id: environment.id, name: environment.name, variables: environment.variables }
          : { id: `direct:${childEnvoy.id}`, name: childEnvoy.name, variables: {} };

        planningClient.requestPlan({
          operationId: childOp.id,
          operationType: responseType as "deploy" | "query" | "investigate" | "maintain" | "trigger",
          intent: childOp.intent,
          environment: environmentForPlanning,
          version: "",
          resolvedVariables: childOp.variables,
          envoyContext: childEnvoy.envoyContext ?? undefined,
        }).then((result) => {
          const dep = deployments.get(childOp.id);
          if (!dep || dep.status !== "pending") return;

          dep.plan = result.plan;
          dep.rollbackPlan = result.rollbackPlan;
          dep.envoyId = childEnvoy.id;

          if (result.blocked) {
            dep.status = "failed" as typeof dep.status;
            dep.failureReason = result.blockReason ?? "Plan blocked";
            deployments.save(dep);
          } else {
            dep.status = "awaiting_approval" as typeof dep.status;
            dep.recommendation = computeRecommendation(dep, deployments, result.assessmentSummary);
            deployments.save(dep);
          }
        }).catch((err) => {
          const dep = deployments.get(childOp.id);
          if (!dep || dep.status !== "pending") return;
          dep.status = "failed" as typeof dep.status;
          dep.failureReason = err instanceof Error ? err.message : "Planning failed";
          deployments.save(dep);
        });
      }
    }

    return reply.status(201).send({ spawned: true, childOperationId: childOp.id });
  });

  // -- Trigger management (pause/resume/disable) ----------------------------

  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/trigger/pause",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const op = deployments.get(request.params.id);
      if (!op || op.input.type !== "trigger") {
        return reply.status(404).send({ error: "Trigger operation not found" });
      }
      if (op.triggerStatus !== "active") {
        return reply.status(409).send({ error: `Cannot pause trigger in "${op.triggerStatus}" status` });
      }

      // Pause on envoy
      if (op.envoyId && envoyRegistry) {
        const envoy = envoyRegistry.get(op.envoyId);
        if (envoy) {
          const client = new EnvoyClient(envoy.url);
          await client.pauseMonitoringDirective(op.id);
        }
      }

      op.triggerStatus = "paused";
      if (op.monitoringDirective) op.monitoringDirective.status = "paused";
      deployments.save(op);

      const actor = (request.user?.email) ?? "anonymous";
      debrief.record({
        partitionId: op.partitionId ?? null,
        operationId: op.id,
        agent: "server",
        decisionType: "trigger-paused",
        decision: `Trigger paused by ${actor}`,
        reasoning: "User requested trigger pause",
        context: {},
        actor: request.user?.email,
      });
      telemetry.record({ actor, action: "trigger.paused" as TelemetryAction, target: { type: "trigger", id: op.id }, details: {} });

      return { operation: op, paused: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/trigger/resume",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const op = deployments.get(request.params.id);
      if (!op || op.input.type !== "trigger") {
        return reply.status(404).send({ error: "Trigger operation not found" });
      }
      if (op.triggerStatus !== "paused") {
        return reply.status(409).send({ error: `Cannot resume trigger in "${op.triggerStatus}" status` });
      }

      // Resume on envoy
      if (op.envoyId && envoyRegistry) {
        const envoy = envoyRegistry.get(op.envoyId);
        if (envoy) {
          const client = new EnvoyClient(envoy.url);
          await client.resumeMonitoringDirective(op.id);
        }
      }

      op.triggerStatus = "active";
      if (op.monitoringDirective) op.monitoringDirective.status = "active";
      deployments.save(op);

      const actor = (request.user?.email) ?? "anonymous";
      debrief.record({
        partitionId: op.partitionId ?? null,
        operationId: op.id,
        agent: "server",
        decisionType: "trigger-resumed",
        decision: `Trigger resumed by ${actor}`,
        reasoning: "User requested trigger resume",
        context: {},
        actor: request.user?.email,
      });
      telemetry.record({ actor, action: "trigger.resumed" as TelemetryAction, target: { type: "trigger", id: op.id }, details: {} });

      return { operation: op, resumed: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/trigger/disable",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const op = deployments.get(request.params.id);
      if (!op || op.input.type !== "trigger") {
        return reply.status(404).send({ error: "Trigger operation not found" });
      }

      // Remove from envoy
      if (op.envoyId && envoyRegistry) {
        const envoy = envoyRegistry.get(op.envoyId);
        if (envoy) {
          const client = new EnvoyClient(envoy.url);
          await client.removeMonitoringDirective(op.id).catch(() => {});
        }
      }

      op.triggerStatus = "disabled";
      if (op.monitoringDirective) op.monitoringDirective.status = "disabled";
      deployments.save(op);

      const actor = (request.user?.email) ?? "anonymous";
      debrief.record({
        partitionId: op.partitionId ?? null,
        operationId: op.id,
        agent: "server",
        decisionType: "trigger-disabled",
        decision: `Trigger disabled by ${actor}`,
        reasoning: "User requested trigger disable",
        context: {},
        actor: request.user?.email,
      });
      telemetry.record({ actor, action: "trigger.disabled" as TelemetryAction, target: { type: "trigger", id: op.id }, details: {} });

      return { operation: op, disabled: true };
    },
  );

  // ---------------------------------------------------------------------------
  // Composite operation helpers — defined inside registerOperationRoutes so
  // they close over the stores and registry.
  // ---------------------------------------------------------------------------

  async function planCompositeChildren(
    parentOp: import("@synth-deploy/core").Operation,
    _registry: EnvoyRegistry,
    planningEnvoy: { id: string; name: string; url: string },
  ): Promise<void> {
    const compositeInput = parentOp.input as { type: "composite"; operations: import("@synth-deploy/core").OperationInput[] };
    const childInputs = compositeInput.operations;

    if (childInputs.length === 0) {
      const dep = deployments.get(parentOp.id);
      if (dep) {
        dep.status = "failed" as typeof dep.status;
        dep.failureReason = "Composite operation has no child operations";
        deployments.save(dep);
      }
      return;
    }

    const childIds: string[] = [];
    const environment = parentOp.environmentId ? environments.get(parentOp.environmentId) : undefined;
    const partition = parentOp.partitionId ? partitions.get(parentOp.partitionId) : undefined;

    for (let seqIdx = 0; seqIdx < childInputs.length; seqIdx++) {
      const childInput = childInputs[seqIdx];
      const childOp = {
        id: crypto.randomUUID(),
        input: childInput,
        intent: "intent" in childInput ? (childInput as { intent: string }).intent
          : childInput.type === "trigger" ? `Monitor: ${(childInput as { condition: string }).condition}`
          : undefined,
        lineage: parentOp.id,
        triggeredBy: "agent" as const,
        environmentId: parentOp.environmentId,
        partitionId: parentOp.partitionId,
        envoyId: planningEnvoy.id,
        version: parentOp.version ?? "",
        status: "pending" as const,
        variables: parentOp.variables,
        debriefEntryIds: [] as string[],
        createdAt: new Date(),
        sequenceIndex: seqIdx,
      };
      deployments.save(childOp);
      childIds.push(childOp.id);
    }

    debrief.record({
      partitionId: parentOp.partitionId ?? null,
      operationId: parentOp.id,
      agent: "server",
      decisionType: "composite-started",
      decision: `Composite operation started — planning ${childIds.length} child operation(s) sequentially`,
      reasoning: `Sequential composite: ${childInputs.map((c) => c.type).join(" → ")}`,
      context: { childIds, childCount: childIds.length, sequence: childInputs.map((c) => c.type) },
    });

    const environmentForPlanning = environment
      ? { id: environment.id, name: environment.name, variables: environment.variables }
      : { id: `direct:${planningEnvoy.id}`, name: planningEnvoy.name, variables: {} };

    let anyFailed = false;

    for (const childId of childIds) {
      const child = deployments.get(childId);
      if (!child) continue;
      const childInput = child.input;

      const childArtifact = childInput.type === "deploy"
        ? artifactStore.get((childInput as { artifactId: string }).artifactId)
        : undefined;

      const planningClient = new EnvoyClient(planningEnvoy.url);

      try {
        const result = await planningClient.requestPlan({
          operationId: childId,
          operationType: childInput.type as "deploy" | "query" | "investigate" | "maintain" | "trigger",
          intent: "intent" in childInput ? (childInput as { intent?: string }).intent
            : childInput.type === "trigger" ? `Monitor: ${(childInput as { condition: string }).condition}`
            : undefined,
          ...(childArtifact ? {
            artifact: {
              id: childArtifact.id,
              name: childArtifact.name,
              type: childArtifact.type,
              analysis: childArtifact.analysis,
            },
          } : {}),
          ...(childInput.type === "investigate" && "allowWrite" in childInput
            ? { allowWrite: (childInput as { allowWrite?: boolean }).allowWrite }
            : {}),
          environment: environmentForPlanning,
          partition: partition ? { id: partition.id, name: partition.name, variables: partition.variables } : undefined,
          version: parentOp.version ?? "",
          resolvedVariables: parentOp.variables,
          envoyContext: planningEnvoy.envoyContext ?? undefined,
        });

        const childDep = deployments.get(childId);
        if (!childDep) continue;

        if (result.blocked) {
          childDep.status = "failed" as typeof childDep.status;
          childDep.failureReason = result.blockReason ?? "Plan blocked";
          deployments.save(childDep);
          anyFailed = true;

          const parentDep = deployments.get(parentOp.id);
          if (parentDep && parentDep.status === "pending") {
            parentDep.status = "failed" as typeof parentDep.status;
            parentDep.failureReason = `Child operation (${childInput.type}) plan blocked: ${childDep.failureReason}`;
            deployments.save(parentDep);
            debrief.record({
              partitionId: parentDep.partitionId ?? null,
              operationId: parentDep.id,
              agent: "server",
              decisionType: "composite-failed",
              decision: `Child operation planning blocked — composite cannot proceed`,
              reasoning: childDep.failureReason,
              context: { childId, childType: childInput.type },
            });
          }
          break;
        }

        childDep.plan = result.plan;
        childDep.rollbackPlan = result.rollbackPlan;
        childDep.envoyId = planningEnvoy.id;
        if (childInput.type === "query" && result.queryFindings) childDep.queryFindings = result.queryFindings;
        if (childInput.type === "investigate" && result.investigationFindings) childDep.investigationFindings = result.investigationFindings;
        childDep.status = "awaiting_approval" as typeof childDep.status;
        deployments.save(childDep);

        debrief.record({
          partitionId: childDep.partitionId ?? null,
          operationId: childDep.id,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `Child operation plan generated with ${result.plan.scriptedPlan.stepSummary.length} steps`,
          reasoning: result.plan.reasoning,
          context: { stepCount: result.plan.scriptedPlan.stepSummary.length, envoyId: planningEnvoy.id, parentOperationId: parentOp.id },
        });
      } catch (err) {
        const childDep = deployments.get(childId);
        if (childDep) {
          childDep.status = "failed" as typeof childDep.status;
          childDep.failureReason = err instanceof Error ? err.message : "Planning failed";
          deployments.save(childDep);
        }
        anyFailed = true;

        const parentDep = deployments.get(parentOp.id);
        if (parentDep && parentDep.status === "pending") {
          parentDep.status = "failed" as typeof parentDep.status;
          parentDep.failureReason = `Child operation (${childInput.type}) planning failed: ${err instanceof Error ? err.message : "unknown error"}`;
          deployments.save(parentDep);
          debrief.record({
            partitionId: parentDep.partitionId ?? null,
            operationId: parentDep.id,
            agent: "server",
            decisionType: "composite-failed",
            decision: `Child operation planning failed — composite cannot proceed`,
            reasoning: parentDep.failureReason!,
            context: { childId, childType: childInput.type, error: parentDep.failureReason },
          });
        }
        break;
      }
    }

    if (!anyFailed) {
      // All children planned — build combined summary plan and await approval
      const allChildren = childIds.map((id) => deployments.get(id)).filter(Boolean) as import("@synth-deploy/core").Operation[];

      const combinedStepSummary = allChildren.flatMap((c, idx) => {
        if (!c.plan?.scriptedPlan) return [];
        return c.plan.scriptedPlan.stepSummary.map((step) => ({
          ...step,
          description: `[${idx + 1}/${allChildren.length}: ${c.input.type}] ${step.description}`,
        }));
      });

      const combinedReasoning = allChildren.map((c, idx) =>
        `Step ${idx + 1} (${c.input.type}): ${c.plan?.reasoning ?? "no reasoning"}`
      ).join("\n\n");

      // Combine child execution scripts into a single composite script
      const combinedScript = allChildren
        .map((c, idx) => `# --- Child ${idx + 1}/${allChildren.length}: ${c.input.type} ---\n${c.plan?.scriptedPlan?.executionScript ?? "# no script"}`)
        .join("\n\n");

      const parentDep = deployments.get(parentOp.id);
      if (parentDep && parentDep.status === "pending") {
        parentDep.plan = {
          scriptedPlan: {
            platform: "bash",
            executionScript: combinedScript,
            dryRunScript: null,
            rollbackScript: null,
            reasoning: combinedReasoning,
            stepSummary: combinedStepSummary,
          },
          reasoning: combinedReasoning,
        };
        parentDep.rollbackPlan = {
          scriptedPlan: {
            platform: "bash",
            executionScript: "# Child operations handle their own rollback",
            dryRunScript: null,
            rollbackScript: null,
            reasoning: "Child operations handle their own rollback",
            stepSummary: [],
          },
          reasoning: "Child operations handle their own rollback",
        };
        parentDep.status = "awaiting_approval" as typeof parentDep.status;
        parentDep.recommendation = computeRecommendation(parentDep, deployments);
        deployments.save(parentDep);

        debrief.record({
          partitionId: parentDep.partitionId ?? null,
          operationId: parentDep.id,
          agent: "server",
          decisionType: "composite-plan-ready",
          decision: `All ${allChildren.length} child plans ready — composite awaiting approval`,
          reasoning: combinedReasoning,
          context: { childIds, totalSteps: combinedStepSummary.length },
        });
      }
    }
  }

  async function executeCompositeSequentially(
    parentId: string,
    childIds: string[],
  ): Promise<void> {
    const parentOp = deployments.get(parentId);
    if (!parentOp) return;

    debrief.record({
      partitionId: parentOp.partitionId ?? null,
      operationId: parentOp.id,
      agent: "server",
      decisionType: "composite-started",
      decision: `Composite execution started — running ${childIds.length} child operations sequentially`,
      reasoning: `Composite operation approved — executing children in order`,
      context: { childIds, totalChildren: childIds.length },
    });

    for (let i = 0; i < childIds.length; i++) {
      const childId = childIds[i];
      const child = deployments.get(childId);
      if (!child || !child.plan || !child.rollbackPlan) {
        const dep = deployments.get(parentId);
        if (dep) {
          dep.status = "failed" as typeof dep.status;
          dep.failureReason = `Child operation ${i + 1} has no plan — cannot execute`;
          deployments.save(dep);
          debrief.record({
            partitionId: dep.partitionId ?? null,
            operationId: dep.id,
            agent: "server",
            decisionType: "composite-failed",
            decision: `Child operation ${i + 1} missing plan — composite failed`,
            reasoning: dep.failureReason!,
            context: { childId, childIndex: i },
          });
        }
        return;
      }

      const targetEnvoy = child.envoyId ? envoyRegistry?.get(child.envoyId) : envoyRegistry?.list()[0];
      if (!targetEnvoy) {
        const dep = deployments.get(parentId);
        if (dep) {
          dep.status = "failed" as typeof dep.status;
          dep.failureReason = `No envoy available for child operation ${i + 1}`;
          deployments.save(dep);
        }
        return;
      }

      child.status = "running" as typeof child.status;
      deployments.save(child);

      debrief.record({
        partitionId: child.partitionId ?? null,
        operationId: child.id,
        agent: "server",
        decisionType: "composite-child-started",
        decision: `Executing child operation ${i + 1}/${childIds.length} (${child.input.type})`,
        reasoning: `Sequential composite execution — child ${i + 1} of ${childIds.length}`,
        context: { childId, childIndex: i, parentOperationId: parentId, childType: child.input.type },
      });

      const artifact = artifactStore.get(getArtifactId(child) ?? "");
      const serverPort = process.env.PORT ?? "9410";
      const serverUrl = process.env.SYNTH_SERVER_URL ?? `http://localhost:${serverPort}`;
      const progressCallbackUrl = `${serverUrl}/api/operations/${child.id}/progress`;
      const callbackToken = targetEnvoy?.token;

      const childEnvoyClient = new EnvoyClient((targetEnvoy as { url: string }).url);

      try {
        await childEnvoyClient.executeApprovedPlan({
          operationId: child.id,
          plan: child.plan,
          rollbackPlan: child.rollbackPlan,
          artifactType: artifact?.type ?? "unknown",
          artifactName: artifact?.name ?? "unknown",
          environmentId: child.environmentId ?? "",
          progressCallbackUrl,
          callbackToken,
        });
      } catch (err) {
        const dep = deployments.get(parentId);
        if (dep) {
          dep.status = "failed" as typeof dep.status;
          dep.failureReason = `Child operation ${i + 1} (${child.input.type}) execution dispatch failed: ${err instanceof Error ? err.message : "unknown error"}`;
          dep.completedAt = new Date();
          deployments.save(dep);
          debrief.record({
            partitionId: dep.partitionId ?? null,
            operationId: dep.id,
            agent: "server",
            decisionType: "composite-failed",
            decision: `Child operation ${i + 1} execution dispatch failed`,
            reasoning: dep.failureReason!,
            context: { childId, childIndex: i, error: dep.failureReason },
          });
        }
        return;
      }

      // Wait for child to complete (poll every 2 seconds, 5-minute timeout)
      const timeoutMs = 300_000;
      const pollIntervalMs = 2_000;
      const start = Date.now();
      let childSucceeded = false;

      while (Date.now() - start < timeoutMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
        const updated = deployments.get(childId);
        if (updated?.status === "succeeded") {
          childSucceeded = true;
          break;
        }
        if (updated?.status === "failed" || updated?.status === "rolled_back" || updated?.status === "cancelled") {
          break;
        }
        // Stop if the parent was externally cancelled or failed while we were waiting
        const parentNow = deployments.get(parentId);
        if (!parentNow || parentNow.status === "failed" || parentNow.status === "cancelled") {
          return;
        }
      }

      const finalChild = deployments.get(childId);
      if (!childSucceeded) {
        const reason = finalChild?.failureReason ?? `Child operation ${i + 1} did not complete in time`;
        const dep = deployments.get(parentId);
        if (dep) {
          dep.status = "failed" as typeof dep.status;
          dep.failureReason = `Composite stopped at step ${i + 1}/${childIds.length} (${child.input.type}): ${reason}`;
          dep.completedAt = new Date();
          deployments.save(dep);
          debrief.record({
            partitionId: dep.partitionId ?? null,
            operationId: dep.id,
            agent: "server",
            decisionType: "composite-failed",
            decision: `Composite stopped at child ${i + 1}/${childIds.length} — ${child.input.type} failed`,
            reasoning: dep.failureReason!,
            context: { childId, childIndex: i, failedChildType: child.input.type, completedChildren: i },
          });
        }
        return;
      }

      debrief.record({
        partitionId: finalChild?.partitionId ?? null,
        operationId: childId,
        agent: "server",
        decisionType: "composite-child-completed",
        decision: `Child operation ${i + 1}/${childIds.length} (${child.input.type}) completed successfully`,
        reasoning: `Child execution succeeded — proceeding to next child`,
        context: { childId, childIndex: i, parentOperationId: parentId },
      });
    }

    // All children succeeded
    const dep = deployments.get(parentId);
    if (dep) {
      dep.status = "succeeded" as typeof dep.status;
      dep.completedAt = new Date();
      deployments.save(dep);
      debrief.record({
        partitionId: dep.partitionId ?? null,
        operationId: dep.id,
        agent: "server",
        decisionType: "composite-completed",
        decision: `Composite operation completed — all ${childIds.length} child operations succeeded`,
        reasoning: `All child operations executed successfully in sequence`,
        context: { childIds, totalChildren: childIds.length },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Recommendation engine — synthesizes enrichment context into a verdict
// ---------------------------------------------------------------------------

function computeRecommendation(
  deployment: import("@synth-deploy/core").Deployment,
  store: IDeploymentStore,
  llmSummary?: string,
): import("@synth-deploy/core").DeploymentRecommendation {
  const factors: string[] = [];
  let verdict: RecommendationVerdict = "proceed";

  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Check for previously rolled-back version
  if (deployment.version) {
    const rolledBack = store.findByArtifactVersion(
      getArtifactId(deployment) ?? "",
      deployment.version,
      "rolled_back",
    );
    if (rolledBack.length > 0) {
      verdict = "caution";
      factors.push("This artifact version was previously rolled back");
    }
  }

  // Check for conflicting deployments (only meaningful when environmentId is set)
  if (deployment.environmentId) {
    const conflicting = store.list().filter(
      (d) =>
        d.environmentId === deployment.environmentId &&
        d.id !== deployment.id &&
        ((d.status) === "running" || (d.status) === "approved"),
    );
    if (conflicting.length > 0) {
      verdict = "hold";
      factors.push(`${conflicting.length} other operation(s) in progress for this environment`);
    }
  }

  // Check deployment frequency
  const recentCount = deployment.environmentId
    ? store.countByEnvironment(deployment.environmentId, twentyFourHoursAgo)
    : 0;
  if (recentCount > 5) {
    if (verdict === "proceed") verdict = "caution";
    factors.push(`High operation frequency: ${recentCount} operations in the last 24h`);
  }

  // Check last deployment status
  const lastDeploy = deployment.environmentId
    ? store.findLatestByEnvironment(deployment.environmentId)
    : undefined;
  if (lastDeploy && lastDeploy.id !== deployment.id) {
    if ((lastDeploy.status) === "failed" || (lastDeploy.status) === "rolled_back") {
      if (verdict === "proceed") verdict = "caution";
      factors.push(`Last operation to this environment ${lastDeploy.status}`);
    } else if ((lastDeploy.status) === "succeeded") {
      factors.push("Last operation to this environment succeeded");
    }
  }

  if (factors.length === 0) {
    factors.push("No risk factors detected — target is stable");
  }

  const summaryMap: Record<RecommendationVerdict, string> = {
    proceed: "Proceed — no conflicting operations, target environment is stable",
    caution: "Proceed with caution — review risk factors before greenlighting",
    hold: "Hold — resolve conflicting operations before proceeding",
  };

  return { verdict, summary: llmSummary ?? summaryMap[verdict], factors };
}
