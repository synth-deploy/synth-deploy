import type {
  DeploymentGraph,
  DeploymentGraphStatus,
  DeploymentGraphNode,
} from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// DeploymentGraphStore — in-memory store for deployment graphs
// ---------------------------------------------------------------------------

export class DeploymentGraphStore {
  private graphs = new Map<string, DeploymentGraph>();

  create(graph: DeploymentGraph): DeploymentGraph {
    this.graphs.set(graph.id, graph);
    return graph;
  }

  getById(id: string): DeploymentGraph | undefined {
    return this.graphs.get(id);
  }

  update(
    id: string,
    updates: Partial<Pick<DeploymentGraph, "name" | "nodes" | "edges" | "status" | "approvalMode" | "partitionId">>,
  ): DeploymentGraph | undefined {
    const existing = this.graphs.get(id);
    if (!existing) return undefined;

    if (updates.name !== undefined) existing.name = updates.name;
    if (updates.nodes !== undefined) existing.nodes = updates.nodes;
    if (updates.edges !== undefined) existing.edges = updates.edges;
    if (updates.status !== undefined) existing.status = updates.status;
    if (updates.approvalMode !== undefined) existing.approvalMode = updates.approvalMode;
    if (updates.partitionId !== undefined) existing.partitionId = updates.partitionId;
    existing.updatedAt = new Date();

    return existing;
  }

  updateStatus(id: string, status: DeploymentGraphStatus): DeploymentGraph | undefined {
    const existing = this.graphs.get(id);
    if (!existing) return undefined;

    existing.status = status;
    existing.updatedAt = new Date();
    return existing;
  }

  updateNode(
    graphId: string,
    nodeId: string,
    updates: Partial<Pick<DeploymentGraphNode, "status" | "deploymentId">>,
  ): DeploymentGraphNode | undefined {
    const graph = this.graphs.get(graphId);
    if (!graph) return undefined;

    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;

    if (updates.status !== undefined) node.status = updates.status;
    if (updates.deploymentId !== undefined) node.deploymentId = updates.deploymentId;
    graph.updatedAt = new Date();

    return node;
  }

  list(): DeploymentGraph[] {
    return Array.from(this.graphs.values());
  }

  delete(id: string): boolean {
    return this.graphs.delete(id);
  }
}
