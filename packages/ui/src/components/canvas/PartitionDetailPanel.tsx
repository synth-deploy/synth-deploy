import { useState } from "react";
import { getPartition, updatePartitionVariables, listDeployments, listEnvironments, getRecentDebrief } from "../../api.js";
import type { Partition, Deployment, Environment, DebriefEntry } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery, invalidateExact } from "../../hooks/useQuery.js";
import SectionHeader from "../SectionHeader.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  partitionId: string;
  title: string;
}

export default function PartitionDetailPanel({ partitionId, title }: Props) {
  const { pushPanel } = useCanvas();

  const { data: partition, loading: l1 } = useQuery<Partition>(`partition:${partitionId}`, () => getPartition(partitionId));
  const { data: deployments, loading: l2 } = useQuery<Deployment[]>(`deployments:partition:${partitionId}`, () => listDeployments({ partitionId }));
  const { data: environments, loading: l3 } = useQuery<Environment[]>("list:environments", () => listEnvironments());
  const { data: debriefEntries, loading: l4 } = useQuery<DebriefEntry[]>(`debrief:partition:${partitionId}`, () => getRecentDebrief({ partitionId, limit: 10 }).catch(() => [] as DebriefEntry[]));
  const loading = l1 || l2 || l3 || l4;
  const [activeTab, setActiveTab] = useState<"overview" | "variables" | "history">("overview");
  const [addingVar, setAddingVar] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [varSaving, setVarSaving] = useState(false);

  async function saveVariable(key: string, value: string) {
    if (!partition) return;
    setVarSaving(true);
    try {
      await updatePartitionVariables(partitionId, { ...partition.variables, [key]: value });
      invalidateExact(`partition:${partitionId}`);
      setEditingKey(null);
      setAddingVar(false);
      setNewKey("");
      setNewValue("");
    } catch { /* ignored */ }
    setVarSaving(false);
  }

  async function deleteVariable(key: string) {
    if (!partition) return;
    setVarSaving(true);
    try {
      const next = { ...partition.variables };
      delete next[key];
      await updatePartitionVariables(partitionId, next);
      invalidateExact(`partition:${partitionId}`);
    } catch { /* ignored */ }
    setVarSaving(false);
  }

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!partition) return <CanvasPanelHost title={title}><div className="error-msg">Partition not found</div></CanvasPanelHost>;

  const vars = Object.entries(partition?.variables ?? {});
  // Build set of variable keys that exist in parent environments (inherited/scoped)
  const envVarKeys = new Set<string>();
  for (const env of (environments ?? [])) {
    for (const key of Object.keys(env.variables ?? {})) {
      envVarKeys.add(key);
    }
  }
  const depsList = deployments ?? [];
  const sortedDeploys = [...depsList].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const succeededCount = depsList.filter((d) => d.status === "succeeded").length;
  const successRate = depsList.length > 0
    ? `${Math.round((succeededCount / depsList.length) * 100)}%`
    : "\u2014";

  return (
    <CanvasPanelHost title={title}>
      <div className="v2-detail-view">
        {/* Partition header with barrier styling */}
        <div className="v2-partition-detail-header">
          <div className="v2-partition-barrier v2-barrier-top" />
          <div className="v2-partition-barrier v2-barrier-bottom" />
          <div className="v2-partition-barrier v2-barrier-left" />
          <div className="v2-partition-barrier v2-barrier-right" />

          <div className="v2-partition-detail-content">
            <div className="v2-partition-detail-avatar">
              <span>{partition.name[0]}</span>
            </div>
            <div className="v2-partition-detail-info">
              <div className="v2-partition-detail-title-row">
                <span className="v2-partition-detail-name">{partition.name}</span>
                <div className="v2-status-active-badge">ACTIVE</div>
              </div>
              <div className="v2-partition-detail-envs">
                {(environments ?? []).map((e) => (
                  <button
                    key={e.id}
                    className="v2-env-tag"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      pushPanel({
                        type: "environment-detail",
                        title: e.name,
                        params: { id: e.id },
                      });
                    }}
                  >
                    {e.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="v2-partition-detail-stats">
              <div className="v2-stat-col">
                <span className="v2-stat-value">{vars.length}</span>
                <span className="v2-stat-label">Variables</span>
              </div>
              <div className="v2-stat-col">
                <span className="v2-stat-value">{depsList.length}</span>
                <span className="v2-stat-label">Deployments</span>
              </div>
              <div className="v2-stat-col">
                <span className="v2-stat-value">{successRate}</span>
                <span className="v2-stat-label">Success Rate</span>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="v2-tab-bar">
          {(["overview", "variables", "history"] as const).map((tab) => (
            <button
              key={tab}
              className={`v2-tab ${activeTab === tab ? "v2-tab-active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === "overview" && (
          <div className="v2-detail-columns">
            <div className="v2-detail-main">
              {/* Recent deployments */}
              <SectionHeader color="var(--status-succeeded)" shape="circle" label="Recent Deployments" subtitle={`for ${partition.name}`} />
              <div className="v2-scoped-list">
                {sortedDeploys.slice(0, 10).map((d) => {
                  const envName = (environments ?? []).find((e) => e.id === d.environmentId)?.name ?? d.environmentId;
                  return (
                    <div
                      key={d.id}
                      className="v2-deploy-row"
                      onClick={() => pushPanel({
                        type: "deployment-detail",
                        title: `Deployment ${d.version}`,
                        params: { id: d.id },
                      })}
                    >
                      <div className={`v2-deploy-dot v2-deploy-${d.status}`} />
                      <div className="v2-deploy-info">
                        <span className="v2-deploy-version">{d.version}</span>
                        <span className="v2-deploy-env">{envName}</span>
                      </div>
                      <span className="v2-deploy-time">
                        {new Date(d.createdAt).toLocaleString()}
                      </span>
                      <div className={`v2-deploy-status-pill v2-pill-${d.status}`}>
                        {d.status}
                      </div>
                    </div>
                  );
                })}
                {sortedDeploys.length === 0 && (
                  <div className="v2-empty-hint">No deployments for this partition</div>
                )}
              </div>
            </div>

            {/* Right: Debriefs */}
            <div className="v2-detail-sidebar">
              <SectionHeader color="var(--accent)" shape="diamond" label="Recent Debriefs" />
              <div className="v2-scoped-list">
                {(debriefEntries ?? []).length > 0 ? (debriefEntries ?? []).slice(0, 5).map((entry) => (
                  <div key={entry.id} className="v2-debrief-row v2-debrief-compact">
                    <div className="v2-debrief-status-bar" style={{ background: "var(--accent)" }} />
                    <div className="v2-debrief-content">
                      <div className="v2-debrief-body">
                        <div className="v2-debrief-header">
                          <span className="v2-debrief-time">
                            {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                          </span>
                          <span className="v2-debrief-from">
                            {entry.agent === "envoy" ? "Envoy" : "Command"}
                          </span>
                        </div>
                        <div className="v2-debrief-summary">{entry.decision}</div>
                      </div>
                    </div>
                  </div>
                )) : (
                  <div className="v2-empty-hint">No recent Debriefs for this Partition</div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === "variables" && (
          <div className="v2-variables-view">
            <div className="v2-variables-header">
              <span className="v2-variables-count">{vars.length} VARIABLES</span>
              <button
                className="v2-create-btn v2-create-btn-partition"
                onClick={() => { setAddingVar(true); setNewKey(""); setNewValue(""); }}
              >
                + Add Variable
              </button>
            </div>
            {addingVar && (
              <div style={{ display: "flex", gap: 6, marginBottom: 8, padding: "0 16px", alignItems: "flex-end" }}>
                <input
                  placeholder="Key"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  style={{ flex: 1, fontSize: 12, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
                />
                <input
                  placeholder="Value"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && newKey.trim() && saveVariable(newKey.trim(), newValue)}
                  style={{ flex: 2, fontSize: 12, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
                />
                <button className="btn btn-sm btn-primary" disabled={varSaving || !newKey.trim()} onClick={() => saveVariable(newKey.trim(), newValue)} style={{ fontSize: 11 }}>Save</button>
                <button className="btn btn-sm" onClick={() => setAddingVar(false)} style={{ fontSize: 11 }}>Cancel</button>
              </div>
            )}
            <div className="v2-variables-table">
              <div className="v2-variables-table-header">
                <div style={{ flex: 1 }}>Key</div>
                <div style={{ flex: 2 }}>Value</div>
                <div style={{ width: 50 }} />
              </div>
              {vars.map(([k, v]) => {
                const isScoped = envVarKeys.has(k);
                return (
                  <div key={k} className="v2-variables-table-row" style={{ display: "flex", alignItems: "center" }}>
                    <div className="v2-var-key" style={{ flex: 1 }}>{k}</div>
                    {editingKey === k && !isScoped ? (
                      <>
                        <input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && saveVariable(k, editValue)}
                          autoFocus
                          style={{ flex: 2, fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--accent-border)", background: "var(--input-bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
                        />
                        <button style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 11, marginLeft: 4 }} disabled={varSaving} onClick={() => saveVariable(k, editValue)}>Save</button>
                        <button style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }} onClick={() => setEditingKey(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <div className="v2-var-value" style={{ flex: 2 }}>{v}</div>
                        {isScoped ? (
                          <span style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", padding: "1px 6px", borderRadius: 3, background: "var(--surface-alt)" }}>scoped</span>
                        ) : (
                          <>
                            <button
                              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: "0 4px" }}
                              title="Edit"
                              onClick={() => { setEditingKey(k); setEditValue(v); }}
                            >
                              ✎
                            </button>
                            <button
                              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: "0 4px" }}
                              title="Delete"
                              onClick={() => deleteVariable(k)}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              {vars.length === 0 && !addingVar && (
                <div className="v2-empty-hint" style={{ padding: 16 }}>No variables configured</div>
              )}
            </div>
          </div>
        )}

        {activeTab === "history" && (
          <div className="v2-history-view">
            <span className="v2-history-label">DEPLOYMENT HISTORY</span>
            <div className="v2-scoped-list">
              {sortedDeploys.map((d) => {
                const envName = (environments ?? []).find((e) => e.id === d.environmentId)?.name ?? d.environmentId;
                const isFailed = d.status === "failed";
                return (
                  <div
                    key={d.id}
                    className={`v2-history-row ${isFailed ? "v2-history-failed" : ""}`}
                    onClick={() => pushPanel({
                      type: "deployment-detail",
                      title: `Deployment ${d.version}`,
                      params: { id: d.id },
                    })}
                  >
                    <div className={`v2-history-dot ${isFailed ? "v2-dot-failed" : "v2-dot-success"}`} />
                    <div className="v2-deploy-info">
                      <span className="v2-deploy-version">{d.version}</span>
                      <span className="v2-deploy-env">{envName}</span>
                    </div>
                    <span className="v2-deploy-time">
                      {new Date(d.createdAt).toLocaleString()}
                    </span>
                    <div className={`v2-deploy-status-pill v2-pill-${d.status}`}>
                      {d.status}
                    </div>
                  </div>
                );
              })}
              {sortedDeploys.length === 0 && (
                <div className="v2-empty-hint">No deployment history</div>
              )}
            </div>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
