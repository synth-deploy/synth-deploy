import { useState, useEffect } from "react";
import {
  listOperations,
  listPartitions,
  listEnvironments,
  listOrders,
  createOrder,
  triggerDeployment,
} from "../../api.js";
import type { Operation, Partition, Environment, Order } from "../../types.js";
import { useSettings } from "../../context/SettingsContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import { useCanvas } from "../../context/CanvasContext.js";
import EnvBadge from "../EnvBadge.js";

interface Props {
  title: string;
  /** Pre-select an Order when navigating from the Orders section */
  preselectedOrderId?: string;
}

export default function DeploymentAuthoringPanel({ title, preselectedOrderId }: Props) {
  const { pushPanel } = useCanvas();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const [operations, setOperations] = useState<Operation[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(preselectedOrderId ?? null);

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

        {/* Order selection — the primary deployment flow */}
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
                <p>No Orders available. Create one above to get started.</p>
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
      </div>
    </CanvasPanelHost>
  );
}
