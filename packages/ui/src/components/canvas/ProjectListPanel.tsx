import { useState, useEffect } from "react";
import { listProjects, listEnvironments } from "../../api.js";
import type { Project, Environment } from "../../types.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import EnvBadge from "../EnvBadge.js";

interface Props {
  title: string;
}

export default function ProjectListPanel({ title }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([listProjects(), listEnvironments()])
      .then(([p, e]) => {
        setProjects(p);
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
            <span className="canvas-summary-value">{projects.length}</span>
            <span className="canvas-summary-label">Projects</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{environments.length}</span>
            <span className="canvas-summary-label">Environments</span>
          </div>
        </div>

        {projects.length > 0 ? (
          <div className="canvas-activity-list">
            {projects.map((p) => (
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
            <p>No projects yet. Use the intent bar to create one.</p>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
