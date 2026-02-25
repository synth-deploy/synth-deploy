import { useState, useEffect } from "react";
import { Link } from "react-router";
import { listDeployments, listTenants, listEnvironments, listProjects } from "../api.js";
import type { Deployment, Tenant, Environment, Project } from "../types.js";
import DeploymentTable from "../components/DeploymentTable.js";
import TentacleHealth from "../components/TentacleHealth.js";

export default function Dashboard() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      listDeployments(),
      listTenants(),
      listEnvironments(),
      listProjects(),
    ]).then(([d, t, e, p]) => {
      setDeployments(d);
      setTenants(t);
      setEnvironments(e);
      setProjects(p);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading...</div>;

  const succeeded = deployments.filter((d) => d.status === "succeeded").length;
  const failed = deployments.filter((d) => d.status === "failed").length;
  const successRate = deployments.length > 0
    ? `${Math.round((succeeded / deployments.length) * 100)}%`
    : "—";

  const recent = [...deployments]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 10);

  return (
    <div>
      <div className="page-header">
        <h2>Dashboard</h2>
        <Link to="/deploy" className="btn btn-primary">New Deployment</Link>
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
          <div className="label">Projects</div>
          <div className="value">{projects.length}</div>
        </div>
        <div className="summary-card">
          <div className="label">Tenants</div>
          <div className="value">{tenants.length}</div>
        </div>
        <div className="summary-card">
          <div className="label">Environments</div>
          <div className="value">{environments.length}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 24 }}>
        <div className="card">
          <div className="card-header">
            <h3>Recent Deployments</h3>
          </div>
          <DeploymentTable deployments={recent} environments={environments} />
        </div>
        <TentacleHealth />
      </div>
    </div>
  );
}
