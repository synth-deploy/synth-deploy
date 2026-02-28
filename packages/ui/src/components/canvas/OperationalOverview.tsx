import { useState, useEffect } from "react";
import { listDeployments, listPartitions, listEnvironments, listProjects, getDeploymentContext } from "../../api.js";
import type { Deployment, Partition, Environment, Project } from "../../types.js";
import type { DeploymentContext } from "../../api.js";
import { useCanvas } from "../../context/CanvasContext.js";
import EnvBadge from "../EnvBadge.js";
import type { EnvAgentData } from "../EnvBadge.js";

export default function OperationalOverview() {
  const { pushPanel } = useCanvas();

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agentContext, setAgentContext] = useState<DeploymentContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      listDeployments(),
      listPartitions(),
      listEnvironments(),
      listProjects(),
      getDeploymentContext(),
    ]).then(([d, t, e, p, ctx]) => {
      setDeployments(d);
      setPartitions(t);
      setEnvironments(e);
      setProjects(p);
      setAgentContext(ctx);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading...</div>;

  const succeeded = deployments.filter((d) => d.status === "succeeded").length;
  const successRate = deployments.length > 0
    ? `${Math.round((succeeded / deployments.length) * 100)}%`
    : "\u2014";

  const recent = [...deployments]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);

  function agentDataForEnv(envName: string): EnvAgentData | undefined {
    if (!agentContext) return undefined;
    const envSummary = agentContext.environmentSummary.find(
      (e) => e.name.toLowerCase() === envName.toLowerCase(),
    );
    if (!envSummary) return undefined;

    const envDeployments = deployments.filter((d) => d.environmentId === envSummary.id);
    const envSucceeded = envDeployments.filter((d) => d.status === "succeeded").length;
    const rate = envDeployments.length > 0
      ? `${Math.round((envSucceeded / envDeployments.length) * 100)}%`
      : "\u2014";

    const history = [...envDeployments]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
      .map((d): "succeeded" | "failed" => d.status === "succeeded" ? "succeeded" : "failed");

    const hasDrift = agentContext?.signals.some(
      (s) => s.type === "drift" && s.relatedEntity?.id === envSummary.id,
    ) ?? false;

    return { successRate: rate, envoyHealth: "OK" as const, drift: hasDrift, history };
  }

  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };

  const sortedSignals = [...(agentContext?.signals ?? [])].sort(
    (a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
  );

  return (
    <div className="canvas-overview">
      {/* Summary strip */}
      <div className="canvas-summary-strip">
        <div className="canvas-summary-item">
          <span className="canvas-summary-value">{deployments.length}</span>
          <span className="canvas-summary-label">Deployments</span>
        </div>
        <div className="canvas-summary-item">
          <span className="canvas-summary-value">{successRate}</span>
          <span className="canvas-summary-label">Success Rate</span>
        </div>
        <div className="canvas-summary-item">
          <span className="canvas-summary-value">{partitions.length}</span>
          <span className="canvas-summary-label">Partitions</span>
        </div>
        <div className="canvas-summary-item">
          <span className="canvas-summary-value">{projects.length}</span>
          <span className="canvas-summary-label">Projects</span>
        </div>
        <div className="canvas-summary-item">
          <span className="canvas-summary-value">{environments.length}</span>
          <span className="canvas-summary-label">Environments</span>
        </div>
      </div>

      {/* Signals */}
      {sortedSignals.length > 0 && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Active Signals</h3>
          <div className="canvas-signal-grid">
            {sortedSignals.map((signal, i) => (
              <button
                key={i}
                className={`canvas-signal-card canvas-signal-${signal.severity}`}
                onClick={() => {
                  if (signal.relatedEntity) {
                    pushPanel({
                      type: `${signal.relatedEntity.type === "environment" ? "environment" : "partition"}-detail`,
                      title: signal.relatedEntity.name,
                      params: { id: signal.relatedEntity.id },
                    });
                  }
                }}
              >
                <div className="canvas-signal-severity">{signal.severity.toUpperCase()}</div>
                <div className="canvas-signal-title">{signal.title}</div>
                <div className="canvas-signal-detail">{signal.detail}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Partition health grid */}
      {partitions.length > 0 && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Partition Health</h3>
          <div className="canvas-partition-grid">
            {partitions.map((partition) => (
              <button
                key={partition.id}
                className="canvas-partition-card"
                onClick={() => pushPanel({
                  type: "partition-detail",
                  title: partition.name,
                  params: { id: partition.id },
                })}
              >
                <div className="canvas-partition-header">
                  <div className="canvas-partition-avatar">{partition.name[0]}</div>
                  <span className="canvas-partition-name">{partition.name}</span>
                </div>
                <div className="canvas-partition-envs">
                  {environments.map((env) => (
                    <EnvBadge
                      key={env.id}
                      name={env.name}
                      agentData={agentDataForEnv(env.name)}
                    />
                  ))}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      {recent.length > 0 && (
        <div className="canvas-section">
          <h3 className="canvas-section-title">Recent Activity</h3>
          <div className="canvas-activity-list">
            {recent.map((d) => (
              <button
                key={d.id}
                className="canvas-activity-row"
                onClick={() => pushPanel({
                  type: "deployment-detail",
                  title: `Deployment ${d.version}`,
                  params: { id: d.id },
                })}
              >
                <span className={`badge badge-${d.status}`}>{d.status}</span>
                <span className="canvas-activity-version">{d.version}</span>
                <span className="canvas-activity-project">
                  {projects.find((p) => p.id === d.projectId)?.name ?? d.projectId}
                </span>
                <span className="canvas-activity-env">
                  {environments.find((e) => e.id === d.environmentId)?.name ?? d.environmentId}
                </span>
                <span className="canvas-activity-time">
                  {new Date(d.createdAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {deployments.length === 0 && partitions.length === 0 && (
        <div className="canvas-empty">
          <p>No data yet. Use the intent bar below to get started.</p>
        </div>
      )}
    </div>
  );
}
