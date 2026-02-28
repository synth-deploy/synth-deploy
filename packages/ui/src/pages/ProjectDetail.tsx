import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router";
import {
  getProject,
  listProjectDeployments,
  listEnvironments,
  listOrders,
  updateProject,
  deleteProject,
  addProjectEnvironment,
  removeProjectEnvironment,
  createProjectStep,
  updateProjectStep,
  deleteProjectStep,
  updateProjectDeployConfig,
  reorderProjectSteps,
} from "../api.js";
import type { Project, Environment, Deployment, DeploymentStep, DeploymentStepType, DeployConfig, Order } from "../types.js";
import EnvBadge from "../components/EnvBadge.js";
import DeploymentTable from "../components/DeploymentTable.js";
import InlineEdit from "../components/InlineEdit.js";
import ConfirmDialog from "../components/ConfirmDialog.js";
import StepEditor from "../components/StepEditor.js";
import DeployConfigEditor from "../components/DeployConfigEditor.js";
import { useSettings } from "../context/SettingsContext.js";

export default function ProjectDetail() {
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [projectEnvs, setProjectEnvs] = useState<Environment[]>([]);
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
      getProject(id),
      listProjectDeployments(id),
      listEnvironments(),
      listOrders({ projectId: id }),
    ]).then(([data, deps, envs, ords]) => {
      setProject(data.project);
      setProjectEnvs(data.environments);
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
    const updated = await updateProject(id, { name: newName });
    setProject(updated);
  }

  async function handleDelete() {
    if (!id) return;
    await deleteProject(id);
    navigate("/projects");
  }

  async function handleAddEnv() {
    if (!id || !addEnvId) return;
    const updated = await addProjectEnvironment(id, addEnvId);
    setProject(updated);
    const env = allEnvs.find((e) => e.id === addEnvId);
    if (env) setProjectEnvs([...projectEnvs, env]);
    setAddEnvId("");
  }

  async function handleRemoveEnv(envId: string) {
    if (!id) return;
    const updated = await removeProjectEnvironment(id, envId);
    setProject(updated);
    setProjectEnvs(projectEnvs.filter((e) => e.id !== envId));
  }

  async function handleAddStep(step: { name: string; type: DeploymentStepType; command: string; order?: number }) {
    if (!id || !project) return;
    const newStep = await createProjectStep(id, step);
    setProject({ ...project, steps: [...project.steps, newStep].sort((a, b) => a.order - b.order) });
  }

  async function handleUpdateStep(stepId: string, updates: Partial<DeploymentStep>) {
    if (!id || !project) return;
    const updated = await updateProjectStep(id, stepId, updates);
    setProject({
      ...project,
      steps: project.steps.map((s) => (s.id === stepId ? updated : s)).sort((a, b) => a.order - b.order),
    });
  }

  async function handleDeleteStep(stepId: string) {
    if (!id || !project) return;
    await deleteProjectStep(id, stepId);
    setProject({ ...project, steps: project.steps.filter((s) => s.id !== stepId) });
  }

  async function handleReorderSteps(stepIds: string[]) {
    if (!id || !project) return;
    const reordered = await reorderProjectSteps(id, stepIds);
    setProject({ ...project, steps: reordered });
  }

  async function handleSaveDeployConfig(config: DeployConfig) {
    if (!id || !project) return;
    const updated = await updateProjectDeployConfig(id, config);
    setProject({ ...project, deployConfig: updated });
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!project) return <div className="error-msg">Project not found</div>;

  const sorted = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // Environments not yet linked to this project
  const unlinkedEnvs = allEnvs.filter(
    (e) => !project.environmentIds.includes(e.id),
  );

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/projects">Projects</Link> / {project.name}
      </div>
      <div className="page-header">
        <InlineEdit value={project.name} onSave={handleUpdateName} />
        <div style={{ display: "flex", gap: 8 }}>
          <Link to={`/deploy?projectId=${project.id}`} className="btn btn-primary">
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
              {projectEnvs.map((env) => (
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
              {projectEnvs.length === 0 && <span className="text-muted">No environments linked</span>}
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
            steps={project.steps}
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
            config={project.deployConfig}
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
        <DeploymentTable deployments={sorted} environments={allEnvs} showProject={false} />
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Project"
          message={`Are you sure you want to delete "${project.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
