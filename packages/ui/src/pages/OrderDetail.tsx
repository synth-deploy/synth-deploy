import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router";
import { getOrder, executeOrder, listPartitions } from "../api.js";
import type { Order, Deployment, Partition } from "../types.js";
import EnvBadge from "../components/EnvBadge.js";
import VariableEditor from "../components/VariableEditor.js";
import DeploymentTable from "../components/DeploymentTable.js";

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [order, setOrder] = useState<Order | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([getOrder(id), listPartitions()])
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
  }, [id]);

  async function handleExecute() {
    if (!id) return;
    setExecuting(true);
    setError(null);
    try {
      const result = await executeOrder(id);
      navigate(`/deployments/${result.deployment.id}`);
    } catch (e: any) {
      setError(e.message);
      setExecuting(false);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (error && !order) return <div className="error-msg">{error}</div>;
  if (!order) return <div className="error-msg">Order not found</div>;

  const partition = partitions.find((t) => t.id === order.partitionId);
  const stepTypeLabel = (type: string) =>
    type === "pre-deploy" ? "Pre-deploy" : type === "post-deploy" ? "Post-deploy" : "Verification";

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/orders">Orders</Link> / {order.id.slice(0, 8)}
      </div>

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
              <Link to={`/projects/${order.projectId}`} className="meta-value">{order.projectName}</Link>
            </div>
            <div className="meta-item">
              <span className="meta-label">Partition</span>
              {partition ? (
                <Link to={`/partitions/${partition.id}`} className="meta-value">{partition.name}</Link>
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

      {error && <div className="error-msg">{error}</div>}

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

      {/* Pipeline Configuration */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Pipeline Configuration</h3>
            <span className="text-muted" style={{ fontSize: 12 }}>frozen at order creation</span>
          </div>
          <div className="deploy-header-meta" style={{ padding: "8px 0" }}>
            <div className="meta-item">
              <span className="meta-label">Health Check</span>
              <span className="meta-value">{order.pipelineConfig.healthCheckEnabled ? "Enabled" : "Disabled"}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Retries</span>
              <span className="meta-value">{order.pipelineConfig.healthCheckRetries}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Timeout</span>
              <span className="meta-value">{order.pipelineConfig.timeoutMs}ms</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Verification</span>
              <span className="meta-value">{order.pipelineConfig.verificationStrategy}</span>
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
            <VariableEditor
              variables={order.variables}
              onSave={async () => {}}
              readOnly
            />
          </div>
        </div>
      )}

      {/* Deployment History */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Deployments from this Order</h3>
            <span className="text-muted" style={{ fontSize: 12 }}>
              {deployments.length} execution{deployments.length !== 1 ? "s" : ""}
            </span>
          </div>
          {deployments.length > 0 ? (
            <DeploymentTable deployments={deployments} />
          ) : (
            <p className="text-muted" style={{ padding: "12px 0", fontSize: 13 }}>
              This order has not been executed yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
