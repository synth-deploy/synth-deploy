import { useState, useEffect, useRef, useCallback } from "react";
import { getDeployment, getPostmortem, listEnvironments, listArtifacts, listPartitions } from "../../api.js";
import type { Deployment, DebriefEntry, Environment, Artifact, Partition, PostmortemReport } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

const decisionTypeColors: Record<string, string> = {
  "pipeline-plan": "#6366f1",
  "configuration-resolved": "var(--accent)",
  "variable-conflict": "var(--status-warning)",
  "health-check": "#06b6d4",
  "deployment-execution": "var(--accent)",
  "deployment-verification": "#10b981",
  "deployment-completion": "var(--status-succeeded)",
  "deployment-failure": "var(--status-failed)",
  "diagnostic-investigation": "#ec4899",
  "environment-scan": "#14b8a6",
  system: "#6b7280",
  "llm-call": "#6b7280",
  "artifact-analysis": "#ec4899",
  "plan-generation": "#6366f1",
  "plan-approval": "var(--status-succeeded)",
  "plan-rejection": "var(--status-failed)",
  "rollback-execution": "var(--status-failed)",
  "cross-system-context": "#14b8a6",
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

    const es = new EventSource(`/api/deployments/${deploymentId}/stream`);
    eventSourceRef.current = es;
    resetStaleTimer();

    es.onmessage = (msg) => {
      try {
        // Deduplicate events on reconnect — server sends id: field,
        // EventSource auto-sends Last-Event-ID on reconnect, but
        // guard against duplicates in case of overlap
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

    // EventSource auto-reconnects on error and sends Last-Event-ID header.
    // Mark stale while disconnected so UI shows the warning.
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

// ---------------------------------------------------------------------------
// LiveProgressSection — renders real-time step progress
// ---------------------------------------------------------------------------

function LiveProgressSection({ events, stale }: { events: ProgressEvent[]; stale: boolean }) {
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the log area
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  if (events.length === 0) return null;

  // Derive step states from events
  const latestEvent = events[events.length - 1];
  const overallProgress = latestEvent.overallProgress;
  const isRollback = events.some((e) => e.type === "rollback-started");

  // Build a map of stepIndex -> latest event for that step
  const stepMap = new Map<number, ProgressEvent>();
  for (const event of events) {
    if (event.type === "step-started" || event.type === "step-completed" || event.type === "step-failed") {
      stepMap.set(event.stepIndex, event);
    }
  }

  return (
    <div className="canvas-section">
      <h3 className="canvas-section-title">
        {isRollback ? "Rollback Progress" : "Live Execution Progress"}
      </h3>

      {/* Progress bar */}
      <div style={{
        background: "var(--surface-alt)",
        borderRadius: 4,
        height: 8,
        marginBottom: 12,
        overflow: "hidden",
      }}>
        <div style={{
          background: latestEvent.status === "failed" ? "var(--status-failed)" : "var(--accent)",
          height: "100%",
          width: `${overallProgress}%`,
          transition: "width 0.3s ease-out",
          borderRadius: 4,
        }} />
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8, textAlign: "right" }}>
        {overallProgress}%
      </div>

      {/* Stale indicator */}
      {stale && (
        <div style={{
          background: "color-mix(in srgb, var(--status-warning) 13%, transparent)",
          border: "1px solid color-mix(in srgb, var(--status-warning) 27%, transparent)",
          borderRadius: 4,
          padding: "6px 10px",
          fontSize: 12,
          color: "var(--status-warning)",
          marginBottom: 10,
        }}>
          Connection to envoy lost — deployment may still be in progress
        </div>
      )}

      {/* Step list */}
      <div className="canvas-timeline">
        {Array.from(stepMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([idx, event]) => {
            const isActive = event.type === "step-started";
            const isFailed = event.type === "step-failed";
            const isCompleted = event.type === "step-completed";

            const dotColor = isCompleted
              ? "var(--status-succeeded)"
              : isFailed
                ? "var(--status-failed)"
                : "var(--accent)";

            return (
              <div key={idx} className="canvas-timeline-entry" style={{ cursor: "default" }}>
                <div className="canvas-timeline-dot" style={{
                  background: dotColor,
                  animation: isActive ? "pulse 1.5s infinite" : undefined,
                }} />
                <div className="canvas-timeline-content">
                  <div className="canvas-timeline-header">
                    <span className="canvas-timeline-type">
                      {isCompleted ? "completed" : isFailed ? "failed" : "running"}
                    </span>
                    <span className="canvas-timeline-time">
                      Step {idx + 1}
                    </span>
                  </div>
                  <div className="canvas-timeline-decision">{event.stepDescription}</div>
                  {event.output && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {event.output}
                    </div>
                  )}
                  {event.error && (
                    <div style={{ fontSize: 11, color: "var(--status-failed)", marginTop: 2 }}>
                      {event.error}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      {/* Rollback events */}
      {isRollback && (
        <div style={{ marginTop: 8 }}>
          {events
            .filter((e) => e.type === "rollback-started" || e.type === "rollback-completed")
            .map((event, i) => (
              <div key={`rb-${i}`} className="canvas-timeline-entry" style={{ cursor: "default" }}>
                <div className="canvas-timeline-dot" style={{
                  background: event.type === "rollback-completed" ? "var(--status-warning)" : "var(--status-failed)",
                }} />
                <div className="canvas-timeline-content">
                  <div className="canvas-timeline-header">
                    <span className="canvas-timeline-type">{event.type}</span>
                  </div>
                  <div className="canvas-timeline-decision">{event.stepDescription}</div>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Live output log */}
      {events.some((e) => e.output) && (
        <div
          ref={logRef}
          style={{
            marginTop: 10,
            maxHeight: 200,
            overflowY: "auto",
            background: "var(--surface-alt)",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: 11,
            fontFamily: "monospace",
            color: "var(--text-muted)",
            lineHeight: 1.6,
          }}
        >
          {events
            .filter((e) => e.output)
            .map((e, i) => (
              <div key={i}>
                <span style={{ color: "var(--text-muted)" }}>[{new Date(e.timestamp).toLocaleTimeString()}]</span>{" "}
                {e.output}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface Props {
  deploymentId: string;
  title: string;
}

export default function DeploymentDetailPanel({ deploymentId, title }: Props) {
  const { pushPanel } = useCanvas();

  const { data: result, loading: l1, refresh: refreshDeployment } = useQuery(`deployment:${deploymentId}`, () => getDeployment(deploymentId));
  const { data: environments, loading: l2 } = useQuery("list:environments", () => listEnvironments());
  const { data: artifacts, loading: l3 } = useQuery("list:artifacts", () => listArtifacts());
  const { data: partitions, loading: l4 } = useQuery("list:partitions", () => listPartitions());
  const loading = l1 || l2 || l3 || l4;

  const deployment = result?.deployment ?? null;
  const debrief = result?.debrief ?? [];

  const [postmortem, setPostmortem] = useState<PostmortemReport | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());

  // Fetch postmortem for failed deployments
  useEffect(() => {
    if (deployment?.status === "failed") {
      getPostmortem(deploymentId).then(setPostmortem).catch(() => {});
    }
  }, [deployment?.status, deploymentId]);

  // Live streaming for running deployments
  const isRunning = deployment?.status === "running";
  const { events: progressEvents, stale, completed: streamCompleted } = useDeploymentStream(deploymentId, isRunning);

  // Re-fetch deployment when stream completes (to get final state)
  useEffect(() => {
    if (streamCompleted) {
      refreshDeployment();
    }
  }, [streamCompleted, refreshDeployment]);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!deployment) return <CanvasPanelHost title={title}><div className="error-msg">Deployment not found</div></CanvasPanelHost>;

  const envName = (environments ?? []).find((e) => e.id === deployment.environmentId)?.name ?? deployment.environmentId;
  const artName = (artifacts ?? []).find((a) => a.id === deployment.artifactId)?.name ?? deployment.artifactId.slice(0, 8);
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

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {/* Header info */}
        <div className="canvas-deploy-header">
          <span className={`badge badge-${deployment.status}`}>{deployment.status}</span>
          <span className="canvas-deploy-version">{deployment.version}</span>
        </div>

        {/* Review Plan action for awaiting_approval */}
        {deployment.status === "awaiting_approval" && (
          <div style={{ marginBottom: 12 }}>
            <button
              className="v2-btn v2-btn-primary"
              onClick={() => pushPanel({
                type: "plan-review",
                title: `Review Plan`,
                params: { id: deployment.id },
              })}
              style={{ fontSize: 13 }}
            >
              Review Plan
            </button>
          </div>
        )}

        <div className="canvas-deploy-meta">
          <span>Artifact: {artName}</span>
          {partName && (
            <button className="canvas-meta-link" onClick={() => pushPanel({
              type: "partition-detail", title: partName, params: { id: deployment.partitionId! },
            })}>
              Partition: {partName}
            </button>
          )}
          <button className="canvas-meta-link" onClick={() => pushPanel({
            type: "environment-detail", title: envName, params: { id: deployment.environmentId },
          })}>
            Environment: {envName}
          </button>
          <span>Started: {new Date(deployment.createdAt).toLocaleString()}</span>
          {deployment.completedAt && (
            <span>Completed: {new Date(deployment.completedAt).toLocaleString()}</span>
          )}
          {deployment.approvedBy && (
            <span>Approved by: {deployment.approvedBy}</span>
          )}
        </div>

        {/* Live execution progress (only for running deployments) */}
        {isRunning && progressEvents.length > 0 && (
          <LiveProgressSection events={progressEvents} stale={stale} />
        )}

        {/* Deployment Plan */}
        {deployment.plan && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Deployment Plan</h3>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
              {deployment.plan.reasoning}
            </div>
            <div className="canvas-timeline">
              {deployment.plan.steps.map((step, i) => (
                <div key={i} className="canvas-timeline-entry" style={{ cursor: "default" }}>
                  <div className="canvas-timeline-dot" style={{ background: step.reversible ? "var(--status-succeeded)" : "var(--status-warning)" }} />
                  <div className="canvas-timeline-content">
                    <div className="canvas-timeline-header">
                      <span className="canvas-timeline-type">{step.action}</span>
                      <span className="canvas-timeline-time">{step.target}</span>
                    </div>
                    <div className="canvas-timeline-decision">{step.description}</div>
                    {!step.reversible && (
                      <div style={{ fontSize: 11, color: "var(--status-warning)", marginTop: 2 }}>Non-reversible</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Execution Record */}
        {deployment.executionRecord && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Execution Record</h3>
            <div className="canvas-timeline">
              {deployment.executionRecord.steps.map((step, i) => {
                const stepColor = step.status === "completed" ? "var(--status-succeeded)" : step.status === "failed" ? "var(--status-failed)" : "var(--status-warning)";
                return (
                  <div key={i} className="canvas-timeline-entry" style={{ cursor: "default" }}>
                    <div className="canvas-timeline-dot" style={{ background: stepColor }} />
                    <div className="canvas-timeline-content">
                      <div className="canvas-timeline-header">
                        <span className="canvas-timeline-type">{step.status}</span>
                        <span className="canvas-timeline-time">
                          {new Date(step.startedAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="canvas-timeline-decision">{step.description}</div>
                      {step.output && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{step.output}</div>
                      )}
                      {step.error && (
                        <div style={{ fontSize: 11, color: "var(--status-failed)", marginTop: 2 }}>{step.error}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Failure analysis */}
        {postmortem?.failureAnalysis && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Failure Analysis</h3>
            <div className="canvas-failure-card">
              <div className="canvas-failure-row">
                <strong>Failed step:</strong> {postmortem.failureAnalysis.failedStep}
              </div>
              <div className="canvas-failure-row">
                <strong>What happened:</strong> {postmortem.failureAnalysis.whatHappened}
              </div>
              <div className="canvas-failure-row">
                <strong>Why:</strong> {postmortem.failureAnalysis.whyItFailed}
              </div>
              <div className="canvas-failure-row">
                <strong>Suggested fix:</strong> {postmortem.failureAnalysis.suggestedFix}
              </div>
            </div>
          </div>
        )}

        {/* Variables */}
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

        {/* Decision diary timeline */}
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
                    style={{ background: decisionTypeColors[entry.decisionType] ?? "#6b7280" }}
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
