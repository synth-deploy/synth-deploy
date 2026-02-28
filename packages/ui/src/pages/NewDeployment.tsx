import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router";
import {
  listProjects,
  listPartitions,
  listEnvironments,
  triggerDeployment,
  interpretIntent,
} from "../api.js";
import type { Project, Partition, Environment } from "../types.js";
import type { IntentResult } from "../api.js";
import { useMode } from "../context/ModeContext.js";
import DeploymentContextPanel from "../components/DeploymentContextPanel.js";
import IntentBar from "../components/IntentBar.js";

export default function NewDeployment() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { mode } = useMode();
  const isAgent = mode === "agent";

  const [projects, setProjects] = useState<Project[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shared deployment config state — used by both modes
  const [projectId, setProjectId] = useState(searchParams.get("projectId") ?? "");
  const [partitionId, setPartitionId] = useState(searchParams.get("partitionId") ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [version, setVersion] = useState("");
  const [varEntries, setVarEntries] = useState<Array<[string, string]>>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  // Agent mode state
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const [lastIntent, setLastIntent] = useState("");

  useEffect(() => {
    Promise.all([listProjects(), listPartitions(), listEnvironments()]).then(([p, t, e]) => {
      setProjects(p);
      setPartitions(t);
      setEnvironments(e);
      setLoading(false);
    });
  }, []);

  // Filter environments to those linked to selected project
  const selectedProject = projects.find((p) => p.id === projectId);
  const availableEnvs = selectedProject
    ? environments.filter((e) => selectedProject.environmentIds.includes(e.id))
    : environments;

  // --- Shared deploy logic (both modes call this) ---

  async function deployWithCurrentConfig() {
    if (!projectId || !partitionId || !environmentId || !version.trim()) {
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

      // Same triggerDeployment call regardless of mode — identical artifacts
      const result = await triggerDeployment({
        projectId,
        partitionId,
        environmentId,
        version: version.trim(),
        variables: Object.keys(variables).length > 0 ? variables : undefined,
      });

      navigate(`/deployments/${result.deployment.id}`);
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  // --- Traditional mode handlers ---

  function handleAddVar() {
    if (!newKey.trim()) return;
    setVarEntries([...varEntries, [newKey.trim(), newValue]]);
    setNewKey("");
    setNewValue("");
  }

  function handleRemoveVar(index: number) {
    setVarEntries(varEntries.filter((_, i) => i !== index));
  }

  function handleTraditionalSubmit(e: React.FormEvent) {
    e.preventDefault();
    deployWithCurrentConfig();
  }

  // --- Agent mode handlers ---

  async function handleIntentSubmit(intent: string) {
    setInterpreting(true);
    setError(null);
    setLastIntent(intent);

    try {
      // Pass current partial config so agent can fill gaps
      const result = await interpretIntent(intent, {
        projectId: projectId || undefined,
        partitionId: partitionId || undefined,
        environmentId: environmentId || undefined,
        version: version || undefined,
        variables: varEntries.length > 0 ? Object.fromEntries(varEntries) : undefined,
      });

      setIntentResult(result);

      // Apply resolved fields to shared config state (UI updates)
      for (const update of result.uiUpdates) {
        switch (update.field) {
          case "projectId":
            if (update.value) setProjectId(update.value);
            break;
          case "partitionId":
            if (update.value) setPartitionId(update.value);
            break;
          case "environmentId":
            if (update.value) setEnvironmentId(update.value);
            break;
          case "version":
            if (update.value) setVersion(update.value);
            break;
        }
      }

      // Apply resolved variables
      if (result.resolved.variables && Object.keys(result.resolved.variables).length > 0) {
        const newVars: Array<[string, string]> = Object.entries(result.resolved.variables);
        setVarEntries(newVars);
      }

      // If fully resolved, deploy immediately — response is UI updating, not text
      if (result.ready) {
        // Small delay so user sees fields populate before deploy fires
        setTimeout(() => {
          deployWithResolvedConfig(result);
        }, 300);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInterpreting(false);
    }
  }

  async function deployWithResolvedConfig(result: IntentResult) {
    setSubmitting(true);
    setError(null);

    try {
      const deployResult = await triggerDeployment({
        projectId: result.resolved.projectId.value,
        partitionId: result.resolved.partitionId.value,
        environmentId: result.resolved.environmentId.value,
        version: result.resolved.version.value,
        variables: Object.keys(result.resolved.variables).length > 0
          ? result.resolved.variables
          : undefined,
      });

      navigate(`/deployments/${deployResult.deployment.id}`);
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  // --- Helper: name lookups for resolved display ---

  function projectName(id: string): string {
    return projects.find((p) => p.id === id)?.name ?? id;
  }

  function partitionName(id: string): string {
    return partitions.find((t) => t.id === id)?.name ?? id;
  }

  function envName(id: string): string {
    return environments.find((e) => e.id === id)?.name ?? id;
  }

  if (loading) return <div className="loading">Loading...</div>;

  // =========================================================================
  // AGENT MODE LAYOUT
  // =========================================================================

  if (isAgent) {
    return (
      <div className="agent-deploy-layout">
        <div className="page-header">
          <h2>New Deployment</h2>
          <span className="mode-badge mode-badge-agent">Agent Mode</span>
        </div>

        {error && <div className="error-msg">{error}</div>}

        {/* Contextual information — fills the space where form fields were */}
        <DeploymentContextPanel />

        {/* Resolved config preview — shows when intent has been interpreted */}
        {intentResult && (
          <div className="resolved-config-card card">
            <div className="card-header">
              <h3>Resolved Configuration</h3>
              {intentResult.ready && (
                <span className="badge badge-succeeded">Ready</span>
              )}
            </div>
            <div className="resolved-fields">
              <ResolvedFieldDisplay
                label="Project"
                field={intentResult.resolved.projectId}
                displayValue={intentResult.resolved.projectId.value ? projectName(intentResult.resolved.projectId.value) : ""}
              />
              <ResolvedFieldDisplay
                label="Partition"
                field={intentResult.resolved.partitionId}
                displayValue={intentResult.resolved.partitionId.value ? partitionName(intentResult.resolved.partitionId.value) : ""}
              />
              <ResolvedFieldDisplay
                label="Environment"
                field={intentResult.resolved.environmentId}
                displayValue={intentResult.resolved.environmentId.value ? envName(intentResult.resolved.environmentId.value) : ""}
              />
              <ResolvedFieldDisplay
                label="Version"
                field={intentResult.resolved.version}
                displayValue={intentResult.resolved.version.value}
              />
            </div>

            {Object.keys(intentResult.resolved.variables).length > 0 && (
              <div className="resolved-variables">
                <div className="resolved-field-label">Variables</div>
                {Object.entries(intentResult.resolved.variables).map(([k, v]) => (
                  <div key={k} className="resolved-var-row">
                    <span className="mono">{k}</span>
                    <span className="mono">{v}</span>
                  </div>
                ))}
              </div>
            )}

            {intentResult.missingFields.length > 0 && (
              <div className="resolved-missing">
                <strong>Missing: {intentResult.missingFields.join(", ")}</strong>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Try including {intentResult.missingFields.map((f) => {
                    if (f === "projectId") return "the project name";
                    if (f === "partitionId") return "the partition name";
                    if (f === "environmentId") return '"production" or "staging"';
                    if (f === "version") return 'a version like "v1.2.3"';
                    return f;
                  }).join(", ")} in your intent, or switch to traditional mode.
                </div>
              </div>
            )}

            {!intentResult.ready && (
              <button
                className="btn btn-primary mt-16"
                disabled={submitting || intentResult.missingFields.length > 0}
                onClick={() => deployWithCurrentConfig()}
              >
                {submitting ? "Deploying..." : "Confirm & Deploy"}
              </button>
            )}
          </div>
        )}

        {/* Intent bar — fixed at bottom of deploy area */}
        <IntentBar
          onIntentResolved={setIntentResult}
          onSubmitIntent={handleIntentSubmit}
          disabled={submitting}
          processing={interpreting}
        />
      </div>
    );
  }

  // =========================================================================
  // TRADITIONAL MODE LAYOUT (original form, unchanged behavior)
  // =========================================================================

  return (
    <div>
      <div className="page-header">
        <h2>New Deployment</h2>
        <span className="mode-badge mode-badge-traditional">Traditional Mode</span>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="card" style={{ maxWidth: 600 }}>
        <form onSubmit={handleTraditionalSubmit}>
          <div className="form-group">
            <label>Project</label>
            <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setEnvironmentId(""); }}>
              <option value="">Select a project...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Partition</label>
            <select value={partitionId} onChange={(e) => setPartitionId(e.target.value)}>
              <option value="">Select a partition...</option>
              {partitions.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Environment</label>
            <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              <option value="">Select an environment...</option>
              {availableEnvs.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Version</label>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g., 1.0.0"
            />
          </div>

          <div className="form-group">
            <label>Variables (optional)</label>
            {varEntries.length > 0 && (
              <table className="var-table" style={{ marginBottom: 8 }}>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {varEntries.map(([k, v], i) => (
                    <tr key={i}>
                      <td><span className="mono">{k}</span></td>
                      <td><span className="mono">{v}</span></td>
                      <td>
                        <button type="button" className="remove-btn" onClick={() => handleRemoveVar(i)}>&times;</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="inline-form">
              <div className="form-group">
                <input
                  placeholder="Key"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  style={{ minWidth: 120 }}
                />
              </div>
              <div className="form-group">
                <input
                  placeholder="Value"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  style={{ minWidth: 120 }}
                />
              </div>
              <button type="button" className="btn btn-sm" onClick={handleAddVar}>Add</button>
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Deploying..." : "Trigger Deployment"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const confidenceLabels: Record<string, string> = {
  exact: "Exact match found in intent",
  inferred: "Inferred from context (not explicitly stated)",
  missing: "Could not be resolved from intent",
};

function ResolvedFieldDisplay({
  label,
  field,
  displayValue,
}: {
  label: string;
  field: { value: string; confidence: string; matchedFrom?: string };
  displayValue: string;
}) {
  return (
    <div className={`resolved-field resolved-field-${field.confidence}`}>
      <span className="resolved-field-label">{label}</span>
      <span className="resolved-field-value">
        {field.confidence === "missing" ? (
          <span className="resolved-field-missing">Not resolved</span>
        ) : (
          displayValue
        )}
      </span>
      {field.matchedFrom && (
        <span className="resolved-field-source">{field.matchedFrom}</span>
      )}
      <span
        className={`resolved-confidence-dot confidence-${field.confidence}`}
        title={confidenceLabels[field.confidence] ?? field.confidence}
      />
    </div>
  );
}
