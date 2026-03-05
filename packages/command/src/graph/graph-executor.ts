import type {
  DeploymentGraph,
  DeploymentGraphNode,
  DeploymentGraphEdge,
  DeploymentPlan,
} from "@deploystack/core";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";
import type { EnvoyClient, EnvoyDeployResult } from "../agent/envoy-client.js";

// ---------------------------------------------------------------------------
// Progress events emitted during graph execution
// ---------------------------------------------------------------------------

export interface GraphProgressEvent {
  type:
    | "node-started"
    | "node-completed"
    | "node-failed"
    | "graph-completed"
    | "graph-failed";
  nodeId?: string;
  graphId: string;
  progress: {
    completed: number;
    total: number;
    executing: number;
    failed: number;
  };
  outputCapture?: Record<string, string>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Topological sort — Kahn's algorithm
// ---------------------------------------------------------------------------

export function topologicalSort(
  nodes: DeploymentGraphNode[],
  edges: DeploymentGraphEdge[],
): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    adjacency.get(edge.from)?.push(edge.to);
  }

  const queue = nodes
    .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id);
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  if (result.length !== nodes.length) {
    throw new Error(
      "Cycle detected in deployment graph — topological sort is impossible",
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// GraphExecutor — sequential execution in topological order
// ---------------------------------------------------------------------------

export class GraphExecutor {
  constructor(
    private envoyRegistry: EnvoyRegistry,
    private createClient: (url: string, timeoutMs: number) => EnvoyClient,
  ) {}

  /**
   * Execute a deployment graph sequentially in topological order.
   * Yields progress events as each node starts, completes, or fails.
   * On failure, halts downstream nodes (they remain pending).
   */
  async *execute(
    graph: DeploymentGraph,
    plans: Map<string, DeploymentPlan>,
  ): AsyncGenerator<GraphProgressEvent> {
    const sorted = topologicalSort(graph.nodes, graph.edges);
    const completed = new Map<string, Record<string, string>>();
    let completedCount = 0;
    let failedCount = 0;

    for (const nodeId of sorted) {
      const node = graph.nodes.find((n) => n.id === nodeId)!;

      // Resolve input bindings from completed upstream outputs
      const resolvedVars: Record<string, string> = {};
      for (const binding of node.inputBindings ?? []) {
        const upstreamOutputs = completed.get(binding.sourceNodeId);
        if (upstreamOutputs?.[binding.sourceOutputName]) {
          resolvedVars[binding.variable] =
            upstreamOutputs[binding.sourceOutputName];
          binding.resolvedValue = upstreamOutputs[binding.sourceOutputName];
        }
      }

      yield {
        type: "node-started",
        nodeId,
        graphId: graph.id,
        progress: {
          completed: completedCount,
          total: graph.nodes.length,
          executing: 1,
          failed: failedCount,
        },
      };

      const entry = this.envoyRegistry.get(node.envoyId);
      if (!entry) {
        failedCount++;
        yield {
          type: "node-failed",
          nodeId,
          graphId: graph.id,
          error: `Envoy not found: ${node.envoyId}`,
          progress: {
            completed: completedCount,
            total: graph.nodes.length,
            executing: 0,
            failed: failedCount,
          },
        };
        break;
      }

      const plan = plans.get(nodeId);
      if (!plan) {
        failedCount++;
        yield {
          type: "node-failed",
          nodeId,
          graphId: graph.id,
          error: `No plan found for node: ${nodeId}`,
          progress: {
            completed: completedCount,
            total: graph.nodes.length,
            executing: 0,
            failed: failedCount,
          },
        };
        break;
      }

      const client = this.createClient(entry.url, 60_000);

      try {
        // Inject resolved variables into the plan's reasoning for traceability
        const enrichedPlan: DeploymentPlan = Object.keys(resolvedVars).length > 0
          ? {
              ...plan,
              reasoning: `${plan.reasoning}\n\nResolved variables from upstream: ${JSON.stringify(resolvedVars)}`,
            }
          : plan;

        const result: EnvoyDeployResult = await client.executeApprovedPlan({
          deploymentId: node.deploymentId ?? nodeId,
          plan: enrichedPlan,
          rollbackPlan: { steps: [], reasoning: "No rollback plan provided" },
          artifactType: "graph-node",
          artifactName: node.artifactId,
          environmentId: "",
        });

        // Capture outputs from step results
        const outputs: Record<string, string> = {};
        for (const binding of node.outputBindings ?? []) {
          if (
            binding.source === "plan_step_output" &&
            binding.stepIndex != null &&
            binding.outputKey
          ) {
            const stepResult = result.debriefEntries?.[binding.stepIndex];
            if (stepResult) {
              outputs[binding.name] = String(
                (stepResult.context as Record<string, unknown>)?.[binding.outputKey] ?? "",
              );
            }
          } else if (binding.source === "manual" && binding.value) {
            outputs[binding.name] = binding.value;
          }
        }

        completed.set(nodeId, outputs);
        completedCount++;

        yield {
          type: "node-completed",
          nodeId,
          graphId: graph.id,
          outputCapture: outputs,
          progress: {
            completed: completedCount,
            total: graph.nodes.length,
            executing: 0,
            failed: failedCount,
          },
        };
      } catch (err) {
        failedCount++;
        const message = err instanceof Error ? err.message : String(err);
        yield {
          type: "node-failed",
          nodeId,
          graphId: graph.id,
          error: message,
          progress: {
            completed: completedCount,
            total: graph.nodes.length,
            executing: 0,
            failed: failedCount,
          },
        };
        // Halt downstream nodes
        break;
      }
    }

    if (failedCount === 0) {
      yield {
        type: "graph-completed",
        graphId: graph.id,
        progress: {
          completed: completedCount,
          total: graph.nodes.length,
          executing: 0,
          failed: 0,
        },
      };
    } else {
      yield {
        type: "graph-failed",
        graphId: graph.id,
        progress: {
          completed: completedCount,
          total: graph.nodes.length,
          executing: 0,
          failed: failedCount,
        },
      };
    }
  }

  /**
   * Rollback completed nodes in reverse topological order.
   * Only rolls back nodes that completed successfully.
   */
  async *rollback(
    graph: DeploymentGraph,
    rollbackPlans: Map<string, DeploymentPlan>,
  ): AsyncGenerator<GraphProgressEvent> {
    const sorted = topologicalSort(graph.nodes, graph.edges).reverse();
    let rolledBack = 0;
    let rollbackFailed = 0;

    for (const nodeId of sorted) {
      const node = graph.nodes.find((n) => n.id === nodeId)!;
      if (node.status !== "completed") continue;

      const plan = rollbackPlans.get(nodeId);
      if (!plan) continue;

      const entry = this.envoyRegistry.get(node.envoyId);
      if (!entry) continue;

      const client = this.createClient(entry.url, 60_000);

      try {
        await client.executeApprovedPlan({
          deploymentId: node.deploymentId ?? nodeId,
          plan,
          rollbackPlan: { steps: [], reasoning: "Rollback of rollback not supported" },
          artifactType: "graph-node-rollback",
          artifactName: node.artifactId,
          environmentId: "",
        });
        rolledBack++;
      } catch {
        rollbackFailed++;
      }
    }

    yield {
      type: rollbackFailed === 0 ? "graph-completed" : "graph-failed",
      graphId: graph.id,
      progress: {
        completed: rolledBack,
        total: graph.nodes.filter((n) => n.status === "completed").length,
        executing: 0,
        failed: rollbackFailed,
      },
    };
  }
}
