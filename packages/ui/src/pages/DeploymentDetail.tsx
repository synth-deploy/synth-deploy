import { useState, useEffect } from "react";
import { useParams, Link } from "react-router";
import { getDeployment, getPostmortem, listEnvironments, listPartitions, listArtifacts } from "../api.js";
import type { Deployment, DebriefEntry, PostmortemReport, Environment, Partition, Artifact } from "../types.js";
import StatusBadge from "../components/StatusBadge.js";
import EnvBadge from "../components/EnvBadge.js";
import DebriefTimeline from "../components/DebriefTimeline.js";
import VariableEditor from "../components/VariableEditor.js";

export default function DeploymentDetail() {
  const { id } = useParams<{ id: string }>();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [debrief, setDebrief] = useState<DebriefEntry[]>([]);
  const [postmortem, setPostmortem] = useState<PostmortemReport | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getDeployment(id),
      getPostmortem(id).catch(() => null),
      listEnvironments(),
      listPartitions(),
      listArtifacts(),
    ]).then(([data, pm, envs, ts, arts]) => {
      setDeployment(data.deployment);
      setDebrief(data.debrief);
      setPostmortem(pm);
      setEnvironments(envs);
      setPartitions(ts);
      setArtifacts(arts);
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, [id]);

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!deployment) return <div className="error-msg">Deployment not found</div>;

  const env = environments.find((e) => e.id === deployment.environmentId);
  const partition = deployment.partitionId ? partitions.find((t) => t.id === deployment.partitionId) : null;
  const artifact = artifacts.find((a) => a.id === deployment.artifactId);

  const durationMs = deployment.completedAt
    ? new Date(deployment.completedAt).getTime() - new Date(deployment.createdAt).getTime()
    : null;

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/">Dashboard</Link> / Deployment {deployment.id.slice(0, 8)}
      </div>

      <div className="deploy-header">
        <div className="deploy-header-main">
          <div className="flex items-center gap-12">
            <h2 style={{ fontSize: 22, fontWeight: 700 }}>
              v{deployment.version}
            </h2>
            <StatusBadge status={deployment.status} />
          </div>
          <div className="deploy-header-meta">
            <div className="meta-item">
              <span className="meta-label">Artifact</span>
              <span className="meta-value">{artifact?.name ?? deployment.artifactId.slice(0, 8)}</span>
            </div>
            {partition && (
              <div className="meta-item">
                <span className="meta-label">Partition</span>
                <Link to={`/partitions/${partition.id}`} className="meta-value">{partition.name}</Link>
              </div>
            )}
            <div className="meta-item">
              <span className="meta-label">Environment</span>
              {env ? <EnvBadge name={env.name} /> : <span className="meta-value">{deployment.environmentId.slice(0, 8)}</span>}
            </div>
            {deployment.approvedBy && (
              <div className="meta-item">
                <span className="meta-label">Approved By</span>
                <span className="meta-value">{deployment.approvedBy}</span>
              </div>
            )}
            <div className="meta-item">
              <span className="meta-label">Started</span>
              <span className="meta-value">
                {new Date(deployment.createdAt).toLocaleString()}
              </span>
            </div>
            {durationMs !== null && (
              <div className="meta-item">
                <span className="meta-label">Duration</span>
                <span className="meta-value">
                  {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Deployment Plan */}
      {deployment.plan && deployment.plan.steps.length > 0 && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Deployment Plan</h3>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {deployment.plan.steps.length} step{deployment.plan.steps.length !== 1 ? "s" : ""}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
              {deployment.plan.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontWeight: 600, fontSize: 12, color: "var(--text-secondary)", minWidth: 24 }}>{i + 1}.</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{s.description}</div>
                    {s.action && <div className="text-secondary" style={{ fontSize: 12, marginTop: 2 }}>{s.action} &rarr; {s.target}</div>}
                  </div>
                  <span className={`badge badge-${s.reversible ? "succeeded" : "running"}`} style={{ fontSize: 10 }}>
                    {s.reversible ? "reversible" : "irreversible"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Rollback Plan */}
      {deployment.rollbackPlan && deployment.rollbackPlan.steps.length > 0 && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Rollback Plan</h3>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" }}>
              {deployment.rollbackPlan.steps.map((s, i) => (
                <div key={i} style={{ fontSize: 13, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontWeight: 600, fontSize: 12, color: "var(--text-secondary)" }}>{i + 1}.</span> {s.description}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Execution Record */}
      {deployment.executionRecord && deployment.executionRecord.steps.length > 0 && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Execution Record</h3>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {deployment.executionRecord.steps.filter((s) => s.status === "completed").length} / {deployment.executionRecord.steps.length} completed
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 0" }}>
              {deployment.executionRecord.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                  <span className={`badge badge-${s.status === "completed" ? "succeeded" : s.status === "failed" ? "failed" : "pending"}`} style={{ fontSize: 10, minWidth: 60, textAlign: "center" }}>
                    {s.status}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13 }}>{s.description}</div>
                    {s.output && <div className="text-secondary" style={{ fontSize: 12, marginTop: 2, fontFamily: "var(--font-mono)" }}>{s.output}</div>}
                    {s.error && <div style={{ fontSize: 12, marginTop: 2, color: "#dc2626" }}>{s.error}</div>}
                  </div>
                  {s.completedAt && s.startedAt && (() => {
                    const ms = new Date(s.completedAt).getTime() - new Date(s.startedAt).getTime();
                    return (
                      <span className="text-muted" style={{ fontSize: 11 }}>
                        {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
                      </span>
                    );
                  })()}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Failure Analysis — shown for failed deployments even if postmortem failed to load */}
      {deployment.status === "failed" && !postmortem?.failureAnalysis && (
        <div className="failure-card">
          <h4>Deployment Failed</h4>
          <div className="failure-field">
            <div className="failure-label">Reason</div>
            <div className="failure-value">{deployment.failureReason ?? "No failure details available. Check the Debrief timeline below."}</div>
          </div>
        </div>
      )}
      {postmortem?.failureAnalysis && (
        <div className="failure-card">
          <h4>Failure Analysis</h4>
          <div className="failure-field">
            <div className="failure-label">Failed Step</div>
            <div className="failure-value">{postmortem.failureAnalysis.failedStep}</div>
          </div>
          <div className="failure-field">
            <div className="failure-label">What Happened</div>
            <div className="failure-value">{postmortem.failureAnalysis.whatHappened}</div>
          </div>
          <div className="failure-field">
            <div className="failure-label">Why</div>
            <div className="failure-value">{postmortem.failureAnalysis.whyItFailed}</div>
          </div>
          <div className="suggested-fix">
            <strong>Suggested Fix:</strong> {postmortem.failureAnalysis.suggestedFix}
          </div>
        </div>
      )}

      {/* Debrief Timeline — THE DIFFERENTIATOR */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Debrief</h3>
            <span className="text-muted" style={{ fontSize: 12 }}>
              {debrief.length} decision{debrief.length !== 1 ? "s" : ""} recorded
            </span>
          </div>
          <DebriefTimeline entries={debrief} />
        </div>
      </div>

      {/* Resolved Variables */}
      {Object.keys(deployment.variables).length > 0 && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Resolved Variables</h3>
            </div>
            <VariableEditor
              variables={deployment.variables}
              onSave={async () => {}}
              readOnly
            />
          </div>
        </div>
      )}

      {/* Configuration Summary */}
      {postmortem && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Configuration</h3>
            </div>
            <p style={{ fontSize: 13 }}>
              {postmortem.configuration.variableCount} variable(s) resolved,{" "}
              {postmortem.configuration.conflictCount} conflict(s)
            </p>
            {postmortem.configuration.conflicts.length > 0 && (
              <div className="mt-16">
                {postmortem.configuration.conflicts.map((c, i) => (
                  <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{c.description}</div>
                    <div className="flex gap-8 mt-16" style={{ marginTop: 4 }}>
                      <span className={`badge badge-${c.riskLevel === "high" ? "failed" : c.riskLevel === "medium" ? "running" : "succeeded"}`}>
                        {c.riskLevel} risk
                      </span>
                    </div>
                    <div className="text-secondary" style={{ fontSize: 12, marginTop: 4 }}>
                      {c.resolution}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
