import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router";
import {
  listOperations,
  listPartitions,
  listEnvironments,
  triggerDeployment,
} from "../api.js";
import type { Operation, Partition, Environment } from "../types.js";
import { useSettings } from "../context/SettingsContext.js";
import DeploymentContextPanel from "../components/DeploymentContextPanel.js";

export default function NewDeployment() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const [operations, setOperations] = useState<Operation[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deployment config state
  const [operationId, setOperationId] = useState(searchParams.get("operationId") ?? "");
  const [partitionId, setPartitionId] = useState(searchParams.get("partitionId") ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [version, setVersion] = useState("");
  const [varEntries, setVarEntries] = useState<Array<[string, string]>>([]);

  useEffect(() => {
    Promise.all([listOperations(), listPartitions(), listEnvironments()]).then(([p, t, e]) => {
      setOperations(p);
      setPartitions(t);
      setEnvironments(e);
      setLoading(false);
    });
  }, []);

  // --- Deploy logic ---

  async function deployWithCurrentConfig() {
    if (!operationId || !partitionId || !version.trim() || (environmentsEnabled && !environmentId)) {
      setError("All fields are required");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const variables: Record<string, string> = {};
      for (const [k, v] of varEntries) {
        if (k.trim()) variables[k.trim()] = v;
      }

      const result = await triggerDeployment({
        operationId,
        partitionId,
        environmentId,
        version: version.trim(),
        variables: Object.keys(variables).length > 0 ? variables : undefined,
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

      {/* Contextual information */}
      <DeploymentContextPanel />

      {/* Manual deployment form */}
      <div className="card" style={{ padding: 16 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Configure Deployment</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontSize: 13 }}>
            Operation
            <select
              value={operationId}
              onChange={(e) => setOperationId(e.target.value)}
              style={{ display: "block", width: "100%", marginTop: 4, fontSize: 13, padding: "6px 8px" }}
            >
              <option value="">Select Operation</option>
              {operations.map((op) => (
                <option key={op.id} value={op.id}>{op.name}</option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13 }}>
            Partition
            <select
              value={partitionId}
              onChange={(e) => setPartitionId(e.target.value)}
              style={{ display: "block", width: "100%", marginTop: 4, fontSize: 13, padding: "6px 8px" }}
            >
              <option value="">Select Partition</option>
              {partitions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
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

          {/* Variable entries */}
          {varEntries.length > 0 && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Variables</div>
              {varEntries.map(([k, v], i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                  <input
                    type="text"
                    value={k}
                    onChange={(e) => {
                      const next = [...varEntries] as Array<[string, string]>;
                      next[i] = [e.target.value, v];
                      setVarEntries(next);
                    }}
                    placeholder="KEY"
                    className="mono"
                    style={{ flex: 1, fontSize: 12, padding: "4px 6px" }}
                  />
                  <input
                    type="text"
                    value={v}
                    onChange={(e) => {
                      const next = [...varEntries] as Array<[string, string]>;
                      next[i] = [k, e.target.value];
                      setVarEntries(next);
                    }}
                    placeholder="value"
                    className="mono"
                    style={{ flex: 1, fontSize: 12, padding: "4px 6px" }}
                  />
                  <button
                    type="button"
                    onClick={() => setVarEntries(varEntries.filter((_, j) => j !== i))}
                    style={{ fontSize: 12, padding: "4px 8px" }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              type="button"
              className="btn"
              onClick={() => setVarEntries([...varEntries, ["", ""]])}
              style={{ fontSize: 12 }}
            >
              + Add Variable
            </button>
          </div>

          <button
            className="btn btn-primary"
            disabled={submitting || !operationId || !partitionId || !version.trim() || (environmentsEnabled && !environmentId)}
            onClick={deployWithCurrentConfig}
            style={{ alignSelf: "flex-start", marginTop: 8 }}
          >
            {submitting ? "Deploying..." : "Deploy"}
          </button>
        </div>
      </div>
    </div>
  );
}
