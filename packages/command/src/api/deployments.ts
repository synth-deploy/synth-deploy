import type { FastifyInstance } from "fastify";
import { generatePostmortem } from "@deploystack/core";
import type { IPartitionStore, IEnvironmentStore, IArtifactStore, ISettingsStore, IDeploymentStore, ITelemetryStore, DebriefWriter, DebriefReader } from "@deploystack/core";
import { requirePermission } from "../middleware/permissions.js";
import {
  CreateDeploymentSchema,
  ApproveDeploymentSchema,
  RejectDeploymentSchema,
  ModifyDeploymentPlanSchema,
  DeploymentListQuerySchema,
  DebriefQuerySchema,
} from "./schemas.js";

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
): void {
  // Create a deployment (plan phase)
  app.post("/api/deployments", { preHandler: [requirePermission("deployment.create")] }, async (request, reply) => {
    const parsed = CreateDeploymentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const { artifactId, environmentId, partitionId, version } = parsed.data;

    // Validate artifact exists
    const artifact = artifactStore.get(artifactId);
    if (!artifact) {
      return reply.status(404).send({ error: `Artifact not found: ${artifactId}` });
    }

    // Validate environment exists
    const environment = environments.get(environmentId);
    if (!environment) {
      return reply.status(404).send({ error: `Environment not found: ${environmentId}` });
    }

    // Validate partition if provided
    if (partitionId) {
      const partition = partitions.get(partitionId);
      if (!partition) {
        return reply.status(404).send({ error: `Partition not found: ${partitionId}` });
      }
    }

    // Resolve variables
    const envVars = environment.variables;
    const partitionVars = partitionId ? (partitions.get(partitionId)?.variables ?? {}) : {};
    const resolved: Record<string, string> = { ...partitionVars, ...envVars };

    const deployment = {
      id: crypto.randomUUID(),
      artifactId,
      environmentId,
      partitionId,
      version: version ?? "",
      status: "pending" as const,
      variables: resolved,
      debriefEntryIds: [] as string[],
      createdAt: new Date(),
    };

    deployments.save(deployment);
    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "deployment.created", target: { type: "deployment", id: deployment.id }, details: { artifactId, environmentId, partitionId } });

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

  // List deployments (optionally filtered by partition or artifact)
  app.get("/api/deployments", { preHandler: [requirePermission("deployment.view")] }, async (request) => {
    const qParsed = DeploymentListQuerySchema.safeParse(request.query);
    const { partitionId, artifactId } = qParsed.success ? qParsed.data : {};

    let list;
    if (partitionId) {
      list = deployments.getByPartition(partitionId);
    } else if (artifactId) {
      list = deployments.getByArtifact(artifactId);
    } else {
      list = deployments.list();
    }

    return { deployments: list };
  });

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

      // Transition deployment status
      deployment.status = "rejected" as typeof deployment.status;
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

      // Store the previous plan diff for audit trail
      const previousStepSummary = deployment.plan.steps.map((s) => s.description).join("; ");

      // Apply modifications
      deployment.plan = {
        ...deployment.plan,
        steps: parsed.data.steps,
        diffFromPreviousPlan: `Modified from: ${previousStepSummary}`,
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

      // Count recent deployments to the same environment
      const recentDeploymentsToEnv = deployments.countByEnvironment(
        deployment.environmentId,
        twentyFourHoursAgo,
      );

      // Check if the same artifact version was previously rolled back
      const previouslyRolledBack = deployment.version
        ? deployments.findByArtifactVersion(
            deployment.artifactId,
            deployment.version,
            "rolled_back",
          ).length > 0
        : false;

      // Check for other in-progress deployments to the same environment
      const allEnvDeployments = deployments.list().filter(
        (d) =>
          d.environmentId === deployment.environmentId &&
          d.id !== deployment.id &&
          ((d.status as string) === "running" || (d.status as string) === "approved" || (d.status as string) === "awaiting_approval"),
      );
      const conflictingDeployments = allEnvDeployments.map((d) => d.id);

      // Find last deployment to the same environment
      const lastDeploy = deployments.findLatestByEnvironment(deployment.environmentId);
      const lastDeploymentToEnv = lastDeploy && lastDeploy.id !== deployment.id
        ? {
            id: lastDeploy.id,
            status: lastDeploy.status,
            version: lastDeploy.version,
            completedAt: lastDeploy.completedAt,
          }
        : undefined;

      const enrichment = {
        recentDeploymentsToEnv,
        previouslyRolledBack,
        conflictingDeployments,
        lastDeploymentToEnv,
      };

      return { enrichment };
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
}
