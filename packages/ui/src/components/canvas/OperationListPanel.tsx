import { useState, useEffect } from "react";
import { listOperations, listEnvironments } from "../../api.js";
import type { Operation, Environment } from "../../types.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

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
      <div className="v2-entity-list">
        <div className="v2-entity-list-header">
          <div>
            <div className="v2-entity-list-title">Operations</div>
            <div className="v2-entity-list-desc">
              Deployment blueprints. Static until an Order snapshots them for execution.
            </div>
          </div>
          <button className="v2-create-btn v2-create-btn-operation">+ Create Operation</button>
        </div>

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
