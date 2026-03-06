import { useState } from "react";
import { listPartitions, listEnvironments, listDeployments, createPartition } from "../../api.js";
import type { Partition, Environment, Deployment } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import { useQuery, invalidate } from "../../hooks/useQuery.js";

interface Props {
  title: string;
}

export default function PartitionListPanel({ title }: Props) {
  const { pushPanel } = useCanvas();

  const { data: partitions, loading: l1 } = useQuery<Partition[]>("list:partitions", listPartitions);
  const { data: environments, loading: l2 } = useQuery<Environment[]>("list:environments", listEnvironments);
  const { data: deployments, loading: l3 } = useQuery<Deployment[]>("list:deployments", listDeployments);
  const loading = l1 || l2 || l3;
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    try {
      const p = await createPartition(name.trim());
      invalidate("list:partitions");
      setName("");
      setError("");
      setShowForm(false);
    } catch (e: any) {
      setError(e.message || "Failed to create partition");
    }
  };

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;

  return (
    <CanvasPanelHost title={title}>
      <div className="v2-entity-list">
        <div className="v2-entity-list-header">
          <div>
            <div className="v2-entity-list-title">Partitions</div>
            <div className="v2-entity-list-desc">
              Isolated configuration boundaries. Each Partition is completely separated from every other.
            </div>
          </div>
          <button className="v2-create-btn v2-create-btn-partition" onClick={() => setShowForm(!showForm)}>
            {showForm ? "Cancel" : "+ Create Partition"}
          </button>
        </div>

        {showForm && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
            {error && <div className="error-msg" style={{ marginBottom: 8 }}>{error}</div>}
            <div style={{ marginBottom: 8 }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Partition name"
                autoFocus
                style={{ width: "100%", padding: "6px 10px", fontSize: 13, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-secondary)", color: "var(--text-primary)" }}
              />
            </div>
            <button className="v2-create-btn v2-create-btn-partition" onClick={handleCreate} style={{ fontSize: 12, padding: "4px 12px" }}>
              Create
            </button>
          </div>
        )}

        <div className="v2-entity-list-items">
          {(partitions ?? []).map((p) => {
            const varCount = Object.keys(p.variables).length;
            const deploys = (deployments ?? []).filter((d) => d.partitionId === p.id);
            const deployCount = deploys.length;
            const lastDeploy = deploys.length > 0
              ? [...deploys].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
              : null;
            const isDormant = varCount === 0 && deployCount === 0;
            return (
              <div
                key={p.id}
                className={`v2-partition-list-item ${isDormant ? "v2-partition-list-dormant" : ""}`}
                onClick={() => {
                  if (!isDormant) {
                    pushPanel({
                      type: "partition-detail",
                      title: p.name,
                      params: { id: p.id },
                    });
                  }
                }}
              >
                <div className={`v2-partition-list-avatar ${isDormant ? "v2-avatar-dormant" : ""}`}>
                  <span>{p.name[0]}</span>
                </div>
                <div className="v2-partition-list-info">
                  <div className="v2-partition-list-name">{p.name}</div>
                  <div className="v2-partition-list-envs">
                    {(environments ?? []).map((e) => (
                      <span key={e.id} className={`v2-partition-list-env ${isDormant ? "v2-env-dormant" : ""}`}>
                        {e.name}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="v2-partition-list-stats">
                  <div className="v2-stat-col">
                    <span className={`v2-stat-value ${isDormant ? "v2-stat-dormant" : ""}`}>{varCount}</span>
                    <span className="v2-stat-label">Variables</span>
                  </div>
                  <div className="v2-stat-col">
                    <span className={`v2-stat-value ${isDormant ? "v2-stat-dormant" : ""}`}>{deployCount}</span>
                    <span className="v2-stat-label">Deploys</span>
                  </div>
                  <div className="v2-stat-col">
                    <span className={`v2-stat-value ${isDormant ? "v2-stat-dormant" : ""}`}>
                      {lastDeploy
                        ? new Date(lastDeploy.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                        : "\u2014"}
                    </span>
                    <span className="v2-stat-label">Last deploy</span>
                  </div>
                </div>
                <div className={`v2-partition-list-status ${isDormant ? "v2-status-dormant" : "v2-status-active"}`}>
                  {isDormant ? "DORMANT" : "ACTIVE"}
                </div>
              </div>
            );
          })}
          {(partitions ?? []).length === 0 && (
            <div className="v2-empty-hint">No partitions yet. Use the Command Channel to create one.</div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
