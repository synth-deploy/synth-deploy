import { useState, useEffect } from "react";
import {
  listArtifacts,
  listPartitions,
  listEnvironments,
  listEnvoys,
  createDeployment,
} from "../../api.js";
import type { Artifact, Partition, Environment } from "../../types.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import { useSettings } from "../../context/SettingsContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import { useCanvas } from "../../context/CanvasContext.js";
import EnvBadge from "../EnvBadge.js";

interface Props {
  title: string;
  preselectedArtifactId?: string;
}

export default function DeploymentAuthoringPanel({ title, preselectedArtifactId }: Props) {
  const { pushPanel } = useCanvas();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [envoys, setEnvoys] = useState<EnvoyRegistryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selection state
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>(preselectedArtifactId ?? "");
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>("");
  const [selectedPartitionId, setSelectedPartitionId] = useState<string>("");
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    Promise.all([
      listArtifacts(),
      listPartitions(),
      listEnvironments(),
      listEnvoys().catch(() => []),
    ]).then(([arts, parts, envs, envoyList]) => {
      setArtifacts(arts);
      setPartitions(parts);
      setEnvironments(envs);
      setEnvoys(envoyList);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  async function handleDeploy() {
    if (!selectedArtifactId || (environmentsEnabled && !selectedEnvironmentId)) return;

    setSubmitting(true);
    setError(null);

    try {
      const result = await createDeployment({
        artifactId: selectedArtifactId,
        environmentId: environmentsEnabled ? selectedEnvironmentId : undefined,
        partitionId: selectedPartitionId || undefined,
        version: version || undefined,
      });

      pushPanel({
        type: "deployment-detail",
        title: `Deployment ${result.deployment.version || result.deployment.id.slice(0, 8)}`,
        params: { id: result.deployment.id },
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedArtifact = artifacts.find((a) => a.id === selectedArtifactId);

  if (loading)
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {error && <div className="error-msg">{error}</div>}

        <div style={{ padding: "0 16px" }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>
            Compose a Deployment
          </h3>

          {/* Artifact selection */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 4 }}>
              Artifact
            </label>
            <select
              value={selectedArtifactId}
              onChange={(e) => setSelectedArtifactId(e.target.value)}
              style={{ fontSize: 13, padding: "6px 8px", width: "100%" }}
            >
              <option value="">Select artifact...</option>
              {artifacts.map((art) => (
                <option key={art.id} value={art.id}>
                  {art.name} ({art.type})
                </option>
              ))}
            </select>
            {selectedArtifact && selectedArtifact.analysis.summary && (
              <div style={{ fontSize: 12, color: "var(--agent-text-muted)", marginTop: 4, padding: "4px 8px", background: "rgba(255,255,255,0.03)", borderRadius: 4 }}>
                {selectedArtifact.analysis.summary}
              </div>
            )}
          </div>

          {/* Environment selection */}
          {environmentsEnabled && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 4 }}>
                Target Environment
              </label>
              <select
                value={selectedEnvironmentId}
                onChange={(e) => setSelectedEnvironmentId(e.target.value)}
                style={{ fontSize: 13, padding: "6px 8px", width: "100%" }}
              >
                <option value="">Select environment...</option>
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </select>
              {envoys.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--agent-text-muted)", marginTop: 4 }}>
                  {envoys.filter((e) => e.health === "OK").length} / {envoys.length} envoy{envoys.length !== 1 ? "s" : ""} healthy
                </div>
              )}
            </div>
          )}

          {/* Partition selection (optional) */}
          {partitions.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 4 }}>
                Partition (optional)
              </label>
              <select
                value={selectedPartitionId}
                onChange={(e) => setSelectedPartitionId(e.target.value)}
                style={{ fontSize: 13, padding: "6px 8px", width: "100%" }}
              >
                <option value="">No partition</option>
                {partitions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Version */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 4 }}>
              Version
            </label>
            <input
              type="text"
              placeholder="e.g. 1.2.3"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              style={{ fontSize: 13, padding: "6px 8px", width: "100%" }}
            />
          </div>

          {/* Summary + deploy */}
          {selectedArtifactId && (!environmentsEnabled || selectedEnvironmentId) && (
            <div className="card" style={{ padding: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                Deployment Summary
              </div>
              <div style={{ fontSize: 13, color: "var(--agent-text-muted)" }}>
                <div>
                  <strong>Artifact:</strong> {selectedArtifact?.name ?? selectedArtifactId.slice(0, 8)}
                </div>
                <div>
                  <strong>Environment:</strong>{" "}
                  <EnvBadge name={environments.find((e) => e.id === selectedEnvironmentId)?.name ?? selectedEnvironmentId.slice(0, 8)} />
                </div>
                {selectedPartitionId && (
                  <div>
                    <strong>Partition:</strong> {partitions.find((p) => p.id === selectedPartitionId)?.name ?? selectedPartitionId.slice(0, 8)}
                  </div>
                )}
                {version && (
                  <div>
                    <strong>Version:</strong> {version}
                  </div>
                )}
              </div>
              <button
                className="btn btn-primary"
                disabled={submitting}
                onClick={handleDeploy}
                style={{ marginTop: 12 }}
              >
                {submitting ? "Creating deployment..." : "Deploy"}
              </button>
            </div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
