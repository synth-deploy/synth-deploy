import { useState, useEffect, useRef, useCallback } from "react";
import { getDeployment, getPostmortem, listEnvironments, listArtifacts, listPartitions, getAuthToken } from "../../api.js";
import type { PostmortemReport } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import SynthMark from "../SynthMark.js";

const decisionTypeColors: Record<string, string> = {
  "pipeline-plan": "var(--dt-plan)",
  "configuration-resolved": "var(--accent)",
  "variable-conflict": "var(--status-warning)",
  "health-check": "var(--dt-health)",
  "deployment-execution": "var(--accent)",
  "deployment-verification": "var(--dt-verification)",
  "deployment-completion": "var(--status-succeeded)",
  "deployment-failure": "var(--status-failed)",
  "diagnostic-investigation": "var(--dt-diagnostic)",
  "environment-scan": "var(--dt-scan)",
  system: "var(--dt-system)",
  "llm-call": "var(--dt-system)",
  "artifact-analysis": "var(--dt-diagnostic)",
  "plan-generation": "var(--dt-plan)",
  "plan-approval": "var(--status-succeeded)",
  "plan-rejection": "var(--status-failed)",
  "rollback-execution": "var(--status-failed)",
  "cross-system-context": "var(--dt-scan)",
  "plan-modification": "var(--accent)",
};

// ---------------------------------------------------------------------------
// Progress event types (matches server-side ProgressEvent)
// ---------------------------------------------------------------------------

interface ProgressEvent {
  deploymentId: string;
  type:
    | "step-started"
    | "step-completed"
    | "step-failed"
    | "rollback-started"
    | "rollback-completed"
    | "deployment-completed";
  stepIndex: number;
  stepDescription: string;
  status: "in_progress" | "completed" | "failed";
  output?: string;
  error?: string;
  timestamp: string;
  overallProgress: number;
}

// ---------------------------------------------------------------------------
// useDeploymentStream — SSE hook for live execution progress
// ---------------------------------------------------------------------------

function useDeploymentStream(deploymentId: string, isRunning: boolean) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [stale, setStale] = useState(false);
  const [completed, setCompleted] = useState(false);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());

  const resetStaleTimer = useCallback(() => {
    setStale(false);
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    staleTimerRef.current = setTimeout(() => setStale(true), 10_000);
  }, []);

  useEffect(() => {
    if (!isRunning) return;

    const token = getAuthToken();
    const url = token
      ? `/api/operations/${deploymentId}/stream?token=${encodeURIComponent(token)}`
      : `/api/operations/${deploymentId}/stream`;
    const es = new EventSource(url);
    eventSourceRef.current = es;
    resetStaleTimer();

    es.onmessage = (msg) => {
      try {
        if (msg.lastEventId && seenIdsRef.current.has(msg.lastEventId)) {
          return;
        }
        if (msg.lastEventId) {
          seenIdsRef.current.add(msg.lastEventId);
        }

        const event: ProgressEvent = JSON.parse(msg.data);
        setEvents((prev) => [...prev, event]);
        resetStaleTimer();

        if (event.type === "deployment-completed") {
          setCompleted(true);
          es.close();
          if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      setStale(true);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current);
    };
  }, [deploymentId, isRunning, resetStaleTimer]);

  return { events, stale, completed };
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rolled_back", "rejected", "shelved"]);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  deploymentId: string;
  title: string;
}

export default function DeploymentDetailPanel({ deploymentId, title }: Props) {
  const { pushPanel, replacePanel, minimizeDeployment } = useCanvas();

  const { data: result, loading: l1, refresh: refreshDeployment } = useQuery(`deployment:${deploymentId}`, () => getDeployment(deploymentId));
  const { data: environments, loading: l2 } = useQuery("list:environments", () => listEnvironments());
  const { data: artifacts, loading: l3 } = useQuery("list:artifacts", () => listArtifacts());
  const { data: partitions, loading: l4 } = useQuery("list:partitions", () => listPartitions());
  const loading = l1 || l2 || l3 || l4;

  const deployment = result?.deployment ?? null;
  const debrief = result?.debrief ?? [];

  const [postmortem, setPostmortem] = useState<PostmortemReport | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
  const [expandedPlanSteps, setExpandedPlanSteps] = useState<Set<number>>(new Set());

  function togglePlanStep(i: number) {
    setExpandedPlanSteps((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  // Fetch postmortem for failed deployments
  useEffect(() => {
    if (deployment?.status === "failed") {
      getPostmortem(deploymentId).then(setPostmortem).catch(() => {});
    }
  }, [deployment?.status, deploymentId]);

  // Auto-redirect pending/awaiting_approval to the plan review modal
  const didRedirect = useRef(false);
  useEffect(() => {
    const status = deployment?.status;
    if (!didRedirect.current && (status === "pending" || status === "awaiting_approval")) {
      didRedirect.current = true;
      replacePanel({
        type: "plan-review",
        title: "Review Plan",
        params: { id: deploymentId },
      });
    }
  }, [deployment?.status, deploymentId, replacePanel]);

  // Live streaming for running deployments
  const isRunning = deployment?.status === "running";
  const { events: progressEvents, stale, completed: streamCompleted } = useDeploymentStream(deploymentId, isRunning);


  // Navigate to the full debrief once the deployment reaches a terminal state
  const didTransitionRef = useRef(false);
  useEffect(() => {
    const status = deployment?.status;
    if (!didTransitionRef.current && status && TERMINAL_STATUSES.has(status)) {
      didTransitionRef.current = true;
      replacePanel({
        type: "debrief",
        title: "Debriefs",
        params: { deploymentId },
      });
    }
  }, [deployment?.status, deploymentId, replacePanel]);

  // Re-fetch when stream completes (success path — deployment-completed event)
  useEffect(() => {
    if (streamCompleted) {
      refreshDeployment();
    }
  }, [streamCompleted, refreshDeployment]);

  // Poll when stream goes stale — failure/rollback don't emit deployment-completed
  useEffect(() => {
    if (!stale || !isRunning) return;
    const interval = setInterval(() => { refreshDeployment(); }, 3_000);
    return () => clearInterval(interval);
  }, [stale, isRunning, refreshDeployment]);

  // Build step state map from progress events
  const stepMap = new Map<number, ProgressEvent>();
  for (const event of progressEvents) {
    if (event.type === "step-started" || event.type === "step-completed" || event.type === "step-failed") {
      stepMap.set(event.stepIndex, event);
    }
  }
  const overallProgress = progressEvents.length > 0
    ? progressEvents[progressEvents.length - 1].overallProgress
    : 0;

  // ── Loading / not found ───────────────────────────────────────────────────
  if (loading || (!deployment && !loading)) {
    // While loading or redirecting (awaiting_approval), show a brief modal
    return (
      <div className="modal-overlay">
        <div className="modal-card" style={{ maxWidth: 500, textAlign: "center", padding: "40px 36px" }}>
          <SynthMark size={36} active />
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 14 }}>
            {loading ? "Loading…" : "Deployment not found"}
          </p>
        </div>
      </div>
    );
  }

  if (!deployment) return null;

  const envName = (environments ?? []).find((e) => e.id === deployment.environmentId)?.name ?? deployment.environmentId ?? "—";
  const depArtifactId = deployment.artifactId ?? (deployment.input?.type === "deploy" ? deployment.input.artifactId : undefined);
  const artName = deployment.input?.type && deployment.input.type !== "deploy"
    ? (deployment.intent ?? deployment.input.type)
    : ((artifacts ?? []).find((a) => a.id === depArtifactId)?.name ?? depArtifactId?.slice(0, 8) ?? "—");
  const partName = deployment.partitionId
    ? ((partitions ?? []).find((t) => t.id === deployment.partitionId)?.name ?? deployment.partitionId.slice(0, 8))
    : null;

  function toggleEntry(id: string) {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Running — full-screen execution overlay ───────────────────────────────
  if (isRunning) {
    const planSummary = deployment.plan?.scriptedPlan?.stepSummary ?? [];
    const isRollback = progressEvents.some((e) => e.type === "rollback-started");
    const rollbackDone = progressEvents.some((e) => e.type === "rollback-completed");
    const anyFailed = progressEvents.some((e) => e.type === "step-failed");

    return (
      <div className="modal-overlay">
        <div className="modal-card" style={{ maxWidth: 500, padding: "32px 36px" }}>

          {/* Header */}
          <div className="exec-header">
            <div className="exec-title-block">
              <SynthMark size={22} active={isRunning && !isRollback} />
              <div>
                <div className="exec-title">
                  {isRollback ? `Rolling back ${artName}` : `Deploying ${artName}`}{" "}
                  {deployment.version}
                </div>
                <div className="exec-subtitle">→ {envName}{partName ? ` · ${partName}` : ""}</div>
              </div>
            </div>
            <button
              className="plan-btn plan-btn-reject"
              onClick={() => minimizeDeployment({ deploymentId, artifactName: artName })}
              style={{ fontSize: 11, padding: "5px 12px", whiteSpace: "nowrap" }}
            >
              Minimize ↓
            </button>
          </div>

          {/* Progress bar */}
          <div className="exec-progress-bar">
            <div
              className="exec-progress-fill"
              style={{
                width: `${overallProgress}%`,
                background: isRollback
                  ? "var(--status-warning)"
                  : anyFailed
                    ? "var(--status-failed)"
                    : "var(--accent)",
              }}
            />
          </div>

          {/* Rollback banner */}
          {isRollback && (
            <div style={{
              background: "color-mix(in srgb, var(--status-warning) 13%, transparent)",
              border: "1px solid color-mix(in srgb, var(--status-warning) 30%, transparent)",
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: 12,
              color: "var(--status-warning)",
              marginBottom: 14,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}>
              <span>↩</span>
              {rollbackDone
                ? "Rollback complete — environment restored to previous state"
                : "Step failed — envoy is rolling back changes"}
            </div>
          )}

          {/* Stale indicator */}
          {stale && !isRollback && (
            <div style={{
              background: "color-mix(in srgb, var(--status-warning) 13%, transparent)",
              border: "1px solid color-mix(in srgb, var(--status-warning) 27%, transparent)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 12,
              color: "var(--status-warning)",
              marginBottom: 14,
            }}>
              Connection to envoy lost — deployment may still be in progress
            </div>
          )}

          {/* Step summary list */}
          {planSummary.length > 0 ? (
            planSummary.map((step, i) => {
              const evt = stepMap.get(i);
              const isCompleted = evt?.type === "step-completed";
              const isActive = evt?.type === "step-started";
              const isFailed = evt?.type === "step-failed";
              return (
                <div
                  key={i}
                  className="exec-step-row"
                  style={{ opacity: isCompleted || isActive || isFailed ? 1 : 0.3 }}
                >
                  <span className={`exec-step-badge ${isCompleted ? "exec-step-badge-done" : isActive ? "exec-step-badge-active" : isFailed ? "exec-step-badge-pending" : "exec-step-badge-pending"}`}
                    style={isFailed ? { background: "var(--status-failed-bg)", color: "var(--status-failed)", border: "1px solid var(--status-failed-border)" } : undefined}
                  >
                    {isCompleted ? "✓" : isFailed ? "✗" : i + 1}
                  </span>
                  <span style={{
                    fontSize: 13,
                    color: isCompleted
                      ? "var(--status-succeeded)"
                      : isFailed
                        ? "var(--status-failed)"
                        : isActive
                          ? "var(--text)"
                          : "var(--text-muted)",
                  }}>
                    {step.description}
                  </span>
                </div>
              );
            })
          ) : progressEvents.length > 0 ? (
            Array.from(stepMap.entries())
              .sort(([a], [b]) => a - b)
              .map(([idx, event]) => {
                const isActive = event.type === "step-started";
                const isCompleted = event.type === "step-completed";
                return (
                  <div key={idx} className="exec-step-row">
                    <span className={`exec-step-badge ${isCompleted ? "exec-step-badge-done" : isActive ? "exec-step-badge-active" : "exec-step-badge-pending"}`}>
                      {isCompleted ? "✓" : idx + 1}
                    </span>
                    <span style={{ fontSize: 13, color: isCompleted ? "var(--status-succeeded)" : isActive ? "var(--text)" : "var(--text-muted)" }}>
                      {event.stepDescription}
                    </span>
                  </div>
                );
              })
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 0", color: "var(--text-muted)", fontSize: 13 }}>
              <SynthMark size={14} active />
              Waiting for envoy to begin execution…
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Pending / awaiting_approval — brief loading state before redirect fires
  if (deployment.status === "pending" || deployment.status === "awaiting_approval") {
    return (
      <div className="modal-overlay">
        <div className="modal-card" style={{ maxWidth: 500, textAlign: "center", padding: "40px 36px" }}>
          <SynthMark size={36} active />
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 14 }}>Opening plan review…</p>
        </div>
      </div>
    );
  }

  // ── All other states — full panel detail view ─────────────────────────────
  return (
    <CanvasPanelHost title={title} hideRootCrumb dismissible={false}>
      <div className="v2-detail-view">

        {/* ── Header ── */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span className={`badge badge-${deployment.status}`}>{deployment.status}</span>
            {deployment.version && (
              <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {deployment.version}
              </span>
            )}
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 500, color: "var(--text)", margin: "0 0 4px", fontFamily: "var(--font-display)" }}>
            {artName}
          </h2>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            → {envName}{partName ? ` · ${partName}` : ""}
          </div>
        </div>

        {/* ── Meta row ── */}
        <div style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px 16px",
          marginBottom: 24,
          padding: "12px 16px",
          borderRadius: 8,
          background: "var(--surface-alt)",
          border: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-muted)",
        }}>
          <span>Started {new Date(deployment.createdAt).toLocaleString()}</span>
          {deployment.completedAt && (
            <span>Completed {new Date(deployment.completedAt).toLocaleString()}</span>
          )}
          {deployment.approvedBy && (
            <span>Approved by {deployment.approvedBy}</span>
          )}
          {partName && (
            <button
              className="canvas-meta-link"
              onClick={() => pushPanel({ type: "partition-detail", title: partName, params: { id: deployment.partitionId! } })}
            >
              Partition: {partName}
            </button>
          )}
          <button
            className="canvas-meta-link"
            onClick={() => deployment.environmentId && pushPanel({ type: "environment-detail", title: envName, params: { id: deployment.environmentId } })}
          >
            Environment: {envName}
          </button>
        </div>

        {/* ── Failure analysis ── */}
        {postmortem?.failureAnalysis && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Failure Analysis</h3>
            <div className="canvas-failure-card">
              <div className="canvas-failure-row"><strong>Failed step:</strong> {postmortem.failureAnalysis.failedStep}</div>
              <div className="canvas-failure-row"><strong>What happened:</strong> {postmortem.failureAnalysis.whatHappened}</div>
              <div className="canvas-failure-row"><strong>Why:</strong> {postmortem.failureAnalysis.whyItFailed}</div>
              <div className="canvas-failure-row"><strong>Suggested fix:</strong> {postmortem.failureAnalysis.suggestedFix}</div>
            </div>
          </div>
        )}

        {/* ── Execution Record ── */}
        {deployment.executionRecord && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Execution Record</h3>
            <div style={{ marginBottom: 4 }}>
              {deployment.executionRecord.steps.map((step, i) => {
                const isCompleted = step.status === "completed";
                const isFailed = step.status === "failed";
                return (
                  <div key={i} className="plan-step-row">
                    <span
                      className="plan-step-num"
                      style={
                        isCompleted
                          ? { background: "var(--status-succeeded-bg)", color: "var(--status-succeeded)", border: "1px solid var(--status-succeeded-border)" }
                          : isFailed
                            ? { background: "color-mix(in srgb, var(--status-failed) 12%, transparent)", color: "var(--status-failed)", border: "1px solid color-mix(in srgb, var(--status-failed) 30%, transparent)" }
                            : undefined
                      }
                    >
                      {isCompleted ? "✓" : isFailed ? "✗" : i + 1}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: isCompleted ? "var(--status-succeeded)" : isFailed ? "var(--status-failed)" : "var(--text)" }}>
                        {step.description}
                      </div>
                      {step.output && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{step.output}</div>
                      )}
                      {step.error && (
                        <div style={{ fontSize: 11, color: "var(--status-failed)", marginTop: 2 }}>{step.error}</div>
                      )}
                    </div>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0, alignSelf: "center" }}>
                      {new Date(step.startedAt).toLocaleTimeString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Deployment Plan (no execution record yet, or archived view) ── */}
        {deployment.plan && !deployment.executionRecord && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Deployment Plan</h3>
            {deployment.plan.reasoning && (
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.55 }}>
                {deployment.plan.reasoning}
              </div>
            )}

            {/* Step summaries */}
            {deployment.plan.scriptedPlan && (
              <div>
                {deployment.plan.scriptedPlan.stepSummary.map((step, i) => (
                  <div key={i} className="plan-step-row">
                    <span className="plan-step-num">{i + 1}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, color: "var(--text)" }}>{step.description}</div>
                        </div>
                        <span style={{
                          fontSize: 10,
                          fontFamily: "var(--font-mono)",
                          fontWeight: 600,
                          padding: "2px 6px",
                          borderRadius: 4,
                          color: !step.reversible ? "var(--status-failed)" : "var(--status-succeeded)",
                          background: !step.reversible
                            ? "color-mix(in srgb, var(--status-failed) 12%, transparent)"
                            : "color-mix(in srgb, var(--status-succeeded) 12%, transparent)",
                          flexShrink: 0,
                        }}>
                          {step.reversible ? "reversible" : "irreversible"}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Script toggle */}
                <button
                  onClick={() => togglePlanStep(-1)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "none",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "6px 12px",
                    marginTop: 10,
                    cursor: "pointer",
                    color: "var(--text-muted)",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {expandedPlanSteps.has(-1) ? "▲ Hide Script" : "▼ View Script"}
                </button>
                {expandedPlanSteps.has(-1) && (
                  <pre style={{
                    marginTop: 8,
                    padding: "14px 16px",
                    borderRadius: 8,
                    background: "var(--surface-alt)",
                    border: "1px solid var(--border)",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text)",
                    overflow: "auto",
                    maxHeight: 400,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    lineHeight: 1.5,
                  }}>
                    {deployment.plan.scriptedPlan.executionScript}
                  </pre>
                )}

                {/* Rollback script toggle */}
                {deployment.plan.scriptedPlan.rollbackScript && (
                  <>
                    <button
                      onClick={() => togglePlanStep(-2)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        background: "none",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: "6px 12px",
                        marginTop: 8,
                        cursor: "pointer",
                        color: "var(--text-muted)",
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {expandedPlanSteps.has(-2) ? "▲ Hide Rollback Script" : "▼ Rollback Script"}
                    </button>
                    {expandedPlanSteps.has(-2) && (
                      <pre style={{
                        marginTop: 8,
                        padding: "14px 16px",
                        borderRadius: 8,
                        background: "var(--surface-alt)",
                        border: "1px solid color-mix(in srgb, var(--status-warning) 30%, var(--border))",
                        fontSize: 12,
                        fontFamily: "var(--font-mono)",
                        color: "var(--text)",
                        overflow: "auto",
                        maxHeight: 400,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        lineHeight: 1.5,
                      }}>
                        {deployment.plan.scriptedPlan.rollbackScript}
                      </pre>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Variables ── */}
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

        {/* ── Decision Diary ── */}
        {debrief.length > 0 && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Decision Diary</h3>
            <div className="canvas-timeline">
              {debrief.map((entry) => (
                <button
                  key={entry.id}
                  className="canvas-timeline-entry"
                  onClick={() => toggleEntry(entry.id)}
                >
                  <div
                    className="canvas-timeline-dot"
                    style={{ background: decisionTypeColors[entry.decisionType] ?? "var(--text-muted)" }}
                  />
                  <div className="canvas-timeline-content">
                    <div className="canvas-timeline-header">
                      <span className="canvas-timeline-type">{entry.decisionType}</span>
                      <span className="canvas-timeline-time">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="canvas-timeline-decision">{entry.decision}</div>
                    {expandedEntries.has(entry.id) && (
                      <div className="canvas-timeline-reasoning">{entry.reasoning}</div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
