import { useState, useEffect } from "react";
import { listPartitions, listOrders, listEnvironments, listDeployments } from "../../api.js";
import type { Partition, Order, Environment, Deployment } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
}

export default function PartitionListPanel({ title }: Props) {
  const { pushPanel } = useCanvas();

  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([listPartitions(), listOrders(), listEnvironments(), listDeployments()])
      .then(([t, o, e, d]) => {
        setPartitions(t);
        setOrders(o);
        setEnvironments(e);
        setDeployments(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;

  return (
    <CanvasPanelHost title={title}>
      <div className="v2-entity-list">
        <div className="v2-entity-list-header">
          <div>
            <div className="v2-entity-list-title">Partitions</div>
            <div className="v2-entity-list-desc">
              Isolated configuration boundaries. Each Partition is completely separated from every other.
            </div>
          </div>
          <button className="v2-create-btn v2-create-btn-partition">+ Create Partition</button>
        </div>

        <div className="v2-entity-list-items">
          {partitions.map((p) => {
            const orderCount = orders.filter((o) => o.partitionId === p.id).length;
            const varCount = Object.keys(p.variables).length;
            const deploys = deployments.filter((d) => d.partitionId === p.id);
            const lastDeploy = deploys.length > 0
              ? [...deploys].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
              : null;
            const isDormant = varCount === 0 && orderCount === 0;
            return (
              <div
                key={p.id}
                className={`v2-partition-list-item ${isDormant ? "v2-partition-list-dormant" : ""}`}
                onClick={() => {
                  if (!isDormant) {
                    pushPanel({
                      type: "partition-detail",
                      title: p.name,
                      params: { id: p.id },
                    });
                  }
                }}
              >
                <div className={`v2-partition-list-avatar ${isDormant ? "v2-avatar-dormant" : ""}`}>
                  <span>{p.name[0]}</span>
                </div>
                <div className="v2-partition-list-info">
                  <div className="v2-partition-list-name">{p.name}</div>
                  <div className="v2-partition-list-envs">
                    {environments.map((e) => (
                      <span key={e.id} className={`v2-partition-list-env ${isDormant ? "v2-env-dormant" : ""}`}>
                        {e.name}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="v2-partition-list-stats">
                  <div className="v2-stat-col">
                    <span className={`v2-stat-value ${isDormant ? "v2-stat-dormant" : ""}`}>{varCount}</span>
                    <span className="v2-stat-label">Variables</span>
                  </div>
                  <div className="v2-stat-col">
                    <span className={`v2-stat-value ${isDormant ? "v2-stat-dormant" : ""}`}>{orderCount}</span>
                    <span className="v2-stat-label">Orders</span>
                  </div>
                  <div className="v2-stat-col">
                    <span className={`v2-stat-value ${isDormant ? "v2-stat-dormant" : ""}`}>
                      {lastDeploy
                        ? new Date(lastDeploy.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                        : "\u2014"}
                    </span>
                    <span className="v2-stat-label">Last deploy</span>
                  </div>
                </div>
                <div className={`v2-partition-list-status ${isDormant ? "v2-status-dormant" : "v2-status-active"}`}>
                  {isDormant ? "DORMANT" : "ACTIVE"}
                </div>
              </div>
            );
          })}
          {partitions.length === 0 && (
            <div className="v2-empty-hint">No partitions yet. Use the Command Channel to create one.</div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
