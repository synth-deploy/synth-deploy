import { useState, useEffect } from "react";
import { listOperations, listEnvironments, createOperation } from "../../api.js";
import type { Operation, Environment } from "../../types.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
}

export default function OperationListPanel({ title }: Props) {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [selectedEnvs, setSelectedEnvs] = useState<string[]>([]);
  const [error, setError] = useState("");

  const toggleEnv = (id: string) => {
    setSelectedEnvs((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]
    );
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    try {
      const op = await createOperation(name.trim(), selectedEnvs);
      setOperations((prev) => [...prev, op]);
      setName("");
      setSelectedEnvs([]);
      setError("");
      setShowForm(false);
    } catch (e: any) {
      setError(e.message || "Failed to create operation");
    }
  };

  useEffect(() => {
    Promise.all([listOperations(), listEnvironments()])
      .then(([p, e]) => {
        setOperations(p);
        setEnvironments(e);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;

  return (
    <CanvasPanelHost title={title}>
      <div className="v2-entity-list">
        <div className="v2-entity-list-header">
          <div>
            <div className="v2-entity-list-title">Operations</div>
            <div className="v2-entity-list-desc">
              Deployment blueprints. Static until an Order snapshots them for execution.
            </div>
          </div>
          <button className="v2-create-btn v2-create-btn-operation" onClick={() => setShowForm(!showForm)}>
            {showForm ? "Cancel" : "+ Create Operation"}
          </button>
        </div>

        {showForm && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
            {error && <div className="error-msg" style={{ marginBottom: 8 }}>{error}</div>}
            <div style={{ marginBottom: 8 }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Operation name"
                autoFocus
                style={{ width: "100%", padding: "6px 10px", fontSize: 13, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-secondary)", color: "var(--text-primary)" }}
              />
            </div>
            <div style={{ marginBottom: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
              {environments.map((env) => (
                <label key={env.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer", color: "var(--text-secondary)" }}>
                  <input
                    type="checkbox"
                    checked={selectedEnvs.includes(env.id)}
                    onChange={() => toggleEnv(env.id)}
                  />
                  {env.name}
                </label>
              ))}
            </div>
            <button className="v2-create-btn v2-create-btn-operation" onClick={handleCreate} style={{ fontSize: 12, padding: "4px 12px" }}>
              Create
            </button>
          </div>
        )}

        <div className="v2-entity-list-items">
          {operations.map((op) => (
            <div key={op.id} className="v2-operation-list-item">
              <div className="v2-operation-card-grid-bg" />
              <div className="v2-operation-list-inner">
                <div className="v2-operation-list-left">
                  <div className="v2-operation-id">{op.id.slice(0, 8)}</div>
                  <div className="v2-operation-name">{op.name}</div>
                  <div className="v2-operation-meta">
                    {op.steps.length} steps &middot; {op.environmentIds.length} environment{op.environmentIds.length !== 1 ? "s" : ""}
                  </div>
                </div>
                <div className="v2-operation-list-envs">
                  {op.environmentIds.map((eid) => {
                    const env = environments.find((e) => e.id === eid);
                    return env ? (
                      <span key={eid} className="v2-partition-list-env">
                        {env.name}
                      </span>
                    ) : null;
                  })}
                  {op.environmentIds.length === 0 && (
                    <span className="v2-empty-hint-inline">No environments</span>
                  )}
                </div>
                <div className="v2-operation-steps">
                  {Array.from({ length: Math.min(op.steps.length, 10) }).map((_, i) => (
                    <div key={i} className="v2-operation-step-bar" />
                  ))}
                </div>
              </div>
            </div>
          ))}
          {operations.length === 0 && (
            <div className="v2-empty-hint">No operations yet. Use the Command Channel to create one.</div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
