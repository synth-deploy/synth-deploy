import { useState, useEffect } from "react";
import { Link } from "react-router";
import { listDeployments, listPartitions, listEnvironments, listOperations, getDeploymentContext, listEnvoys } from "../api.js";
import type { EnvoyRegistryEntry } from "../api.js";
import type { Deployment, Partition, Environment, Operation } from "../types.js";
import type { DeploymentContext } from "../api.js";
import { useMode } from "../context/ModeContext.js";
import DeploymentTable from "../components/DeploymentTable.js";
import CommandHealth from "../components/CommandHealth.js";
import EnvBadge from "../components/EnvBadge.js";
import type { EnvAgentData } from "../components/EnvBadge.js";

export default function Dashboard() {
  const { mode } = useMode();
  const isAgent = mode === "agent";

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [agentContext, setAgentContext] = useState<DeploymentContext | null>(null);
  const [envoyHealthStatus, setEnvoyHealthStatus] = useState<"OK" | "Degraded" | "Unreachable">("OK");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetches: Promise<any>[] = [
      listDeployments(),
      listPartitions(),
      listEnvironments(),
      listOperations(),
    ];
    if (isAgent) {
      fetches.push(getDeploymentContext());
    } else {
      fetches.push(Promise.resolve(null));
    }
    fetches.push(listEnvoys().catch(() => []));
    Promise.all(fetches).then(([d, t, e, p, ctx, envoyResult]) => {
      setDeployments(d);
      setPartitions(t);
      setEnvironments(e);
      setOperations(p);
      if (ctx) setAgentContext(ctx);
      const envoyList = envoyResult as EnvoyRegistryEntry[];
      if (envoyList.length > 0) {
        const hasUnreachable = envoyList.some((ev) => ev.health === "Unreachable");
        const hasDegraded = envoyList.some((ev) => ev.health === "Degraded");
        setEnvoyHealthStatus(hasUnreachable ? "Unreachable" : hasDegraded ? "Degraded" : "OK");
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [isAgent]);

  if (loading) return <div className="loading">Loading...</div>;

  const succeeded = deployments.filter((d) => d.status === "succeeded").length;
  const successRate = deployments.length > 0
    ? `${Math.round((succeeded / deployments.length) * 100)}%`
    : "—";

  const recent = [...deployments]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  // Build agent data for each environment from context
  function agentDataForEnv(envName: string): EnvAgentData | undefined {
    if (!agentContext) return undefined;
    const envSummary = agentContext.environmentSummary.find(
      (e) => e.name.toLowerCase() === envName.toLowerCase(),
    );
    if (!envSummary) return undefined;

    const envDeployments = deployments.filter(
      (d) => d.environmentId === envSummary.id,
    );
    const envSucceeded = envDeployments.filter((d) => d.status === "succeeded").length;
    const rate = envDeployments.length > 0
      ? `${Math.round((envSucceeded / envDeployments.length) * 100)}%`
      : "—";

    // Build history from most recent 5 deployments
    const history = [...envDeployments]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5)
      .map((d): "succeeded" | "failed" => d.status === "succeeded" ? "succeeded" : "failed");

    // Check for drift signals
    const hasDrift = agentContext.signals.some(
      (s) => s.type === "drift" && s.relatedEntity?.id === envSummary.id,
    );

    return {
      successRate: rate,
      envoyHealth: envoyHealthStatus,
      drift: hasDrift,
      history,
    };
  }

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
        <div className={isAgent ? "agent-collapse" : ""}>
          <Link to="/deploy" className="btn btn-primary">New Deployment</Link>
        </div>
      </div>

      <div className="summary-grid">
        <div className="summary-card">
          <div className="label">Total Deployments</div>
          <div className="value">{deployments.length}</div>
        </div>
        <div className="summary-card">
          <div className="label">Success Rate</div>
          <div className="value">{successRate}</div>
        </div>
        <div className="summary-card">
          <div className="label">Operations</div>
          <div className="value">{operations.length}</div>
        </div>
        <div className="summary-card">
          <div className="label">Partitions</div>
          <div className="value">{partitions.length}</div>
        </div>
        <div className="summary-card">
          <div className="label">Environments</div>
          <div className="value">{environments.length}</div>
        </div>
      </div>

      {/* Agent mode: partition rows with expanded env badges */}
      {isAgent && partitions.length > 0 && (
        <div className="partition-rows">
          {partitions.map((partition) => (
            <div key={partition.id} className="partition-row">
              <div className="partition-row-header">
                <div className="partition-row-avatar">
                  {partition.name[0]}
                </div>
                <span className="partition-row-name">{partition.name}</span>
              </div>
              <div className="partition-row-badges">
                {environments.map((env) => (
                  <EnvBadge
                    key={env.id}
                    name={env.name}
                    agentData={agentDataForEnv(env.name)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 24 }}>
        <div className="card">
          <div className="card-header">
            <h3>Recent Deployments</h3>
          </div>
          <DeploymentTable deployments={recent} environments={environments} operations={operations} />
        </div>
        <CommandHealth />
      </div>
    </div>
  );
}
