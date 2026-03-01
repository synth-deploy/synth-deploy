import { useState, useEffect } from "react";
import { getEnvironment, listDeployments, listOperations } from "../../api.js";
import type { Environment, Deployment, Operation } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  environmentId: string;
  title: string;
}

export default function EnvironmentDetailPanel({ environmentId, title }: Props) {
  const { pushPanel } = useCanvas();

  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getEnvironment(environmentId),
      listDeployments(),
      listOperations(),
    ]).then(([e, d, p]) => {
      setEnvironment(e);
      setDeployments(d.filter((dep) => dep.environmentId === environmentId));
      setOperations(p);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [environmentId]);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!environment) return <CanvasPanelHost title={title}><div className="error-msg">Environment not found</div></CanvasPanelHost>;

  const vars = Object.entries(environment.variables);
  const succeeded = deployments.filter((d) => d.status === "succeeded").length;
  const successRate = deployments.length > 0
    ? `${Math.round((succeeded / deployments.length) * 100)}%`
    : "\u2014";

  const sorted = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
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
            <span className="canvas-summary-value">{vars.length}</span>
            <span className="canvas-summary-label">Variables</span>
          </div>
        </div>

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
                  <span className="canvas-activity-operation">
                    {operations.find((p) => p.id === d.operationId)?.name ?? d.operationId}
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
