import { useState, useEffect } from "react";
import { Link } from "react-router";
import { listEnvironments, createEnvironment } from "../api.js";
import type { Environment } from "../types.js";

export default function Environments() {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listEnvironments().then((e) => {
      setEnvironments(e);
      setLoading(false);
    });
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setError(null);
    try {
      const env = await createEnvironment(name.trim());
      setEnvironments([...environments, env]);
      setName("");
      setShowForm(false);
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h2>Environments</h2>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Create Environment"}
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {showForm && (
        <div className="card mb-16">
          <div className="inline-form">
            <div className="form-group">
              <label>Environment Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., production, staging, dev"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
            </div>
            <button className="btn btn-primary" onClick={handleCreate}>Create</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Variables</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {environments.map((env) => (
                <tr key={env.id}>
                  <td>
                    <Link to={`/environments/${env.id}`} style={{ fontWeight: 500 }}>
                      {env.name}
                    </Link>
                  </td>
                  <td>{Object.keys(env.variables).length} configured</td>
                  <td className="mono text-muted">{env.id.slice(0, 8)}</td>
                </tr>
              ))}
              {environments.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty-state">
                    <p>No environments yet. Create one to get started.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
