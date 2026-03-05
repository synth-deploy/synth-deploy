import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router";
import {
  listArtifacts,
  listPartitions,
  listEnvironments,
  createDeployment,
} from "../api.js";
import type { Artifact, Partition, Environment } from "../types.js";
import { useSettings } from "../context/SettingsContext.js";
import DeploymentContextPanel from "../components/DeploymentContextPanel.js";

export default function NewDeployment() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [artifactId, setArtifactId] = useState(searchParams.get("artifactId") ?? "");
  const [partitionId, setPartitionId] = useState(searchParams.get("partitionId") ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    Promise.all([listArtifacts(), listPartitions(), listEnvironments()]).then(([a, p, e]) => {
      setArtifacts(a);
      setPartitions(p);
      setEnvironments(e);
      setLoading(false);
    });
  }, []);

  async function handleDeploy() {
    if (!artifactId || (environmentsEnabled && !environmentId)) {
      setError("Artifact and environment are required");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const result = await createDeployment({
        artifactId,
        environmentId,
        partitionId: partitionId || undefined,
        version: version.trim() || undefined,
      });

      navigate(`/deployments/${result.deployment.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="agent-deploy-layout">
      <div className="page-header">
        <h2>New Deployment</h2>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <DeploymentContextPanel />

      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Configure Deployment</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontSize: 13 }}>
            Artifact
            <select
              value={artifactId}
              onChange={(e) => setArtifactId(e.target.value)}
              style={{ display: "block", width: "100%", marginTop: 4, fontSize: 13, padding: "6px 8px" }}
            >
              <option value="">Select Artifact</option>
              {artifacts.map((art) => (
                <option key={art.id} value={art.id}>{art.name} ({art.type})</option>
              ))}
            </select>
          </label>

          {environmentsEnabled && (
            <label style={{ fontSize: 13 }}>
              Environment
              <select
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                style={{ display: "block", width: "100%", marginTop: 4, fontSize: 13, padding: "6px 8px" }}
              >
                <option value="">Select Environment</option>
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>{env.name}</option>
                ))}
              </select>
            </label>
          )}

          {partitions.length > 0 && (
            <label style={{ fontSize: 13 }}>
              Partition (optional)
              <select
                value={partitionId}
                onChange={(e) => setPartitionId(e.target.value)}
                style={{ display: "block", width: "100%", marginTop: 4, fontSize: 13, padding: "6px 8px" }}
              >
                <option value="">No partition</option>
                {partitions.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}

          <label style={{ fontSize: 13 }}>
            Version
            <input
              type="text"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g. 1.2.3"
              style={{ display: "block", width: "100%", marginTop: 4, fontSize: 13, padding: "6px 8px" }}
            />
          </label>

          <button
            className="btn btn-primary"
            disabled={submitting || !artifactId || (environmentsEnabled && !environmentId)}
            onClick={handleDeploy}
            style={{ alignSelf: "flex-start", marginTop: 8 }}
          >
            {submitting ? "Deploying..." : "Deploy"}
          </button>
        </div>
      </div>
    </div>
  );
}
