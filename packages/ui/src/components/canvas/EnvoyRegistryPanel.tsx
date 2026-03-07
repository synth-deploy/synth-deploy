import { listEnvoys } from "../../api.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import { useQuery } from "../../hooks/useQuery.js";

interface Props {
  title: string;
}

const healthColor = (h: EnvoyRegistryEntry["health"]) =>
  h === "OK" ? "var(--status-succeeded)" : h === "Degraded" ? "var(--status-warning)" : "var(--status-failed)";

export default function EnvoyRegistryPanel({ title }: Props) {
  const { pushPanel } = useCanvas();
  const { data: envoys, loading } = useQuery<EnvoyRegistryEntry[]>("list:envoys", listEnvoys);

  if (loading) {
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );
  }

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div style={{ padding: "0 16px", marginBottom: 16 }}>
          <h1 className="v6-page-title">Envoy Fleet</h1>
          <p className="v6-page-subtitle">
            Agents executing deployments on your infrastructure.
            <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
              {(envoys ?? []).length} registered
            </span>
          </p>
        </div>
        <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden", margin: "0 16px" }}>
          {(envoys ?? []).map((envoy) => (
            <button
              key={envoy.id}
              className="canvas-activity-row"
              style={{ borderBottom: "1px solid var(--border)" }}
              onClick={() =>
                pushPanel({
                  type: "envoy-detail",
                  title: `Envoy: ${envoy.hostname ?? envoy.id}`,
                  params: { id: envoy.id },
                })
              }
            >
              <span
                className="status-pip"
                style={{
                  background: healthColor(envoy.health),
                  opacity: envoy.health === "Unreachable" ? 0.3 : 0.8,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14, fontFamily: "var(--font-mono)" }}>
                    {envoy.hostname ?? envoy.id}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                    {envoy.url}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {envoy.lastSeen
                    ? `Last seen: ${new Date(envoy.lastSeen).toLocaleString()}`
                    : "Never connected"}
                  {envoy.summary &&
                    ` · ${envoy.summary.totalDeployments} deployments · ${envoy.summary.environments} environments`}
                </div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: healthColor(envoy.health),
                  fontFamily: "var(--font-mono)",
                }}
              >
                {envoy.health}
              </span>
            </button>
          ))}
          {(envoys ?? []).length === 0 && (
            <div className="empty-state">
              <p>No Envoys configured. Add an Envoy URL in Settings.</p>
            </div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
