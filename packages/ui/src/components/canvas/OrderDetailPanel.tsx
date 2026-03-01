import { useState, useEffect } from "react";
import { getOrder, executeOrder, listPartitions } from "../../api.js";
import type { Order, Deployment, Partition } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import EnvBadge from "../EnvBadge.js";

interface Props {
  orderId: string;
  title: string;
}

export default function OrderDetailPanel({ orderId, title }: Props) {
  const { pushPanel } = useCanvas();
  const [order, setOrder] = useState<Order | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);

  useEffect(() => {
    Promise.all([getOrder(orderId), listPartitions()])
      .then(([data, ts]) => {
        setOrder(data.order);
        setDeployments(data.deployments);
        setPartitions(ts);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [orderId]);

  async function handleExecute() {
    setExecuting(true);
    setError(null);
    try {
      const result = await executeOrder(orderId);
      pushPanel({
        type: "deployment-detail",
        title: `Deployment ${result.deployment.version}`,
        params: { id: result.deployment.id },
      });
    } catch (e: any) {
      setError(e.message);
      setExecuting(false);
    }
  }

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (error && !order) return <CanvasPanelHost title={title}><div className="error-msg">{error}</div></CanvasPanelHost>;
  if (!order) return <CanvasPanelHost title={title}><div className="error-msg">Order not found</div></CanvasPanelHost>;

  const partition = partitions.find((t) => t.id === order.partitionId);
  const stepTypeLabel = (type: string) =>
    type === "pre-deploy" ? "Pre-deploy" : type === "post-deploy" ? "Post-deploy" : "Verification";

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {/* Header */}
        <div className="deploy-header">
          <div className="deploy-header-main">
            <div className="flex items-center gap-12">
              <h2 style={{ fontSize: 22, fontWeight: 700 }}>{order.projectName}</h2>
              <span className="badge badge-pending">v{order.version}</span>
              <EnvBadge name={order.environmentName} />
            </div>
            <div style={{ marginTop: 8 }}>
              <button
                className="btn btn-primary"
                onClick={handleExecute}
                disabled={executing}
              >
                {executing ? "Executing..." : "Execute Order"}
              </button>
            </div>
            <div className="deploy-header-meta">
              <div className="meta-item">
                <span className="meta-label">Project</span>
                <span className="meta-value">{order.projectName}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Partition</span>
                {partition ? (
                  <button
                    className="meta-value"
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--accent)", textDecoration: "underline" }}
                    onClick={() => pushPanel({
                      type: "partition-detail",
                      title: partition.name,
                      params: { id: partition.id },
                    })}
                  >
                    {partition.name}
                  </button>
                ) : (
                  <span className="meta-value">{order.partitionId.slice(0, 8)}</span>
                )}
              </div>
              <div className="meta-item">
                <span className="meta-label">Environment</span>
                <EnvBadge name={order.environmentName} />
              </div>
              <div className="meta-item">
                <span className="meta-label">Created</span>
                <span className="meta-value">{new Date(order.createdAt).toLocaleString()}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Order ID</span>
                <span className="meta-value mono">{order.id.slice(0, 12)}</span>
              </div>
            </div>
          </div>
        </div>

        {error && <div className="error-msg" style={{ margin: "0 16px 12px" }}>{error}</div>}

        {/* Frozen Deployment Steps */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Deployment Steps</h3>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {order.steps.length} step{order.steps.length !== 1 ? "s" : ""} (frozen at order creation)
              </span>
            </div>
            {order.steps.length > 0 ? (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Command</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.steps
                      .sort((a, b) => a.order - b.order)
                      .map((step, i) => (
                        <tr key={step.id}>
                          <td className="text-muted">{i + 1}</td>
                          <td style={{ fontWeight: 500 }}>{step.name}</td>
                          <td>
                            <span className={`badge badge-${step.type === "verification" ? "running" : "pending"}`}>
                              {stepTypeLabel(step.type)}
                            </span>
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>{step.command}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-muted" style={{ padding: "12px 0", fontSize: 13 }}>
                No deployment steps configured at time of snapshot.
              </p>
            )}
          </div>
        </div>

        {/* Deployment Configuration */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Deployment Configuration</h3>
              <span className="text-muted" style={{ fontSize: 12 }}>frozen at order creation</span>
            </div>
            <div className="deploy-header-meta" style={{ padding: "8px 0" }}>
              <div className="meta-item">
                <span className="meta-label">Health Check</span>
                <span className="meta-value">{order.deployConfig.healthCheckEnabled ? "Enabled" : "Disabled"}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Retries</span>
                <span className="meta-value">{order.deployConfig.healthCheckRetries}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Timeout</span>
                <span className="meta-value">{order.deployConfig.timeoutMs}ms</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Verification</span>
                <span className="meta-value">{order.deployConfig.verificationStrategy}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Resolved Variables */}
        {Object.keys(order.variables).length > 0 && (
          <div className="section">
            <div className="card">
              <div className="card-header">
                <h3>Resolved Variables</h3>
                <span className="text-muted" style={{ fontSize: 12 }}>
                  {Object.keys(order.variables).length} variable{Object.keys(order.variables).length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="canvas-var-table">
                {Object.entries(order.variables).map(([key, value]) => (
                  <div key={key} className="canvas-var-row">
                    <span className="canvas-var-key">{key}</span>
                    <span className="canvas-var-value">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Deployments from this Order */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Deployments from this Order</h3>
              <span className="text-muted" style={{ fontSize: 12 }}>
                {deployments.length} execution{deployments.length !== 1 ? "s" : ""}
              </span>
            </div>
            {deployments.length > 0 ? (
              <div className="canvas-activity-list">
                {deployments.map((d) => (
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
                    <span className="canvas-activity-time">
                      {new Date(d.createdAt).toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-muted" style={{ padding: "12px 0", fontSize: 13 }}>
                This order has not been executed yet.
              </p>
            )}
          </div>
        </div>
      </div>
    </CanvasPanelHost>
  );
}
