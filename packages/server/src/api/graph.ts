import type { FastifyInstance } from "fastify";
import type { IArtifactStore } from "@synth-deploy/core";
import type { DeploymentPlan } from "@synth-deploy/core";
import type { DebriefWriter } from "@synth-deploy/core";
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
  debrief: DebriefWriter,
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

      // Record debrief entry for graph creation with inference reasoning
      debrief.record({
        partitionId: graph.partitionId ?? null,
        operationId: null,
        agent: "server",
        decisionType: "plan-generation",
        decision: `Created deployment graph "${graph.name}" with ${graph.nodes.length} nodes and ${graph.edges.length} edges`,
        reasoning: `Inferred dependency graph for artifacts: ${body.artifactIds.join(", ")}. Edges: ${JSON.stringify(graph.edges.map((e) => `${e.from} -[${e.type}]-> ${e.to}`))}`,
        context: {
          graphId: graph.id,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          approvalMode: graph.approvalMode,
          edges: graph.edges,
        },
      });

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

      // Record debrief entry for user corrections
      debrief.record({
        partitionId: graph.partitionId ?? null,
        operationId: null,
        agent: "server",
        decisionType: "plan-modification",
        decision: `User corrected deployment graph "${graph.name}"`,
        reasoning: `Updated fields: ${Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined).join(", ")}`,
        context: {
          graphId: id,
          updatedFields: Object.keys(body).filter(
            (k) => body[k as keyof typeof body] !== undefined,
          ),
        },
      });

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
        partitionVariables?: Record<string, string>;
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
      const dataFlowValues: Record<string, Record<string, string>> = {};

      // Execute and collect results
      // (In a production system this would be async with SSE/WebSocket progress,
      //  but for now we run synchronously and return the final state.)
      try {
        for await (const event of executor.execute(
          graph,
          plansMap,
          body.partitionVariables,
        )) {
          events.push(event as unknown as Record<string, unknown>);

          // Update node status in store
          if (event.nodeId) {
            if (event.type === "node-started") {
              graphStore.updateNode(id, event.nodeId, { status: "executing" });
            } else if (event.type === "node-completed") {
              graphStore.updateNode(id, event.nodeId, { status: "completed" });
              if (event.outputCapture) {
                dataFlowValues[event.nodeId] = event.outputCapture;
              }
            } else if (event.type === "node-failed") {
              graphStore.updateNode(id, event.nodeId, { status: "failed" });
            } else if (event.type === "node-skipped") {
              // Skipped nodes remain in "pending" status — they were never started
              graphStore.updateNode(id, event.nodeId, { status: "pending" });
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

      // Record debrief summary for execution completion
      const finalCompletedCount =
        finalGraph?.nodes.filter((n) => n.status === "completed").length ?? 0;
      const finalFailedCount =
        finalGraph?.nodes.filter((n) => n.status === "failed").length ?? 0;

      debrief.record({
        partitionId: graph.partitionId ?? null,
        operationId: null,
        agent: "server",
        decisionType:
          finalFailedCount > 0 ? "deployment-failure" : "deployment-completion",
        decision: `Graph "${graph.name}" execution ${finalFailedCount > 0 ? "failed" : "completed"}: ${finalCompletedCount}/${graph.nodes.length} nodes succeeded`,
        reasoning: `Executed deployment graph with ${graph.nodes.length} nodes. ${finalCompletedCount} completed, ${finalFailedCount} failed. Data flow values captured for ${Object.keys(dataFlowValues).length} nodes.`,
        context: {
          graphId: id,
          completedCount: finalCompletedCount,
          failedCount: finalFailedCount,
          totalNodes: graph.nodes.length,
          dataFlowValues,
          partitionVariables: body.partitionVariables,
        },
      });

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

      const existingNode = graph.nodes.find((n) => n.id === nodeId);
      if (!existingNode) {
        return reply.status(404).send({ error: "Node not found" });
      }

      if (existingNode.status !== "awaiting_approval") {
        return reply.status(409).send({
          error: `Node is not awaiting approval (current status: ${existingNode.status})`,
        });
      }

      // Mark as approved (ready to execute)
      const node = graphStore.updateNode(id, nodeId, { status: "pending" });

      return { node };
    },
  );

  // Approve remaining nodes — switch from per-node to graph approval mid-execution
  app.post(
    "/api/deployment-graphs/:id/approve-remaining",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const graph = graphStore.getById(id);
      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      if (graph.status !== "executing" && graph.status !== "awaiting_approval") {
        return reply.status(409).send({
          error: `Cannot approve remaining in status: ${graph.status}`,
        });
      }

      graphStore.update(id, { approvalMode: "graph" });

      return { graph: graphStore.getById(id) };
    },
  );

  // Retry a failed node
  app.post(
    "/api/deployment-graphs/:id/nodes/:nodeId/retry",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const { id, nodeId } = request.params as { id: string; nodeId: string };

      const graph = graphStore.getById(id);
      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      if (graph.status !== "failed") {
        return reply.status(409).send({
          error: `Cannot retry node when graph status is: ${graph.status}`,
        });
      }

      const existingNode = graph.nodes.find((n) => n.id === nodeId);
      if (!existingNode) {
        return reply.status(404).send({ error: "Node not found" });
      }

      if (existingNode.status !== "failed") {
        return reply.status(409).send({
          error: `Node is not in failed status (current status: ${existingNode.status})`,
        });
      }

      // Re-queue for execution
      const node = graphStore.updateNode(id, nodeId, { status: "pending" });

      return { node };
    },
  );

  // Skip a failed node — allows downstream to proceed
  app.post(
    "/api/deployment-graphs/:id/nodes/:nodeId/skip",
    { preHandler: [requirePermission("deployment.approve")] },
    async (request, reply) => {
      const { id, nodeId } = request.params as { id: string; nodeId: string };

      const graph = graphStore.getById(id);
      if (!graph) {
        return reply.status(404).send({ error: "Deployment graph not found" });
      }

      if (graph.status !== "failed") {
        return reply.status(409).send({
          error: `Cannot skip node when graph status is: ${graph.status}`,
        });
      }

      const existingNode = graph.nodes.find((n) => n.id === nodeId);
      if (!existingNode) {
        return reply.status(404).send({ error: "Node not found" });
      }

      if (existingNode.status !== "failed") {
        return reply.status(409).send({
          error: `Node is not in failed status (current status: ${existingNode.status})`,
        });
      }

      // Mark as completed (skipped) so downstream nodes can proceed
      const node = graphStore.updateNode(id, nodeId, { status: "completed" });

      // Set graph back to awaiting_approval so it can be re-executed
      graphStore.updateStatus(id, "awaiting_approval");

      return { node, skipped: true, graph: graphStore.getById(id) };
    },
  );
}
