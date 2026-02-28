import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router";
import {
  getPartition,
  updatePartitionVariables,
  updatePartition,
  deletePartition,
  listDeployments,
  getPartitionHistory,
  listEnvironments,
  listProjects,
} from "../api.js";
import type { Partition, Deployment, ProjectHistory, Environment, Project } from "../types.js";
import VariableEditor from "../components/VariableEditor.js";
import DeploymentTable from "../components/DeploymentTable.js";
import InlineEdit from "../components/InlineEdit.js";
import ConfirmDialog from "../components/ConfirmDialog.js";

export default function PartitionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [partition, setPartition] = useState<Partition | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [history, setHistory] = useState<ProjectHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getPartition(id),
      listDeployments(id),
      getPartitionHistory(id),
      listEnvironments(),
      listProjects(),
    ]).then(([t, d, h, e, p]) => {
      setPartition(t);
      setDeployments(d);
      setHistory(h);
      setEnvironments(e);
      setProjects(p);
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, [id]);

  async function handleUpdateName(newName: string) {
    if (!id) return;
    const updated = await updatePartition(id, { name: newName });
    setPartition(updated);
  }

  async function handleSaveVariables(variables: Record<string, string>) {
    if (!id) return;
    const updated = await updatePartitionVariables(id, variables);
    setPartition(updated);
  }

  async function handleDelete() {
    if (!id) return;
    await deletePartition(id);
    navigate("/partitions");
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!partition) return <div className="error-msg">Partition not found</div>;

  const sorted = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/partitions">Partitions</Link> / {partition.name}
      </div>
      <div className="page-header">
        <InlineEdit value={partition.name} onSave={handleUpdateName} />
        <div style={{ display: "flex", gap: 8 }}>
          <Link to={`/deploy?partitionId=${partition.id}`} className="btn btn-primary">
            Deploy to Partition
          </Link>
          <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>
            Delete
          </button>
        </div>
      </div>

      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Variables</h3>
          </div>
          <VariableEditor variables={partition.variables} onSave={handleSaveVariables} />
        </div>
      </div>

      {history && history.overview.totalDeployments > 0 && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>History Overview</h3>
            </div>
            <div className="summary-grid" style={{ marginBottom: 0 }}>
              <div className="summary-card">
                <div className="label">Total</div>
                <div className="value">{history.overview.totalDeployments}</div>
              </div>
              <div className="summary-card">
                <div className="label">Success Rate</div>
                <div className="value">{history.overview.successRate}</div>
              </div>
              <div className="summary-card">
                <div className="label">Environments</div>
                <div className="value">{history.overview.environments.length}</div>
              </div>
              <div className="summary-card">
                <div className="label">Versions</div>
                <div className="value">{history.overview.versions.length}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3>Deployment History</h3>
        </div>
        <DeploymentTable deployments={sorted} environments={environments} projects={projects} />
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Partition"
          message={`Are you sure you want to delete "${partition.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
