import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router";
import {
  getPartition,
  updatePartitionVariables,
  updatePartition,
  deletePartition,
  listDeployments,
  listEnvironments,
  listArtifacts,
} from "../api.js";
import type { Partition, Deployment, Environment, Artifact } from "../types.js";
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
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getPartition(id),
      listDeployments({ partitionId: id }),
      listEnvironments(),
      listArtifacts(),
    ]).then(([t, d, e, a]) => {
      setPartition(t);
      setDeployments(d);
      setEnvironments(e);
      setArtifacts(a);
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

  const succeeded = deployments.filter((d) => d.status === "succeeded").length;
  const successRate = deployments.length > 0
    ? `${Math.round((succeeded / deployments.length) * 100)}%`
    : "\u2014";

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

      {deployments.length > 0 && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Overview</h3>
            </div>
            <div className="summary-grid" style={{ marginBottom: 0 }}>
              <div className="summary-card">
                <div className="label">Total Deployments</div>
                <div className="value">{deployments.length}</div>
              </div>
              <div className="summary-card">
                <div className="label">Success Rate</div>
                <div className="value">{successRate}</div>
              </div>
              <div className="summary-card">
                <div className="label">Environments</div>
                <div className="value">
                  {new Set(deployments.map((d) => d.environmentId)).size}
                </div>
              </div>
              <div className="summary-card">
                <div className="label">Variables</div>
                <div className="value">{Object.keys(partition.variables).length}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Variables</h3>
          </div>
          <VariableEditor variables={partition.variables} onSave={handleSaveVariables} />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Deployment History</h3>
        </div>
        <DeploymentTable deployments={sorted} environments={environments} artifacts={artifacts} />
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
