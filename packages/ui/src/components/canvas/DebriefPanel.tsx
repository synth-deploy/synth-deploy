import { useState, useEffect, useCallback, useRef } from "react";
import { getRecentDebrief, getDeployment, listDeployments, listPartitions, listArtifacts, listEnvironments, getWhatsNew, requestRollbackPlan, executeRollback, retryDeployment, getPostmortem, pinOperation, unpinOperation, getPinnedOperations } from "../../api.js";
import type { WhatsNewResult, LlmPostmortem } from "../../api.js";
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
  { value: "query-findings", label: "Query" },
  { value: "investigation-findings", label: "Investigation" },
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
  const [llmPostmortem, setLlmPostmortem] = useState<LlmPostmortem | null>(null);
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

  function handleRunAgain() {
    if (!deployment) return;
    const opType = deployment.input?.type ?? "deploy";
    const intent = deployment.intent ?? "";
    const params: Record<string, string> = {};
    if (opType === "deploy" && deployment.artifactId) params.artifactId = deployment.artifactId;
    if (deployment.environmentId) params.environmentId = deployment.environmentId;
    if (deployment.partitionId) params.partitionId = deployment.partitionId;
    if (opType !== "deploy") params.opType = opType;
    if (intent) params.intent = intent;
    pushPanel({
      type: "operation-authoring",
      title: "Run Again",
      params,
    });
  }

  useEffect(() => {
    getWhatsNew(deploymentId).then(setWhatsNew).catch(() => {});
  }, [deploymentId]);

  useEffect(() => {
    if (deployment?.status === "failed" || deployment?.status === "rolled_back") {
      getPostmortem(deploymentId)
        .then(({ llmPostmortem: llm }) => { if (llm) setLlmPostmortem(llm); })
        .catch(() => {});
    }
  }, [deployment?.status, deploymentId]);

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
  // Envoy log: only discovery/diagnostic entries, not execution steps (those are in Executed Plan)
  const envoyLogEntries = debrief.filter(
    (e) => e.agent === "envoy" &&
      (e.decisionType === "environment-probe" || e.decisionType === "environment-scan" || e.decisionType === "diagnostic-investigation"),
  );
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
              onClick={handleRunAgain}
            >
              Run Again
            </button>
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

      {/* ── Synth's Assessment ── outcome + reasoning + recommendation ── */}
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

        // Failure detail when no failed step captured
        const showFailureReason = deployment.status === "failed" && deployment.failureReason && !failedStep;

        const rec = deployment.recommendation;

        return (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Synth&rsquo;s Assessment</h3>
            <div style={{
              padding: "14px 18px",
              borderRadius: 10,
              background: rec ? "var(--accent-soft, rgba(45,91,240,0.06))" : "var(--surface)",
              border: `1px solid ${rec ? "var(--accent-border)" : "var(--border)"}`,
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--text)",
            }}>
              {/* Outcome */}
              <div style={{ fontSize: 14, fontWeight: 600, color: statusColor, marginBottom: reasoning || rec || assessmentEntry ? 12 : 0 }}>
                {outcomeLine}
              </div>

              {/* Failure detail */}
              {showFailureReason && (
                <div style={{ marginBottom: 8, fontSize: 12, color: "var(--status-failed)" }}>
                  {deployment.failureReason}
                </div>
              )}

              {/* LLM reasoning — the "why" behind this plan */}
              {reasoning && (
                <div style={{ fontSize: 13, color: "var(--text)", marginBottom: rec ? 12 : 0 }}>
                  {reasoning}
                </div>
              )}

              {/* Recommendation verdict + factors */}
              {rec ? (
                <>
                  <div style={{
                    fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase",
                    letterSpacing: "0.08em", color: "var(--accent)", marginBottom: 6,
                  }}>
                    {rec.verdict === "proceed" ? "Proceed" : rec.verdict === "caution" ? "Proceed with Caution" : "Hold"}
                  </div>
                  <div style={{ color: "var(--text)" }}>{rec.summary}</div>
                  {rec.factors.length > 0 && (
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
                      {rec.factors.map((f, i) => <li key={i}>{f}</li>)}
                    </ul>
                  )}
                </>
              ) : assessmentEntry && !reasoning && (
                <div style={{ color: "var(--text)" }}>{assessmentEntry.reasoning || assessmentEntry.decision}</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── LLM Incident Analysis ── shown for failed/rolled_back when LLM postmortem available ── */}
      {llmPostmortem && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Incident Analysis</h3>
          <div style={{
            borderRadius: 10,
            border: "1px solid color-mix(in srgb, var(--status-failed) 25%, transparent)",
            background: "color-mix(in srgb, var(--status-failed) 4%, transparent)",
            padding: "16px 18px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}>
            {/* Executive summary */}
            <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.65 }}>
              {llmPostmortem.executiveSummary}
            </div>

            {/* Root cause */}
            <div>
              <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--status-failed)", marginBottom: 5 }}>
                Root Cause
              </div>
              <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
                {llmPostmortem.rootCause}
              </div>
            </div>

            {/* Contributing factors */}
            {llmPostmortem.contributingFactors.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 5 }}>
                  Contributing Factors
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                  {llmPostmortem.contributingFactors.map((f, i) => (
                    <li key={i} style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Remediation steps */}
            {llmPostmortem.remediationSteps.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 5 }}>
                  Remediation Steps
                </div>
                <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                  {llmPostmortem.remediationSteps.map((s, i) => (
                    <li key={i} style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>{s}</li>
                  ))}
                </ol>
              </div>
            )}

            {/* Lessons learned */}
            {llmPostmortem.lessonsLearned.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontFamily: "var(--font-mono)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 5 }}>
                  Lessons Learned
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                  {llmPostmortem.lessonsLearned.map((l, i) => (
                    <li key={i} style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>{l}</li>
                  ))}
                </ul>
              </div>
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

      {/* Envoy Log — target system observations: probes, scans, diagnostics */}
      {envoyLogEntries.length > 0 && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Envoy Log</h3>
          <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", overflow: "hidden" }}>
            {envoyLogEntries.map((entry, i) => {
              const isLast = i === envoyLogEntries.length - 1;
              const ts = new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
              const typeLabel = entry.decisionType === "diagnostic-investigation" ? "diagnostic" : "probe";
              const typeColor = entry.decisionType === "diagnostic-investigation" ? "var(--status-warning)" : "var(--text-muted)";
              return (
                <div key={entry.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 14px", borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", flexShrink: 0, marginTop: 2, minWidth: 64 }}>{ts}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: typeColor, flexShrink: 0, marginTop: 2, minWidth: 72 }}>{typeLabel}</span>
                  <span style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>
                    {entry.decision}
                    {entry.reasoning && (
                      <span style={{ color: "var(--text-muted)" }}> — {entry.reasoning}</span>
                    )}
                  </span>
                </div>
              );
            })}
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
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  function handleSearchChange(value: string) {
    setSearchInput(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchQuery(value), 300);
  }

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const debriefKey = `debrief:${filterPartition}:${filterType}:${searchQuery}`;
  const { data: entries, loading: l1, error } = useQuery<DebriefEntry[]>(debriefKey, () =>
    getRecentDebrief({
      limit: 100,
      partitionId: filterPartition || undefined,
      decisionType: filterType || undefined,
      q: searchQuery || undefined,
    }),
  );
  const { data: deployments, loading: l2 } = useQuery<Deployment[]>("list:deployments", listDeployments);
  const { data: partitions } = useQuery<Partition[]>("list:partitions", listPartitions);
  const { data: artifacts } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const { data: environments } = useQuery<Environment[]>("list:environments", listEnvironments);

  // Load pinned operations
  useEffect(() => {
    getPinnedOperations()
      .then(({ pinnedIds: ids }) => setPinnedIds(new Set(ids)))
      .catch(() => {});
  }, []);

  const handleTogglePin = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPinnedIds((prev) => {
      if (prev.has(id)) {
        unpinOperation(id).catch(() => {});
        const next = new Set(prev); next.delete(id); return next;
      } else {
        pinOperation(id).catch(() => {});
        return new Set(prev).add(id);
      }
    });
  }, []);

  const { pushPanel } = useCanvas();
  const loading = l1 || l2;
  const safeEntries = entries ?? [];
  const safeDeployments = (deployments ?? []).slice().sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // Client-side search filtering for the Deployments tab
  const filteredDeployments = searchQuery
    ? safeDeployments.filter((dep) => {
        const q = searchQuery.toLowerCase();
        const artName = (artifacts ?? []).find((a) => a.id === dep.artifactId)?.name ?? "";
        const envName = (environments ?? []).find((e) => e.id === dep.environmentId)?.name ?? "";
        return (
          artName.toLowerCase().includes(q) ||
          envName.toLowerCase().includes(q) ||
          (dep.version ?? "").toLowerCase().includes(q) ||
          (dep.intent ?? "").toLowerCase().includes(q) ||
          dep.status.toLowerCase().includes(q)
        );
      })
    : safeDeployments;

  // Split pinned vs unpinned
  const pinnedDeployments = filteredDeployments.filter((d) => pinnedIds.has(d.id));
  const unpinnedDeployments = filteredDeployments.filter((d) => !pinnedIds.has(d.id));

  const diagnosticEntries = safeEntries.filter((e) =>
    !e.deploymentId && ["diagnostic-investigation", "variable-conflict"].includes(e.decisionType),
  );
  const healthEntries = safeEntries.filter((e) =>
    ["health-check", "environment-scan"].includes(e.decisionType),
  );

  const tabCounts: Record<TabId, number> = {
    deployments: filteredDeployments.length,
    diagnostics: diagnosticEntries.length,
    health: healthEntries.length,
    fulllog: safeEntries.length,
  };

  const FINISHED_STATUSES = new Set(["succeeded", "failed", "rolled_back"]);

  function renderDeploymentRow(dep: Deployment) {
    const artName = (artifacts ?? []).find((a) => a.id === dep.artifactId)?.name ?? dep.artifactId.slice(0, 8);
    const envName = (environments ?? []).find((e) => e.id === dep.environmentId)?.name ?? dep.environmentId?.slice(0, 8) ?? "—";
    const duration = formatDuration(dep.createdAt, dep.completedAt);
    const isFinished = FINISHED_STATUSES.has(dep.status);
    const isAwaiting = dep.status === "awaiting_approval";
    const isPinned = pinnedIds.has(dep.id);
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
        className="debrief-op-row"
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <button
              className={`debrief-pin-btn${isPinned ? " pinned" : ""}`}
              title={isPinned ? "Unpin" : "Pin for quick access"}
              onClick={(e) => handleTogglePin(dep.id, e)}
            >
              {isPinned ? "\u2605" : "\u2606"}
            </button>
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
          {dep.input?.type && dep.input.type !== "deploy" && (
            <span className="debrief-op-type-tag">{dep.input.type}</span>
          )}
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
  }

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

            {/* Search bar */}
            <div style={{ marginBottom: 16 }}>
              <input
                className="debrief-search-input"
                type="text"
                placeholder="Search debriefs..."
                value={searchInput}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
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
                {/* Pinned section */}
                {pinnedDeployments.length > 0 && (
                  <>
                    <div className="debrief-pinned-header">Pinned</div>
                    {pinnedDeployments.map(renderDeploymentRow)}
                    {unpinnedDeployments.length > 0 && (
                      <div className="debrief-section-divider" />
                    )}
                  </>
                )}
                {unpinnedDeployments.length === 0 && pinnedDeployments.length === 0 && (
                  <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>
                    {searchInput ? "No matching operations." : "No operations recorded."}
                  </div>
                )}
                {unpinnedDeployments.map(renderDeploymentRow)}
              </div>
            )}

            {/* ── Diagnostics tab ─────────────────────────────────────────── */}
            {tab === "diagnostics" && !loading && (
              diagnosticEntries.length === 0
                ? <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>{searchInput ? "No matching diagnostics." : "No diagnostic investigations recorded."}</div>
                : <DebriefTimeline entries={diagnosticEntries} />
            )}

            {/* ── Health tab ───────────────────────────────────────────────── */}
            {tab === "health" && !loading && (
              healthEntries.length === 0
                ? <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>{searchInput ? "No matching health events." : "No health or scan events recorded."}</div>
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
