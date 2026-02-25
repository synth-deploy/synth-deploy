import { useState, useEffect } from "react";
import { useParams, Link } from "react-router";
import { getProject, listProjectDeployments, listEnvironments } from "../api.js";
import type { Project, Environment, Deployment } from "../types.js";
import EnvBadge from "../components/EnvBadge.js";
import DeploymentTable from "../components/DeploymentTable.js";

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [projectEnvs, setProjectEnvs] = useState<Environment[]>([]);
  const [allEnvs, setAllEnvs] = useState<Environment[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      getProject(id),
      listProjectDeployments(id),
      listEnvironments(),
    ]).then(([data, deps, envs]) => {
      setProject(data.project);
      setProjectEnvs(data.environments);
      setDeployments(deps);
      setAllEnvs(envs);
      setLoading(false);
    }).catch((e) => {
      setError(e.message);
      setLoading(false);
    });
  }, [id]);

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-msg">{error}</div>;
  if (!project) return <div className="error-msg">Project not found</div>;

  const sorted = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/projects">Projects</Link> / {project.name}
      </div>
      <div className="page-header">
        <h2>{project.name}</h2>
        <Link to={`/deploy?projectId=${project.id}`} className="btn btn-primary">
          Deploy
        </Link>
      </div>

      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Environments</h3>
          </div>
          <div className="flex flex-wrap gap-12">
            {projectEnvs.map((env) => (
              <div key={env.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <EnvBadge name={env.name} />
                <span className="mono text-muted" style={{ fontSize: 11 }}>{env.id.slice(0, 8)}</span>
              </div>
            ))}
            {projectEnvs.length === 0 && <span className="text-muted">No environments linked</span>}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Deployment History</h3>
        </div>
        <DeploymentTable deployments={sorted} environments={allEnvs} showProject={false} />
      </div>
    </div>
  );
}
