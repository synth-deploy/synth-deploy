import { useState, useEffect, useCallback } from "react";
import CanvasPanelHost from "./CanvasPanelHost.js";
import SectionHeader from "../SectionHeader.js";

// ---------------------------------------------------------------------------
// Types (mirrors backend graph types, dates as strings from JSON)
// ---------------------------------------------------------------------------

interface OutputBinding {
  name: string;
  source: "plan_step_output" | "manual";
  stepIndex?: number;
  outputKey?: string;
  value?: string;
}

interface InputBinding {
  variable: string;
  sourceNodeId: string;
  sourceOutputName: string;
  resolvedValue?: string;
}

interface GraphNode {
  id: string;
  artifactId: string;
  envoyId: string;
  artifactName?: string;
  envoyName?: string;
  outputBindings?: OutputBinding[];
  inputBindings?: InputBinding[];
  deploymentId?: string;
  status: "pending" | "planning" | "awaiting_approval" | "executing" | "completed" | "failed";
}

interface GraphEdge {
  from: string;
  to: string;
  type: "depends_on" | "data_flow";
  dataBinding?: { outputName: string; inputVariable: string };
}

type GraphStatus =
  | "draft" | "planning" | "awaiting_approval" | "executing"
  | "completed" | "failed" | "rolled_back";

interface DeploymentGraph {
  id: string;
  name: string;
  partitionId?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  status: GraphStatus;
  approvalMode: "per-node" | "graph";
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

let authToken: string | null = null;
try {
  authToken = localStorage.getItem("deploystack_token");
} catch { /* SSR safe */ }

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as Record<string, string>).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json();
}

async function fetchGraph(id: string): Promise<DeploymentGraph> {
  const data = await fetchJson<{ graph: DeploymentGraph }>(`/api/deployment-graphs/${id}`);
  return data.graph;
}

async function fetchGraphList(): Promise<DeploymentGraph[]> {
  const data = await fetchJson<{ graphs: DeploymentGraph[] }>("/api/deployment-graphs");
  return data.graphs;
}

async function approveNode(graphId: string, nodeId: string): Promise<void> {
  await fetchJson(`/api/deployment-graphs/${graphId}/nodes/${nodeId}/approve`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Status badge colors
// ---------------------------------------------------------------------------

const statusColor = (s: string) => {
  switch (s) {
    case "completed": return "#16a34a";
    case "executing": return "#2563eb";
    case "failed": return "#dc2626";
    case "rolled_back": return "#ca8a04";
    case "awaiting_approval": return "#9333ea";
    case "planning": return "#0891b2";
    case "draft": return "#6b7280";
    default: return "#6b7280";
  }
};

// ---------------------------------------------------------------------------
// DeploymentGraphPanel — list view or detail view
// ---------------------------------------------------------------------------

interface Props {
  title: string;
  graphId?: string;
}

export default function DeploymentGraphPanel({ title, graphId }: Props) {
  if (graphId) {
    return <GraphDetailView title={title} graphId={graphId} />;
  }
  return <GraphListView title={title} />;
}

// ---------------------------------------------------------------------------
// List view — all graphs
// ---------------------------------------------------------------------------

function GraphListView({ title }: { title: string }) {
  const [graphs, setGraphs] = useState<DeploymentGraph[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGraphList()
      .then(setGraphs)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );
  }

  if (error) {
    return (
      <CanvasPanelHost title={title}>
        <div className="error-msg">{error}</div>
      </CanvasPanelHost>
    );
  }

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <SectionHeader
          color="#8b5cf6"
          shape="diamond"
          label="Deployment Graphs"
          subtitle="orchestrated multi-envoy deployments"
        />

        {graphs.length === 0 && (
          <div style={{ color: "#666", fontSize: 13, padding: "16px 0" }}>
            No deployment graphs created yet. Create one via the API.
          </div>
        )}

        {graphs.map((g) => (
          <div
            key={g.id}
            style={{
              background: "rgba(139,92,246,0.04)",
              border: "1px solid rgba(139,92,246,0.15)",
              borderRadius: 8,
              padding: "12px 16px",
              marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{g.name}</span>
              <StatusBadge status={g.status} />
            </div>
            <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
              {g.nodes.length} node{g.nodes.length !== 1 ? "s" : ""} ·{" "}
              {g.edges.length} edge{g.edges.length !== 1 ? "s" : ""} ·{" "}
              {g.approvalMode} approval ·{" "}
              Created {new Date(g.createdAt).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </CanvasPanelHost>
  );
}

// ---------------------------------------------------------------------------
// Detail view — single graph with nodes, edges, and controls
// ---------------------------------------------------------------------------

function GraphDetailView({ title, graphId }: { title: string; graphId: string }) {
  const [graph, setGraph] = useState<DeploymentGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchGraph(graphId)
      .then(setGraph)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [graphId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );
  }

  if (error || !graph) {
    return (
      <CanvasPanelHost title={title}>
        <div className="error-msg">{error ?? "Graph not found"}</div>
      </CanvasPanelHost>
    );
  }

  // Build execution order numbers from edges (simple topological numbering)
  const orderMap = buildOrderMap(graph.nodes, graph.edges);

  // Progress stats
  const completedCount = graph.nodes.filter((n) => n.status === "completed").length;
  const failedCount = graph.nodes.filter((n) => n.status === "failed").length;
  const executingCount = graph.nodes.filter((n) => n.status === "executing").length;

  const handleApproveNode = async (nodeId: string) => {
    setActionError(null);
    try {
      await approveNode(graphId, nodeId);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Approval failed");
    }
  };

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {/* Header */}
        <SectionHeader
          color="#8b5cf6"
          shape="diamond"
          label={graph.name}
          subtitle={`${graph.approvalMode} approval mode`}
        />

        {/* Status and progress */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <StatusBadge status={graph.status} />
            <span style={{ fontSize: 12, color: "#888" }}>
              Updated {new Date(graph.updatedAt).toLocaleString()}
            </span>
          </div>

          {(graph.status === "executing" || graph.status === "completed" || graph.status === "failed") && (
            <ProgressBar
              completed={completedCount}
              failed={failedCount}
              executing={executingCount}
              total={graph.nodes.length}
            />
          )}
        </div>

        {actionError && (
          <div style={{ color: "#dc2626", fontSize: 12, marginBottom: 8, padding: "6px 10px", background: "#dc262610", borderRadius: 6 }}>
            {actionError}
          </div>
        )}

        {/* Nodes */}
        <div style={{ marginBottom: 20 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#aaa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
            Nodes ({graph.nodes.length})
          </h4>

          {graph.nodes
            .sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))
            .map((node) => (
              <div
                key={node.id}
                style={{
                  background: "rgba(139,92,246,0.03)",
                  border: "1px solid rgba(139,92,246,0.12)",
                  borderRadius: 8,
                  padding: "10px 14px",
                  marginBottom: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: "50%",
                    background: "rgba(139,92,246,0.15)", color: "#8b5cf6",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 700, flexShrink: 0,
                  }}>
                    {(orderMap.get(node.id) ?? 0) + 1}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>
                    {node.artifactName ?? node.artifactId}
                  </span>
                  <span style={{ fontSize: 11, color: "#888" }}>
                    {node.envoyName ?? node.envoyId}
                  </span>
                  <StatusBadge status={node.status} />

                  {graph.approvalMode === "per-node" && node.status === "pending" && (
                    <button
                      onClick={() => handleApproveNode(node.id)}
                      style={{
                        marginLeft: "auto", fontSize: 11, padding: "2px 10px",
                        borderRadius: 4, border: "1px solid #9333ea40",
                        background: "#9333ea15", color: "#9333ea", cursor: "pointer",
                      }}
                    >
                      Approve
                    </button>
                  )}
                </div>

                {/* Input bindings */}
                {node.inputBindings && node.inputBindings.length > 0 && (
                  <div style={{ marginTop: 6, paddingLeft: 30 }}>
                    {node.inputBindings.map((b, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#888" }}>
                        Input: <code style={{ color: "#c084fc" }}>${b.variable}</code>{" "}
                        from node {b.sourceNodeId.slice(0, 8)}...
                        {b.resolvedValue && (
                          <span style={{ color: "#16a34a" }}> = {b.resolvedValue}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Output bindings */}
                {node.outputBindings && node.outputBindings.length > 0 && (
                  <div style={{ marginTop: 4, paddingLeft: 30 }}>
                    {node.outputBindings.map((b, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#888" }}>
                        Output: <code style={{ color: "#38bdf8" }}>{b.name}</code>{" "}
                        ({b.source})
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
        </div>

        {/* Edges */}
        {graph.edges.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <h4 style={{ fontSize: 13, fontWeight: 600, color: "#aaa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
              Dependencies ({graph.edges.length})
            </h4>

            {graph.edges.map((edge, i) => {
              const fromNode = graph.nodes.find((n) => n.id === edge.from);
              const toNode = graph.nodes.find((n) => n.id === edge.to);
              return (
                <div
                  key={i}
                  style={{
                    fontSize: 12, color: "#999", padding: "4px 0",
                    display: "flex", alignItems: "center", gap: 6,
                  }}
                >
                  <span style={{ fontWeight: 500, color: "#ccc" }}>
                    {fromNode?.artifactName ?? edge.from.slice(0, 8)}
                  </span>
                  <span style={{ color: edge.type === "data_flow" ? "#38bdf8" : "#8b5cf6" }}>
                    {edge.type === "data_flow" ? "-- data -->" : "-- depends -->"}
                  </span>
                  <span style={{ fontWeight: 500, color: "#ccc" }}>
                    {toNode?.artifactName ?? edge.to.slice(0, 8)}
                  </span>
                  {edge.dataBinding && (
                    <span style={{ fontSize: 10, color: "#666" }}>
                      ({edge.dataBinding.outputName} {"->"} {"$"}{edge.dataBinding.inputVariable})
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const color = statusColor(status);
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color,
        border: `1px solid ${color}30`,
        background: `${color}12`,
        borderRadius: 10,
        padding: "1px 8px",
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ProgressBar({
  completed,
  failed,
  executing,
  total,
}: {
  completed: number;
  failed: number;
  executing: number;
  total: number;
}) {
  const pctComplete = total > 0 ? (completed / total) * 100 : 0;
  const pctFailed = total > 0 ? (failed / total) * 100 : 0;
  const pctExecuting = total > 0 ? (executing / total) * 100 : 0;

  return (
    <div>
      <div style={{
        height: 6, borderRadius: 3, background: "#333", overflow: "hidden",
        display: "flex", marginBottom: 4,
      }}>
        <div style={{ width: `${pctComplete}%`, background: "#16a34a", transition: "width 0.3s" }} />
        <div style={{ width: `${pctExecuting}%`, background: "#2563eb", transition: "width 0.3s" }} />
        <div style={{ width: `${pctFailed}%`, background: "#dc2626", transition: "width 0.3s" }} />
      </div>
      <div style={{ fontSize: 11, color: "#888" }}>
        {completed}/{total} completed
        {failed > 0 && <span style={{ color: "#dc2626" }}> · {failed} failed</span>}
        {executing > 0 && <span style={{ color: "#2563eb" }}> · {executing} executing</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Topological order helper (mirrors backend Kahn's algorithm)
// ---------------------------------------------------------------------------

function buildOrderMap(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
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

  const queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order = new Map<string, number>();
  let idx = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.set(current, idx++);
    for (const neighbor of adjacency.get(current) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  // Assign remaining nodes (if cycle detected) at the end
  for (const node of nodes) {
    if (!order.has(node.id)) {
      order.set(node.id, idx++);
    }
  }

  return order;
}
