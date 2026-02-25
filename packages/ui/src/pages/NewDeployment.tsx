import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { listProjects, listTenants, listEnvironments, triggerDeployment } from "../api.js";
import type { Project, Tenant, Environment } from "../types.js";

export default function NewDeployment() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<Project[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [projectId, setProjectId] = useState(searchParams.get("projectId") ?? "");
  const [tenantId, setTenantId] = useState(searchParams.get("tenantId") ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [version, setVersion] = useState("");
  const [varEntries, setVarEntries] = useState<Array<[string, string]>>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  useEffect(() => {
    Promise.all([listProjects(), listTenants(), listEnvironments()]).then(([p, t, e]) => {
      setProjects(p);
      setTenants(t);
      setEnvironments(e);
      setLoading(false);
    });
  }, []);

  // Filter environments to those linked to selected project
  const selectedProject = projects.find((p) => p.id === projectId);
  const availableEnvs = selectedProject
    ? environments.filter((e) => selectedProject.environmentIds.includes(e.id))
    : environments;

  function handleAddVar() {
    if (!newKey.trim()) return;
    setVarEntries([...varEntries, [newKey.trim(), newValue]]);
    setNewKey("");
    setNewValue("");
  }

  function handleRemoveVar(index: number) {
    setVarEntries(varEntries.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId || !tenantId || !environmentId || !version.trim()) {
      setError("All fields are required");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const variables: Record<string, string> = {};
      for (const [k, v] of varEntries) {
        if (k.trim()) variables[k.trim()] = v;
      }

      const result = await triggerDeployment({
        projectId,
        tenantId,
        environmentId,
        version: version.trim(),
        variables: Object.keys(variables).length > 0 ? variables : undefined,
      });

      navigate(`/deployments/${result.deployment.id}`);
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h2>New Deployment</h2>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="card" style={{ maxWidth: 600 }}>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Project</label>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setEnvironmentId(""); }}>
              <option value="">Select a project...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Tenant</label>
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">Select a tenant...</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Environment</label>
            <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              <option value="">Select an environment...</option>
              {availableEnvs.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Version</label>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g., 1.0.0"
            />
          </div>

          <div className="form-group">
            <label>Variables (optional)</label>
            {varEntries.length > 0 && (
              <table className="var-table" style={{ marginBottom: 8 }}>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {varEntries.map(([k, v], i) => (
                    <tr key={i}>
                      <td><span className="mono">{k}</span></td>
                      <td><span className="mono">{v}</span></td>
                      <td>
                        <button type="button" className="remove-btn" onClick={() => handleRemoveVar(i)}>&times;</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="inline-form">
              <div className="form-group">
                <input
                  placeholder="Key"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  style={{ minWidth: 120 }}
                />
              </div>
              <div className="form-group">
                <input
                  placeholder="Value"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  style={{ minWidth: 120 }}
                />
              </div>
              <button type="button" className="btn btn-sm" onClick={handleAddVar}>Add</button>
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Deploying..." : "Trigger Deployment"}
          </button>
        </form>
      </div>
    </div>
  );
}
