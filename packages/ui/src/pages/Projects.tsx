import { useState, useEffect } from "react";
import { Link } from "react-router";
import { listProjects, createProject, listEnvironments } from "../api.js";
import type { Project, Environment } from "../types.js";

export default function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [selectedEnvs, setSelectedEnvs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listProjects(), listEnvironments()]).then(([p, e]) => {
      setProjects(p);
      setEnvironments(e);
      setLoading(false);
    });
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setError(null);
    try {
      const project = await createProject(name.trim(), selectedEnvs);
      setProjects([...projects, project]);
      setName("");
      setSelectedEnvs([]);
      setShowForm(false);
    } catch (e: any) {
      setError(e.message);
    }
  }

  function toggleEnv(id: string) {
    setSelectedEnvs((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id],
    );
  }

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h2>Projects</h2>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Create Project"}
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {showForm && (
        <div className="card mb-16">
          <div className="form-group">
            <label>Project Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., web-app, api-service"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Environments</label>
            <div className="flex flex-wrap gap-8">
              {environments.map((env) => (
                <label key={env.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedEnvs.includes(env.id)}
                    onChange={() => toggleEnv(env.id)}
                  />
                  {env.name}
                </label>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleCreate}>Create</button>
        </div>
      )}

      <div className="card">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Environments</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={`/projects/${p.id}`} style={{ fontWeight: 500 }}>
                      {p.name}
                    </Link>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-8">
                      {p.environmentIds.map((eid) => {
                        const env = environments.find((e) => e.id === eid);
                        return env ? (
                          <span key={eid} className={`env-badge env-badge-${env.name.toLowerCase().includes("prod") ? "production" : env.name.toLowerCase().includes("stag") ? "staging" : "default"}`}>
                            {env.name}
                          </span>
                        ) : null;
                      })}
                      {p.environmentIds.length === 0 && <span className="text-muted">—</span>}
                    </div>
                  </td>
                  <td className="mono text-muted">{p.id.slice(0, 8)}</td>
                </tr>
              ))}
              {projects.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty-state">
                    <p>No projects yet. Create one to get started.</p>
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
