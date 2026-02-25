import { Link } from "react-router";
import type { Deployment, Environment, Project } from "../types.js";
import StatusBadge from "./StatusBadge.js";
import EnvBadge from "./EnvBadge.js";

interface Props {
  deployments: Deployment[];
  environments?: Environment[];
  projects?: Project[];
  showProject?: boolean;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(created: string, completed: string | null): string {
  if (!completed) return "—";
  const ms = new Date(completed).getTime() - new Date(created).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function DeploymentTable({ deployments, environments = [], projects = [], showProject = true }: Props) {
  const envMap = new Map(environments.map((e) => [e.id, e]));
  const projectMap = new Map(projects.map((p) => [p.id, p]));

  if (deployments.length === 0) {
    return (
      <div className="empty-state">
        <p>No deployments yet</p>
      </div>
    );
  }

  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Version</th>
            {showProject && <th>Project</th>}
            <th>Environment</th>
            <th>Time</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => {
            const env = envMap.get(d.environmentId);
            return (
              <tr key={d.id}>
                <td>
                  <Link to={`/deployments/${d.id}`}>
                    <StatusBadge status={d.status} />
                  </Link>
                </td>
                <td>
                  <Link to={`/deployments/${d.id}`} className="mono">
                    {d.version}
                  </Link>
                </td>
                {showProject && (
                  <td>
                    <Link to={`/projects/${d.projectId}`}>
                      {projectMap.get(d.projectId)?.name ?? d.projectId.slice(0, 8)}
                    </Link>
                  </td>
                )}
                <td>
                  {env ? <EnvBadge name={env.name} /> : <span className="mono">{d.environmentId.slice(0, 8)}</span>}
                </td>
                <td className="text-secondary">{formatTime(d.createdAt)}</td>
                <td className="text-secondary">{formatDuration(d.createdAt, d.completedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
