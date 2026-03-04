import { useState, useEffect } from "react";
import { getDeployment, getPostmortem, listEnvironments, listOperations, listPartitions } from "../../api.js";
import type { Deployment, DebriefEntry, Environment, Operation, Partition, PostmortemReport } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

const decisionTypeColors: Record<string, string> = {
  "pipeline-plan": "#6366f1",
  "configuration-resolved": "#8b5cf6",
  "variable-conflict": "#f59e0b",
  "health-check": "#06b6d4",
  "deployment-execution": "#3b82f6",
  "deployment-verification": "#10b981",
  "deployment-completion": "#16a34a",
  "deployment-failure": "#dc2626",
  "diagnostic-investigation": "#ec4899",
  "environment-scan": "#14b8a6",
  system: "#6b7280",
  "llm-call": "#6b7280",
  "artifact-analysis": "#ec4899",
  "plan-generation": "#6366f1",
  "plan-approval": "#16a34a",
  "plan-rejection": "#dc2626",
  "rollback-execution": "#dc2626",
  "cross-system-context": "#14b8a6",
};

interface Props {
  deploymentId: string;
  title: string;
}

export default function DeploymentDetailPanel({ deploymentId, title }: Props) {
  const { pushPanel } = useCanvas();

  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [debrief, setDebrief] = useState<DebriefEntry[]>([]);
  const [postmortem, setPostmortem] = useState<PostmortemReport | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());

  useEffect(() => {
    Promise.all([
      getDeployment(deploymentId),
      listEnvironments(),
      listOperations(),
      listPartitions(),
    ]).then(async ([result, e, p, t]) => {
      setDeployment(result.deployment);
      setDebrief(result.debrief);
      setEnvironments(e);
      setOperations(p);
      setPartitions(t);

      if (result.deployment.status === "failed") {
        try {
          const pm = await getPostmortem(deploymentId);
          setPostmortem(pm);
        } catch { /* postmortem not available */ }
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [deploymentId]);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!deployment) return <CanvasPanelHost title={title}><div className="error-msg">Deployment not found</div></CanvasPanelHost>;

  const envName = environments.find((e) => e.id === deployment.environmentId)?.name ?? deployment.environmentId;
  const projName = operations.find((p) => p.id === deployment.operationId)?.name ?? deployment.operationId;
  const partName = partitions.find((t) => t.id === deployment.partitionId)?.name ?? deployment.partitionId;

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

        <div className="canvas-deploy-meta">
          <button className="canvas-meta-link" onClick={() => pushPanel({
            type: "partition-detail", title: partName, params: { id: deployment.partitionId },
          })}>
            Partition: {partName}
          </button>
          <button className="canvas-meta-link" onClick={() => pushPanel({
            type: "environment-detail", title: envName, params: { id: deployment.environmentId },
          })}>
            Environment: {envName}
          </button>
          <span>Operation: {projName}</span>
          <span>Started: {new Date(deployment.createdAt).toLocaleString()}</span>
          {deployment.completedAt && (
            <span>Completed: {new Date(deployment.completedAt).toLocaleString()}</span>
          )}
        </div>

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
