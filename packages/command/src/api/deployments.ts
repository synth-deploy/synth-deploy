import type { FastifyInstance } from "fastify";
import { generatePostmortem } from "@deploystack/core";
import type { IPartitionStore, IEnvironmentStore, IArtifactStore, ISettingsStore, IDeploymentStore, DebriefWriter, DebriefReader } from "@deploystack/core";
import {
  CreateDeploymentSchema,
  ApproveDeploymentSchema,
  RejectDeploymentSchema,
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
): void {
  // Create a deployment (plan phase)
  app.post("/api/deployments", async (request, reply) => {
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

    return reply.status(201).send({ deployment });
  });

  // Get deployment by ID
  app.get<{ Params: { id: string } }>("/api/deployments/:id", async (request, reply) => {
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
  app.get("/api/deployments", async (request) => {
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
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const parsed = ApproveDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      // Record approval in debrief
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        deploymentId: deployment.id,
        agent: "command",
        decisionType: "system",
        decision: `Deployment approved by ${parsed.data.approvedBy}`,
        reasoning: parsed.data.modifications
          ? `Approved with modifications: ${parsed.data.modifications}`
          : "Approved without modifications",
        context: { approvedBy: parsed.data.approvedBy },
      });

      return { deployment, approved: true };
    },
  );

  // Reject a deployment plan
  app.post<{ Params: { id: string } }>(
    "/api/deployments/:id/reject",
    async (request, reply) => {
      const deployment = deployments.get(request.params.id);
      if (!deployment) {
        return reply.status(404).send({ error: "Deployment not found" });
      }

      const parsed = RejectDeploymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      // Record rejection in debrief
      debrief.record({
        partitionId: deployment.partitionId ?? null,
        deploymentId: deployment.id,
        agent: "command",
        decisionType: "system",
        decision: "Deployment plan rejected",
        reasoning: parsed.data.reason,
        context: { reason: parsed.data.reason },
      });

      return { deployment, rejected: true };
    },
  );

  // Get deployment postmortem
  app.get<{ Params: { id: string } }>(
    "/api/deployments/:id/postmortem",
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
  app.get("/api/debrief", async (request) => {
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
