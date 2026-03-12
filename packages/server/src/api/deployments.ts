import type { FastifyInstance } from "fastify";
import { generatePostmortem } from "@synth-deploy/core";
import type { IPartitionStore, IEnvironmentStore, IArtifactStore, ISettingsStore, IDeploymentStore, ITelemetryStore, DebriefWriter, DebriefReader, DeploymentEnrichment, RecommendationVerdict } from "@synth-deploy/core";
import { requirePermission } from "../middleware/permissions.js";
import {
  CreateDeploymentSchema,
  ApproveDeploymentSchema,
  RejectDeploymentSchema,
  ModifyDeploymentPlanSchema,
  SubmitPlanSchema,
  DeploymentListQuerySchema,
  DebriefQuerySchema,
  ProgressEventSchema,
} from "./schemas.js";
import type { ProgressEventStore } from "./progress-event-store.js";
import { EnvoyClient } from "../agent/envoy-client.js";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";

/**
 * REST API routes for deployments. These are the traditional (non-MCP) interface
 * for the web UI and integrations.
 */
export function registerDeploymentRoutes(
  app: FastifyInstance,
  deployments: IDeploymentStore,
  debrief: DebriefWriter & DebriefReader,
  partitions: IPartitionStore,
  environments: IEnvironmentStore,
  artifactStore: IArtifactStore,
  settings: ISettingsStore,
  telemetry: ITelemetryStore,
  progressStore?: ProgressEventStore,
  envoyClient?: EnvoyClient,
  envoyRegistry?: EnvoyRegistry,
): void {
  // Create a deployment (plan phase)
  app.post("/api/deployments", { preHandler: [requirePermission("deployment.create")] }, async (request, reply) => {
    const parsed = CreateDeploymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const { artifactId, environmentId, partitionId, envoyId, version } = parsed.data;

    // Validate artifact exists
    const artifact = artifactStore.get(artifactId);
    if (!artifact) {
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

    const deployment = {
      id: crypto.randomUUID(),
      artifactId,
      environmentId,
      partitionId,
      envoyId: targetEnvoy?.id,
      version: version ?? "",
      status: "pending" as const,
      variables: resolved,
      debriefEntryIds: [] as string[],
      createdAt: new Date(),
    };

    deployments.save(deployment);
    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "deployment.created", target: { type: "deployment", id: deployment.id }, details: { artifactId, environmentId, partitionId, envoyId } });

    // Dispatch planning to the appropriate envoy asynchronously.
    // The envoy reasons about the deployment (read-only) and POSTs back a plan,
    // which transitions the deployment to awaiting_approval.
    if (envoyRegistry) {
      // Find the target envoy: explicit envoyId > environment-assigned > first available
      const planningEnvoy = targetEnvoy
        ?? (environment ? envoyRegistry.findForEnvironment(environment.name) : undefined)
        ?? envoyRegistry.list()[0];

      if (planningEnvoy) {
        const planningClient = new EnvoyClient(planningEnvoy.url);
        const environmentForPlanning = environment
          ? { id: environment.id, name: environment.name, variables: environment.variables }
          : { id: `direct:${planningEnvoy.id}`, name: planningEnvoy.name, variables: {} };

        planningClient.requestPlan({
          deploymentId: deployment.id,
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
          version: deployment.version,
          resolvedVariables: resolved,
        }).then((result) => {
          const dep = deployments.get(deployment.id);
          if (!dep || dep.status !== "pending") return;

          dep.plan = result.plan;
          dep.rollbackPlan = result.rollbackPlan;
          dep.envoyId = planningEnvoy.id;

          if (result.blocked) {
            // Unrecoverable precondition failures — block execution, do not present for approval
            dep.status = "failed" as typeof dep.status;
            dep.failureReason = result.blockReason ?? "Plan blocked due to unrecoverable precondition failures";
            deployments.save(dep);

            debrief.record({
              partitionId: dep.partitionId ?? null,
              deploymentId: dep.id,
              agent: "envoy",
              decisionType: "plan-generation" as Parameters<typeof debrief.record>[0]["decisionType"],
              decision: `Deployment plan blocked — infrastructure prerequisites not met`,
              reasoning: result.blockReason ?? result.plan.reasoning,
              context: { stepCount: result.plan.steps.length, envoyId: planningEnvoy.id, blocked: true },
            });
          } else {
            // Plan is valid — transition to awaiting_approval
            dep.status = "awaiting_approval" as typeof dep.status;
            dep.recommendation = computeRecommendation(dep, deployments);
            deployments.save(dep);

            debrief.record({
              partitionId: dep.partitionId ?? null,
              deploymentId: dep.id,
              agent: "envoy",
              decisionType: "plan-generation" as Parameters<typeof debrief.record>[0]["decisionType"],
              decision: `Deployment plan generated with ${result.plan.steps.length} steps`,
              reasoning: result.plan.reasoning,
              context: { stepCount: result.plan.steps.length, envoyId: planningEnvoy.id, delta: result.delta },
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
            deploymentId: dep.id,
            agent: "command",
            decisionType: "deployment-failure" as Parameters<typeof debrief.record>[0]["decisionType"],
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
  app.get<{ Params: { id: string } }>("/api/deployments/:id", { preHandler: [requirePermission("deployment.view")] }, async (request, reply) => {
    const deployment = deployments.get(request.params.id);
    if (!deployment) {
      return reply.status(404).send({ error: "Deployment not found" });
    }

    return {
      deployment,
      debrief: debrief.getByDeployment(deployment.id),
    };
  });

  // What's New — compare deployed artifact version against catalog latest
  app.get<{ Params: { id: string } }>("/api/deployments/:id/whats-new", { preHandler: [requirePermission("deployment.view")] }, async (request, reply) => {
    const deployment = deployments.get(request.params.id);
    if (!deployment) {
      return reply.status(404).send({ error: "Deployment not found" });
    }

    const versions = artifactStore.getVersions(deployment.artifactId);
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
  app.get("/api/deployments", { preHandler: [requirePermission("deployment.view")] }, async (request) => {
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
    "/api/deployments/:id/plan",
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const parsed = SubmitPlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid plan submission", details: parsed.error.format() });
      }

      if ((deployment.status as string) !== "pending" && (deployment.status as string) !== "planning") {
        return reply.status(409).send({ error: `Cannot submit plan for deployment in "${deployment.status}" status` });
      }

      deployment.plan = parsed.data.plan;
      deployment.rollbackPlan = parsed.data.rollbackPlan;
      deployment.status = "awaiting_approval" as typeof deployment.status;

      // Generate recommendation from enrichment context
      deployment.recommendation = computeRecommendation(deployment, deployments);

      deployments.save(deployment);

      debrief.record({
        partitionId: deployment.partitionId ?? null,
        deploymentId: deployment.id,
        agent: "envoy",
        decisionType: "plan-generation" as Parameters<typeof debrief.record>[0]["decisionType"],
        decision: `Deployment plan submitted with ${parsed.data.plan.steps.length} steps`,
        reasoning: parsed.data.plan.reasoning,
        context: { stepCount: parsed.data.plan.steps.length },
      });

      return reply.status(200).send({ deployment });
    },
  );

  // Approve a deployment plan
  app.post<{ Params: { id: string } }>(
    "/api/deployments/:id/approve",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const parsed = ApproveDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      if ((deployment.status as string) !== "awaiting_approval") {
        return reply.status(409).send({ error: `Cannot approve deployment in "${deployment.status}" status — must be "awaiting_approval"` });
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
        deploymentId: deployment.id,
        agent: "command",
        decisionType: "system",
        decision: `Deployment approved by ${actor}`,
        reasoning: parsed.data.modifications
          ? `Approved with modifications: ${parsed.data.modifications}`
          : "Approved without modifications",
        context: { approvedBy: actor },
        actor: request.user?.email,
      });
      telemetry.record({ actor, action: "deployment.approved", target: { type: "deployment", id: deployment.id }, details: { modifications: parsed.data.modifications } });

      // Dispatch approved plan to envoy for execution
      if (envoyClient && deployment.plan && deployment.rollbackPlan) {
        const artifact = artifactStore.get(deployment.artifactId);
        const serverPort = process.env.PORT ?? "3000";
        const serverUrl = process.env.SYNTH_SERVER_URL ?? `http://localhost:${serverPort}`;
        const progressCallbackUrl = `${serverUrl}/api/deployments/${deployment.id}/progress`;
        const callbackToken = envoyRegistry?.list().find(r => r.url === envoyClient.url)?.token;

        deployment.status = "running" as typeof deployment.status;
        deployments.save(deployment);

        // Fire-and-forget: execution runs async, progress comes via callback
        envoyClient.executeApprovedPlan({
          deploymentId: deployment.id,
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
            deploymentId: deployment.id,
            agent: "command",
            decisionType: "deployment-failure" as Parameters<typeof debrief.record>[0]["decisionType"],
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
    "/api/deployments/:id/reject",
    { preHandler: [requirePermission("deployment.reject")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const parsed = RejectDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      if ((deployment.status as string) !== "awaiting_approval") {
        return reply.status(409).send({ error: `Cannot reject deployment in "${deployment.status}" status — must be "awaiting_approval"` });
      }

      // Transition deployment status and store rejection reason
      deployment.status = "rejected" as typeof deployment.status;
      deployment.rejectionReason = parsed.data.reason;
      deployments.save(deployment);

      const actor = (request.user?.email) ?? "anonymous";

      // Record rejection in debrief
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        deploymentId: deployment.id,
        agent: "command",
        decisionType: "system",
        decision: "Deployment plan rejected",
        reasoning: parsed.data.reason,
        context: { reason: parsed.data.reason },
        actor: request.user?.email,
      });
      telemetry.record({ actor, action: "deployment.rejected", target: { type: "deployment", id: deployment.id }, details: { reason: parsed.data.reason } });

      return { deployment, rejected: true };
    },
  );

  // Modify a deployment plan (user edits steps before approval)
  app.post<{ Params: { id: string } }>(
    "/api/deployments/:id/modify",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const parsed = ModifyDeploymentPlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      if ((deployment.status as string) !== "awaiting_approval") {
        return reply.status(409).send({ error: `Cannot modify deployment in "${deployment.status}" status — must be "awaiting_approval"` });
      }

      if (!deployment.plan) {
        return reply.status(409).send({ error: "Deployment has no plan to modify" });
      }

      // Validate modified plan with envoy if available
      if (envoyClient) {
        try {
          const validation = await envoyClient.validatePlan(parsed.data.steps);
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

      // Build structured diff: what changed between old and new steps
      const oldSteps = deployment.plan.steps;
      const newSteps = parsed.data.steps;
      const diffLines: string[] = [];
      const maxLen = Math.max(oldSteps.length, newSteps.length);
      for (let i = 0; i < maxLen; i++) {
        const old = oldSteps[i];
        const cur = newSteps[i];
        if (!old) {
          diffLines.push(`+ Step ${i + 1} (added): ${cur.action} ${cur.target} — ${cur.description}`);
        } else if (!cur) {
          diffLines.push(`- Step ${i + 1} (removed): ${old.action} ${old.target} — ${old.description}`);
        } else if (old.action !== cur.action || old.target !== cur.target || old.description !== cur.description) {
          diffLines.push(`~ Step ${i + 1} (changed): ${old.action} ${old.target} → ${cur.action} ${cur.target}`);
          if (old.description !== cur.description) {
            diffLines.push(`  was: ${old.description}`);
            diffLines.push(`  now: ${cur.description}`);
          }
        }
      }
      const diffFromPreviousPlan = diffLines.length > 0
        ? diffLines.join("\n")
        : "Steps reordered or metadata changed (actions and targets unchanged)";

      // Apply modifications
      deployment.plan = {
        ...deployment.plan,
        steps: parsed.data.steps,
        diffFromPreviousPlan,
      };
      deployments.save(deployment);

      const actor = (request.user?.email) ?? "anonymous";

      // Record modification in debrief
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        deploymentId: deployment.id,
        agent: "command",
        decisionType: "plan-modification" as Parameters<typeof debrief.record>[0]["decisionType"],
        decision: `Deployment plan modified by ${actor}`,
        reasoning: parsed.data.reason,
        context: {
          modifiedBy: actor,
          stepCount: parsed.data.steps.length,
          reason: parsed.data.reason,
        },
        actor: request.user?.email,
      });
      telemetry.record({
        actor,
        action: "deployment.modified" as Parameters<typeof telemetry.record>[0]["action"],
        target: { type: "deployment", id: deployment.id },
        details: { reason: parsed.data.reason, stepCount: parsed.data.steps.length },
      });

      return { deployment, modified: true };
    },
  );

  // Get cross-system enrichment context for a deployment
  app.get<{ Params: { id: string } }>(
    "/api/deployments/:id/context",
    { preHandler: [requirePermission("deployment.view")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const now = new Date();
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Count recent deployments to the same environment (only meaningful when environmentId is set)
      const recentDeploymentsToEnv = deployment.environmentId
        ? deployments.countByEnvironment(deployment.environmentId, twentyFourHoursAgo)
        : 0;

      // Check if the same artifact version was previously rolled back
      const previouslyRolledBack = deployment.version
        ? deployments.findByArtifactVersion(
            deployment.artifactId,
            deployment.version,
            "rolled_back",
          ).length > 0
        : false;

      // Check for other in-progress deployments to the same environment
      const conflictingDeployments = deployment.environmentId
        ? deployments.list()
            .filter(
              (d) =>
                d.environmentId === deployment.environmentId &&
                d.id !== deployment.id &&
                ((d.status as string) === "running" || (d.status as string) === "approved" || (d.status as string) === "awaiting_approval"),
            )
            .map((d) => d.id)
        : [];

      // Find last deployment to the same environment
      const lastDeploy = deployment.environmentId
        ? deployments.findLatestByEnvironment(deployment.environmentId)
        : undefined;
      const lastDeploymentToEnv = lastDeploy && lastDeploy.id !== deployment.id
        ? {
            id: lastDeploy.id,
            status: lastDeploy.status,
            version: lastDeploy.version,
            completedAt: lastDeploy.completedAt,
          }
        : undefined;

      const enrichment: DeploymentEnrichment = {
        recentDeploymentsToEnv,
        previouslyRolledBack,
        conflictingDeployments,
        lastDeploymentToEnv,
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
    "/api/deployments/:id/request-rollback-plan",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const finishedStatuses = new Set(["succeeded", "failed", "rolled_back"]);
      if (!finishedStatuses.has(deployment.status as string)) {
        return reply.status(409).send({
          error: `Cannot request rollback plan for deployment in "${deployment.status}" status — deployment must be finished`,
        });
      }

      const artifact = artifactStore.get(deployment.artifactId);
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

      // Build the list of completed steps from execution record (or plan as fallback)
      const completedSteps: Array<{
        description: string;
        action: string;
        target: string;
        status: "completed" | "failed" | "rolled_back";
        output?: string;
      }> = deployment.executionRecord?.steps.map((s) => ({
        description: s.description,
        action: deployment.plan?.steps.find((p) => p.description === s.description)?.action ?? "unknown",
        target: deployment.plan?.steps.find((p) => p.description === s.description)?.target ?? "",
        status: s.status,
        output: s.output ?? s.error,
      })) ?? deployment.plan?.steps.map((s) => ({
        description: s.description,
        action: s.action,
        target: s.target,
        status: "completed" as const,
      })) ?? [];

      const rollbackClient = new EnvoyClient(targetEnvoy.url);

      try {
        const rollbackPlan = await rollbackClient.requestRollbackPlan({
          deploymentId: deployment.id,
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
          version: deployment.version,
          failureReason: deployment.failureReason ?? undefined,
        });

        // Store the generated rollback plan on the deployment
        deployment.rollbackPlan = rollbackPlan;
        deployments.save(deployment);

        const actor = (request.user?.email) ?? "anonymous";

        debrief.record({
          partitionId: deployment.partitionId ?? null,
          deploymentId: deployment.id,
          agent: "command",
          decisionType: "plan-generation" as Parameters<typeof debrief.record>[0]["decisionType"],
          decision: `Rollback plan requested and generated for ${artifact.name} v${deployment.version}`,
          reasoning: rollbackPlan.reasoning,
          context: {
            requestedBy: actor,
            stepCount: rollbackPlan.steps.length,
            envoyId: targetEnvoy.id,
            deploymentStatus: deployment.status,
          },
          actor: request.user?.email,
        });
        telemetry.record({
          actor,
          action: "deployment.rollback-plan-requested" as Parameters<typeof telemetry.record>[0]["action"],
          target: { type: "deployment", id: deployment.id },
          details: { stepCount: rollbackPlan.steps.length },
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
    "/api/deployments/:id/execute-rollback",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      if (!deployment.rollbackPlan) {
        return reply.status(409).send({ error: "No rollback plan available — request one first" });
      }

      const finishedStatuses = new Set(["succeeded", "failed"]);
      if (!finishedStatuses.has(deployment.status as string)) {
        return reply.status(409).send({
          error: `Cannot execute rollback for deployment in "${deployment.status}" status`,
        });
      }

      const artifact = artifactStore.get(deployment.artifactId);
      const targetEnvoy = deployment.envoyId
        ? envoyRegistry?.get(deployment.envoyId)
        : envoyRegistry?.list()[0];

      if (!targetEnvoy) {
        return reply.status(503).send({ error: "No envoy available to execute rollback" });
      }

      const actor = (request.user?.email) ?? "anonymous";
      const serverPort = process.env.PORT ?? "3000";
      const serverUrl = process.env.SYNTH_SERVER_URL ?? `http://localhost:${serverPort}`;
      const progressCallbackUrl = `${serverUrl}/api/deployments/${deployment.id}/progress`;

      deployment.status = "running" as typeof deployment.status;
      deployments.save(deployment);

      debrief.record({
        partitionId: deployment.partitionId ?? null,
        deploymentId: deployment.id,
        agent: "command",
        decisionType: "rollback-execution" as Parameters<typeof debrief.record>[0]["decisionType"],
        decision: `Rollback execution initiated for ${artifact?.name ?? deployment.artifactId} v${deployment.version}`,
        reasoning: `Rollback requested by ${actor}. Executing ${deployment.rollbackPlan.steps.length} rollback step(s).`,
        context: { initiatedBy: actor, stepCount: deployment.rollbackPlan.steps.length },
        actor: request.user?.email,
      });
      telemetry.record({
        actor,
        action: "deployment.rollback-executed" as Parameters<typeof telemetry.record>[0]["action"],
        target: { type: "deployment", id: deployment.id },
        details: { stepCount: deployment.rollbackPlan.steps.length },
      });

      const rollbackClient = new EnvoyClient(targetEnvoy.url);

      // Execute the rollback plan as if it were a forward plan — it IS a forward plan
      // (just in the reverse direction). Use an empty no-op plan as the "rollback of rollback".
      const emptyPlan = { steps: [], reasoning: "No rollback of rollback." };

      rollbackClient.executeApprovedPlan({
        deploymentId: deployment.id,
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
          deploymentId: dep.id,
          agent: "command",
          decisionType: "rollback-execution" as Parameters<typeof debrief.record>[0]["decisionType"],
          decision: result.success
            ? `Rollback completed successfully for ${artifact?.name ?? dep.artifactId} v${dep.version}`
            : `Rollback failed for ${artifact?.name ?? dep.artifactId} v${dep.version}`,
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
    "/api/deployments/:id/retry",
    { preHandler: [requirePermission("deployment.create")] },
    async (request, reply) => {
      const source = deployments.get(request.params.id);
      if (!source) {
        return reply.status(404).send({ error: "Deployment not found" });
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
      const artifact = artifactStore.get(source.artifactId);
      if (!artifact) {
        return reply.status(404).send({ error: `Artifact not found: ${source.artifactId}` });
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
        artifactId: source.artifactId,
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
      telemetry.record({ actor, action: "deployment.created", target: { type: "deployment", id: deployment.id }, details: { artifactId: source.artifactId, environmentId: source.environmentId, partitionId: source.partitionId, envoyId: source.envoyId, retryOf: source.id } });

      // Record retry debrief entry
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        deploymentId: deployment.id,
        agent: "command",
        decisionType: "system",
        decision: `Retry of deployment ${source.id} (attempt #${attemptNumber})`,
        reasoning: `User initiated retry of deployment ${source.id}. Same artifact, version, environment, and partition.`,
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
            deploymentId: deployment.id,
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
            version: deployment.version,
            resolvedVariables: resolved,
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
                deploymentId: dep.id,
                agent: "envoy",
                decisionType: "plan-generation" as Parameters<typeof debrief.record>[0]["decisionType"],
                decision: `Deployment plan blocked — infrastructure prerequisites not met`,
                reasoning: result.blockReason ?? result.plan.reasoning,
                context: { stepCount: result.plan.steps.length, envoyId: planningEnvoy.id, blocked: true },
              });
            } else {
              dep.status = "awaiting_approval" as typeof dep.status;
              dep.recommendation = computeRecommendation(dep, deployments);
              deployments.save(dep);

              debrief.record({
                partitionId: dep.partitionId ?? null,
                deploymentId: dep.id,
                agent: "envoy",
                decisionType: "plan-generation" as Parameters<typeof debrief.record>[0]["decisionType"],
                decision: `Deployment plan generated with ${result.plan.steps.length} steps`,
                reasoning: result.plan.reasoning,
                context: { stepCount: result.plan.steps.length, envoyId: planningEnvoy.id, delta: result.delta },
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
              deploymentId: dep.id,
              agent: "command",
              decisionType: "deployment-failure" as Parameters<typeof debrief.record>[0]["decisionType"],
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
    "/api/deployments/:id/postmortem",
    { preHandler: [requirePermission("deployment.view")] },
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const entries = debrief.getByDeployment(deployment.id);
      const postmortem = generatePostmortem(entries, deployment);
      return { postmortem };
    },
  );

  // Get recent debrief entries (supports filtering by partition and decision type)
  app.get("/api/debrief", { preHandler: [requirePermission("deployment.view")] }, async (request) => {
    const qParsed = DebriefQuerySchema.safeParse(request.query);
    const { limit, partitionId, decisionType } = qParsed.success ? qParsed.data : {};

    const max = limit ?? 50;

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

  // ---------------------------------------------------------------------------
  // Progress streaming — envoy callback and SSE endpoints
  // ---------------------------------------------------------------------------

  // POST /api/deployments/:id/progress — receives progress events from envoy
  app.post<{ Params: { id: string } }>(
    "/api/deployments/:id/progress",
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
        return reply.status(400).send({ error: "Deployment ID in URL does not match event body" });
      }

      progressStore.push(event);
      return reply.status(200).send({ received: true });
    },
  );

  // GET /api/deployments/:id/stream — SSE endpoint for live progress
  // Auth is via ?token= query param since EventSource cannot send headers
  app.get<{ Params: { id: string } }>(
    "/api/deployments/:id/stream",
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
}

// ---------------------------------------------------------------------------
// Recommendation engine — synthesizes enrichment context into a verdict
// ---------------------------------------------------------------------------

function computeRecommendation(
  deployment: import("@synth-deploy/core").Deployment,
  store: IDeploymentStore,
): import("@synth-deploy/core").DeploymentRecommendation {
  const factors: string[] = [];
  let verdict: RecommendationVerdict = "proceed";

  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Check for previously rolled-back version
  if (deployment.version) {
    const rolledBack = store.findByArtifactVersion(
      deployment.artifactId,
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
        ((d.status as string) === "running" || (d.status as string) === "approved"),
    );
    if (conflicting.length > 0) {
      verdict = "hold";
      factors.push(`${conflicting.length} other deployment(s) in progress for this environment`);
    }
  }

  // Check deployment frequency
  const recentCount = deployment.environmentId
    ? store.countByEnvironment(deployment.environmentId, twentyFourHoursAgo)
    : 0;
  if (recentCount > 5) {
    if (verdict === "proceed") verdict = "caution";
    factors.push(`High deployment frequency: ${recentCount} deployments in the last 24h`);
  }

  // Check last deployment status
  const lastDeploy = deployment.environmentId
    ? store.findLatestByEnvironment(deployment.environmentId)
    : undefined;
  if (lastDeploy && lastDeploy.id !== deployment.id) {
    if ((lastDeploy.status as string) === "failed" || (lastDeploy.status as string) === "rolled_back") {
      if (verdict === "proceed") verdict = "caution";
      factors.push(`Last deployment to this environment ${lastDeploy.status}`);
    } else if ((lastDeploy.status as string) === "succeeded") {
      factors.push("Last deployment to this environment succeeded");
    }
  }

  if (factors.length === 0) {
    factors.push("No risk factors detected — target is stable");
  }

  const summaryMap: Record<RecommendationVerdict, string> = {
    proceed: "Proceed — no conflicting deployments, target environment is stable",
    caution: "Proceed with caution — review risk factors before greenlighting",
    hold: "Hold — resolve conflicting deployments before proceeding",
  };

  return { verdict, summary: summaryMap[verdict], factors };
}
