import { useState } from "react";
import { listEnvoys, listPartitions, listEnvironments } from "../../api.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import type { Partition, Environment } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import AddEnvoyModal from "../AddEnvoyModal.js";
import { useQuery } from "../../hooks/useQuery.js";



const SECTIONS = [
  { id: "envoys", label: "Envoys" },
  { id: "environments", label: "Environments" },
  { id: "partitions", label: "Partitions" },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

export default function TopologyPanel({ title }: { title?: string }) {
  const [section, setSection] = useState<Section>("envoys");
  const [showAddEnvoy, setShowAddEnvoy] = useState(false);
  const { pushPanel } = useCanvas();

  const { data: envoys } = useQuery<EnvoyRegistryEntry[]>("list:envoys", listEnvoys);
  const { data: environments } = useQuery<Environment[]>("list:environments", listEnvironments);
  const { data: partitions } = useQuery<Partition[]>("list:partitions", listPartitions);

  const addLabel =
    section === "envoys"
      ? "Add Envoy"
      : section === "environments"
        ? "Add Environment"
        : "Add Partition";

  return (
    <CanvasPanelHost title={title ?? "Topology"}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 className="v6-page-title">Topology</h1>
          <p className="v6-page-subtitle">Your deployment infrastructure — envoys, environments, and partitions.</p>
        </div>
        <button
          className="btn-accent-outline"
          onClick={() => {
            if (section === "envoys") setShowAddEnvoy(true);
          }}
        >
          <svg className="icon-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {addLabel}
        </button>
      </div>

      <div className="segmented-control" style={{ marginBottom: 20 }}>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`segmented-control-btn ${section === s.id ? "segmented-control-btn-active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === "envoys" && (
        <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden" }}>
          {envoys?.map((e) => (
            <button
              key={e.id}
              className="canvas-activity-row"
              style={{ borderBottom: "1px solid var(--border)" }}
              onClick={() => pushPanel({ type: "envoy-detail", title: e.hostname ?? e.id, params: { id: e.id } })}
            >
              <span
                className="status-pip"
                style={{ background: e.health === "OK" ? "var(--status-succeeded)" : e.health === "Degraded" ? "var(--status-warning)" : "var(--status-failed)" }}
              />
              <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: 14 }}>{e.hostname ?? e.id}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{e.lastSeen}</span>
            </button>
          ))}
          {(!envoys || envoys.length === 0) && (
            <div className="empty-state"><p>No envoys registered yet.</p></div>
          )}
        </div>
      )}

      {section === "environments" && (
        <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden" }}>
          {environments?.map((env) => (
            <button
              key={env.id}
              className="canvas-activity-row"
              style={{ borderBottom: "1px solid var(--border)" }}
              onClick={() => pushPanel({ type: "environment-detail", title: env.name, params: { id: env.id } })}
            >
              <span style={{ fontWeight: 600, fontSize: 14 }}>{env.name}</span>
            </button>
          ))}
          {(!environments || environments.length === 0) && (
            <div className="empty-state"><p>No environments created yet.</p></div>
          )}
        </div>
      )}

      {section === "partitions" && (
        <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden" }}>
          {partitions?.map((p) => (
            <button
              key={p.id}
              className="canvas-activity-row"
              style={{ borderBottom: "1px solid var(--border)" }}
              onClick={() => pushPanel({ type: "partition-detail", title: p.name, params: { id: p.id } })}
            >
              <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 12, marginLeft: "auto" }}>
                {Object.keys(p.variables).length} variable{Object.keys(p.variables).length !== 1 ? "s" : ""}
              </span>
            </button>
          ))}
          {(!partitions || partitions.length === 0) && (
            <div className="empty-state"><p>No partitions created yet.</p></div>
          )}
        </div>
      )}
      {showAddEnvoy && <AddEnvoyModal onClose={() => setShowAddEnvoy(false)} />}
    </CanvasPanelHost>
  );
}
