import { useState, useEffect } from "react";
import { listOperations, listEnvironments } from "../../api.js";
import type { Operation, Environment } from "../../types.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import EnvBadge from "../EnvBadge.js";

interface Props {
  title: string;
}

export default function OperationListPanel({ title }: Props) {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);

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
      <div className="canvas-detail">
        <div className="canvas-summary-strip">
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{operations.length}</span>
            <span className="canvas-summary-label">Operations</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{environments.length}</span>
            <span className="canvas-summary-label">Environments</span>
          </div>
        </div>

        {operations.length > 0 ? (
          <div className="canvas-activity-list">
            {operations.map((p) => (
              <div key={p.id} className="canvas-activity-row">
                <span style={{ fontWeight: 500 }}>{p.name}</span>
                <span className="flex flex-wrap gap-8">
                  {p.environmentIds.map((eid) => {
                    const env = environments.find((e) => e.id === eid);
                    return env ? <EnvBadge key={eid} name={env.name} /> : null;
                  })}
                  {p.environmentIds.length === 0 && <span className="text-muted">—</span>}
                </span>
                <span className="mono text-muted" style={{ fontSize: 12 }}>
                  {p.id.slice(0, 8)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="canvas-empty">
            <p>No operations yet. Use the intent bar to create one.</p>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
