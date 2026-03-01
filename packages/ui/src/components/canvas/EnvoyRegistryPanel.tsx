import { useState, useEffect } from "react";
import { listEnvoys } from "../../api.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import SectionHeader from "../SectionHeader.js";

interface Props {
  title: string;
}

const healthColor = (h: EnvoyRegistryEntry["health"]) =>
  h === "OK" ? "#16a34a" : h === "Degraded" ? "#ca8a04" : "#dc2626";

export default function EnvoyRegistryPanel({ title }: Props) {
  const { pushPanel } = useCanvas();
  const [envoys, setEnvoys] = useState<EnvoyRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listEnvoys()
      .then(setEnvoys)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
        <SectionHeader
          color="#34d399"
          shape="circle"
          label="Registered Envoys"
          subtitle="agents executing deployments"
        />
        <div className="v2-envoys-list">
          {envoys.map((envoy) => (
            <div
              key={envoy.id}
              className="v2-envoy-row"
              onClick={() =>
                pushPanel({
                  type: "envoy-detail",
                  title: `Envoy: ${envoy.hostname ?? envoy.id}`,
                  params: { id: envoy.id },
                })
              }
              style={{
                background: "rgba(52,211,153,0.04)",
                borderColor: "rgba(52,211,153,0.15)",
                border: "1px solid rgba(52,211,153,0.15)",
                borderRadius: 8,
                padding: "12px 16px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: healthColor(envoy.health),
                  opacity: envoy.health === "Unreachable" ? 0.3 : 0.8,
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {envoy.hostname ?? envoy.id}
                  </span>
                  <span style={{ fontSize: 12, color: "#888", fontFamily: "monospace" }}>
                    {envoy.url}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>
                  {envoy.lastSeen
                    ? `Last seen: ${new Date(envoy.lastSeen).toLocaleString()}`
                    : "Never connected"}
                  {envoy.summary &&
                    ` · ${envoy.summary.totalDeployments} deployments · ${envoy.summary.environments} environments`}
                </div>
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: healthColor(envoy.health),
                  border: `1px solid ${healthColor(envoy.health)}30`,
                  background: `${healthColor(envoy.health)}15`,
                  borderRadius: 12,
                  padding: "2px 10px",
                }}
              >
                {envoy.health}
              </div>
            </div>
          ))}
          {envoys.length === 0 && (
            <div style={{ color: "#666", fontSize: 13, padding: "16px 0" }}>
              No Envoys configured. Add an Envoy URL in Settings.
            </div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
