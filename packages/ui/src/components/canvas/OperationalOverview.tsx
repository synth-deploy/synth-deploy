import { useState, useEffect } from "react";
import {
  listDeployments,
  listPartitions,
  listEnvironments,
  listOperations,
  listOrders,
  getRecentDebrief,
  getDeploymentContext,
  getHealth,
  getSystemState,
} from "../../api.js";
import type { Deployment, Partition, Environment, Operation, Order, DebriefEntry } from "../../types.js";
import type { DeploymentContext, SystemState, AlertSignal } from "../../api.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useSettings } from "../../context/SettingsContext.js";
import SectionHeader from "../SectionHeader.js";
import CommandEye from "../CommandEye.js";
import DeploymentParticles from "../DeploymentParticles.js";

// ---------------------------------------------------------------------------
// Top-level state-driven router
// ---------------------------------------------------------------------------

export default function OperationalOverview() {
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchState = () =>
      getSystemState()
        .then(setSystemState)
        .catch(() => {});

    fetchState().then(() => setLoading(false));

    const interval = setInterval(fetchState, 30000);

    const onFocus = () => fetchState();
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (loading) return <div className="loading">Loading...</div>;
  if (!systemState) return <div className="loading">Failed to load system state.</div>;

  switch (systemState.state) {
    case "empty":
      return <EmptyState />;
    case "alert":
      return <AlertState signals={systemState.signals} stats={systemState.stats} />;
    case "normal":
      return <NormalState stats={systemState.stats} />;
  }
}

// ---------------------------------------------------------------------------
// EmptyState — placeholder until guided onboarding (#137)
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="v2-dashboard">
      <div className="v2-empty-state" style={{ textAlign: "center", padding: "60px 20px" }}>
        <h2 style={{ color: "var(--agent-text)", fontSize: 20, marginBottom: 12 }}>
          Welcome to DeployStack
        </h2>
        <p style={{ color: "var(--agent-text-muted)", fontSize: 14, maxWidth: 400, margin: "0 auto" }}>
          No artifacts or envoys registered yet. Add an artifact to get started,
          or register an envoy to begin deploying.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AlertState — leads with actionable signals, then shows NormalState below
// ---------------------------------------------------------------------------

function AlertState({ signals, stats }: { signals: AlertSignal[]; stats: SystemState["stats"] }) {
  const { pushPanel } = useCanvas();

  return (
    <div className="v2-dashboard">
      {/* Alert banner */}
      <div style={{
        background: "rgba(220, 38, 38, 0.08)",
        border: "1px solid rgba(220, 38, 38, 0.25)",
        borderRadius: 8,
        padding: "16px",
        marginBottom: 16,
      }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: "#dc2626", marginBottom: 8 }}>
          Attention Required
        </div>
        <div style={{ fontSize: 13, color: "var(--agent-text-muted)" }}>
          {signals.length} signal{signals.length !== 1 ? "s" : ""} need review
        </div>
      </div>

      {/* Signal cards — each clickable for drill-in */}
      {signals.map((signal, i) => {
        const severityColor = signal.severity === "critical" ? "#dc2626" : "#f59e0b";
        return (
          <div
            key={i}
            onClick={() => {
              if (signal.relatedEntity) {
                const type = signal.relatedEntity.type;
                if (type === "environment") {
                  pushPanel({ type: "environment-detail", title: signal.relatedEntity.name, params: { id: signal.relatedEntity.id } });
                } else if (type === "deployment") {
                  pushPanel({ type: "deployment-detail", title: "Deployment", params: { id: signal.relatedEntity.id } });
                } else if (type === "envoy") {
                  pushPanel({ type: "envoy-registry", title: "Envoys", params: {} });
                }
              }
            }}
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "12px 16px", borderRadius: 8,
              border: `1px solid ${severityColor}30`,
              background: `${severityColor}08`,
              cursor: signal.relatedEntity ? "pointer" : "default",
              marginBottom: 8,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: severityColor, flexShrink: 0,
            }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--agent-text)" }}>
                {signal.title}
              </div>
              <div style={{ fontSize: 12, color: "var(--agent-text-muted)", marginTop: 2 }}>
                {signal.detail}
              </div>
            </div>
            {signal.relatedEntity && (
              <span style={{ fontSize: 11, color: "var(--agent-text-muted)" }}>
                {signal.relatedEntity.name} &rarr;
              </span>
            )}
          </div>
        );
      })}

      {/* Still show deployment authoring below signals */}
      <div style={{ marginTop: 24 }}>
        <NormalState stats={stats} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NormalState — preserves all existing OperationalOverview functionality
// ---------------------------------------------------------------------------

function NormalState({ stats: _stats }: { stats: SystemState["stats"] }) {
  const { pushPanel } = useCanvas();
  const { settings } = useSettings();

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [debriefEntries, setDebriefEntries] = useState<DebriefEntry[]>([]);
  const [agentContext, setAgentContext] = useState<DeploymentContext | null>(null);
  const [commandStatus, setCommandStatus] = useState<string>("observing");
  const [signalsExpanded, setSignalsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pulse, setPulse] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setPulse((p) => p + 1), 80);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    Promise.all([
      listDeployments(),
      listPartitions(),
      listEnvironments(),
      listOperations(),
      listOrders(),
      getRecentDebrief({ limit: 10 }),
      getDeploymentContext().catch(() => null),
      getHealth().catch(() => null),
    ])
      .then(([d, t, e, p, o, db, ctx, health]) => {
        setDeployments(d);
        setPartitions(t);
        setEnvironments(e);
        setOperations(p);
        setOrders(o);
        setDebriefEntries(db);
        setAgentContext(ctx);
        if (health) setCommandStatus("observing");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading...</div>;

  const activeDeployments = deployments.filter(
    (d) => d.status === "running" || d.status === "pending",
  );
  const debriefCount = debriefEntries.length;

  // Debrief status helpers
  const debriefStatusIcons: Record<string, { icon: string; color: string; bg: string }> = {
    complete: { icon: "\u2713", color: "#34d399", bg: "rgba(52,211,153,0.1)" },
    escalated: { icon: "\u2191", color: "#f87171", bg: "rgba(248,113,113,0.1)" },
    decision: { icon: "\u25C6", color: "#63e1be", bg: "rgba(99,225,190,0.1)" },
  };

  function getDebriefStatus(entry: DebriefEntry): string {
    if (entry.decisionType === "deployment-failure" || entry.decisionType === "diagnostic-investigation") return "escalated";
    if (entry.decisionType === "deployment-completion") return "complete";
    return "decision";
  }

  function getDebriefRouting(entry: DebriefEntry): string {
    if (entry.decisionType === "deployment-failure") return "\u2192 Command";
    if (entry.decisionType === "deployment-completion") return "filed";
    return "held";
  }

  return (
    <div className="v2-dashboard">
      <div className="v2-breadcrumb">
        {settings?.coBranding ? (
          <span className="v2-breadcrumb-logo v2-cobranding-logo">
            <img
              src={settings.coBranding.logoUrl}
              alt={settings.coBranding.operatorName}
              className="v2-cobranding-img"
            />
            <span
              className="v2-cobranding-name"
              style={settings.coBranding.accentColor ? { color: settings.coBranding.accentColor } : undefined}
            >
              {settings.coBranding.operatorName}
            </span>
            <span className="v2-cobranding-powered-by">by DeployStack</span>
          </span>
        ) : (
          <span className="v2-breadcrumb-logo">DeployStack</span>
        )}
      </div>

      {/* Command status card */}
      <div className="v2-command-card">
        <div className="v2-command-card-glow" />
        <div className="v2-command-card-content">
          <CommandEye />
          <div className="v2-command-info">
            <div className="v2-command-title-row">
              <span className="v2-command-label">Command</span>
              <div className="v2-command-status-badge">
                <span>{commandStatus.toUpperCase()}</span>
              </div>
            </div>
            <div className="v2-command-subtitle">
              Monitoring {partitions.length} Partitions &middot; {environments.length} Environments &middot; {orders.length} Orders pending
            </div>
            <div className="v2-command-stats">
              <div className="v2-command-stat">
                <span className="v2-command-stat-value">{debriefCount}</span>
                <span className="v2-command-stat-label">Decisions today</span>
              </div>
              <div className="v2-command-stat">
                <span className="v2-command-stat-value">{activeDeployments.length}</span>
                <span className="v2-command-stat-label">Active deploys</span>
              </div>
              <div className="v2-command-stat">
                <span className="v2-command-stat-value">{agentContext?.signals.filter((s) => s.severity === "critical").length ?? 0}</span>
                <span className="v2-command-stat-label">Escalations</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Active signals section — collapsible */}
      {agentContext && agentContext.signals.length > 0 && (
        <>
          <div
            className="v2-signals-collapse-header"
            onClick={() => setSignalsExpanded(!signalsExpanded)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 16px",
              cursor: "pointer",
              borderRadius: 8,
              border: "1px solid var(--agent-border)",
              background: "var(--agent-card-bg)",
              marginBottom: signalsExpanded ? 8 : 0,
              userSelect: "none",
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: agentContext.signals.some(s => s.severity === "critical") ? "#dc2626"
                : agentContext.signals.some(s => s.severity === "warning") ? "#f59e0b" : "#2563eb",
              flexShrink: 0,
            }} />
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--agent-text)" }}>
              Active Signals
            </span>
            <span style={{
              fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)",
              background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: 10,
            }}>
              {agentContext.signals.length}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--agent-text-muted)" }}>
              {signalsExpanded ? "\u25B2" : "\u25BC"}
            </span>
          </div>
          {signalsExpanded && (
            <div className="v2-signals-list" style={{ gap: 4 }}>
              {agentContext.signals.map((signal, i) => {
                const severityColor =
                  signal.severity === "critical" ? "#dc2626"
                  : signal.severity === "warning" ? "#f59e0b"
                  : "#2563eb";
                return (
                  <div
                    key={i}
                    className={`v2-signal-compact v2-signal-${signal.severity}`}
                    onClick={() =>
                      pushPanel({
                        type: "signal-detail",
                        title: signal.title,
                        params: { signal: JSON.stringify(signal) },
                      })
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--agent-border)",
                      background: "var(--agent-card-bg)",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: severityColor, flexShrink: 0,
                    }} />
                    <span style={{ fontWeight: 500, color: "var(--agent-text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {signal.title}
                    </span>
                    {signal.relatedEntity && (
                      <span style={{ fontSize: 11, color: "var(--agent-text-muted)", flexShrink: 0 }}>
                        {signal.relatedEntity.name}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Operations section */}
      <SectionHeader
        color="#6b7280"
        shape="square"
        label="Operations"
        subtitle="blueprints, static until ordered"
        onClick={() =>
          pushPanel({ type: "operation-list", title: "Operations", params: {} })
        }
      />
      <div className="v2-operations-grid">
        {operations.map((op) => (
          <div
            key={op.id}
            className="v2-operation-card"
            onClick={() =>
              pushPanel({
                type: "operation-list",
                title: "Operations",
                params: {},
              })
            }
          >
            <div className="v2-operation-card-grid-bg" />
            <div className="v2-operation-card-inner">
              <div className="v2-operation-id">{op.id.slice(0, 8)}</div>
              <div className="v2-operation-name">{op.name}</div>
              <div className="v2-operation-meta">
                {op.steps.length} steps &middot; {op.environmentIds.length} env{op.environmentIds.length !== 1 ? "s" : ""}
              </div>
              <div className="v2-operation-steps">
                {Array.from({ length: Math.min(op.steps.length, 10) }).map((_, i) => (
                  <div key={i} className="v2-operation-step-bar" />
                ))}
              </div>
            </div>
          </div>
        ))}
        {operations.length === 0 && (
          <div className="v2-empty-hint">No operations yet. Use the Command Channel to create one.</div>
        )}
      </div>

      {/* Orders section */}
      <SectionHeader
        color="#f59e0b"
        shape="square"
        label="Orders"
        subtitle="versioned snapshots, stacked and ready"
        onClick={() =>
          pushPanel({ type: "order-list", title: "Orders", params: {} })
        }
      />
      <div className="v2-orders-list">
        {orders.map((order, i) => {
          const opName =
            operations.find((p) => p.id === order.operationId)?.name ?? order.operationName;
          const partName =
            partitions.find((t) => t.id === order.partitionId)?.name ?? order.partitionId.slice(0, 8);
          const envName =
            environments.find((e) => e.id === order.environmentId)?.name ?? order.environmentName;
          return (
            <div
              key={order.id}
              className="v2-order-row"
              onClick={() =>
                pushPanel({
                  type: "order-detail",
                  title: `Order ${order.id.slice(0, 8)}`,
                  params: { id: order.id },
                })
              }
              style={{
                borderColor: "rgba(245,158,11,0.15)",
                background: "rgba(245,158,11,0.04)",
                transform: `translateY(${Math.sin(pulse * 0.05 + i * 0.8) * 1}px)`,
              }}
            >
              <div className="v2-order-stack-icon">
                <div className="v2-order-stack-line" />
                <div className="v2-order-stack-line" style={{ opacity: 0.6 }} />
                <div className="v2-order-stack-line" style={{ opacity: 0.3 }} />
              </div>
              <div className="v2-order-info">
                <div className="v2-order-title">
                  <span className="v2-order-op-name">{opName}</span>
                  <span className="v2-order-version">v{order.version}</span>
                </div>
                <div className="v2-order-target">
                  {partName} &rarr; {envName} &middot;{" "}
                  {new Date(order.createdAt).toLocaleString()}
                </div>
              </div>
              <button
                className="v2-order-deploy-btn"
                style={{
                  background: "rgba(99,225,190,0.12)",
                  border: "1px solid rgba(99,225,190,0.3)",
                  color: "#63e1be",
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "3px 10px",
                  borderRadius: 4,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  pushPanel({
                    type: "deployment-authoring",
                    title: "Deploy Order",
                    params: { orderId: order.id },
                  });
                }}
              >
                DEPLOY
              </button>
              <div className="v2-order-status-pill">
                <span>QUEUED</span>
              </div>
            </div>
          );
        })}
        {orders.length === 0 && (
          <div className="v2-empty-hint">No orders pending.</div>
        )}
      </div>

      {/* Deployment particles */}
      {activeDeployments.length > 0 && (
        <div className="v2-deployment-particles-section">
          <span className="v2-particles-label">
            Deployments &mdash; routing Orders to Envoys
          </span>
          <DeploymentParticles />
          <div className="v2-active-deploys-row">
            {activeDeployments.slice(0, 4).map((d) => {
              const opName =
                operations.find((p) => p.id === d.operationId)?.name ?? d.operationId.slice(0, 8);
              const partName =
                partitions.find((t) => t.id === d.partitionId)?.name ?? d.partitionId.slice(0, 8);
              return (
                <div
                  key={d.id}
                  className="v2-active-deploy-tag"
                  onClick={() =>
                    pushPanel({
                      type: "deployment-detail",
                      title: `Deployment ${d.version}`,
                      params: { id: d.id },
                    })
                  }
                >
                  {d.version} &rarr; {partName} ({opName})
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ height: 24 }} />

      {/* Partitions section */}
      <SectionHeader
        color="#818cf8"
        shape="hollow"
        label="Partitions"
        subtitle="isolated boundaries, each walled off"
        count={partitions.length}
        onClick={() =>
          pushPanel({ type: "partition-list", title: "Partitions", params: {} })
        }
      />
      <div className="v2-partitions-grid">
        {partitions.map((p) => {
          const orderCount = orders.filter((o) => o.partitionId === p.id).length;
          // Treat partitions with no variables, no orders, and old dates as dormant
          const isDormant = Object.keys(p.variables).length === 0 && orderCount === 0;
          return (
            <div
              key={p.id}
              className={`v2-partition-card ${isDormant ? "v2-partition-dormant" : ""}`}
              onClick={() => {
                if (!isDormant) {
                  pushPanel({
                    type: "partition-detail",
                    title: p.name,
                    params: { id: p.id },
                  });
                }
              }}
            >
              {!isDormant && (
                <>
                  <div className="v2-partition-barrier-top" />
                  <div className="v2-partition-barrier-bottom" />
                </>
              )}
              <div className="v2-partition-name">{p.name}</div>
              <div className="v2-partition-envs">
                {environments.map((e) => (
                  <div
                    key={e.id}
                    className={`v2-partition-env-badge ${isDormant ? "v2-partition-env-dormant" : ""}`}
                  >
                    {e.name}
                  </div>
                ))}
              </div>
              <div className="v2-partition-meta">
                {isDormant
                  ? "Dormant"
                  : `${orderCount} order${orderCount !== 1 ? "s" : ""} pending`}
              </div>
            </div>
          );
        })}
        {partitions.length === 0 && (
          <div className="v2-empty-hint">No partitions yet.</div>
        )}
      </div>

      {/* Envoys section — shown as deployment context summary */}
      <SectionHeader
        color="#34d399"
        shape="circle"
        label="Envoys"
        subtitle="on the ground, executing and reporting"
        onClick={() =>
          pushPanel({ type: "envoy-registry", title: "Envoys", params: {} })
        }
      />
      <div className="v2-envoys-list">
        {agentContext?.environmentSummary.map((envSummary) => {
          const isExecuting = deployments.some(
            (d) => d.environmentId === envSummary.id && d.status === "running",
          );
          const statusCfg = isExecuting
            ? { color: "#63e1be", bg: "rgba(99,225,190,0.04)", border: "rgba(99,225,190,0.2)", label: "EXECUTING" }
            : { color: "#6b7280", bg: "rgba(15,20,30,0.4)", border: "rgba(107,114,128,0.12)", label: "AWAITING ORDERS" };
          return (
            <div
              key={envSummary.id}
              className="v2-envoy-row"
              style={{ background: statusCfg.bg, borderColor: statusCfg.border }}
              onClick={() =>
                pushPanel({
                  type: "environment-detail",
                  title: envSummary.name,
                  params: { id: envSummary.id },
                })
              }
            >
              <div className="v2-envoy-indicator">
                <div
                  className="v2-envoy-ring"
                  style={{
                    borderColor: statusCfg.color,
                    opacity: isExecuting
                      ? 0.3 + 0.3 * Math.sin(tick * 0.1)
                      : 0.15,
                  }}
                />
                {isExecuting && (
                  <div className="v2-envoy-spinner" style={{ borderTopColor: statusCfg.color }} />
                )}
                <div
                  className="v2-envoy-dot"
                  style={{
                    background: statusCfg.color,
                    opacity: isExecuting ? 0.8 : 0.3,
                  }}
                />
              </div>
              <div className="v2-envoy-info">
                <div className="v2-envoy-name-row">
                  <span className="v2-envoy-env-name">{envSummary.name}</span>
                  <span className="v2-envoy-deploy-count">{envSummary.deployCount} deploys</span>
                </div>
                <div className="v2-envoy-last-status">
                  {envSummary.lastDeployStatus
                    ? `Last: ${envSummary.lastDeployStatus}`
                    : "No deploys yet"}
                </div>
              </div>
              <div className="v2-envoy-status-pill" style={{ color: statusCfg.color, borderColor: `${statusCfg.color}30`, background: `${statusCfg.color}15` }}>
                {statusCfg.label}
              </div>
            </div>
          );
        })}
        {(!agentContext || agentContext.environmentSummary.length === 0) && (
          <div className="v2-empty-hint">No environments configured.</div>
        )}
      </div>

      {/* Debriefs section */}
      <SectionHeader
        color="#e879f9"
        shape="diamond"
        label="Debriefs"
        subtitle="reasoned records, handed off"
        onClick={() =>
          pushPanel({ type: "debrief", title: "Debrief", params: {} })
        }
      />
      <div className="v2-debriefs-list">
        {debriefEntries.slice(0, 5).map((entry) => {
          const status = getDebriefStatus(entry);
          const s = debriefStatusIcons[status] ?? debriefStatusIcons.decision;
          const routing = getDebriefRouting(entry);
          const partName =
            partitions.find((t) => t.id === entry.partitionId)?.name ?? "System";
          const statusBarColor =
            status === "escalated"
              ? "linear-gradient(180deg, #f87171, rgba(248,113,113,0.2))"
              : status === "complete"
                ? "linear-gradient(180deg, #34d399, rgba(52,211,153,0.2))"
                : "linear-gradient(180deg, #63e1be, rgba(99,225,190,0.2))";
          return (
            <div key={entry.id} className="v2-debrief-row">
              <div
                className="v2-debrief-status-bar"
                style={{ background: statusBarColor }}
              />
              <div className="v2-debrief-content">
                <div className="v2-debrief-icon" style={{ background: s.bg }}>
                  <span style={{ color: s.color }}>{s.icon}</span>
                </div>
                <div className="v2-debrief-body">
                  <div className="v2-debrief-header">
                    <span className="v2-debrief-time">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                    </span>
                    <span className="v2-debrief-from">
                      {entry.agent === "envoy" ? `Envoy \u203A ${partName}` : "Command"}
                    </span>
                    <span
                      className="v2-debrief-routing"
                      style={{
                        color: routing === "\u2192 Command" ? "#f87171" : "#6b7280",
                        background: routing === "\u2192 Command" ? "rgba(248,113,113,0.08)" : "rgba(107,114,128,0.08)",
                        borderColor: routing === "\u2192 Command" ? "rgba(248,113,113,0.15)" : "rgba(107,114,128,0.1)",
                      }}
                    >
                      {routing}
                    </span>
                  </div>
                  <div className="v2-debrief-summary">{entry.decision}</div>
                </div>
              </div>
            </div>
          );
        })}
        {debriefEntries.length === 0 && (
          <div className="v2-empty-hint">No debrief entries yet.</div>
        )}
      </div>

      {deployments.length === 0 && partitions.length === 0 && operations.length === 0 && (
        <div className="v2-empty-state">
          <p>No data yet. Use the Command Channel below to get started.</p>
        </div>
      )}
    </div>
  );
}
