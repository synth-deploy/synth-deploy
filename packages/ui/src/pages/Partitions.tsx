import { useState, useEffect } from "react";
import { Link } from "react-router";
import { listPartitions, createPartition } from "../api.js";
import type { Partition } from "../types.js";

export default function Partitions() {
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listPartitions().then((t) => {
      setPartitions(t);
      setLoading(false);
    });
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setError(null);
    try {
      const partition = await createPartition(name.trim());
      setPartitions([...partitions, partition]);
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
        <h2>Partitions</h2>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Create Partition"}
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {showForm && (
        <div className="card mb-16">
          <div className="inline-form">
            <div className="form-group">
              <label>Partition Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Acme Corp"
                autoFocus
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
                <th>Created</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {partitions.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/partitions/${t.id}`} style={{ fontWeight: 500 }}>
                      {t.name}
                    </Link>
                  </td>
                  <td>{Object.keys(t.variables).length} configured</td>
                  <td className="text-secondary">
                    {new Date(t.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                  <td className="mono text-muted">{t.id.slice(0, 8)}</td>
                </tr>
              ))}
              {partitions.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-state">
                    <p>No partitions yet. Create one to get started.</p>
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
