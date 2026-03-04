import { useState, useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router";
import {
  listOperations,
  listPartitions,
  listEnvironments,
  triggerDeployment,
  interpretIntent,
} from "../api.js";
import type { Operation, Partition, Environment } from "../types.js";
import type { IntentResult } from "../api.js";
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
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deployment config state
  const [operationId, setOperationId] = useState(searchParams.get("operationId") ?? "");
  const [partitionId, setPartitionId] = useState(searchParams.get("partitionId") ?? "");
  const [environmentId, setEnvironmentId] = useState("");
  const [version, setVersion] = useState("");
  const [varEntries, setVarEntries] = useState<Array<[string, string]>>([]);

  // Intent state
  const [intent, setIntent] = useState("");
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const conversationIdRef = useRef(crypto.randomUUID());

  const intentFromUrl = searchParams.get("intent");
  const intentSubmittedRef = useRef(false);

  useEffect(() => {
    Promise.all([listOperations(), listPartitions(), listEnvironments()]).then(([p, t, e]) => {
      setOperations(p);
      setPartitions(t);
      setEnvironments(e);
      setLoading(false);
    });
  }, []);

  // Auto-submit intent from URL query param (from command channel).
  // handleIntentSubmit is intentionally omitted -- ref guard prevents re-execution.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (intentFromUrl && !loading && !intentSubmittedRef.current) {
      intentSubmittedRef.current = true;
      handleIntentSubmit(intentFromUrl);
    }
  }, [intentFromUrl, loading]);

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

  // --- Intent handlers ---

  async function handleIntentSubmit(intentText: string) {
    setInterpreting(true);
    setError(null);

    try {
      const result = await interpretIntent(intentText, {
        operationId: operationId || undefined,
        partitionId: partitionId || undefined,
        environmentId: environmentId || undefined,
        version: version || undefined,
        variables: varEntries.length > 0 ? Object.fromEntries(varEntries) : undefined,
      }, conversationIdRef.current);

      setIntentResult(result);

      // Apply resolved fields to config state
      for (const update of result.uiUpdates) {
        switch (update.field) {
          case "operationId":
            if (update.value) setOperationId(update.value);
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

      // If fully resolved, deploy immediately
      if (result.ready) {
        setTimeout(() => {
          deployWithResolvedConfig(result);
        }, 300);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInterpreting(false);
    }
  }

  async function deployWithResolvedConfig(result: IntentResult) {
    setSubmitting(true);
    setError(null);

    try {
      const deployResult = await triggerDeployment({
        operationId: result.resolved.operationId.value,
        partitionId: result.resolved.partitionId.value,
        environmentId: result.resolved.environmentId.value,
        version: result.resolved.version.value,
        variables: Object.keys(result.resolved.variables).length > 0
          ? result.resolved.variables
          : undefined,
      });

      navigate(`/deployments/${deployResult.deployment.id}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  function handleIntentFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!intent.trim() || submitting || interpreting) return;
    const text = intent.trim();
    setIntent("");
    handleIntentSubmit(text);
  }

  // --- Helper: name lookups for resolved display ---

  function operationName(id: string): string {
    return operations.find((p) => p.id === id)?.name ?? id;
  }

  function partitionName(id: string): string {
    return partitions.find((t) => t.id === id)?.name ?? id;
  }

  function envName(id: string): string {
    return environments.find((e) => e.id === id)?.name ?? id;
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

      {/* Resolved config preview -- shows when intent has been interpreted */}
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
              label="Operation"
              field={intentResult.resolved.operationId}
              displayValue={intentResult.resolved.operationId.value ? operationName(intentResult.resolved.operationId.value) : ""}
            />
            <ResolvedFieldDisplay
              label="Partition"
              field={intentResult.resolved.partitionId}
              displayValue={intentResult.resolved.partitionId.value ? partitionName(intentResult.resolved.partitionId.value) : ""}
            />
            {environmentsEnabled && (
              <ResolvedFieldDisplay
                label="Environment"
                field={intentResult.resolved.environmentId}
                displayValue={intentResult.resolved.environmentId.value ? envName(intentResult.resolved.environmentId.value) : ""}
              />
            )}
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

          {(() => {
            const missing = environmentsEnabled
              ? intentResult.missingFields
              : intentResult.missingFields.filter((f) => f !== "environmentId");
            return missing.length > 0 ? (
              <div className="resolved-missing">
                <strong>Missing: {missing.join(", ")}</strong>
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  Try including {missing.map((f) => {
                    if (f === "operationId") return "the operation name";
                    if (f === "partitionId") return "the partition name";
                    if (f === "environmentId") return '"production" or "staging"';
                    if (f === "version") return 'a version like "v1.2.3"';
                    return f;
                  }).join(", ")} in your intent.
                </div>
              </div>
            ) : null;
          })()}

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

      {/* Intent bar */}
      <form className="intent-bar" onSubmit={handleIntentFormSubmit}>
        <div className="intent-bar-inner">
          <span className="intent-bar-icon">&gt;</span>
          <input
            className="intent-bar-input"
            type="text"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="Issue intent... e.g. deploy Acme to staging"
            disabled={submitting || interpreting}
          />
          <button
            type="submit"
            className="intent-bar-submit"
            disabled={!intent.trim() || submitting || interpreting}
          >
            {interpreting ? "..." : "Go"}
          </button>
        </div>
      </form>
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
