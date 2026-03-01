import { useState, useEffect, useRef } from "react";
import { listOperations, listPartitions, listEnvironments, triggerDeployment, interpretIntent } from "../../api.js";
import type { Operation, Partition, Environment } from "../../types.js";
import type { IntentResult } from "../../api.js";
import { useSettings } from "../../context/SettingsContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import { useCanvas } from "../../context/CanvasContext.js";

const confidenceLabels: Record<string, string> = {
  exact: "Exact match found in intent",
  inferred: "Inferred from context (not explicitly stated)",
  missing: "Could not be resolved from intent",
};

interface Props {
  title: string;
  initialIntent?: string;
}

export default function DeploymentAuthoringPanel({ title, initialIntent }: Props) {
  const { pushPanel } = useCanvas();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const [operations, setOperations] = useState<Operation[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const conversationIdRef = useRef(crypto.randomUUID());
  const initialSubmittedRef = useRef(false);

  useEffect(() => {
    Promise.all([listOperations(), listPartitions(), listEnvironments()]).then(([p, t, e]) => {
      setOperations(p);
      setPartitions(t);
      setEnvironments(e);
      setLoading(false);
    });
  }, []);

  // Auto-submit initial intent
  useEffect(() => {
    if (initialIntent && !loading && !initialSubmittedRef.current) {
      initialSubmittedRef.current = true;
      handleIntentSubmit(initialIntent);
    }
  }, [initialIntent, loading]);

  async function handleIntentSubmit(intent: string) {
    setInterpreting(true);
    setError(null);

    try {
      const result = await interpretIntent(intent, {}, conversationIdRef.current);
      setIntentResult(result);

      if (result.ready) {
        setTimeout(() => deployWithResolvedConfig(result), 300);
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
        operationId: result.resolved.operationId.value,
        partitionId: result.resolved.partitionId.value,
        environmentId: result.resolved.environmentId.value,
        version: result.resolved.version.value,
        variables: Object.keys(result.resolved.variables).length > 0
          ? result.resolved.variables
          : undefined,
      });

      // Navigate to deployment detail in the canvas
      pushPanel({
        type: "deployment-detail",
        title: `Deployment ${deployResult.deployment.version}`,
        params: { id: deployResult.deployment.id },
      });
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  }

  function operationName(id: string): string {
    return operations.find((p) => p.id === id)?.name ?? id;
  }
  function partitionName(id: string): string {
    return partitions.find((t) => t.id === id)?.name ?? id;
  }
  function envName(id: string): string {
    return environments.find((e) => e.id === id)?.name ?? id;
  }

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {error && <div className="error-msg">{error}</div>}

        {interpreting && (
          <div className="canvas-interpreting">Interpreting intent...</div>
        )}

        {intentResult && (
          <div className="canvas-resolved-config">
            <div className="canvas-resolved-header">
              <h3>Resolved Configuration</h3>
              {intentResult.ready && <span className="badge badge-succeeded">Ready</span>}
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
              <div className="canvas-section">
                <div className="canvas-section-title">Variables</div>
                <div className="canvas-var-table">
                  {Object.entries(intentResult.resolved.variables).map(([k, v]) => (
                    <div key={k} className="canvas-var-row">
                      <span className="mono">{k}</span>
                      <span className="mono">{v}</span>
                    </div>
                  ))}
                </div>
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
                onClick={() => {
                  if (intentResult) deployWithResolvedConfig(intentResult);
                }}
              >
                {submitting ? "Deploying..." : "Confirm & Deploy"}
              </button>
            )}
          </div>
        )}

        {!intentResult && !interpreting && (
          <div className="canvas-empty">
            <p>Use the intent bar below to describe your deployment.</p>
            <p style={{ fontSize: 13, opacity: 0.6 }}>
              Example: "deploy Acme to staging v1.2.3"
            </p>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}

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
