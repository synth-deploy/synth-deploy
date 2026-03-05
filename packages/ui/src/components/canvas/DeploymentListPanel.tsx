import { useState, useEffect } from "react";
import { listDeployments, listEnvironments, listArtifacts, listPartitions } from "../../api.js";
import type { Deployment, Environment, Artifact, Partition } from "../../types.js";
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
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      listDeployments(filterPartitionId ? { partitionId: filterPartitionId } : undefined),
      listEnvironments(),
      listArtifacts(),
      listPartitions(),
    ]).then(([d, e, a, t]) => {
      let filtered = d;
      if (filterStatus) {
        filtered = filtered.filter((dep) => dep.status === filterStatus);
      }
      setDeployments(filtered);
      setEnvironments(e);
      setArtifacts(a);
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
                  {artifacts.find((a) => a.id === d.artifactId)?.name ?? d.artifactId.slice(0, 8)}
                </span>
                <span className="canvas-activity-partition">
                  {d.partitionId
                    ? (partitions.find((t) => t.id === d.partitionId)?.name ?? d.partitionId.slice(0, 8))
                    : "\u2014"}
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
