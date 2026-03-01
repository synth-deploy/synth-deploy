import { useState, useEffect } from "react";
import { listDeployments, listEnvironments, listOperations, listPartitions } from "../../api.js";
import type { Deployment, Environment, Operation, Partition } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
  filterStatus?: string;
  filterPartitionId?: string;
}

export default function DeploymentListPanel({ title, filterStatus, filterPartitionId }: Props) {
  const { pushPanel } = useCanvas();

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      listDeployments(filterPartitionId),
      listEnvironments(),
      listOperations(),
      listPartitions(),
    ]).then(([d, e, p, t]) => {
      let filtered = d;
      if (filterStatus) {
        filtered = filtered.filter((dep) => dep.status === filterStatus);
      }
      setDeployments(filtered);
      setEnvironments(e);
      setOperations(p);
      setPartitions(t);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [filterStatus, filterPartitionId]);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;

  const sorted = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div className="canvas-summary-strip">
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{deployments.length}</span>
            <span className="canvas-summary-label">Total</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">
              {deployments.filter((d) => d.status === "succeeded").length}
            </span>
            <span className="canvas-summary-label">Succeeded</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">
              {deployments.filter((d) => d.status === "failed").length}
            </span>
            <span className="canvas-summary-label">Failed</span>
          </div>
        </div>

        {sorted.length > 0 ? (
          <div className="canvas-activity-list">
            {sorted.map((d) => (
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
                <span className="canvas-activity-partition">
                  {partitions.find((t) => t.id === d.partitionId)?.name ?? d.partitionId}
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
        ) : (
          <div className="canvas-empty">
            <p>No deployments match the current filter.</p>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
