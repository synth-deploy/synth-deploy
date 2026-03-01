import { Link } from "react-router";
import type { Deployment, Environment, Operation } from "../types.js";
import StatusBadge from "./StatusBadge.js";
import EnvBadge from "./EnvBadge.js";

interface Props {
  deployments: Deployment[];
  environments?: Environment[];
  operations?: Operation[];
  showOperation?: boolean;
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

export default function DeploymentTable({ deployments, environments = [], operations = [], showOperation = true }: Props) {
  const envMap = new Map(environments.map((e) => [e.id, e]));
  const operationMap = new Map(operations.map((p) => [p.id, p]));

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
            {showOperation && <th>Operation</th>}
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
                {showOperation && (
                  <td>
                    <Link to={`/operations/${d.operationId}`}>
                      {operationMap.get(d.operationId)?.name ?? d.operationId.slice(0, 8)}
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
