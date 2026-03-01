import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router";
import {
  getOperation,
  listOperationDeployments,
  listEnvironments,
  listOrders,
  updateOperation,
  deleteOperation,
  addOperationEnvironment,
  removeOperationEnvironment,
  createOperationStep,
  updateOperationStep,
  deleteOperationStep,
  updateOperationDeployConfig,
  reorderOperationSteps,
} from "../api.js";
import type { Operation, Environment, Deployment, DeploymentStep, DeploymentStepType, DeployConfig, Order } from "../types.js";
import EnvBadge from "../components/EnvBadge.js";
import DeploymentTable from "../components/DeploymentTable.js";
import InlineEdit from "../components/InlineEdit.js";
import ConfirmDialog from "../components/ConfirmDialog.js";
import StepEditor from "../components/StepEditor.js";
import DeployConfigEditor from "../components/DeployConfigEditor.js";
import { useSettings } from "../context/SettingsContext.js";

export default function OperationDetail() {
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [operationEnvs, setOperationEnvs] = useState<Environment[]>([]);
  const [allEnvs, setAllEnvs] = useState<Environment[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [addEnvId, setAddEnvId] = useState("");

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getOperation(id),
      listOperationDeployments(id),
      listEnvironments(),
      listOrders({ operationId: id }),
    ]).then(([data, deps, envs, ords]) => {
      setOperation(data.operation);
      setOperationEnvs(data.environments);
      setDeployments(deps);
      setAllEnvs(envs);
      setOrders(ords);
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, [id]);

  async function handleUpdateName(newName: string) {
    if (!id) return;
    const updated = await updateOperation(id, { name: newName });
    setOperation(updated);
  }

  async function handleDelete() {
    if (!id) return;
    await deleteOperation(id);
    navigate("/operations");
  }

  async function handleAddEnv() {
    if (!id || !addEnvId) return;
    const updated = await addOperationEnvironment(id, addEnvId);
    setOperation(updated);
    const env = allEnvs.find((e) => e.id === addEnvId);
    if (env) setOperationEnvs([...operationEnvs, env]);
    setAddEnvId("");
  }

  async function handleRemoveEnv(envId: string) {
    if (!id) return;
    const updated = await removeOperationEnvironment(id, envId);
    setOperation(updated);
    setOperationEnvs(operationEnvs.filter((e) => e.id !== envId));
  }

  async function handleAddStep(step: { name: string; type: DeploymentStepType; command: string; order?: number }) {
    if (!id || !operation) return;
    const newStep = await createOperationStep(id, step);
    setOperation({ ...operation, steps: [...operation.steps, newStep].sort((a, b) => a.order - b.order) });
  }

  async function handleUpdateStep(stepId: string, updates: Partial<DeploymentStep>) {
    if (!id || !operation) return;
    const updated = await updateOperationStep(id, stepId, updates);
    setOperation({
      ...operation,
      steps: operation.steps.map((s) => (s.id === stepId ? updated : s)).sort((a, b) => a.order - b.order),
    });
  }

  async function handleDeleteStep(stepId: string) {
    if (!id || !operation) return;
    await deleteOperationStep(id, stepId);
    setOperation({ ...operation, steps: operation.steps.filter((s) => s.id !== stepId) });
  }

  async function handleReorderSteps(stepIds: string[]) {
    if (!id || !operation) return;
    const reordered = await reorderOperationSteps(id, stepIds);
    setOperation({ ...operation, steps: reordered });
  }

  async function handleSaveDeployConfig(config: DeployConfig) {
    if (!id || !operation) return;
    const updated = await updateOperationDeployConfig(id, config);
    setOperation({ ...operation, deployConfig: updated });
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!operation) return <div className="error-msg">Operation not found</div>;

  const sorted = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // Environments not yet linked to this operation
  const unlinkedEnvs = allEnvs.filter(
    (e) => !operation.environmentIds.includes(e.id),
  );

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/operations">Operations</Link> / {operation.name}
      </div>
      <div className="page-header">
        <InlineEdit value={operation.name} onSave={handleUpdateName} />
        <div style={{ display: "flex", gap: 8 }}>
          <Link to={`/deploy?operationId=${operation.id}`} className="btn btn-primary">
            Deploy
          </Link>
          <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>
            Delete
          </button>
        </div>
      </div>

      {/* Environments */}
      {environmentsEnabled && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Environments</h3>
            </div>
            <div className="env-link-row">
              {operationEnvs.map((env) => (
                <div key={env.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <EnvBadge name={env.name} />
                  <button
                    className="env-remove-btn"
                    onClick={() => handleRemoveEnv(env.id)}
                    title={`Unlink ${env.name}`}
                  >
                    &times;
                  </button>
                </div>
              ))}
              {operationEnvs.length === 0 && <span className="text-muted">No environments linked</span>}
            </div>
            {unlinkedEnvs.length > 0 && (
              <div className="env-link-add">
                <select value={addEnvId} onChange={(e) => setAddEnvId(e.target.value)}>
                  <option value="">Add environment...</option>
                  {unlinkedEnvs.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
                <button className="btn btn-primary" onClick={handleAddEnv} disabled={!addEnvId}>
                  Add
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Deployment Steps */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Deployment Steps</h3>
          </div>
          <StepEditor
            steps={operation.steps}
            onAdd={handleAddStep}
            onUpdate={handleUpdateStep}
            onDelete={handleDeleteStep}
            onReorder={handleReorderSteps}
          />
        </div>
      </div>

      {/* Deployment Configuration */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Deployment Configuration</h3>
          </div>
          <DeployConfigEditor
            config={operation.deployConfig}
            onSave={handleSaveDeployConfig}
          />
        </div>
      </div>

      {/* Orders */}
      {orders.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h3>Orders</h3>
            <span className="text-muted" style={{ fontSize: 12 }}>{orders.length} order{orders.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Version</th>
                  <th>Environment</th>
                  <th>Steps</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {orders
                  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                  .slice(0, 10)
                  .map((o) => (
                    <tr key={o.id}>
                      <td>
                        <Link to={`/orders/${o.id}`} className="mono" style={{ fontWeight: 500 }}>
                          {o.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="mono">v{o.version}</td>
                      <td>{o.environmentName}</td>
                      <td>{o.steps.length}</td>
                      <td className="text-muted" style={{ fontSize: 12 }}>
                        {new Date(o.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Deployment History */}
      <div className="card">
        <div className="card-header">
          <h3>Deployment History</h3>
        </div>
        <DeploymentTable deployments={sorted} environments={allEnvs} showOperation={false} />
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Operation"
          message={`Are you sure you want to delete "${operation.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
