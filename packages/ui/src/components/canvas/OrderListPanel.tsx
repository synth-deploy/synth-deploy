import { useState, useEffect } from "react";
import { listOrders, listOperations, listPartitions, listEnvironments } from "../../api.js";
import type { Order, Operation, Partition, Environment } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useSettings } from "../../context/SettingsContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import EnvBadge from "../EnvBadge.js";

interface Props {
  title: string;
  filterOperationId?: string;
  filterPartitionId?: string;
}

export default function OrderListPanel({ title, filterOperationId, filterPartitionId }: Props) {
  const { pushPanel } = useCanvas();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const [orders, setOrders] = useState<Order[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [filterOperation, setFilterOperation] = useState(filterOperationId ?? "");
  const [filterPartition, setFilterPartition] = useState(filterPartitionId ?? "");

  useEffect(() => {
    const filters: { operationId?: string; partitionId?: string } = {};
    if (filterOperationId) filters.operationId = filterOperationId;
    if (filterPartitionId) filters.partitionId = filterPartitionId;

    Promise.all([
      listOrders(Object.keys(filters).length > 0 ? filters : undefined),
      listOperations(),
      listPartitions(),
      listEnvironments(),
    ])
      .then(([o, p, t, e]) => {
        setOrders(o);
        setOperations(p);
        setPartitions(t);
        setEnvironments(e);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    const filters: { operationId?: string; partitionId?: string } = {};
    if (filterOperation) filters.operationId = filterOperation;
    if (filterPartition) filters.partitionId = filterPartition;
    listOrders(Object.keys(filters).length > 0 ? filters : undefined).then(setOrders);
  }, [filterOperation, filterPartition]);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div className="canvas-summary-strip">
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{orders.length}</span>
            <span className="canvas-summary-label">Orders</span>
          </div>
        </div>

        {/* Filters */}
        <div className="card" style={{ margin: "0 16px 16px", padding: "12px 16px" }}>
          <div className="flex gap-8 items-center">
            <span className="text-muted" style={{ fontSize: 12 }}>Filter:</span>
            <select
              value={filterOperation}
              onChange={(e) => setFilterOperation(e.target.value)}
              style={{ fontSize: 13, padding: "4px 8px" }}
            >
              <option value="">All Operations</option>
              {operations.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              value={filterPartition}
              onChange={(e) => setFilterPartition(e.target.value)}
              style={{ fontSize: 13, padding: "4px 8px" }}
            >
              <option value="">All Partitions</option>
              {partitions.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </div>

        {orders.length > 0 ? (
          <div className="canvas-activity-list">
            {orders.map((o) => {
              const partition = partitions.find((t) => t.id === o.partitionId);
              return (
                <button
                  key={o.id}
                  className="canvas-activity-row"
                  onClick={() => pushPanel({
                    type: "order-detail",
                    title: `Order ${o.id.slice(0, 8)}`,
                    params: { id: o.id },
                  })}
                >
                  <span className="mono" style={{ fontWeight: 500, fontSize: 12 }}>
                    {o.id.slice(0, 8)}
                  </span>
                  <span>{o.operationName}</span>
                  <span className="mono" style={{ fontSize: 12 }}>v{o.version}</span>
                  {environmentsEnabled && <EnvBadge name={o.environmentName} />}
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    {partition?.name ?? o.partitionId.slice(0, 8)}
                  </span>
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    {o.steps.length} step{o.steps.length !== 1 ? "s" : ""}
                  </span>
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    {new Date(o.createdAt).toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="canvas-empty">
            <p>No orders yet. Use the intent bar to create one, or deploy to generate one automatically.</p>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
