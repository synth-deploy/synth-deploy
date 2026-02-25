import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router";
import {
  getProject,
  listProjectDeployments,
  listEnvironments,
  updateProject,
  deleteProject,
  addProjectEnvironment,
  removeProjectEnvironment,
  createProjectStep,
  updateProjectStep,
  deleteProjectStep,
  updateProjectPipeline,
} from "../api.js";
import type { Project, Environment, Deployment, DeploymentStep, DeploymentStepType, PipelineConfig } from "../types.js";
import EnvBadge from "../components/EnvBadge.js";
import DeploymentTable from "../components/DeploymentTable.js";
import InlineEdit from "../components/InlineEdit.js";
import ConfirmDialog from "../components/ConfirmDialog.js";
import StepEditor from "../components/StepEditor.js";
import PipelineConfigEditor from "../components/PipelineConfigEditor.js";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [projectEnvs, setProjectEnvs] = useState<Environment[]>([]);
  const [allEnvs, setAllEnvs] = useState<Environment[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
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
    ]).then(([data, deps, envs]) => {
      setProject(data.project);
      setProjectEnvs(data.environments);
      setDeployments(deps);
      setAllEnvs(envs);
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

  async function handleSavePipeline(config: PipelineConfig) {
    if (!id || !project) return;
    const updated = await updateProjectPipeline(id, config);
    setProject({ ...project, pipelineConfig: updated });
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
          />
        </div>
      </div>

      {/* Pipeline Configuration */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Pipeline Configuration</h3>
          </div>
          <PipelineConfigEditor
            config={project.pipelineConfig}
            onSave={handleSavePipeline}
          />
        </div>
      </div>

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
