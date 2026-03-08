import { useState, useEffect } from "react";
import { getRecentDebrief, getDeployment, listDeployments, listPartitions, listArtifacts, listEnvironments } from "../../api.js";
import type { DebriefEntry, Partition, Deployment, Artifact, Environment, DecisionType } from "../../types.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import DebriefTimeline from "../DebriefTimeline.js";
import { useQuery } from "../../hooks/useQuery.js";

const DECISION_TYPES: { value: DecisionType; label: string }[] = [
  { value: "pipeline-plan", label: "Plan" },
  { value: "configuration-resolved", label: "Config" },
  { value: "variable-conflict", label: "Conflict" },
  { value: "health-check", label: "Health" },
  { value: "deployment-execution", label: "Execute" },
  { value: "deployment-verification", label: "Verify" },
  { value: "deployment-completion", label: "Complete" },
  { value: "deployment-failure", label: "Failure" },
  { value: "diagnostic-investigation", label: "Diagnostic" },
  { value: "environment-scan", label: "Scan" },
  { value: "system", label: "System" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDuration(start: string, end: string | null): string | null {
  if (!end) return null;
  const secs = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    succeeded: "Success",
    failed: "Failed",
    rolled_back: "Rolled Back",
    running: "Running",
    pending: "Pending",
    planning: "Planning",
    awaiting_approval: "Awaiting Approval",
    approved: "Approved",
    rejected: "Rejected",
  };
  return map[status] ?? status;
}

// ---------------------------------------------------------------------------
// Deployment detail sub-view for debrief drill-in
// ---------------------------------------------------------------------------
function DeploymentDebriefDetail({ deploymentId, onBack }: { deploymentId: string; onBack: () => void }) {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [debrief, setDebrief] = useState<DebriefEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const { data: artifacts } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const { data: environments } = useQuery<Environment[]>("list:environments", listEnvironments);

  useEffect(() => {
    setLoading(true);
    getDeployment(deploymentId)
      .then(({ deployment: d, debrief: db }) => { setDeployment(d); setDebrief(db); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [deploymentId]);

  if (loading) return <div className="loading">Loading deployment detail...</div>;
  if (!deployment) return <div className="error-msg">Deployment not found</div>;

  const artName = (artifacts ?? []).find((a) => a.id === deployment.artifactId)?.name ?? deployment.artifactId.slice(0, 8);
  const envName = (environments ?? []).find((e) => e.id === deployment.environmentId)?.name ?? deployment.environmentId.slice(0, 8);
  const duration = deployment.completedAt
    ? Math.round((new Date(deployment.completedAt).getTime() - new Date(deployment.createdAt).getTime()) / 1000)
    : null;
  const envoyEntries = debrief.filter((e) => e.agent === "envoy");

  return (
    <div>
      <button
        onClick={onBack}
        style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, marginBottom: 12, padding: 0 }}
      >
        ← Back to list
      </button>

      {/* Summary stat cards */}
      <div className="canvas-summary-strip" style={{ marginBottom: 16 }}>
        <div className="canvas-summary-item">
          <span className="canvas-summary-value" style={{ fontSize: 13 }}>{artName}</span>
          <span className="canvas-summary-label">Artifact</span>
        </div>
        <div className="canvas-summary-item">
          <span className="canvas-summary-value" style={{ fontSize: 13 }}>{new Date(deployment.createdAt).toLocaleString()}</span>
          <span className="canvas-summary-label">Started</span>
        </div>
        <div className="canvas-summary-item">
          <span className="canvas-summary-value" style={{ fontSize: 13 }}>{duration != null ? `${duration}s` : "—"}</span>
          <span className="canvas-summary-label">Duration</span>
        </div>
        <div className="canvas-summary-item">
          <span className="canvas-summary-value" style={{
            fontSize: 13,
            color: deployment.status === "succeeded" ? "var(--status-succeeded)" : deployment.status === "failed" ? "var(--status-failed)" : "var(--text)",
          }}>
            {deployment.status}
          </span>
          <span className="canvas-summary-label">Status</span>
        </div>
      </div>

      {/* Synth's Assessment at time of deployment */}
      {deployment.recommendation && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Synth&rsquo;s Assessment</h3>
          <div style={{
            padding: "10px 14px", borderRadius: 6, fontSize: 13, color: "var(--text)", lineHeight: 1.5,
            background: "var(--surface)", border: "1px solid var(--border)",
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4, color: deployment.recommendation.verdict === "proceed" ? "var(--status-succeeded)" : deployment.recommendation.verdict === "caution" ? "var(--status-warning)" : "var(--status-failed)" }}>
              {deployment.recommendation.verdict === "proceed" ? "Proceed" : deployment.recommendation.verdict === "caution" ? "Proceed with Caution" : "Hold"}
            </div>
            {deployment.recommendation.summary}
            {deployment.recommendation.factors.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
                {deployment.recommendation.factors.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Executed Plan steps with durations */}
      {deployment.executionRecord && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Executed Plan</h3>
          <div className="canvas-timeline">
            {deployment.executionRecord.steps.map((step, i) => {
              const stepDuration = step.completedAt
                ? `${Math.round((new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000)}s`
                : "—";
              const dotColor = step.status === "completed" ? "var(--status-succeeded)" : step.status === "failed" ? "var(--status-failed)" : "var(--status-warning)";
              return (
                <div key={i} className="canvas-timeline-entry" style={{ cursor: "default" }}>
                  <div className="canvas-timeline-dot" style={{ background: dotColor }} />
                  <div className="canvas-timeline-content">
                    <div className="canvas-timeline-header">
                      <span className="canvas-timeline-type">{step.status}</span>
                      <span className="canvas-timeline-time">{stepDuration}</span>
                    </div>
                    <div className="canvas-timeline-decision">{step.description}</div>
                    {step.output && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{step.output}</div>}
                    {step.error && <div style={{ fontSize: 11, color: "var(--status-failed)", marginTop: 2 }}>{step.error}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Config Diff — old vs new, colored by line type */}
      {deployment.plan?.diffFromCurrent && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Configuration Changes</h3>
          <div style={{ borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", padding: "12px 16px" }}>
            {deployment.plan.diffFromCurrent.split("\n").filter(Boolean).map((line, i) => {
              const isAdded = line.startsWith("+");
              const isRemoved = line.startsWith("-");
              return (
                <div key={i} style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: isAdded ? "var(--status-succeeded)" : isRemoved ? "var(--status-failed)" : "var(--text-muted)",
                  textDecoration: isRemoved ? "line-through" : undefined,
                }}>
                  {line}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Variables at time of deployment */}
      {Object.keys(deployment.variables).length > 0 && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Variables</h3>
          <div className="canvas-var-table">
            {Object.entries(deployment.variables).map(([k, v]) => (
              <div key={k} className="canvas-var-row">
                <span className="mono">{k}</span>
                <span className="mono">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Envoy Notes */}
      {envoyEntries.length > 0 && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Envoy Notes</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--text)", lineHeight: 1.7 }}>
            {envoyEntries.map((entry) => (
              <li key={entry.id} style={{ marginBottom: 4 }}>
                <span style={{ color: "var(--text)" }}>{entry.decision}</span>
                {entry.reasoning && (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}> — {entry.reasoning}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Rollback Plan */}
      {deployment.rollbackPlan && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Rollback Plan</h3>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.5 }}>
            {deployment.rollbackPlan.reasoning}
          </div>
          <div className="canvas-timeline">
            {deployment.rollbackPlan.steps.map((step, i) => (
              <div key={i} className="canvas-timeline-entry" style={{ cursor: "default" }}>
                <div className="canvas-timeline-dot" style={{ background: "var(--accent)" }} />
                <div className="canvas-timeline-content">
                  <div className="canvas-timeline-header">
                    <span className="canvas-timeline-type">{step.action}</span>
                    <span className="canvas-timeline-time">{step.target}</span>
                  </div>
                  <div className="canvas-timeline-decision">{step.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type TabId = "deployments" | "diagnostics" | "health" | "fulllog";

const TABS: { id: TabId; label: string }[] = [
  { id: "deployments", label: "Deployments" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "health",      label: "Health" },
  { id: "fulllog",     label: "Full Log" },
];

interface Props {
  title: string;
  filterPartitionId?: string;
  filterDecisionType?: string;
}

export default function DebriefPanel({ title, filterPartitionId, filterDecisionType }: Props) {
  const [tab, setTab] = useState<TabId>("deployments");
  const [filterPartition, setFilterPartition] = useState(filterPartitionId ?? "");
  const [filterType, setFilterType] = useState(filterDecisionType ?? "");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);

  const debriefKey = `debrief:${filterPartition}:${filterType}`;
  const { data: entries, loading: l1, error } = useQuery<DebriefEntry[]>(debriefKey, () =>
    getRecentDebrief({ limit: 100, partitionId: filterPartition || undefined, decisionType: filterType || undefined }),
  );
  const { data: deployments, loading: l2 } = useQuery<Deployment[]>("list:deployments", listDeployments);
  const { data: partitions } = useQuery<Partition[]>("list:partitions", listPartitions);
  const { data: artifacts } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const { data: environments } = useQuery<Environment[]>("list:environments", listEnvironments);

  const loading = l1 || l2;
  const safeEntries = entries ?? [];
  const safeDeployments = (deployments ?? []).slice().sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const diagnosticEntries = safeEntries.filter((e) =>
    !e.deploymentId && ["diagnostic-investigation", "variable-conflict"].includes(e.decisionType),
  );
  const healthEntries = safeEntries.filter((e) =>
    ["health-check", "environment-scan"].includes(e.decisionType),
  );

  const tabCounts: Record<TabId, number> = {
    deployments: safeDeployments.length,
    diagnostics: diagnosticEntries.length,
    health: healthEntries.length,
    fulllog: safeEntries.length,
  };

  const FINISHED_STATUSES = new Set(["succeeded", "failed", "rolled_back"]);

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {!selectedDeploymentId && (
          <>
            <div style={{ marginBottom: 20 }}>
              <h1 style={{ fontSize: 24, fontWeight: 500, color: "var(--text)", margin: "0 0 4px 0" }}>Debriefs</h1>
              <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
                Operational records of what was done, by whom, and what informed each decision.
              </p>
            </div>

            {/* Segmented tab control */}
            <div className="segmented-control" style={{ marginBottom: 20 }}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className={`segmented-control-btn ${tab === t.id ? "segmented-control-btn-active" : ""}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                  <span className="segmented-control-count">{tabCounts[t.id]}</span>
                </button>
              ))}
            </div>

            {loading && <div className="loading">Loading...</div>}
            {error && <div className="error-msg">{error.message}</div>}

            {/* ── Deployments tab ─────────────────────────────────────────── */}
            {tab === "deployments" && !loading && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {safeDeployments.length === 0 && (
                  <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>No deployments recorded.</div>
                )}
                {safeDeployments.map((dep) => {
                  const artName = (artifacts ?? []).find((a) => a.id === dep.artifactId)?.name ?? dep.artifactId.slice(0, 8);
                  const envName = (environments ?? []).find((e) => e.id === dep.environmentId)?.name ?? dep.environmentId.slice(0, 8);
                  const duration = formatDuration(dep.createdAt, dep.completedAt);
                  const isFinished = FINISHED_STATUSES.has(dep.status);
                  return (
                    <div
                      key={dep.id}
                      onClick={() => isFinished && setSelectedDeploymentId(dep.id)}
                      style={{
                        padding: "16px 20px",
                        borderRadius: 10,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        cursor: isFinished ? "pointer" : "default",
                        transition: "background 0.15s",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{artName}</span>
                          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{dep.version}</span>
                          <span style={{ color: "var(--text-muted)" }}>→</span>
                          <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{envName}</span>
                        </div>
                        <span
                          className={`badge badge-${dep.status}`}
                          style={{
                            borderRadius: 4,
                            fontFamily: "var(--font-mono)",
                            letterSpacing: "0.03em",
                            textTransform: "uppercase",
                            fontSize: 10,
                            border: "1px solid currentColor",
                          }}
                        >
                          {statusLabel(dep.status)}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 20, fontSize: 12, color: "var(--text-muted)" }}>
                        <span>{timeAgo(dep.createdAt)}</span>
                        {duration && <span>Duration: {duration}</span>}
                        {isFinished && (
                          <span style={{ color: "var(--accent)", fontWeight: 500 }}>View full debrief →</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Diagnostics tab ─────────────────────────────────────────── */}
            {tab === "diagnostics" && !loading && (
              diagnosticEntries.length === 0
                ? <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>No diagnostic investigations recorded.</div>
                : <DebriefTimeline entries={diagnosticEntries} />
            )}

            {/* ── Health tab ───────────────────────────────────────────────── */}
            {tab === "health" && !loading && (
              healthEntries.length === 0
                ? <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>No health or scan events recorded.</div>
                : <DebriefTimeline entries={healthEntries} />
            )}

            {/* ── Full Log tab ─────────────────────────────────────────────── */}
            {tab === "fulllog" && (
              <>
                <div className="card" style={{ marginBottom: 16, padding: "12px 16px" }}>
                  <div className="flex gap-8 items-center">
                    <span className="text-muted" style={{ fontSize: 12 }}>Filter:</span>
                    <select
                      value={filterPartition}
                      onChange={(e) => setFilterPartition(e.target.value)}
                      style={{ fontSize: 13, padding: "4px 8px" }}
                    >
                      <option value="">All Partitions</option>
                      {(partitions ?? []).map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                    <select
                      value={filterType}
                      onChange={(e) => setFilterType(e.target.value)}
                      style={{ fontSize: 13, padding: "4px 8px" }}
                    >
                      <option value="">All Types</option>
                      {DECISION_TYPES.map((dt) => (
                        <option key={dt.value} value={dt.value}>{dt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {!loading && <DebriefTimeline entries={safeEntries} />}
              </>
            )}
          </>
        )}

        {selectedDeploymentId && (
          <div style={{ padding: "0 16px" }}>
            <DeploymentDebriefDetail
              deploymentId={selectedDeploymentId}
              onBack={() => setSelectedDeploymentId(null)}
            />
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
