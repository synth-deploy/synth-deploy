import type { Deployment, Environment, Artifact } from "../types.js";
import StatusBadge from "./StatusBadge.js";
import EnvBadge from "./EnvBadge.js";

interface Props {
  deployments: Deployment[];
  environments?: Environment[];
  artifacts?: Artifact[];
  showArtifact?: boolean;
  onClickDeployment?: (id: string) => void;
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
  if (!completed) return "\u2014";
  const ms = new Date(completed).getTime() - new Date(created).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function DeploymentTable({ deployments, environments = [], artifacts = [], showArtifact = true, onClickDeployment }: Props) {
  const envMap = new Map(environments.map((e) => [e.id, e]));
  const artifactMap = new Map(artifacts.map((a) => [a.id, a]));

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
            {showArtifact && <th>Artifact</th>}
            <th>Environment</th>
            <th>Time</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => {
            const env = envMap.get(d.environmentId);
            return (
              <tr key={d.id} onClick={onClickDeployment ? () => onClickDeployment(d.id) : undefined} style={onClickDeployment ? { cursor: "pointer" } : undefined}>
                <td>
                  <StatusBadge status={d.status} />
                </td>
                <td className="mono">{d.version}</td>
                {showArtifact && (
                  <td>
                    {artifactMap.get(d.artifactId)?.name ?? d.artifactId.slice(0, 8)}
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
