import { useState } from "react";
import { getEnvironment, updateEnvironment, listDeployments, listArtifacts, listEnvoys } from "../../api.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import type { Environment, Deployment, Artifact } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery, invalidateExact } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  environmentId: string;
  title: string;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 7) return `${Math.floor(secs / 86400)}d ago`;
  return `${Math.floor(secs / 86400 / 7)}w ago`;
}

export default function EnvironmentDetailPanel({ environmentId, title }: Props) {
  const { pushPanel } = useCanvas();

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [addingVar, setAddingVar] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [varSaving, setVarSaving] = useState(false);

  const { data: environment, loading: l1 } = useQuery<Environment>(`environment:${environmentId}`, () => getEnvironment(environmentId));
  const { data: allDeployments, loading: l2 } = useQuery<Deployment[]>("list:deployments", () => listDeployments());
  const { data: artifacts, loading: l3 } = useQuery<Artifact[]>("list:artifacts", () => listArtifacts());
  const { data: envoys, loading: l4 } = useQuery<EnvoyRegistryEntry[]>("list:envoys", listEnvoys);
  const loading = l1 || l2 || l3 || l4;

  if (loading) return <CanvasPanelHost title={title} hideRootCrumb dismissible={false}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!environment) return <CanvasPanelHost title={title} hideRootCrumb dismissible={false}><div className="error-msg">Environment not found</div></CanvasPanelHost>;

  async function saveVariable(key: string, value: string) {
    if (!environment) return;
    setVarSaving(true);
    try {
      await updateEnvironment(environmentId, { variables: { ...environment.variables, [key]: value } });
      invalidateExact(`environment:${environmentId}`);
      setEditingKey(null);
      setAddingVar(false);
      setNewKey("");
      setNewValue("");
    } catch { /* ignored */ }
    setVarSaving(false);
  }

  async function deleteVariable(key: string) {
    if (!environment) return;
    setVarSaving(true);
    try {
      const next = { ...environment.variables };
      delete next[key];
      await updateEnvironment(environmentId, { variables: next });
      invalidateExact(`environment:${environmentId}`);
    } catch { /* ignored */ }
    setVarSaving(false);
  }

  // Derived data
  const deployments = (allDeployments ?? []).filter((d) => d.environmentId === environmentId);
  const assignedEnvoys = (envoys ?? []).filter((e) => e.assignedEnvironments.includes(environment.name));

  // Health badge
  const envoyCount = assignedEnvoys.length;
  const healthyCount = assignedEnvoys.filter((e) => e.health === "OK").length;
  const degradedCount = assignedEnvoys.filter((e) => e.health === "Degraded").length;
  const unreachableCount = assignedEnvoys.filter((e) => e.health === "Unreachable").length;
  const overallHealth =
    envoyCount === 0 ? null :
    unreachableCount > 0 ? "Unreachable" :
    degradedCount > 0 ? "Degraded" : "Healthy";
  const healthBadgeColor =
    overallHealth === "Healthy" ? "var(--status-succeeded)" :
    overallHealth === "Degraded" ? "var(--status-warning)" :
    "var(--status-failed)";

  // Stat card: Artifacts Deployed (unique artifacts with a succeeded deployment)
  const succeededDeps = deployments.filter((d) => d.status === "succeeded");
  const deployedArtifactIds = [...new Set(succeededDeps.map((d) => d.artifactId).filter((id): id is string => !!id))];
  const deployedArtifacts = deployedArtifactIds
    .map((id) => (artifacts ?? []).find((a) => a.id === id)?.name ?? id.slice(0, 8))
    .slice(0, 4);
  const extraArtifacts = deployedArtifactIds.length - deployedArtifacts.length;

  // Stat card: Deployments (30d)
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentDeps = deployments.filter((d) => new Date(d.createdAt).getTime() > thirtyDaysAgo);
  const recentSucceeded = recentDeps.filter((d) => d.status === "succeeded").length;
  const recentFailed = recentDeps.filter((d) => d.status === "failed").length;
  const recentPending = recentDeps.filter((d) => d.status === "pending" || d.status === "running" || d.status === "planning").length;

  // Stat card: Last Deployment
  const sorted = [...deployments].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const lastDep = sorted[0];
  const lastDepArtifact = lastDep ? (artifacts ?? []).find((a) => a.id === lastDep.artifactId)?.name ?? lastDep.artifactId?.slice(0, 8) ?? lastDep.intent ?? "—" : null;
  const lastDepEnvoy = lastDep?.envoyId ? (envoys ?? []).find((e) => e.id === lastDep.envoyId)?.name ?? lastDep.envoyId.slice(0, 8) : null;

  // Currently Deployed: most recent succeeded deployment per artifactId
  const currentlyDeployed: Array<{ artifact: string; version: string; envoy: string | null; deployedAt: string; health: string }> = [];
  const seenArtifacts = new Set<string>();
  for (const d of succeededDeps.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())) {
    if (!d.artifactId || seenArtifacts.has(d.artifactId)) continue;
    seenArtifacts.add(d.artifactId);
    const envoy = d.envoyId ? (envoys ?? []).find((e) => e.id === d.envoyId) : null;
    currentlyDeployed.push({
      artifact: (artifacts ?? []).find((a) => a.id === d.artifactId)?.name ?? d.artifactId?.slice(0, 8) ?? d.intent ?? "—",
      version: d.version,
      envoy: envoy?.name ?? null,
      deployedAt: timeAgo(d.createdAt),
      health: envoy?.health === "OK" ? "healthy" : envoy?.health === "Degraded" ? "degraded" : "unknown",
    });
  }

  const vars = Object.entries(environment.variables ?? {});

  return (
    <CanvasPanelHost title={title} hideRootCrumb dismissible={false}>
      <div className="v2-detail-view">

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              {overallHealth && (
                <span className="status-pip" style={{ background: healthBadgeColor, width: 9, height: 9, flexShrink: 0 }} />
              )}
              <h1 style={{ fontSize: 24, fontWeight: 500, color: "var(--text)", margin: 0, fontFamily: "var(--font-display)" }}>{environment.name}</h1>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
              {envoyCount} envoy{envoyCount !== 1 ? "s" : ""} assigned · {vars.length} variable{vars.length !== 1 ? "s" : ""} configured
            </p>
          </div>
          {overallHealth && (
            <span style={{
              padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
              background: `color-mix(in srgb, ${healthBadgeColor} 12%, transparent)`,
              color: healthBadgeColor,
              border: `1px solid color-mix(in srgb, ${healthBadgeColor} 25%, transparent)`,
              fontFamily: "var(--font-mono)", textTransform: "uppercase",
            }}>{overallHealth}</span>
          )}
        </div>

        {/* Stat Cards */}
        <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
          {[
            {
              label: "Envoys",
              value: String(envoyCount),
              sub: envoyCount === 0 ? "None assigned" : [healthyCount > 0 && `${healthyCount} healthy`, degradedCount > 0 && `${degradedCount} degraded`, unreachableCount > 0 && `${unreachableCount} unreachable`].filter(Boolean).join(" · "),
            },
            {
              label: "Artifacts Deployed",
              value: String(deployedArtifactIds.length),
              sub: deployedArtifacts.length === 0 ? "None" : deployedArtifacts.join(", ") + (extraArtifacts > 0 ? ` +${extraArtifacts} more` : ""),
            },
            {
              label: "Deployments (30d)",
              value: String(recentDeps.length),
              sub: recentDeps.length === 0 ? "No recent deployments" : [recentSucceeded > 0 && `${recentSucceeded} succeeded`, recentFailed > 0 && `${recentFailed} failed`, recentPending > 0 && `${recentPending} pending`].filter(Boolean).join(" · "),
            },
            {
              label: "Last Deployment",
              value: lastDep ? timeAgo(lastDep.createdAt) : "—",
              sub: lastDep ? `${lastDepArtifact} ${lastDep.version}${lastDepEnvoy ? ` → ${lastDepEnvoy}` : ""}` : "No deployments yet",
            },
          ].map((stat) => (
            <div key={stat.label} style={{ flex: 1, padding: "14px 16px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{stat.label}</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", lineHeight: 1 }}>{stat.value}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.4 }}>{stat.sub}</div>
            </div>
          ))}
        </div>

        {/* Assigned Envoys */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="section-label">Assigned Envoys</div>
        </div>
        <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", marginBottom: 24 }}>
          {assignedEnvoys.map((e, i) => {
            const envoyHealthColor = e.health === "OK" ? "var(--status-succeeded)" : e.health === "Degraded" ? "var(--status-warning)" : "var(--status-failed)";
            const envoyHealthLabel = e.health === "OK" ? "Healthy" : e.health;
            return (
              <button
                key={e.id}
                onClick={() => pushPanel({ type: "envoy-detail", title: e.name, params: { id: e.id } })}
                style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", width: "100%",
                  background: "transparent", border: "none",
                  borderBottom: i < assignedEnvoys.length - 1 ? "1px solid var(--border)" : "none",
                  cursor: "pointer", textAlign: "left",
                }}
              >
                <span className="status-pip" style={{ background: envoyHealthColor, width: 7, height: 7, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{e.name}</span>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                    {[e.os, e.summary ? `${e.summary.totalDeployments} plans stored` : null, e.lastSeen ? `Last seen ${timeAgo(e.lastSeen)}` : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <span style={{
                  padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)",
                  background: `color-mix(in srgb, ${envoyHealthColor} 12%, transparent)`,
                  color: envoyHealthColor,
                  border: `1px solid color-mix(in srgb, ${envoyHealthColor} 25%, transparent)`,
                  textTransform: "uppercase",
                }}>{envoyHealthLabel}</span>
                <svg width="16" height="16" viewBox="0 0 16 16" style={{ opacity: 0.3, flexShrink: 0 }}>
                  <path d="M6 4l4 4-4 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            );
          })}
          {assignedEnvoys.length === 0 && (
            <div className="empty-state"><p>No envoys assigned to this environment.</p></div>
          )}
        </div>

        {/* Currently Deployed */}
        {currentlyDeployed.length > 0 && (
          <>
            <div className="section-label" style={{ marginBottom: 10 }}>Currently Deployed</div>
            <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface)", marginBottom: 24 }}>
              {currentlyDeployed.map((d, i) => {
                const depHealthColor = d.health === "healthy" ? "var(--status-succeeded)" : d.health === "degraded" ? "var(--status-warning)" : "var(--text-muted)";
                return (
                  <div key={`${d.artifact}-${i}`} style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 16px", borderBottom: i < currentlyDeployed.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <span className="status-pip" style={{ background: depHealthColor, width: 6, height: 6, flexShrink: 0 }} />
                    <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{d.artifact}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{d.version}</span>
                    </div>
                    {d.envoy && (
                      <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", minWidth: 80 }}>{d.envoy}</span>
                    )}
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{d.deployedAt}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Environment Variables */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="section-label">Environment Variables</div>
          <button
            className="btn-accent-outline"
            style={{ fontSize: 10, padding: "4px 12px" }}
            onClick={() => { setAddingVar(true); setNewKey(""); setNewValue(""); }}
          >
            + Add Variable
          </button>
        </div>
        <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface)", marginBottom: 24 }}>
          {/* Table header */}
          <div style={{ display: "flex", padding: "8px 16px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--text) 3%, transparent)" }}>
            <span style={{ flex: 2, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1 }}>Key</span>
            <span style={{ flex: 3, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1 }}>Value</span>
            <span style={{ flex: 1, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1 }}>Source</span>
            <span style={{ width: 60 }} />
          </div>
          {addingVar && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "color-mix(in srgb, var(--accent) 4%, transparent)" }}>
              <input
                placeholder="KEY"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="v2-input"
                style={{ flex: 2, fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
              <input
                placeholder="value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && newKey.trim() && saveVariable(newKey.trim(), newValue)}
                className="v2-input"
                style={{ flex: 3, fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
              <div style={{ flex: 1, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>Env</div>
              <div style={{ width: 60, display: "flex", gap: 4 }}>
                <button className="btn btn-sm btn-primary" disabled={varSaving || !newKey.trim()} onClick={() => saveVariable(newKey.trim(), newValue)} style={{ fontSize: 10 }}>Save</button>
                <button className="btn btn-sm" onClick={() => setAddingVar(false)} style={{ fontSize: 10 }}>✕</button>
              </div>
            </div>
          )}
          {vars.map(([k, v], i) => (
            <div key={k} style={{ display: "flex", alignItems: "center", padding: "10px 16px", borderBottom: i < vars.length - 1 ? "1px solid var(--border)" : "none" }}>
              <span style={{ flex: 2, fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 500, color: "var(--text)" }}>{k}</span>
              {editingKey === k ? (
                <>
                  <input
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveVariable(k, editValue)}
                    autoFocus
                    className="v2-input"
                    style={{ flex: 3, fontFamily: "var(--font-mono)", fontSize: 12 }}
                  />
                  <div style={{ flex: 1 }} />
                  <div style={{ width: 60, display: "flex", gap: 4 }}>
                    <button className="btn btn-sm btn-primary" style={{ fontSize: 10 }} disabled={varSaving} onClick={() => saveVariable(k, editValue)}>Save</button>
                    <button className="btn btn-sm" style={{ fontSize: 10 }} onClick={() => setEditingKey(null)}>✕</button>
                  </div>
                </>
              ) : (
                <>
                  <span style={{ flex: 3, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{v}</span>
                  <span style={{ flex: 1, fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 500, color: "var(--text-muted)" }}>Env</span>
                  <div style={{ width: 60, display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button
                      title="Edit"
                      style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 0 }}
                      onClick={() => { setEditingKey(k); setEditValue(v); }}
                    >✎</button>
                    <button
                      title="Delete"
                      style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: 0 }}
                      onClick={() => deleteVariable(k)}
                    >✕</button>
                  </div>
                </>
              )}
            </div>
          ))}
          {vars.length === 0 && !addingVar && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "16px", textAlign: "center" }}>No variables configured</div>
          )}
        </div>

        {/* Recent Deployments */}
        {sorted.length > 0 && (
          <>
            <div className="section-label" style={{ marginBottom: 10 }}>Recent Deployments</div>
            <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)" }}>
              {sorted.slice(0, 15).map((d, i) => {
                const artifact = (artifacts ?? []).find((a) => a.id === d.artifactId);
                const envoy = d.envoyId ? (envoys ?? []).find((e) => e.id === d.envoyId) : null;
                return (
                  <button
                    key={d.id}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", width: "100%",
                      background: "transparent", border: "none",
                      borderBottom: i < Math.min(sorted.length, 15) - 1 ? "1px solid var(--border)" : "none",
                      cursor: "pointer", textAlign: "left",
                    }}
                    onClick={() => pushPanel({ type: "deployment-detail", title: `Deployment ${d.version}`, params: { id: d.id } })}
                  >
                    <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{artifact?.name ?? d.artifactId?.slice(0, 8) ?? d.intent ?? "—"}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{d.version}</span>
                      {envoy && (
                        <>
                          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>→</span>
                          <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{envoy.name}</span>
                        </>
                      )}
                    </div>
                    <div className={`v2-deploy-status-pill v2-pill-${d.status}`}>{d.status}</div>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 48, textAlign: "right" }}>{timeAgo(d.createdAt)}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

      </div>
    </CanvasPanelHost>
  );
}
