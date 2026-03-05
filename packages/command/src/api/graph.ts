import type { FastifyInstance } from "fastify";
import type { IArtifactStore } from "@deploystack/core";
import type { DeploymentPlan } from "@deploystack/core";
import { requirePermission } from "../middleware/permissions.js";
import type { DeploymentGraphStore } from "../graph/graph-store.js";
import type { GraphInferenceEngine } from "../graph/graph-inference.js";
import { GraphExecutor } from "../graph/graph-executor.js";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";
import { EnvoyClient } from "../agent/envoy-client.js";

// ---------------------------------------------------------------------------
// Deployment Graph API routes
// ---------------------------------------------------------------------------

export function registerGraphRoutes(
  app: FastifyInstance,
  graphStore: DeploymentGraphStore,
  inferenceEngine: GraphInferenceEngine,
  envoyRegistry: EnvoyRegistry,
  artifactStore: IArtifactStore,
): void {
  // Create a deployment graph (triggers inference)
  app.post(
    "/api/deployment-graphs",
    { preHandler: [requirePermission("deployment.create")] },
    async (request, reply) => {
      const body = request.body as {
        name?: string;
        artifactIds: string[];
        envoyAssignments: Record<string, string>;
        partitionId?: string;
        approvalMode?: "per-node" | "graph";
      };

      if (!body.artifactIds || body.artifactIds.length === 0) {
        return reply
          .status(400)
          .send({ error: "artifactIds is required and must not be empty" });
      }

      if (!body.envoyAssignments || Object.keys(body.envoyAssignments).length === 0) {
        return reply
          .status(400)
          .send({ error: "envoyAssignments is required" });
      }

      // Validate all artifacts exist
      for (const artifactId of body.artifactIds) {
        if (!artifactStore.get(artifactId)) {
          return reply
            .status(404)
            .send({ error: `Artifact not found: ${artifactId}` });
        }
      }

      // Validate all assigned envoys exist
      for (const [artifactId, envoyId] of Object.entries(body.envoyAssignments)) {
        if (!envoyRegistry.get(envoyId)) {
          return reply
            .status(404)
            .send({
              error: `Envoy not found: ${envoyId} (assigned to artifact ${artifactId})`,
            });
        }
      }

      // Infer the graph structure using LLM (or flat fallback)
      const graph = await inferenceEngine.inferGraph({
        artifactIds: body.artifactIds,
        envoyAssignments: body.envoyAssignments,
        partitionId: body.partitionId,
        graphName: body.name,
      });

      if (body.approvalMode) {
        graph.approvalMode = body.approvalMode;
      }

      graphStore.create(graph);

      return reply.status(201).send({ graph });
    },
  );

  // List all deployment graphs
  app.get(
    "/api/deployment-graphs",
    { preHandler: [requirePermission("deployment.view")] },
    async () => {
      return { graphs: graphStore.list() };
    },
  );

  // Get a specific deployment graph with node statuses
  app.get(
    "/api/deployment-graphs/:id",
    { preHandler: [requirePermission("deployment.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const graph = graphStore.getById(id);

      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      // Enrich with artifact names for display
      const enrichedNodes = graph.nodes.map((node) => {
        const artifact = artifactStore.get(node.artifactId);
        const envoy = envoyRegistry.get(node.envoyId);
        return {
          ...node,
          artifactName: artifact?.name ?? node.artifactId,
          envoyName: envoy?.name ?? node.envoyId,
        };
      });

      return { graph: { ...graph, nodes: enrichedNodes } };
    },
  );

  // Update a deployment graph (user corrections to inferred structure)
  app.put(
    "/api/deployment-graphs/:id",
    { preHandler: [requirePermission("deployment.create")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const graph = graphStore.getById(id);
      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      const body = request.body as {
        name?: string;
        nodes?: typeof graph.nodes;
        edges?: typeof graph.edges;
        approvalMode?: "per-node" | "graph";
      };

      if (graph.status !== "draft" && graph.status !== "awaiting_approval") {
        return reply
          .status(409)
          .send({ error: `Cannot modify graph in status: ${graph.status}` });
      }

      const updated = graphStore.update(id, body);
      return { graph: updated };
    },
  );

  // Delete a deployment graph
  app.delete(
    "/api/deployment-graphs/:id",
    { preHandler: [requirePermission("deployment.create")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const graph = graphStore.getById(id);
      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      if (graph.status === "executing") {
        return reply
          .status(409)
          .send({ error: "Cannot delete a graph that is currently executing" });
      }

      graphStore.delete(id);
      return reply.status(204).send();
    },
  );

  // Execute a deployment graph
  app.post(
    "/api/deployment-graphs/:id/execute",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        plans: Record<string, DeploymentPlan>; // nodeId -> plan
      };

      const graph = graphStore.getById(id);
      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      if (
        graph.status !== "draft" &&
        graph.status !== "awaiting_approval"
      ) {
        return reply
          .status(409)
          .send({ error: `Cannot execute graph in status: ${graph.status}` });
      }

      if (!body.plans || Object.keys(body.plans).length === 0) {
        return reply
          .status(400)
          .send({ error: "plans map (nodeId -> DeploymentPlan) is required" });
      }

      // Validate all nodes have plans
      const missingPlans = graph.nodes
        .filter((n) => !body.plans[n.id])
        .map((n) => n.id);
      if (missingPlans.length > 0) {
        return reply.status(400).send({
          error: `Missing plans for nodes: ${missingPlans.join(", ")}`,
        });
      }

      graphStore.updateStatus(id, "executing");

      const executor = new GraphExecutor(
        envoyRegistry,
        (url, timeoutMs) => new EnvoyClient(url, timeoutMs),
      );

      const plansMap = new Map(Object.entries(body.plans));
      const events: Array<Record<string, unknown>> = [];

      // Execute and collect results
      // (In a production system this would be async with SSE/WebSocket progress,
      //  but for now we run synchronously and return the final state.)
      try {
        for await (const event of executor.execute(graph, plansMap)) {
          events.push(event as unknown as Record<string, unknown>);

          // Update node status in store
          if (event.nodeId) {
            if (event.type === "node-started") {
              graphStore.updateNode(id, event.nodeId, { status: "executing" });
            } else if (event.type === "node-completed") {
              graphStore.updateNode(id, event.nodeId, { status: "completed" });
            } else if (event.type === "node-failed") {
              graphStore.updateNode(id, event.nodeId, { status: "failed" });
            }
          }

          if (event.type === "graph-completed") {
            graphStore.updateStatus(id, "completed");
          } else if (event.type === "graph-failed") {
            graphStore.updateStatus(id, "failed");
          }
        }
      } catch (err) {
        graphStore.updateStatus(id, "failed");
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message, events });
      }

      const finalGraph = graphStore.getById(id);
      return { graph: finalGraph, events };
    },
  );

  // Rollback a deployment graph
  app.post(
    "/api/deployment-graphs/:id/rollback",
    { preHandler: [requirePermission("deployment.rollback")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        rollbackPlans: Record<string, DeploymentPlan>;
      };

      const graph = graphStore.getById(id);
      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      if (graph.status !== "completed" && graph.status !== "failed") {
        return reply.status(409).send({
          error: `Cannot rollback graph in status: ${graph.status}`,
        });
      }

      if (!body.rollbackPlans || Object.keys(body.rollbackPlans).length === 0) {
        return reply
          .status(400)
          .send({ error: "rollbackPlans map is required" });
      }

      graphStore.updateStatus(id, "executing");

      const executor = new GraphExecutor(
        envoyRegistry,
        (url, timeoutMs) => new EnvoyClient(url, timeoutMs),
      );

      const rollbackMap = new Map(Object.entries(body.rollbackPlans));
      const events: Array<Record<string, unknown>> = [];

      try {
        for await (const event of executor.rollback(graph, rollbackMap)) {
          events.push(event as unknown as Record<string, unknown>);
        }
      } catch {
        // Rollback errors are non-fatal — we still update status
      }

      graphStore.updateStatus(id, "rolled_back");
      const finalGraph = graphStore.getById(id);
      return { graph: finalGraph, events };
    },
  );

  // Per-node approval (for per-node approval mode)
  app.post(
    "/api/deployment-graphs/:id/nodes/:nodeId/approve",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const { id, nodeId } = request.params as { id: string; nodeId: string };

      const graph = graphStore.getById(id);
      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      if (graph.approvalMode !== "per-node") {
        return reply.status(409).send({
          error: "Graph is not in per-node approval mode",
        });
      }

      const node = graphStore.updateNode(id, nodeId, {
        status: "awaiting_approval",
      });
      if (!node) {
        return reply.status(404).send({ error: "Node not found" });
      }

      // Mark as approved (ready to execute)
      graphStore.updateNode(id, nodeId, { status: "pending" });

      return { node };
    },
  );
}
