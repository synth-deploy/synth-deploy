import { useState, useEffect } from "react";
import { useParams, Link } from "react-router";
import { getDeployment, getPostmortem, listEnvironments, listTenants } from "../api.js";
import type { Deployment, DebriefEntry, PostmortemReport, Environment, Tenant } from "../types.js";
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
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getDeployment(id),
      getPostmortem(id),
      listEnvironments(),
      listTenants(),
    ]).then(([data, pm, envs, ts]) => {
      setDeployment(data.deployment);
      setDebrief(data.debrief);
      setPostmortem(pm);
      setEnvironments(envs);
      setTenants(ts);
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
  const tenant = tenants.find((t) => t.id === deployment.tenantId);

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
              <span className="meta-label">Project</span>
              <Link to={`/projects/${deployment.projectId}`} className="meta-value">
                {deployment.projectId.slice(0, 8)}
              </Link>
            </div>
            <div className="meta-item">
              <span className="meta-label">Tenant</span>
              {tenant ? (
                <Link to={`/tenants/${tenant.id}`} className="meta-value">{tenant.name}</Link>
              ) : (
                <span className="meta-value">{deployment.tenantId.slice(0, 8)}</span>
              )}
            </div>
            <div className="meta-item">
              <span className="meta-label">Environment</span>
              {env ? <EnvBadge name={env.name} /> : <span className="meta-value">{deployment.environmentId.slice(0, 8)}</span>}
            </div>
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
              {debrief.length} decision{diary.length !== 1 ? "s" : ""} recorded
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
