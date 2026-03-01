import { useState, useEffect, useRef } from "react";
import {
  listOperations,
  listPartitions,
  listEnvironments,
  listOrders,
  createOrder,
  triggerDeployment,
  interpretIntent,
} from "../../api.js";
import type { Operation, Partition, Environment, Order } from "../../types.js";
import type { IntentResult } from "../../api.js";
import { useSettings } from "../../context/SettingsContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import { useCanvas } from "../../context/CanvasContext.js";
import EnvBadge from "../EnvBadge.js";

interface Props {
  title: string;
  initialIntent?: string;
  /** Pre-select an Order when navigating from the Orders section */
  preselectedOrderId?: string;
}

export default function DeploymentAuthoringPanel({ title, initialIntent, preselectedOrderId }: Props) {
  const { pushPanel } = useCanvas();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const [operations, setOperations] = useState<Operation[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(preselectedOrderId ?? null);
  const [intentResult, setIntentResult] = useState<IntentResult | null>(null);
  const conversationIdRef = useRef(crypto.randomUUID());
  const initialSubmittedRef = useRef(false);

  // New Order creation state
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [newOrderOpId, setNewOrderOpId] = useState("");
  const [newOrderPartId, setNewOrderPartId] = useState("");
  const [newOrderEnvId, setNewOrderEnvId] = useState("");
  const [newOrderVersion, setNewOrderVersion] = useState("");
  const [creatingOrder, setCreatingOrder] = useState(false);

  useEffect(() => {
    Promise.all([listOperations(), listPartitions(), listEnvironments(), listOrders()]).then(
      ([ops, parts, envs, ords]) => {
        setOperations(ops);
        setPartitions(parts);
        setEnvironments(envs);
        setOrders(ords);
        setLoading(false);
      },
    );
  }, []);

  // Auto-submit initial intent (from CommandChannel)
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
        // Intent resolved all fields — create an Order and deploy
        setTimeout(() => deployFromIntent(result), 300);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInterpreting(false);
    }
  }

  async function deployFromIntent(result: IntentResult) {
    setSubmitting(true);
    setError(null);

    try {
      // Create an Order from the resolved intent fields
      const order = await createOrder({
        operationId: result.resolved.operationId.value,
        partitionId: result.resolved.partitionId.value,
        environmentId: result.resolved.environmentId.value,
        version: result.resolved.version.value,
      });

      // Deploy from the newly created Order
      const deployResult = await triggerDeployment({
        orderId: order.id,
        partitionId: result.resolved.partitionId.value,
        environmentId: result.resolved.environmentId.value,
        triggeredBy: "agent",
        variables:
          Object.keys(result.resolved.variables).length > 0
            ? result.resolved.variables
            : undefined,
      });

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

  async function deployFromOrder(order: Order) {
    setSubmitting(true);
    setError(null);

    try {
      const deployResult = await triggerDeployment({
        orderId: order.id,
        partitionId: order.partitionId,
        environmentId: order.environmentId,
        triggeredBy: "user",
      });

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

  async function handleCreateOrder() {
    setCreatingOrder(true);
    setError(null);

    try {
      const order = await createOrder({
        operationId: newOrderOpId,
        partitionId: newOrderPartId,
        environmentId: newOrderEnvId,
        version: newOrderVersion,
      });

      // Add to local list and select it
      setOrders((prev) => [order, ...prev]);
      setSelectedOrderId(order.id);
      setShowNewOrder(false);
      setNewOrderOpId("");
      setNewOrderPartId("");
      setNewOrderEnvId("");
      setNewOrderVersion("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreatingOrder(false);
    }
  }

  const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? null;

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

        {interpreting && <div className="canvas-interpreting">Interpreting intent...</div>}

        {/* Intent resolution results (from CommandChannel) */}
        {intentResult && !intentResult.ready && (
          <IntentResolutionView
            result={intentResult}
            operations={operations}
            partitions={partitions}
            environments={environments}
            environmentsEnabled={environmentsEnabled}
            submitting={submitting}
            onDeploy={() => deployFromIntent(intentResult)}
          />
        )}

        {/* Order selection — the primary deployment flow */}
        {!intentResult && !interpreting && (
          <>
            {/* Header with create button */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0 16px",
                marginBottom: 12,
              }}
            >
              <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>Select an Order to deploy</h3>
              <button
                className="btn btn-primary"
                style={{ fontSize: 12, padding: "4px 12px" }}
                onClick={() => setShowNewOrder(!showNewOrder)}
              >
                {showNewOrder ? "Cancel" : "New Order"}
              </button>
            </div>

            {/* New Order creation form */}
            {showNewOrder && (
              <div className="card" style={{ margin: "0 16px 16px", padding: 16 }}>
                <h4 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                  Snapshot an Operation into a new Order
                </h4>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <select
                    value={newOrderOpId}
                    onChange={(e) => setNewOrderOpId(e.target.value)}
                    style={{ fontSize: 13, padding: "6px 8px" }}
                  >
                    <option value="">Select Operation</option>
                    {operations.map((op) => (
                      <option key={op.id} value={op.id}>
                        {op.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={newOrderPartId}
                    onChange={(e) => setNewOrderPartId(e.target.value)}
                    style={{ fontSize: 13, padding: "6px 8px" }}
                  >
                    <option value="">Select Partition</option>
                    {partitions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {environmentsEnabled && (
                    <select
                      value={newOrderEnvId}
                      onChange={(e) => setNewOrderEnvId(e.target.value)}
                      style={{ fontSize: 13, padding: "6px 8px" }}
                    >
                      <option value="">Select Environment</option>
                      {environments.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="text"
                    placeholder="Version (e.g. 1.2.3)"
                    value={newOrderVersion}
                    onChange={(e) => setNewOrderVersion(e.target.value)}
                    style={{ fontSize: 13, padding: "6px 8px" }}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={
                      creatingOrder ||
                      !newOrderOpId ||
                      !newOrderPartId ||
                      !newOrderVersion ||
                      (environmentsEnabled && !newOrderEnvId)
                    }
                    onClick={handleCreateOrder}
                    style={{ alignSelf: "flex-start", marginTop: 4 }}
                  >
                    {creatingOrder ? "Creating..." : "Create Order"}
                  </button>
                </div>
              </div>
            )}

            {/* Order list */}
            {orders.length > 0 ? (
              <div className="canvas-activity-list">
                {orders.map((order) => {
                  const isSelected = selectedOrderId === order.id;
                  const partName =
                    partitions.find((p) => p.id === order.partitionId)?.name ??
                    order.partitionId.slice(0, 8);
                  return (
                    <button
                      key={order.id}
                      className={`canvas-activity-row ${isSelected ? "canvas-activity-row-selected" : ""}`}
                      onClick={() => setSelectedOrderId(isSelected ? null : order.id)}
                      style={{
                        borderColor: isSelected ? "rgba(99,225,190,0.4)" : undefined,
                        background: isSelected ? "rgba(99,225,190,0.08)" : undefined,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{order.operationName}</span>
                      <span className="mono" style={{ fontSize: 12 }}>
                        v{order.version}
                      </span>
                      {environmentsEnabled && <EnvBadge name={order.environmentName} />}
                      <span className="text-muted" style={{ fontSize: 12 }}>
                        {partName}
                      </span>
                      <span className="text-muted" style={{ fontSize: 12 }}>
                        {new Date(order.createdAt).toLocaleString()}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="canvas-empty">
                <p>No Orders available. Create one above, or use the Command Channel to describe a deployment.</p>
              </div>
            )}

            {/* Selected Order detail + deploy button */}
            {selectedOrder && (
              <div className="card" style={{ margin: "16px 16px 0", padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>
                      {selectedOrder.operationName}{" "}
                      <span className="mono" style={{ fontSize: 13, opacity: 0.7 }}>
                        v{selectedOrder.version}
                      </span>
                    </div>
                    <div className="text-muted" style={{ marginTop: 4, fontSize: 13 }}>
                      {partitions.find((p) => p.id === selectedOrder.partitionId)?.name ??
                        selectedOrder.partitionId.slice(0, 8)}{" "}
                      {environmentsEnabled && (
                        <>
                          &rarr; <EnvBadge name={selectedOrder.environmentName} />
                        </>
                      )}
                    </div>
                    <div className="text-muted" style={{ marginTop: 4, fontSize: 12 }}>
                      {selectedOrder.steps.length} step{selectedOrder.steps.length !== 1 ? "s" : ""} |{" "}
                      Created {new Date(selectedOrder.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={submitting}
                    onClick={() => deployFromOrder(selectedOrder)}
                  >
                    {submitting ? "Deploying..." : "Deploy"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </CanvasPanelHost>
  );
}

// --- Intent resolution sub-view (shown when CommandChannel resolves an intent) ---

function IntentResolutionView({
  result,
  operations,
  partitions,
  environments,
  environmentsEnabled,
  submitting,
  onDeploy,
}: {
  result: IntentResult;
  operations: Operation[];
  partitions: Partition[];
  environments: Environment[];
  environmentsEnabled: boolean;
  submitting: boolean;
  onDeploy: () => void;
}) {
  function operationName(id: string): string {
    return operations.find((p) => p.id === id)?.name ?? id;
  }
  function partitionName(id: string): string {
    return partitions.find((t) => t.id === id)?.name ?? id;
  }
  function envName(id: string): string {
    return environments.find((e) => e.id === id)?.name ?? id;
  }

  const missing = environmentsEnabled
    ? result.missingFields
    : result.missingFields.filter((f) => f !== "environmentId");

  return (
    <div className="canvas-resolved-config">
      <div className="canvas-resolved-header">
        <h3>Resolved Configuration</h3>
        {result.ready && <span className="badge badge-succeeded">Ready</span>}
      </div>
      <div className="resolved-fields">
        <ResolvedFieldDisplay
          label="Operation"
          field={result.resolved.operationId}
          displayValue={
            result.resolved.operationId.value
              ? operationName(result.resolved.operationId.value)
              : ""
          }
        />
        <ResolvedFieldDisplay
          label="Partition"
          field={result.resolved.partitionId}
          displayValue={
            result.resolved.partitionId.value
              ? partitionName(result.resolved.partitionId.value)
              : ""
          }
        />
        {environmentsEnabled && (
          <ResolvedFieldDisplay
            label="Environment"
            field={result.resolved.environmentId}
            displayValue={
              result.resolved.environmentId.value
                ? envName(result.resolved.environmentId.value)
                : ""
            }
          />
        )}
        <ResolvedFieldDisplay
          label="Version"
          field={result.resolved.version}
          displayValue={result.resolved.version.value}
        />
      </div>

      {Object.keys(result.resolved.variables).length > 0 && (
        <div className="canvas-section">
          <div className="canvas-section-title">Variables</div>
          <div className="canvas-var-table">
            {Object.entries(result.resolved.variables).map(([k, v]) => (
              <div key={k} className="canvas-var-row">
                <span className="mono">{k}</span>
                <span className="mono">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {missing.length > 0 && (
        <div className="resolved-missing">
          <strong>Missing: {missing.join(", ")}</strong>
          <div style={{ marginTop: 4, fontSize: 12 }}>
            Try including{" "}
            {missing
              .map((f) => {
                if (f === "operationId") return "the operation name";
                if (f === "partitionId") return "the partition name";
                if (f === "environmentId") return '"production" or "staging"';
                if (f === "version") return 'a version like "v1.2.3"';
                return f;
              })
              .join(", ")}{" "}
            in your intent.
          </div>
        </div>
      )}

      {!result.ready && (
        <button
          className="btn btn-primary mt-16"
          disabled={submitting || missing.length > 0}
          onClick={onDeploy}
        >
          {submitting ? "Deploying..." : "Create Order & Deploy"}
        </button>
      )}
    </div>
  );
}

// --- Shared sub-component ---

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
      {field.matchedFrom && <span className="resolved-field-source">{field.matchedFrom}</span>}
      <span
        className={`resolved-confidence-dot confidence-${field.confidence}`}
        title={confidenceLabels[field.confidence] ?? field.confidence}
      />
    </div>
  );
}
