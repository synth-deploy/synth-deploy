import { useState, useEffect } from "react";
import { getPartition, getPartitionHistory, listDeployments, listEnvironments, getDeploymentContext } from "../../api.js";
import type { Partition, Deployment, Environment } from "../../types.js";
import type { OperationHistory, DeploymentContext } from "../../api.js";
import { useCanvas } from "../../context/CanvasContext.js";
import EnvBadge from "../EnvBadge.js";
import type { EnvAgentData } from "../EnvBadge.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  partitionId: string;
  title: string;
}

export default function PartitionDetailPanel({ partitionId, title }: Props) {
  const { pushPanel } = useCanvas();

  const [partition, setPartition] = useState<Partition | null>(null);
  const [history, setHistory] = useState<OperationHistory | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [agentContext, setAgentContext] = useState<DeploymentContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getPartition(partitionId),
      getPartitionHistory(partitionId).catch(() => null),
      listDeployments(partitionId),
      listEnvironments(),
      getDeploymentContext(),
    ]).then(([p, h, d, e, ctx]) => {
      setPartition(p);
      setHistory(h);
      setDeployments(d);
      setEnvironments(e);
      setAgentContext(ctx);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [partitionId]);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!partition) return <CanvasPanelHost title={title}><div className="error-msg">Partition not found</div></CanvasPanelHost>;

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

    const historyDots = [...envDeployments]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
      .map((d): "succeeded" | "failed" => d.status === "succeeded" ? "succeeded" : "failed");

    const hasDrift = agentContext?.signals.some(
      (s) => s.type === "drift" && s.relatedEntity?.id === envSummary.id,
    ) ?? false;

    return { successRate: rate, envoyHealth: "OK" as const, drift: hasDrift, history: historyDots };
  }

  const sorted = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const vars = Object.entries(partition.variables);

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {/* Overview stats */}
        {history && (
          <div className="canvas-summary-strip">
            <div className="canvas-summary-item">
              <span className="canvas-summary-value">{history.overview.totalDeployments}</span>
              <span className="canvas-summary-label">Deployments</span>
            </div>
            <div className="canvas-summary-item">
              <span className="canvas-summary-value">{history.overview.successRate}</span>
              <span className="canvas-summary-label">Success Rate</span>
            </div>
            <div className="canvas-summary-item">
              <span className="canvas-summary-value">{history.overview.environments.length}</span>
              <span className="canvas-summary-label">Environments</span>
            </div>
            <div className="canvas-summary-item">
              <span className="canvas-summary-value">{history.overview.versions.length}</span>
              <span className="canvas-summary-label">Versions</span>
            </div>
          </div>
        )}

        {/* Variables */}
        {vars.length > 0 && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Variables</h3>
            <div className="canvas-var-table">
              {vars.map(([k, v]) => (
                <div key={k} className="canvas-var-row">
                  <span className="mono">{k}</span>
                  <span className="mono">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Environment badges */}
        {environments.length > 0 && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Environments</h3>
            <div className="canvas-env-grid">
              {environments.map((env) => (
                <button
                  key={env.id}
                  className="canvas-env-card"
                  onClick={() => pushPanel({
                    type: "environment-detail",
                    title: env.name,
                    params: { id: env.id },
                  })}
                >
                  <EnvBadge name={env.name} agentData={agentDataForEnv(env.name)} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Deployment history */}
        {sorted.length > 0 && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Deployment History</h3>
            <div className="canvas-activity-list">
              {sorted.slice(0, 15).map((d) => (
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
      </div>
    </CanvasPanelHost>
  );
}
