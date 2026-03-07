import { useState } from "react";
import { getEnvoyHealth, listEnvironments, listPartitions } from "../../api.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import type { Environment, Partition } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  envoyId: string;
  title: string;
}

export default function EnvoyDetailPanel({ envoyId, title }: Props) {
  const { pushPanel } = useCanvas();
  const { data: envoy, loading: l1, error } = useQuery<EnvoyRegistryEntry>(`envoyHealth:${envoyId}`, () => getEnvoyHealth(envoyId));
  const { data: environments, loading: l2 } = useQuery<Environment[]>("list:environments", listEnvironments);
  const { data: partitions, loading: l3 } = useQuery<Partition[]>("list:partitions", listPartitions);
  const loading = l1 || l2 || l3;
  const [showEnvPicker, setShowEnvPicker] = useState(false);
  const [showPartPicker, setShowPartPicker] = useState(false);

  if (loading) {
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );
  }

  if (error || !envoy) {
    return (
      <CanvasPanelHost title={title}>
        <div className="error-msg">{error?.message ?? "Envoy not found"}</div>
      </CanvasPanelHost>
    );
  }

  const healthColor =
    envoy.health === "OK"
      ? "var(--status-succeeded)"
      : envoy.health === "Degraded"
        ? "var(--status-warning)"
        : "var(--status-failed)";

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div className="canvas-summary-strip">
          <div className="canvas-summary-item">
            <span className="canvas-summary-value" style={{ color: healthColor }}>
              {envoy.health}
            </span>
            <span className="canvas-summary-label">Health</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">
              {envoy.readiness?.ready ? "Ready" : "Not Ready"}
            </span>
            <span className="canvas-summary-label">Readiness</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">
              {envoy.summary?.totalDeployments ?? 0}
            </span>
            <span className="canvas-summary-label">Total Deployments</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">
              {envoy.summary?.executing ?? 0}
            </span>
            <span className="canvas-summary-label">Executing</span>
          </div>
        </div>

        <div className="canvas-section">
          <h3 className="canvas-section-title">Connection</h3>
          <div className="canvas-var-table">
            <div className="canvas-var-row">
              <span className="mono">URL</span>
              <span className="mono">{envoy.url}</span>
            </div>
            <div className="canvas-var-row">
              <span className="mono">Hostname</span>
              <span className="mono">{envoy.hostname ?? "Unknown"}</span>
            </div>
            <div className="canvas-var-row">
              <span className="mono">Last Seen</span>
              <span className="mono">
                {envoy.lastSeen
                  ? new Date(envoy.lastSeen).toLocaleString()
                  : "Never"}
              </span>
            </div>
          </div>
        </div>

        {envoy.readiness && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Readiness</h3>
            <div className="canvas-var-table">
              <div className="canvas-var-row">
                <span className="mono">Status</span>
                <span
                  className="mono"
                  style={{
                    color: envoy.readiness.ready ? "var(--status-succeeded)" : "var(--status-failed)",
                  }}
                >
                  {envoy.readiness.ready ? "READY" : "NOT READY"}
                </span>
              </div>
              <div className="canvas-var-row">
                <span className="mono">Reason</span>
                <span className="mono">{envoy.readiness.reason}</span>
              </div>
            </div>
          </div>
        )}

        {envoy.summary && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Deployment Summary</h3>
            <div className="canvas-var-table">
              <div className="canvas-var-row">
                <span className="mono">Succeeded</span>
                <span className="mono" style={{ color: "var(--status-succeeded)" }}>
                  {envoy.summary.succeeded}
                </span>
              </div>
              <div className="canvas-var-row">
                <span className="mono">Failed</span>
                <span className="mono" style={{ color: "var(--status-failed)" }}>
                  {envoy.summary.failed}
                </span>
              </div>
              <div className="canvas-var-row">
                <span className="mono">Executing</span>
                <span className="mono" style={{ color: "var(--accent)" }}>
                  {envoy.summary.executing}
                </span>
              </div>
              <div className="canvas-var-row">
                <span className="mono">Environments</span>
                <span className="mono">{envoy.summary.environments}</span>
              </div>
            </div>
          </div>
        )}

        {/* Connections — environments and partitions linked to this envoy */}
        <div className="canvas-section">
          <h3 className="canvas-section-title">Connections</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* Environments card */}
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Environments</span>
                <button
                  className="btn btn-sm"
                  onClick={() => setShowEnvPicker(!showEnvPicker)}
                  style={{ fontSize: 11, padding: "2px 8px" }}
                >
                  + Assign
                </button>
              </div>
              {showEnvPicker && (
                <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  {(environments ?? []).map((env) => (
                    <button
                      key={env.id}
                      className="canvas-activity-row"
                      style={{ fontSize: 12, padding: "4px 8px" }}
                      onClick={() => {
                        // TODO: wire to POST /api/envoys/:id/connections
                        pushPanel({ type: "environment-detail", title: env.name, params: { id: env.id } });
                        setShowEnvPicker(false);
                      }}
                    >
                      {env.name}
                    </button>
                  ))}
                </div>
              )}
              {(environments ?? []).length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {(environments ?? []).map((env) => (
                    <div key={env.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
                      <button
                        style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 500, padding: 0 }}
                        onClick={() => pushPanel({ type: "environment-detail", title: env.name, params: { id: env.id } })}
                      >
                        {env.name}
                      </button>
                      <button
                        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: "0 4px" }}
                        title="Unlink environment"
                        onClick={() => {/* TODO: wire to DELETE /api/envoys/:id/connections/environment/:targetId */}}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No environments linked</div>
              )}
            </div>

            {/* Partitions card */}
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Partitions</span>
                <button
                  className="btn btn-sm"
                  onClick={() => setShowPartPicker(!showPartPicker)}
                  style={{ fontSize: 11, padding: "2px 8px" }}
                >
                  + Assign
                </button>
              </div>
              {showPartPicker && (
                <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  {(partitions ?? []).map((part) => (
                    <button
                      key={part.id}
                      className="canvas-activity-row"
                      style={{ fontSize: 12, padding: "4px 8px" }}
                      onClick={() => {
                        // TODO: wire to POST /api/envoys/:id/connections
                        pushPanel({ type: "partition-detail", title: part.name, params: { id: part.id } });
                        setShowPartPicker(false);
                      }}
                    >
                      {part.name}
                    </button>
                  ))}
                </div>
              )}
              {(partitions ?? []).length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {(partitions ?? []).map((part) => (
                    <div key={part.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0" }}>
                      <button
                        style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 500, padding: 0 }}
                        onClick={() => pushPanel({ type: "partition-detail", title: part.name, params: { id: part.id } })}
                      >
                        {part.name}
                      </button>
                      <button
                        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: "0 4px" }}
                        title="Unlink partition"
                        onClick={() => {/* TODO: wire to DELETE /api/envoys/:id/connections/partition/:targetId */}}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No partitions linked</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </CanvasPanelHost>
  );
}
