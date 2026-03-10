import { useState } from "react";
import { getEnvironment, updateEnvironment, listDeployments, listArtifacts } from "../../api.js";
import type { Environment, Deployment, Artifact } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery, invalidateExact } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  environmentId: string;
  title: string;
}

export default function EnvironmentDetailPanel({ environmentId, title }: Props) {
  const { pushPanel } = useCanvas();

  const { data: environment, loading: l1 } = useQuery<Environment>(`environment:${environmentId}`, () => getEnvironment(environmentId));
  const { data: allDeployments, loading: l2 } = useQuery<Deployment[]>("list:deployments", () => listDeployments());
  const { data: artifacts, loading: l3 } = useQuery<Artifact[]>("list:artifacts", () => listArtifacts());
  const loading = l1 || l2 || l3;
  const deployments = (allDeployments ?? []).filter((dep) => dep.environmentId === environmentId);

  if (loading) return <CanvasPanelHost title={title} hideRootCrumb><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!environment) return <CanvasPanelHost title={title} hideRootCrumb><div className="error-msg">Environment not found</div></CanvasPanelHost>;

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [addingVar, setAddingVar] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [varSaving, setVarSaving] = useState(false);

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

  const vars = Object.entries(environment?.variables ?? {});
  const succeeded = deployments.filter((d) => d.status === "succeeded").length;
  const successRate = deployments.length > 0
    ? `${Math.round((succeeded / deployments.length) * 100)}%`
    : "\u2014";

  const sorted = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <CanvasPanelHost title={title} hideRootCrumb>
      <div className="canvas-detail">
        <div className="canvas-summary-strip">
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{deployments.length}</span>
            <span className="canvas-summary-label">Deployments</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{successRate}</span>
            <span className="canvas-summary-label">Success Rate</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{vars.length}</span>
            <span className="canvas-summary-label">Variables</span>
          </div>
        </div>

        <div className="canvas-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 className="canvas-section-title">Variables</h3>
            <button
              className="btn btn-sm"
              onClick={() => { setAddingVar(true); setNewKey(""); setNewValue(""); }}
              style={{ fontSize: 11, padding: "2px 8px" }}
            >
              + Add Variable
            </button>
          </div>
          {addingVar && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "flex-end" }}>
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
          <div className="canvas-var-table">
            {vars.map(([k, v]) => (
              <div key={k} className="canvas-var-row" style={{ display: "flex", alignItems: "center" }}>
                <span className="mono" style={{ flex: 1 }}>{k}</span>
                {editingKey === k ? (
                  <>
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveVariable(k, editValue)}
                      autoFocus
                      style={{ flex: 2, fontSize: 12, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--accent-border)", background: "var(--input-bg)", color: "var(--text)", fontFamily: "var(--font-mono)" }}
                    />
                    <button className="btn btn-sm btn-primary" style={{ fontSize: 11, marginLeft: 4 }} disabled={varSaving} onClick={() => saveVariable(k, editValue)}>Save</button>
                    <button className="btn btn-sm" style={{ fontSize: 11, marginLeft: 2 }} onClick={() => setEditingKey(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="mono" style={{ flex: 2 }}>{v}</span>
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
              </div>
            ))}
            {vars.length === 0 && !addingVar && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", padding: 8 }}>No variables configured</div>
            )}
          </div>
        </div>

        {sorted.length > 0 && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Deployment History</h3>
            <div className="canvas-activity-list">
              {sorted.slice(0, 15).map((d) => (
                <button
                  key={d.id}
                  className="canvas-activity-row"
                  onClick={() => pushPanel({
                    type: "deployment-detail",
                    title: `Deployment ${d.version}`,
                    params: { id: d.id },
                  })}
                >
                  <span className={`badge badge-${d.status}`}>{d.status}</span>
                  <span className="canvas-activity-version">{d.version}</span>
                  <span className="canvas-activity-artifact">
                    {(artifacts ?? []).find((a) => a.id === d.artifactId)?.name ?? d.artifactId.slice(0, 8)}
                  </span>
                  <span className="canvas-activity-time">
                    {new Date(d.createdAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
