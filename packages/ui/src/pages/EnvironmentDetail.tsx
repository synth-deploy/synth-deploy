import { useState, useEffect } from "react";
import { useParams, Link, useNavigate } from "react-router";
import {
  getEnvironment,
  updateEnvironment,
  deleteEnvironment,
  listProjects,
} from "../api.js";
import type { Environment, Project } from "../types.js";
import VariableEditor from "../components/VariableEditor.js";
import InlineEdit from "../components/InlineEdit.js";
import ConfirmDialog from "../components/ConfirmDialog.js";

export default function EnvironmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [env, setEnv] = useState<Environment | null>(null);
  const [linkedProjects, setLinkedProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([getEnvironment(id), listProjects()])
      .then(([environment, projects]) => {
        setEnv(environment);
        setLinkedProjects(projects.filter((p) => p.environmentIds.includes(id)));
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
          <h3>Linked Projects</h3>
        </div>
        {linkedProjects.length > 0 ? (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {linkedProjects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/projects/${p.id}`} style={{ fontWeight: 500 }}>
                        {p.name}
                      </Link>
                    </td>
                    <td className="mono text-muted">{p.id.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted" style={{ padding: "12px 0", fontSize: 13 }}>
            Not linked to any projects.
          </p>
        )}
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Environment"
          message={
            linkedProjects.length > 0
              ? `This environment is linked to ${linkedProjects.length} project(s). Unlink it from all projects before deleting.`
              : `Are you sure you want to delete "${env.name}"? This cannot be undone.`
          }
          onConfirm={linkedProjects.length > 0 ? () => setShowDeleteConfirm(false) : handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
          confirmLabel={linkedProjects.length > 0 ? "OK" : "Delete"}
        />
      )}
    </div>
  );
}
