import { useState, useEffect } from "react";
import { getRecentDebrief, getDeployment, listDeployments, listPartitions, listArtifacts, listEnvironments, getWhatsNew, requestRollbackPlan, executeRollback, retryDeployment } from "../../api.js";
import type { WhatsNewResult } from "../../api.js";
import type { DebriefEntry, Partition, Deployment, Artifact, Environment, DecisionType } from "../../types.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import DebriefTimeline from "../DebriefTimeline.js";
import { useQuery } from "../../hooks/useQuery.js";
import { useCanvas } from "../../context/CanvasContext.js";

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
function DeploymentDebriefDetail({ deploymentId, onBack, onNavigate }: { deploymentId: string; onBack: () => void; onNavigate: (id: string) => void }) {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [debrief, setDebrief] = useState<DebriefEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [whatsNew, setWhatsNew] = useState<WhatsNewResult | null>(null);
  const [rollbackRequesting, setRollbackRequesting] = useState(false);
  const [rollbackExecuting, setRollbackExecuting] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const { data: artifacts } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const { data: environments } = useQuery<Environment[]>("list:environments", listEnvironments);
  const { data: partitions } = useQuery<Partition[]>("list:partitions", listPartitions);
  const { data: allDeployments } = useQuery<Deployment[]>("list:deployments", listDeployments);
  const { pushPanel } = useCanvas();

  useEffect(() => {
    setLoading(true);
    getDeployment(deploymentId)
      .then(({ deployment: d, debrief: db }) => { setDeployment(d); setDebrief(db); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [deploymentId]);

  async function handleRequestRollbackPlan() {
    if (!deployment) return;
    setRollbackRequesting(true);
    setRollbackError(null);
    try {
      const { deployment: updated } = await requestRollbackPlan(deployment.id);
      setDeployment(updated);
    } catch (err) {
      setRollbackError(err instanceof Error ? err.message : "Failed to generate rollback plan");
    } finally {
      setRollbackRequesting(false);
    }
  }

  async function handleExecuteRollback() {
    if (!deployment) return;
    setRollbackExecuting(true);
    setRollbackError(null);
    try {
      const { deployment: updated } = await executeRollback(deployment.id);
      setDeployment(updated);
    } catch (err) {
      setRollbackError(err instanceof Error ? err.message : "Failed to execute rollback");
    } finally {
      setRollbackExecuting(false);
    }
  }

  async function handleRetry() {
    if (!deployment) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const { deployment: newDep } = await retryDeployment(deployment.id);
      onNavigate(newDep.id);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Failed to retry deployment");
    } finally {
      setRetrying(false);
    }
  }

  useEffect(() => {
    getWhatsNew(deploymentId).then(setWhatsNew).catch(() => {});
  }, [deploymentId]);

  if (loading) return <div className="loading">Loading deployment detail...</div>;
  if (!deployment) return <div className="error-msg">Deployment not found</div>;

  const safeAllDeployments = allDeployments ?? [];
  const artName = (artifacts ?? []).find((a) => a.id === deployment.artifactId)?.name ?? deployment.artifactId.slice(0, 8);
  const envName = (environments ?? []).find((e) => e.id === deployment.environmentId)?.name ?? deployment.environmentId?.slice(0, 8) ?? "—";
  const partName = deployment.partitionId
    ? ((partitions ?? []).find((p) => p.id === deployment.partitionId)?.name ?? null)
    : null;
  const duration = deployment.completedAt
    ? Math.round((new Date(deployment.completedAt).getTime() - new Date(deployment.createdAt).getTime()) / 1000)
    : null;
  const envoyEntries = debrief.filter((e) => e.agent === "envoy");
  // Fallback assessment from debrief when recommendation isn't persisted
  const assessmentEntry = !deployment.recommendation
    ? debrief.find((e) => e.decisionType === "plan-generation" || e.decisionType === "pipeline-plan")
    : null;
  // Fallback plan steps from debrief when plan isn't stored
  const executionEntries = !deployment.plan
    ? debrief.filter((e) => e.decisionType === "deployment-execution" || e.decisionType === "deployment-verification")
    : [];
  // Config changes fallback from debrief when plan.diffFromCurrent isn't available
  const configEntry = !deployment.plan?.diffFromCurrent
    ? debrief.find((e) => e.decisionType === "configuration-resolved")
    : null;

  const statusColor = deployment.status === "succeeded"
    ? "var(--status-succeeded)"
    : deployment.status === "failed"
    ? "var(--status-failed)"
    : deployment.status === "rolled_back"
    ? "var(--status-warning)"
    : "var(--text-muted)";

  const durationLabel = duration != null
    ? (duration >= 60 ? `${Math.floor(duration / 60)}m ${duration % 60}s` : `${duration}s`)
    : "—";

  const isFinished = (["succeeded", "failed", "rolled_back"] as string[]).includes(deployment.status);

  // Attempt chain: find previous (retryOf) and next (retriedBy) deployments
  const previousAttempt = deployment.retryOf
    ? safeAllDeployments.find((d) => d.id === deployment.retryOf) ?? null
    : null;
  const retriedByDep = safeAllDeployments.find((d) => d.retryOf === deployment.id) ?? null;

  // Calculate attempt number by following retryOf chain backwards
  let attemptNumber: number | null = null;
  if (deployment.retryOf || retriedByDep) {
    let count = 1;
    let currentId: string | undefined = deployment.retryOf;
    while (currentId) {
      count++;
      const prev = safeAllDeployments.find((d) => d.id === currentId);
      currentId = prev?.retryOf;
    }
    attemptNumber = count;
  }

  // Helper to describe a deployment for attempt chain links
  function attemptLabel(dep: Deployment): string {
    const aName = (artifacts ?? []).find((a) => a.id === dep.artifactId)?.name ?? dep.artifactId.slice(0, 8);
    const eName = (environments ?? []).find((e) => e.id === dep.environmentId)?.name ?? dep.environmentId?.slice(0, 8) ?? "—";
    return `${aName} ${dep.version} → ${eName}`;
  }

  return (
    <div>
      {/* Attempt chain banner */}
      {previousAttempt && (
        <div style={{
          marginBottom: 12,
          padding: "10px 14px",
          borderRadius: 8,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          <span style={{ color: "var(--text-muted)" }}>Retry of</span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{attemptLabel(previousAttempt)}</span>
          <span style={{ color: "var(--text-muted)" }}> — </span>
          <span
            style={{ color: "var(--accent)", cursor: "pointer", fontWeight: 500 }}
            onClick={() => onNavigate(previousAttempt.id)}
          >
            View previous attempt
          </span>
        </div>
      )}
      {retriedByDep && (
        <div style={{
          marginBottom: 12,
          padding: "10px 14px",
          borderRadius: 8,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          <span style={{ color: "var(--text-muted)" }}>Retried as</span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{attemptLabel(retriedByDep)}</span>
          <span style={{ color: "var(--text-muted)" }}> — </span>
          <span
            style={{ color: "var(--accent)", cursor: "pointer", fontWeight: 500 }}
            onClick={() => onNavigate(retriedByDep.id)}
          >
            View next attempt
          </span>
        </div>
      )}

      {/* Breadcrumb */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
        <span
          style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer" }}
          onClick={onBack}
        >
          Debriefs
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>›</span>
        <span
          style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer", fontWeight: 500 }}
          onClick={() => pushPanel({ type: "artifact-detail", title: artName, params: { artifactId: deployment.artifactId } })}
        >
          {artName}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>›</span>
        <span
          style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer", fontWeight: 500 }}
          onClick={() => pushPanel({ type: "environment-detail", title: envName, params: { id: deployment.environmentId } })}
        >
          {envName}
        </span>
        {partName && (
          <>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>›</span>
            <span
              style={{ fontSize: 13, color: "var(--accent)", cursor: "pointer", fontWeight: 500 }}
              onClick={() => pushPanel({ type: "partition-detail", title: partName, params: { id: deployment.partitionId! } })}
            >
              {partName}
            </span>
          </>
        )}
      </div>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 500, color: "var(--text)", margin: "0 0 6px 0", fontFamily: "var(--font-display)" }}>
            {artName}{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 400, color: "var(--text-muted)" }}>
              {deployment.version}
            </span>
            {attemptNumber != null && (
              <span style={{
                marginLeft: 8,
                padding: "2px 8px",
                borderRadius: 4,
                fontSize: 11,
                background: "color-mix(in srgb, var(--text) 6%, transparent)",
                color: "var(--text-muted)",
                fontFamily: "monospace",
                border: "1px solid var(--border)",
                verticalAlign: "middle",
              }}>
                Attempt #{attemptNumber}
              </span>
            )}
          </h1>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
            → {envName}{partName ? ` · ${partName}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {retryError && (
            <span style={{ fontSize: 12, color: "var(--status-failed)" }}>{retryError}</span>
          )}
          {isFinished && (
            <button
              className="btn-secondary"
              style={{ fontSize: 12, padding: "4px 12px" }}
              disabled={retrying}
              onClick={handleRetry}
            >
              {retrying ? "Retrying…" : "Retry Deployment"}
            </button>
          )}
          <div className={`v2-deploy-status-pill v2-pill-${deployment.status}`}>
            {statusLabel(deployment.status)}
          </div>
        </div>
      </div>

      {/* What's New */}
      {whatsNew && (
        <div style={{
          marginBottom: 20,
          padding: "10px 14px",
          borderRadius: 8,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          fontSize: 12,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}>
          {whatsNew.isLatest ? (
            <>
              <span style={{ color: "var(--status-succeeded)", fontWeight: 600 }}>✓</span>
              <span style={{ color: "var(--text-muted)" }}>
                Up to date — <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{whatsNew.deployedVersion || "—"}</span> is the latest catalog version
              </span>
            </>
          ) : (
            <>
              <span style={{ color: "var(--status-warning)", fontWeight: 700 }}>↑</span>
              <span style={{ color: "var(--text-muted)" }}>
                Newer version available — deployed{" "}
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text)" }}>{whatsNew.deployedVersion || "—"}</span>
                , latest is{" "}
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text)" }}>{whatsNew.latestVersion}</span>
                {whatsNew.latestCreatedAt && (
                  <span style={{ color: "var(--text-muted)" }}> (added {timeAgo(whatsNew.latestCreatedAt)})</span>
                )}
              </span>
            </>
          )}
        </div>
      )}

      {/* Summary stat cards */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        {[
          { label: "Artifact", value: artName },
          { label: "Started", value: new Date(deployment.createdAt).toLocaleString() },
          { label: "Duration", value: durationLabel },
          { label: "Status", value: statusLabel(deployment.status), color: statusColor },
        ].map((item) => (
          <div key={item.label} style={{ flex: 1, padding: "14px 16px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 5 }}>{item.label}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: item.color ?? "var(--text)" }}>{item.value}</div>
          </div>
        ))}
      </div>

      {/* ── Deployment Summary ── narrative quick-read ──────────────── */}
      {(() => {
        // Outcome line
        const outcomeStatus = deployment.status;
        const failedStepIndex = deployment.executionRecord?.steps.findIndex((s) => s.status === "failed") ?? -1;
        const failedStep = failedStepIndex >= 0 ? deployment.executionRecord!.steps[failedStepIndex] : null;
        let outcomeLine: string;
        if (outcomeStatus === "succeeded") {
          outcomeLine = `Deployment succeeded${durationLabel !== "—" ? ` in ${durationLabel}` : ""}`;
        } else if (outcomeStatus === "failed") {
          const reason = failedStep
            ? `at step ${failedStepIndex + 1}: ${failedStep.error || failedStep.description}`
            : deployment.failureReason || "unknown error";
          outcomeLine = `Deployment failed ${reason}`;
        } else if (outcomeStatus === "rolled_back") {
          outcomeLine = `Deployment rolled back${deployment.failureReason ? ` — ${deployment.failureReason}` : ""}`;
        } else {
          outcomeLine = `Deployment ${statusLabel(outcomeStatus).toLowerCase()}`;
        }

        // LLM reasoning (strip dry-run suffix)
        const rawReasoning = deployment.plan?.reasoning ?? "";
        const reasoning = rawReasoning.replace(/\s*\[Dry-run validated[^\]]*\]\s*$/i, "").trim();

        // Environment probes from debrief
        const probeEntries = debrief.filter(
          (e) => e.decisionType === "environment-probe" || e.decisionType === "environment-scan",
        );

        // Execution steps — prefer executionRecord, fall back to plan steps
        const execSteps = deployment.executionRecord?.steps ?? null;
        const planSteps = deployment.plan?.steps ?? null;
        const stepCount = execSteps?.length ?? planSteps?.length ?? 0;

        return (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Summary</h3>
            <div style={{
              padding: "14px 18px",
              borderRadius: 10,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--text)",
            }}>
              {/* Outcome */}
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: statusColor,
                marginBottom: probeEntries.length > 0 || reasoning || stepCount > 0 ? 12 : 0,
              }}>
                {outcomeLine}
              </div>

              {/* Environment probes */}
              {probeEntries.length > 0 && (
                <div style={{ marginBottom: reasoning || stepCount > 0 ? 10 : 0 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Synth probed the target system{probeEntries.length > 1 ? ` (${probeEntries.length} checks)` : ""}
                    {probeEntries.length <= 3
                      ? `: ${probeEntries.map((p) => {
                          const cmd = p.context.command as string | undefined;
                          const preview = p.context.outputPreview as string | undefined;
                          if (cmd) return cmd;
                          if (preview) return preview.slice(0, 80);
                          return p.decision;
                        }).join(", ")}`
                      : ` and observed: ${probeEntries.map((p) => p.decision).slice(0, 3).join("; ")}${probeEntries.length > 3 ? "..." : ""}`
                    }
                  </span>
                </div>
              )}

              {/* LLM reasoning */}
              {reasoning && (
                <div style={{
                  fontSize: 13,
                  color: "var(--text)",
                  marginBottom: stepCount > 0 ? 12 : 0,
                }}>
                  {reasoning}
                </div>
              )}

              {/* Execution steps — compact numbered list */}
              {execSteps && execSteps.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {execSteps.map((step, i) => {
                    const icon = step.status === "completed" ? "\u2713" : step.status === "failed" ? "\u2717" : "\u2026";
                    const iconColor = step.status === "completed"
                      ? "var(--status-succeeded)"
                      : step.status === "failed"
                      ? "var(--status-failed)"
                      : "var(--text-muted)";
                    const stepMs = step.completedAt
                      ? Math.round((new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000)
                      : null;
                    const stepTime = stepMs != null ? (stepMs >= 60 ? `${Math.floor(stepMs / 60)}m ${stepMs % 60}s` : `${stepMs}s`) : null;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12 }}>
                        <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, width: 18, textAlign: "right", flexShrink: 0 }}>{i + 1}.</span>
                        <span style={{ color: iconColor, fontSize: 11, flexShrink: 0 }}>{icon}</span>
                        <span style={{ color: step.status === "failed" ? "var(--status-failed)" : "var(--text)" }}>{step.description}</span>
                        {stepTime && <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{stepTime}</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Plan steps fallback when no execution record */}
              {!execSteps && planSteps && planSteps.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 2 }}>
                    {stepCount}-step plan:
                  </div>
                  {planSteps.map((step, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 12 }}>
                      <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, width: 18, textAlign: "right", flexShrink: 0 }}>{i + 1}.</span>
                      <span style={{ color: "var(--text)" }}>
                        {step.action}{step.description ? ` \u2014 ${step.description}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Failure detail */}
              {deployment.status === "failed" && deployment.failureReason && !failedStep && (
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--status-failed)" }}>
                  {deployment.failureReason}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Synth's Assessment — from recommendation or debrief fallback */}
      {(deployment.recommendation || assessmentEntry) && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Synth&rsquo;s Assessment</h3>
          <div style={{
            padding: "14px 18px", borderRadius: 10, fontSize: 13, color: "var(--text)", lineHeight: 1.6,
            background: "var(--accent-soft, rgba(45,91,240,0.06))", border: "1px solid var(--accent-border)",
          }}>
            {deployment.recommendation ? (
              <>
                <div style={{
                  fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase",
                  letterSpacing: "0.08em", color: "var(--accent)", marginBottom: 8,
                }}>
                  Recommendation: {deployment.recommendation.verdict === "proceed" ? "Proceed" : deployment.recommendation.verdict === "caution" ? "Proceed with Caution" : "Hold"}
                </div>
                <div style={{ color: "var(--text)" }}>{deployment.recommendation.summary}</div>
                {deployment.recommendation.factors.length > 0 && (
                  <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
                    {deployment.recommendation.factors.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                )}
              </>
            ) : assessmentEntry && (
              <>
                <div style={{
                  fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase",
                  letterSpacing: "0.08em", color: "var(--accent)", marginBottom: 8,
                }}>
                  {assessmentEntry.decision}
                </div>
                {assessmentEntry.reasoning && (
                  <div style={{ color: "var(--text)" }}>{assessmentEntry.reasoning}</div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Executed Plan steps — prefer executionRecord, fall back to plan.steps, then debrief entries */}
      {(deployment.executionRecord || deployment.plan || executionEntries.length > 0) && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Executed Plan</h3>
          <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface)" }}>
            {deployment.executionRecord
              ? deployment.executionRecord.steps.map((step, i) => {
                  const stepDuration = step.completedAt
                    ? `${Math.round((new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) / 1000)}s`
                    : "—";
                  const isLast = i === deployment.executionRecord!.steps.length - 1;
                  const iconColor = step.status === "completed" ? "var(--status-succeeded)" : step.status === "failed" ? "var(--status-failed)" : "var(--status-warning)";
                  const iconBg = step.status === "completed" ? "var(--status-succeeded-bg)" : step.status === "failed" ? "var(--status-failed-bg)" : "var(--status-warning-bg)";
                  const iconLabel = step.status === "completed" ? "✓" : step.status === "failed" ? "✗" : "…";
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "11px 16px", borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
                      <span style={{ width: 22, height: 22, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", background: iconBg, color: iconColor, fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{iconLabel}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text)" }}>{step.description}</div>
                        {step.output && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{step.output}</div>}
                        {step.error && <div style={{ fontSize: 11, color: "var(--status-failed)", marginTop: 2 }}>{step.error}</div>}
                      </div>
                      <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0, marginTop: 3 }}>{stepDuration}</span>
                    </div>
                  );
                })
              : deployment.plan
              ? deployment.plan.steps.map((step, i) => {
                  const isLast = i === deployment.plan!.steps.length - 1;
                  const succeeded = deployment.status === "succeeded";
                  const failed = deployment.status === "failed" || deployment.status === "rolled_back";
                  const iconColor = succeeded ? "var(--status-succeeded)" : failed ? "var(--status-failed)" : "var(--text-muted)";
                  const iconBg = succeeded ? "var(--status-succeeded-bg)" : failed ? "var(--status-failed-bg)" : "var(--surface-alt)";
                  const iconLabel = succeeded ? "✓" : failed ? "✗" : "·";
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "11px 16px", borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
                      <span style={{ width: 22, height: 22, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", background: iconBg, color: iconColor, fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{iconLabel}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text)" }}>{step.description}</div>
                        {step.action && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>{step.action}</div>}
                      </div>
                      {step.target && <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0, marginTop: 3 }}>{step.target}</span>}
                    </div>
                  );
                })
              : executionEntries.map((entry, i) => {
                  const isLast = i === executionEntries.length - 1;
                  const iconColor = "var(--status-succeeded)";
                  const iconBg = "var(--status-succeeded-bg)";
                  const ms = typeof entry.context.executionDurationMs === "number" ? entry.context.executionDurationMs
                    : typeof entry.context.durationMs === "number" ? entry.context.durationMs
                    : typeof entry.context.duration === "number" ? entry.context.duration
                    : null;
                  const stepTime = ms != null
                    ? (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`)
                    : null;
                  return (
                    <div key={entry.id} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "11px 16px", borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
                      <span style={{ width: 22, height: 22, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", background: iconBg, color: iconColor, fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>✓</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: "var(--text)" }}>{entry.decision}</div>
                        {entry.reasoning && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{entry.reasoning}</div>}
                      </div>
                      {stepTime && <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0, marginTop: 3 }}>{stepTime}</span>}
                    </div>
                  );
                })
            }
          </div>
        </div>
      )}

      {/* Config Diff */}
      {(deployment.plan?.diffFromCurrent?.length || configEntry) && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Configuration Changes</h3>
          <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            {deployment.plan?.diffFromCurrent?.length
              ? deployment.plan.diffFromCurrent.map((change, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{change.key}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--status-failed)", textDecoration: "line-through" }}>{change.from}</span>
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>→</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--status-succeeded)" }}>{change.to}</span>
                  </div>
                ))
              : configEntry && (
                  <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
                    <div>{configEntry.decision}</div>
                    {configEntry.reasoning && (
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>{configEntry.reasoning}</div>
                    )}
                  </div>
                )
            }
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
          <div style={{ padding: "12px 16px", borderRadius: 10, background: "var(--surface-alt)", border: "1px solid var(--border)" }}>
            {envoyEntries.map((entry) => (
              <div key={entry.id} style={{ display: "flex", gap: 10, padding: "4px 0" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2, flexShrink: 0 }}>•</span>
                <span style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>
                  {entry.decision}
                  {entry.reasoning && (
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}> — {entry.reasoning}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Decision Log — all non-envoy debrief entries for this deployment */}
      {debrief.filter((e) => e.agent !== "envoy").length > 0 && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Decision Log</h3>
          <DebriefTimeline entries={debrief.filter((e) => e.agent !== "envoy")} />
        </div>
      )}

      {/* Rollback */}
      {(["succeeded", "failed", "rolled_back"] as string[]).includes(deployment.status) && (
        <div className="canvas-section">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: deployment.rollbackPlan ? 10 : 0 }}>
            <h3 className="canvas-section-title" style={{ margin: 0 }}>
              {deployment.rollbackPlan ? "Rollback Plan" : "Rollback"}
            </h3>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {rollbackError && (
                <span style={{ fontSize: 12, color: "var(--status-failed)" }}>{rollbackError}</span>
              )}
              {deployment.status !== "rolled_back" && deployment.rollbackPlan && (
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: "4px 12px" }}
                  disabled={rollbackExecuting}
                  onClick={handleExecuteRollback}
                >
                  {rollbackExecuting ? "Executing…" : "Execute Rollback"}
                </button>
              )}
              {deployment.status !== "rolled_back" && (
                <button
                  className="btn-secondary"
                  style={{ fontSize: 12, padding: "4px 12px" }}
                  disabled={rollbackRequesting}
                  onClick={handleRequestRollbackPlan}
                >
                  {rollbackRequesting ? "Generating…" : deployment.rollbackPlan ? "Regenerate Plan" : "Request Rollback Plan"}
                </button>
              )}
            </div>
          </div>
          {deployment.rollbackPlan && (
            <>
              {deployment.rollbackPlan.reasoning && (
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.5 }}>
                  {deployment.rollbackPlan.reasoning}
                </div>
              )}
              <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface)" }}>
                {deployment.rollbackPlan.steps.map((step, i) => {
                  const isLast = i === deployment.rollbackPlan!.steps.length - 1;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "11px 16px", borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
                      <span style={{
                        width: 20, height: 20, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
                        background: "var(--accent-soft, rgba(45,91,240,0.06))", color: "var(--accent)", fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 1,
                      }}>{i + 1}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: "var(--text)" }}>{step.action}</div>
                        {step.description && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{step.description}</div>}
                      </div>
                      {step.target && <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0, marginTop: 3 }}>{step.target}</span>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
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
  initialDeploymentId?: string;
}

export default function DebriefPanel({ title, filterPartitionId, filterDecisionType, initialDeploymentId }: Props) {
  const [tab, setTab] = useState<TabId>("deployments");
  const [filterPartition, setFilterPartition] = useState(filterPartitionId ?? "");
  const [filterType, setFilterType] = useState(filterDecisionType ?? "");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(initialDeploymentId ?? null);

  const debriefKey = `debrief:${filterPartition}:${filterType}`;
  const { data: entries, loading: l1, error } = useQuery<DebriefEntry[]>(debriefKey, () =>
    getRecentDebrief({ limit: 100, partitionId: filterPartition || undefined, decisionType: filterType || undefined }),
  );
  const { data: deployments, loading: l2 } = useQuery<Deployment[]>("list:deployments", listDeployments);
  const { data: partitions } = useQuery<Partition[]>("list:partitions", listPartitions);
  const { data: artifacts } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const { data: environments } = useQuery<Environment[]>("list:environments", listEnvironments);

  const { pushPanel } = useCanvas();
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
    <CanvasPanelHost title={title} noBreadcrumb>
      <div>
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
                  const envName = (environments ?? []).find((e) => e.id === dep.environmentId)?.name ?? dep.environmentId?.slice(0, 8) ?? "—";
                  const duration = formatDuration(dep.createdAt, dep.completedAt);
                  const isFinished = FINISHED_STATUSES.has(dep.status);
                  const isAwaiting = dep.status === "awaiting_approval";
                  function handleRowClick() {
                    if (isAwaiting) {
                      pushPanel({ type: "plan-review", title: "Review Plan", params: { id: dep.id } });
                    } else {
                      setSelectedDeploymentId(dep.id);
                    }
                  }
                  return (
                    <div
                      key={dep.id}
                      onClick={handleRowClick}
                      style={{
                        padding: "16px 20px",
                        borderRadius: 10,
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        cursor: "pointer",
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
                        <div className={`v2-deploy-status-pill v2-pill-${dep.status}`}>
                          {statusLabel(dep.status)}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 20, fontSize: 12, color: "var(--text-muted)" }}>
                        <span>{timeAgo(dep.createdAt)}</span>
                        {duration && <span>Duration: {duration}</span>}
                        {isFinished && (
                          <span style={{ color: "var(--accent)", fontWeight: 500 }}>View full debrief →</span>
                        )}
                        {isAwaiting && (
                          <span style={{ color: "var(--status-warning)", fontWeight: 500 }}>
                            Review Plan →
                          </span>
                        )}
                        {!isFinished && !isAwaiting && (
                          <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>View debrief →</span>
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
              onNavigate={(id) => setSelectedDeploymentId(id)}
            />
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
