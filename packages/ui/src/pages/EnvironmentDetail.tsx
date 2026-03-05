import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router";
import {
  getEnvironment,
  updateEnvironment,
  deleteEnvironment,
  listDeployments,
} from "../api.js";
import type { Environment, Deployment } from "../types.js";
import VariableEditor from "../components/VariableEditor.js";
import InlineEdit from "../components/InlineEdit.js";
import ConfirmDialog from "../components/ConfirmDialog.js";

export default function EnvironmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [env, setEnv] = useState<Environment | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([getEnvironment(id), listDeployments()])
      .then(([environment, allDeployments]) => {
        setEnv(environment);
        setDeployments(allDeployments.filter((d) => d.environmentId === id));
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, [id]);

  async function handleUpdateName(newName: string) {
    if (!id) return;
    const updated = await updateEnvironment(id, { name: newName });
    setEnv(updated);
  }

  async function handleSaveVariables(variables: Record<string, string>) {
    if (!id) return;
    const updated = await updateEnvironment(id, { variables });
    setEnv(updated);
  }

  async function handleDelete() {
    if (!id) return;
    try {
      await deleteEnvironment(id);
      navigate("/environments");
    } catch (e: any) {
      setError(e.message);
      setShowDeleteConfirm(false);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (error && !env) return <div className="error-msg">{error}</div>;
  if (!env) return <div className="error-msg">Environment not found</div>;

  const hasDeployments = deployments.length > 0;

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/environments">Environments</Link> / {env.name}
      </div>
      <div className="page-header">
        <InlineEdit value={env.name} onSave={handleUpdateName} />
        <button className="btn btn-danger" onClick={() => setShowDeleteConfirm(true)}>
          Delete
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Variables</h3>
          </div>
          <VariableEditor variables={env.variables} onSave={handleSaveVariables} />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Deployment History</h3>
        </div>
        {hasDeployments ? (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {deployments
                  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                  .map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{d.version}</td>
                      <td><span className={`badge badge-${d.status}`}>{d.status}</span></td>
                      <td className="text-muted">{new Date(d.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted" style={{ padding: "12px 0", fontSize: 13 }}>
            No deployments for this environment.
          </p>
        )}
      </div>

      {showDeleteConfirm && !hasDeployments && (
        <ConfirmDialog
          title="Delete Environment"
          message={`Are you sure you want to delete "${env.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
          confirmLabel="Delete"
        />
      )}
      {showDeleteConfirm && hasDeployments && (
        <ConfirmDialog
          title="Cannot Delete Environment"
          message={`This environment has ${deployments.length} active deployment(s). Remove or reassign them before deleting "${env.name}".`}
          onConfirm={() => setShowDeleteConfirm(false)}
          onCancel={() => setShowDeleteConfirm(false)}
          confirmLabel="OK"
        />
      )}
    </div>
  );
}
