import { useState } from "react";
import { listEnvoys, listPartitions, listEnvironments } from "../../api.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import type { Partition, Environment } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import AddEnvoyModal from "../AddEnvoyModal.js";
import AddEnvironmentModal from "../AddEnvironmentModal.js";
import AddPartitionModal from "../AddPartitionModal.js";
import { useQuery } from "../../hooks/useQuery.js";



type Section = "envoys" | "environments" | "partitions";

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function TopologyPanel({ title }: { title?: string }) {
  const [section, setSection] = useState<Section>("envoys");
  const [showAddEnvoy, setShowAddEnvoy] = useState(false);
  const [showAddEnvironment, setShowAddEnvironment] = useState(false);
  const [showAddPartition, setShowAddPartition] = useState(false);
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
    <CanvasPanelHost title={title ?? "Topology"} noBreadcrumb>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 className="v6-page-title">Topology</h1>
          <p className="v6-page-subtitle">Your deployment infrastructure — envoys, environments, and partitions.</p>
        </div>
        <button
          className="btn-accent-outline"
          onClick={() => {
            if (section === "envoys") setShowAddEnvoy(true);
            else if (section === "environments") setShowAddEnvironment(true);
            else if (section === "partitions") setShowAddPartition(true);
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
        {[
          { id: "envoys" as const, label: "Envoys", count: envoys?.length ?? 0 },
          { id: "environments" as const, label: "Environments", count: environments?.length ?? 0 },
          { id: "partitions" as const, label: "Partitions", count: partitions?.length ?? 0 },
        ].map((s) => (
          <button
            key={s.id}
            className={`segmented-control-btn ${section === s.id ? "segmented-control-btn-active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
            {s.count > 0 && (
              <span style={{ fontSize: 10, color: section === s.id ? "var(--text-secondary)" : "var(--text-muted)", fontWeight: 400, marginLeft: 4 }}>
                {s.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {section === "envoys" && (
        <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", padding: 6 }}>
          {envoys?.map((e) => {
            const healthColor = e.health === "OK" ? "var(--status-succeeded)" : e.health === "Degraded" ? "var(--status-warning)" : "var(--status-failed)";
            const envName = e.assignedEnvironments[0] ?? null;
            const isProd = envName?.toLowerCase().includes("prod");
            return (
              <button
                key={e.id}
                onClick={() => pushPanel({ type: "envoy-detail", title: e.name, params: { id: e.id } })}
                style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", width: "100%",
                  background: "transparent", border: "none", borderBottom: "1px solid var(--border)",
                  cursor: "pointer", textAlign: "left",
                }}
              >
                <span className="status-pip" style={{ background: healthColor, flexShrink: 0, width: 8, height: 8 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--text)" }}>{e.name}</span>
                    {envName && (
                      <span style={{
                        padding: "1px 7px", borderRadius: 3, fontSize: 10, fontWeight: 600,
                        fontFamily: "var(--font-mono)",
                        background: isProd ? "var(--status-failed-soft, color-mix(in srgb, var(--status-failed) 12%, transparent))" : "var(--accent-soft, color-mix(in srgb, var(--accent) 12%, transparent))",
                        color: isProd ? "var(--status-failed)" : "var(--accent)",
                      }}>{envName}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font)" }}>
                    {[e.os, e.lastSeen ? `Last seen ${timeAgo(e.lastSeen)}` : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {e.summary && (
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", lineHeight: 1 }}>{e.summary.totalDeployments}</div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>plans stored</div>
                  </div>
                )}
                <svg width="16" height="16" viewBox="0 0 16 16" style={{ opacity: 0.3, flexShrink: 0 }}>
                  <path d="M6 4l4 4-4 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            );
          })}
          {(!envoys || envoys.length === 0) && (
            <div className="empty-state"><p>No envoys registered yet.</p></div>
          )}
        </div>
      )}

      {section === "environments" && (
        <div>
          {environments?.map((env) => {
            const assigned = envoys?.filter((e) => e.assignedEnvironments.includes(env.name)) ?? [];
            const envoyCount = assigned.length;
            const healthColor =
              envoyCount === 0
                ? "var(--text-faint, var(--text-muted))"
                : assigned.some((e) => e.health === "Unreachable")
                  ? "var(--status-failed)"
                  : assigned.some((e) => e.health === "Degraded")
                    ? "var(--status-warning)"
                    : "var(--status-succeeded)";
            return (
              <button
                key={env.id}
                onClick={() => pushPanel({ type: "environment-detail", title: env.name, params: { id: env.id } })}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "18px 22px", borderRadius: 10, marginBottom: 10,
                  background: "var(--surface)", border: "1px solid var(--border)",
                  cursor: "pointer", transition: "background 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className="status-pip" style={{ background: healthColor, width: 8, height: 8, flexShrink: 0 }} />
                    <span style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>{env.name}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                      {envoyCount} envoy{envoyCount !== 1 ? "s" : ""}
                    </span>
                    <svg width="16" height="16" viewBox="0 0 16 16" style={{ opacity: 0.3, flexShrink: 0 }}>
                      <path d="M6 4l4 4-4 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>
                <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, lineHeight: 1.5, paddingLeft: 18 }}>
                  {Object.keys(env.variables).length} variable{Object.keys(env.variables).length !== 1 ? "s" : ""} configured
                </p>
              </button>
            );
          })}
          {(!environments || environments.length === 0) && (
            <div className="empty-state"><p>No environments created yet.</p></div>
          )}
        </div>
      )}

      {section === "partitions" && (
        <div>
          {partitions?.map((p) => {
            const varCount = Object.keys(p.variables).length;
            return (
              <button
                key={p.id}
                onClick={() => pushPanel({ type: "partition-detail", title: p.name, params: { id: p.id } })}
                style={{
                  display: "flex", alignItems: "center", gap: 16, padding: "16px 20px",
                  borderRadius: 10, marginBottom: 8, width: "100%", textAlign: "left",
                  background: "var(--surface)", border: "1px solid var(--border)",
                  cursor: "pointer", transition: "background 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "var(--surface)")}
              >
                <span className="status-pip" style={{ background: "var(--status-succeeded)", width: 8, height: 8, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                    {varCount} scoped variable{varCount !== 1 ? "s" : ""}
                  </div>
                </div>
                <span style={{
                  padding: "2px 9px", borderRadius: 4, fontSize: 10, fontWeight: 600, flexShrink: 0,
                  fontFamily: "var(--font-mono)", textTransform: "uppercase",
                  background: "color-mix(in srgb, var(--status-succeeded) 12%, transparent)",
                  color: "var(--status-succeeded)",
                  border: "1px solid color-mix(in srgb, var(--status-succeeded) 25%, transparent)",
                }}>Active</span>
                <svg width="16" height="16" viewBox="0 0 16 16" style={{ opacity: 0.3, flexShrink: 0 }}>
                  <path d="M6 4l4 4-4 4" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            );
          })}
          {(!partitions || partitions.length === 0) && (
            <div className="empty-state"><p>No partitions created yet.</p></div>
          )}
        </div>
      )}
      {showAddEnvoy && <AddEnvoyModal onClose={() => setShowAddEnvoy(false)} />}
      {showAddEnvironment && <AddEnvironmentModal onClose={() => setShowAddEnvironment(false)} />}
      {showAddPartition && <AddPartitionModal onClose={() => setShowAddPartition(false)} />}
    </CanvasPanelHost>
  );
}
