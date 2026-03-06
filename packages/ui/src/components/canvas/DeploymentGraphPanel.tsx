import { useState, useEffect } from "react";
import { useQuery } from "../../hooks/useQuery.js";
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

async function approveRemaining(graphId: string): Promise<void> {
  await fetchJson(`/api/deployment-graphs/${graphId}/approve-remaining`, {
    method: "POST",
  });
}

async function retryNode(graphId: string, nodeId: string): Promise<void> {
  await fetchJson(`/api/deployment-graphs/${graphId}/nodes/${nodeId}/retry`, {
    method: "POST",
  });
}

async function skipNode(graphId: string, nodeId: string): Promise<void> {
  await fetchJson(`/api/deployment-graphs/${graphId}/nodes/${nodeId}/skip`, {
    method: "POST",
  });
}

async function updateGraph(
  graphId: string,
  updates: { nodes?: GraphNode[]; edges?: GraphEdge[] },
): Promise<DeploymentGraph> {
  const data = await fetchJson<{ graph: DeploymentGraph }>(
    `/api/deployment-graphs/${graphId}`,
    { method: "PUT", body: JSON.stringify(updates) },
  );
  return data.graph;
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
  const { data: graphs, loading, error } = useQuery<DeploymentGraph[]>("list:deploymentGraphs", fetchGraphList);

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
        <div className="error-msg">{error.message}</div>
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

        {(graphs ?? []).length === 0 && (
          <div style={{ color: "#666", fontSize: 13, padding: "16px 0" }}>
            No deployment graphs created yet. Create one via the API.
          </div>
        )}

        {(graphs ?? []).map((g) => (
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
  const { data: graph, loading, error, refresh: reload } = useQuery<DeploymentGraph>(
    `deploymentGraph:${graphId}`,
    () => fetchGraph(graphId),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editedEdges, setEditedEdges] = useState<GraphEdge[]>([]);
  const [editedNodes, setEditedNodes] = useState<GraphNode[]>([]);

  // Add-edge form state
  const [newEdgeFrom, setNewEdgeFrom] = useState("");
  const [newEdgeTo, setNewEdgeTo] = useState("");
  const [newEdgeType, setNewEdgeType] = useState<"depends_on" | "data_flow">("depends_on");
  const [newEdgeOutputName, setNewEdgeOutputName] = useState("");
  const [newEdgeInputVar, setNewEdgeInputVar] = useState("");

  // Add-binding form state
  const [bindingNodeId, setBindingNodeId] = useState<string | null>(null);
  const [newBindingName, setNewBindingName] = useState("");
  const [newBindingSource, setNewBindingSource] = useState<"plan_step_output" | "manual">("manual");
  const [newBindingValue, setNewBindingValue] = useState("");
  const [newBindingStepIndex, setNewBindingStepIndex] = useState("");
  const [newBindingOutputKey, setNewBindingOutputKey] = useState("");

  // Sync edit state when graph data loads/changes
  useEffect(() => {
    if (graph) {
      setEditedEdges(graph.edges);
      setEditedNodes(graph.nodes);
    }
  }, [graph]);

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
        <div className="error-msg">{error?.message ?? "Graph not found"}</div>
      </CanvasPanelHost>
    );
  }

  const canEdit = graph.status === "draft" || graph.status === "awaiting_approval";

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

  const handleApproveRemaining = async () => {
    setActionError(null);
    try {
      await approveRemaining(graphId);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Approve remaining failed");
    }
  };

  const handleRetryNode = async (nodeId: string) => {
    setActionError(null);
    try {
      await retryNode(graphId, nodeId);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Retry failed");
    }
  };

  const handleSkipNode = async (nodeId: string) => {
    setActionError(null);
    try {
      await skipNode(graphId, nodeId);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Skip failed");
    }
  };

  const handleToggleEdit = () => {
    if (editMode) {
      // Cancel edit — reset to graph state
      setEditedEdges(graph.edges);
      setEditedNodes(graph.nodes);
    }
    setEditMode(!editMode);
  };

  const handleRemoveEdge = (index: number) => {
    setEditedEdges((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAddEdge = () => {
    if (!newEdgeFrom || !newEdgeTo || newEdgeFrom === newEdgeTo) return;
    const edge: GraphEdge = {
      from: newEdgeFrom,
      to: newEdgeTo,
      type: newEdgeType,
    };
    if (newEdgeType === "data_flow" && newEdgeOutputName && newEdgeInputVar) {
      edge.dataBinding = {
        outputName: newEdgeOutputName,
        inputVariable: newEdgeInputVar,
      };
    }
    setEditedEdges((prev) => [...prev, edge]);
    setNewEdgeFrom("");
    setNewEdgeTo("");
    setNewEdgeType("depends_on");
    setNewEdgeOutputName("");
    setNewEdgeInputVar("");
  };

  const handleAddBinding = (nodeId: string) => {
    if (!newBindingName) return;
    const binding: OutputBinding = {
      name: newBindingName,
      source: newBindingSource,
    };
    if (newBindingSource === "manual") {
      binding.value = newBindingValue;
    } else {
      binding.stepIndex = parseInt(newBindingStepIndex, 10) || 0;
      binding.outputKey = newBindingOutputKey;
    }
    setEditedNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId
          ? { ...n, outputBindings: [...(n.outputBindings ?? []), binding] }
          : n,
      ),
    );
    setBindingNodeId(null);
    setNewBindingName("");
    setNewBindingSource("manual");
    setNewBindingValue("");
    setNewBindingStepIndex("");
    setNewBindingOutputKey("");
  };

  const handleSaveEdits = async () => {
    setActionError(null);
    try {
      await updateGraph(graphId, { nodes: editedNodes, edges: editedEdges });
      setEditMode(false);
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Save failed");
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

            {canEdit && (
              <button
                onClick={handleToggleEdit}
                style={{
                  marginLeft: "auto", fontSize: 11, padding: "2px 10px",
                  borderRadius: 4, border: `1px solid ${editMode ? "#dc262640" : "#8b5cf640"}`,
                  background: editMode ? "#dc262615" : "#8b5cf615",
                  color: editMode ? "#dc2626" : "#8b5cf6",
                  cursor: "pointer",
                }}
              >
                {editMode ? "Cancel Edit" : "Edit"}
              </button>
            )}

            {graph.approvalMode === "per-node" &&
              (graph.status === "executing" || graph.status === "awaiting_approval") && (
              <button
                onClick={handleApproveRemaining}
                style={{
                  marginLeft: canEdit ? 0 : "auto", fontSize: 11, padding: "2px 10px",
                  borderRadius: 4, border: "1px solid #16a34a40",
                  background: "#16a34a15", color: "#16a34a", cursor: "pointer",
                }}
              >
                Approve Remaining
              </button>
            )}
          </div>

          {editMode && (
            <button
              onClick={handleSaveEdits}
              style={{
                fontSize: 12, padding: "4px 16px", borderRadius: 4,
                border: "1px solid #16a34a40", background: "#16a34a20",
                color: "#16a34a", cursor: "pointer", marginBottom: 8,
              }}
            >
              Save Changes
            </button>
          )}

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

                  {graph.approvalMode === "per-node" && node.status === "awaiting_approval" && (
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

                  {node.status === "failed" && graph.status === "failed" && (
                    <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                      <button
                        onClick={() => handleRetryNode(node.id)}
                        style={{
                          fontSize: 11, padding: "2px 10px",
                          borderRadius: 4, border: "1px solid #2563eb40",
                          background: "#2563eb15", color: "#2563eb", cursor: "pointer",
                        }}
                      >
                        Retry
                      </button>
                      <button
                        onClick={() => handleSkipNode(node.id)}
                        style={{
                          fontSize: 11, padding: "2px 10px",
                          borderRadius: 4, border: "1px solid #ca8a0440",
                          background: "#ca8a0415", color: "#ca8a04", cursor: "pointer",
                        }}
                      >
                        Skip
                      </button>
                    </div>
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

                {/* Add Binding form (edit mode) */}
                {editMode && (
                  <div style={{ marginTop: 6, paddingLeft: 30 }}>
                    {bindingNodeId === node.id ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                        <input
                          placeholder="Name"
                          value={newBindingName}
                          onChange={(e) => setNewBindingName(e.target.value)}
                          style={inputStyle}
                        />
                        <select
                          value={newBindingSource}
                          onChange={(e) => setNewBindingSource(e.target.value as "plan_step_output" | "manual")}
                          style={inputStyle}
                        >
                          <option value="manual">manual</option>
                          <option value="plan_step_output">plan_step_output</option>
                        </select>
                        {newBindingSource === "manual" ? (
                          <input
                            placeholder="Value"
                            value={newBindingValue}
                            onChange={(e) => setNewBindingValue(e.target.value)}
                            style={inputStyle}
                          />
                        ) : (
                          <>
                            <input
                              placeholder="Step index"
                              value={newBindingStepIndex}
                              onChange={(e) => setNewBindingStepIndex(e.target.value)}
                              style={{ ...inputStyle, width: 70 }}
                            />
                            <input
                              placeholder="Output key"
                              value={newBindingOutputKey}
                              onChange={(e) => setNewBindingOutputKey(e.target.value)}
                              style={inputStyle}
                            />
                          </>
                        )}
                        <button onClick={() => handleAddBinding(node.id)} style={smallBtnStyle("#16a34a")}>
                          Add
                        </button>
                        <button onClick={() => setBindingNodeId(null)} style={smallBtnStyle("#dc2626")}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setBindingNodeId(node.id)}
                        style={{ ...smallBtnStyle("#38bdf8"), marginTop: 2 }}
                      >
                        + Add Binding
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
        </div>

        {/* Edges */}
        <div style={{ marginBottom: 20 }}>
          <h4 style={{ fontSize: 13, fontWeight: 600, color: "#aaa", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
            Dependencies ({editMode ? editedEdges.length : graph.edges.length})
          </h4>

          {(editMode ? editedEdges : graph.edges).map((edge, i) => {
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
                {editMode && (
                  <button
                    onClick={() => handleRemoveEdge(i)}
                    style={{
                      marginLeft: "auto", fontSize: 10, padding: "1px 6px",
                      borderRadius: 3, border: "1px solid #dc262640",
                      background: "#dc262610", color: "#dc2626", cursor: "pointer",
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}

          {/* Add Edge form (edit mode) */}
          {editMode && (
            <div style={{
              marginTop: 8, padding: "8px 10px",
              background: "rgba(139,92,246,0.04)", borderRadius: 6,
              border: "1px solid rgba(139,92,246,0.1)",
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#aaa", marginBottom: 6 }}>
                Add Edge
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
                <select value={newEdgeFrom} onChange={(e) => setNewEdgeFrom(e.target.value)} style={inputStyle}>
                  <option value="">From...</option>
                  {graph.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.artifactName ?? n.artifactId}
                    </option>
                  ))}
                </select>
                <select value={newEdgeTo} onChange={(e) => setNewEdgeTo(e.target.value)} style={inputStyle}>
                  <option value="">To...</option>
                  {graph.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.artifactName ?? n.artifactId}
                    </option>
                  ))}
                </select>
                <select
                  value={newEdgeType}
                  onChange={(e) => setNewEdgeType(e.target.value as "depends_on" | "data_flow")}
                  style={inputStyle}
                >
                  <option value="depends_on">depends_on</option>
                  <option value="data_flow">data_flow</option>
                </select>
                {newEdgeType === "data_flow" && (
                  <>
                    <input
                      placeholder="Output name"
                      value={newEdgeOutputName}
                      onChange={(e) => setNewEdgeOutputName(e.target.value)}
                      style={inputStyle}
                    />
                    <input
                      placeholder="Input variable"
                      value={newEdgeInputVar}
                      onChange={(e) => setNewEdgeInputVar(e.target.value)}
                      style={inputStyle}
                    />
                  </>
                )}
                <button onClick={handleAddEdge} style={smallBtnStyle("#16a34a")}>
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  fontSize: 11, padding: "2px 6px", borderRadius: 3,
  border: "1px solid #444", background: "#1a1a1a", color: "#ccc",
  outline: "none", minWidth: 80,
};

function smallBtnStyle(color: string): React.CSSProperties {
  return {
    fontSize: 10, padding: "1px 8px", borderRadius: 3,
    border: `1px solid ${color}40`, background: `${color}15`,
    color, cursor: "pointer",
  };
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
