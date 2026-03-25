import type {
  DeploymentGraph,
  DeploymentGraphNode,
  DeploymentGraphEdge,
  DeploymentPlan,
} from "@synth-deploy/core";
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
    | "node-skipped"
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
// Depth computation — group nodes by distance from roots for parallel exec
// ---------------------------------------------------------------------------

export function computeDepths(
  nodes: DeploymentGraphNode[],
  edges: DeploymentGraphEdge[],
): Map<string, number> {
  const depths = new Map<string, number>();
  const inEdges = new Map<string, string[]>(); // nodeId -> list of "from" nodeIds
  for (const node of nodes) {
    depths.set(node.id, 0);
    inEdges.set(node.id, []);
  }
  for (const edge of edges) {
    inEdges.get(edge.to)?.push(edge.from);
  }
  // BFS to compute max depth
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      const parents = inEdges.get(node.id) ?? [];
      const maxParent = Math.max(0, ...parents.map((p) => depths.get(p) ?? 0));
      const newDepth = parents.length > 0 ? maxParent + 1 : 0;
      if (newDepth > (depths.get(node.id) ?? 0)) {
        depths.set(node.id, newDepth);
        changed = true;
      }
    }
  }
  return depths;
}

// ---------------------------------------------------------------------------
// Downstream node computation — find all transitive dependents of a node
// ---------------------------------------------------------------------------

function getDownstreamNodeIds(
  nodeId: string,
  edges: DeploymentGraphEdge[],
): Set<string> {
  const downstream = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from)!.push(edge.to);
  }

  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of adjacency.get(current) ?? []) {
      if (!downstream.has(child)) {
        downstream.add(child);
        queue.push(child);
      }
    }
  }
  return downstream;
}

// ---------------------------------------------------------------------------
// GraphExecutor — depth-based parallel execution
// ---------------------------------------------------------------------------

export class GraphExecutor {
  constructor(
    private envoyRegistry: EnvoyRegistry,
    private createClient: (url: string, timeoutMs: number) => EnvoyClient,
  ) {}

  /**
   * Execute a deployment graph with depth-based parallelism.
   * Nodes at the same depth run concurrently via Promise.allSettled().
   * If a node fails, all its downstream dependents are skipped,
   * but sibling nodes at the same depth continue executing.
   */
  async *execute(
    graph: DeploymentGraph,
    plans: Map<string, DeploymentPlan>,
    partitionVariables?: Record<string, string>,
  ): AsyncGenerator<GraphProgressEvent> {
    // Validate topological order (detects cycles)
    topologicalSort(graph.nodes, graph.edges);

    const depths = computeDepths(graph.nodes, graph.edges);
    const completed = new Map<string, Record<string, string>>();
    let completedCount = 0;
    let failedCount = 0;
    const skippedNodes = new Set<string>();

    // Group nodes by depth
    const maxDepth = Math.max(0, ...Array.from(depths.values()));
    const depthGroups: DeploymentGraphNode[][] = [];
    for (let d = 0; d <= maxDepth; d++) {
      depthGroups.push(
        graph.nodes.filter((n) => (depths.get(n.id) ?? 0) === d),
      );
    }

    for (const group of depthGroups) {
      // Filter out nodes that should be skipped (downstream of failed nodes)
      const executableNodes = group.filter((n) => !skippedNodes.has(n.id));

      if (executableNodes.length === 0) continue;

      // Collect events from parallel execution, then yield them after
      const levelEvents: GraphProgressEvent[] = [];
      const executingCount = executableNodes.length;

      // Execute all nodes at this depth concurrently
      const results = await Promise.allSettled(
        executableNodes.map(async (node) => {
          // Resolve input bindings from completed upstream outputs
          const resolvedVars: Record<string, string> = {};

          // Merge partition variables first (input bindings override)
          if (partitionVariables) {
            Object.assign(resolvedVars, partitionVariables);
          }

          for (const binding of node.inputBindings ?? []) {
            const upstreamOutputs = completed.get(binding.sourceNodeId);
            if (upstreamOutputs?.[binding.sourceOutputName]) {
              resolvedVars[binding.variable] =
                upstreamOutputs[binding.sourceOutputName];
              binding.resolvedValue =
                upstreamOutputs[binding.sourceOutputName];
            }
          }

          levelEvents.push({
            type: "node-started",
            nodeId: node.id,
            graphId: graph.id,
            progress: {
              completed: completedCount,
              total: graph.nodes.length,
              executing: executingCount,
              failed: failedCount,
            },
          });

          const entry = this.envoyRegistry.get(node.envoyId);
          if (!entry) {
            throw new Error(`Envoy not found: ${node.envoyId}`);
          }

          const plan = plans.get(node.id);
          if (!plan) {
            throw new Error(`No plan found for node: ${node.id}`);
          }

          const client = this.createClient(entry.url, 60_000);

          // Inject resolved variables into the plan's reasoning for traceability
          const enrichedPlan: DeploymentPlan =
            Object.keys(resolvedVars).length > 0
              ? {
                  ...plan,
                  reasoning: `${plan.reasoning}\n\nResolved variables from upstream: ${JSON.stringify(resolvedVars)}`,
                }
              : plan;

          const result: EnvoyDeployResult = await client.executeApprovedPlan({
            operationId: node.deploymentId ?? node.id,
            plan: enrichedPlan,
            rollbackPlan: {
              scriptedPlan: {
                platform: "bash",
                executionScript: "# No rollback plan provided",
                dryRunScript: null,
                rollbackScript: null,
                reasoning: "No rollback plan provided",
                stepSummary: [],
              },
              reasoning: "No rollback plan provided",
            },
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
                  (stepResult.context as Record<string, unknown>)?.[
                    binding.outputKey
                  ] ?? "",
                );
              }
            } else if (binding.source === "manual" && binding.value) {
              outputs[binding.name] = binding.value;
            }
          }

          return { nodeId: node.id, outputs };
        }),
      );

      // Process results: update state and collect events
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const node = executableNodes[i];

        if (result.status === "fulfilled") {
          completed.set(result.value.nodeId, result.value.outputs);
          completedCount++;

          levelEvents.push({
            type: "node-completed",
            nodeId: node.id,
            graphId: graph.id,
            outputCapture: result.value.outputs,
            progress: {
              completed: completedCount,
              total: graph.nodes.length,
              executing: 0,
              failed: failedCount,
            },
          });
        } else {
          failedCount++;
          const message =
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason);

          levelEvents.push({
            type: "node-failed",
            nodeId: node.id,
            graphId: graph.id,
            error: message,
            progress: {
              completed: completedCount,
              total: graph.nodes.length,
              executing: 0,
              failed: failedCount,
            },
          });

          // Mark all downstream nodes as skipped
          const downstream = getDownstreamNodeIds(node.id, graph.edges);
          for (const downId of downstream) {
            skippedNodes.add(downId);
          }
        }
      }

      // Yield all events from this depth level
      for (const event of levelEvents) {
        yield event;
      }

      // Yield skipped events for nodes in future depth levels that were just marked
      for (const node of graph.nodes) {
        if (skippedNodes.has(node.id) && !completed.has(node.id)) {
          // Only yield skipped event once — remove from set tracking after yield
          // We'll check depth to avoid yielding for nodes not yet reached
          const nodeDepth = depths.get(node.id) ?? 0;
          const currentDepth = depths.get(group[0].id) ?? 0;
          if (nodeDepth === currentDepth + 1) {
            // Don't yield yet — will be handled when we reach that depth level
          }
        }
      }
    }

    // Yield skip events for any remaining skipped nodes
    for (const nodeId of skippedNodes) {
      if (!completed.has(nodeId)) {
        yield {
          type: "node-skipped",
          nodeId,
          graphId: graph.id,
          error: "Skipped due to upstream failure",
          progress: {
            completed: completedCount,
            total: graph.nodes.length,
            executing: 0,
            failed: failedCount,
          },
        };
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
          operationId: node.deploymentId ?? nodeId,
          plan,
          rollbackPlan: {
            scriptedPlan: {
              platform: "bash",
              executionScript: "# Rollback of rollback not supported",
              dryRunScript: null,
              rollbackScript: null,
              reasoning: "Rollback of rollback not supported",
              stepSummary: [],
            },
            reasoning: "Rollback of rollback not supported",
          },
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
