import { getEnvoyHealth } from "../../api.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import { useQuery } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  envoyId: string;
  title: string;
}

export default function EnvoyDetailPanel({ envoyId, title }: Props) {
  const { data: envoy, loading, error } = useQuery<EnvoyRegistryEntry>(`envoyHealth:${envoyId}`, () => getEnvoyHealth(envoyId));

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
      </div>
    </CanvasPanelHost>
  );
}
