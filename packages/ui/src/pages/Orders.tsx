import { useState, useEffect } from "react";
import { Link } from "react-router";
import { listOrders, listOperations, listPartitions, listEnvironments, createOrder } from "../api.js";
import type { Order, Operation, Partition, Environment } from "../types.js";
import EnvBadge from "../components/EnvBadge.js";
import { useSettings } from "../context/SettingsContext.js";

export default function Orders() {
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;
  const [orders, setOrders] = useState<Order[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [operationId, setOperationId] = useState("");
  const [partitionId, setPartitionId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [version, setVersion] = useState("");

  // Filters
  const [filterOperation, setFilterOperation] = useState("");
  const [filterPartition, setFilterPartition] = useState("");

  useEffect(() => {
    Promise.all([listOrders(), listOperations(), listPartitions(), listEnvironments()]).then(
      ([o, p, t, e]) => {
        setOrders(o);
        setOperations(p);
        setPartitions(t);
        setEnvironments(e);
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    const filters: { operationId?: string; partitionId?: string } = {};
    if (filterOperation) filters.operationId = filterOperation;
    if (filterPartition) filters.partitionId = filterPartition;
    listOrders(Object.keys(filters).length > 0 ? filters : undefined).then(setOrders);
  }, [filterOperation, filterPartition]);

  async function handleCreate() {
    if (!operationId || !partitionId || !version.trim() || (environmentsEnabled && !environmentId)) return;
    setError(null);
    try {
      const order = await createOrder({ operationId, partitionId, environmentId, version: version.trim() });
      setOrders([order, ...orders]);
      setOperationId("");
      setPartitionId("");
      setEnvironmentId("");
      setVersion("");
      setShowForm(false);
    } catch (e: any) {
      setError(e.message);
    }
  }

  const selectedOperation = operations.find((p) => p.id === operationId);
  const availableEnvs = selectedOperation
    ? environments.filter((e) => selectedOperation.environmentIds.includes(e.id))
    : [];

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h2>Orders</h2>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Create Order"}
        </button>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {showForm && (
        <div className="card mb-16">
          <div className="form-group">
            <label>Operation</label>
            <select value={operationId} onChange={(e) => { setOperationId(e.target.value); setEnvironmentId(""); }}>
              <option value="">Select operation...</option>
              {operations.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Partition</label>
            <select value={partitionId} onChange={(e) => setPartitionId(e.target.value)}>
              <option value="">Select partition...</option>
              {partitions.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          {environmentsEnabled && (
            <div className="form-group">
              <label>Environment</label>
              <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} disabled={!operationId}>
                <option value="">Select environment...</option>
                {availableEnvs.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="form-group">
            <label>Version</label>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="e.g., 1.0.0"
            />
          </div>
          <button className="btn btn-primary" onClick={handleCreate}>Create Order</button>
        </div>
      )}

      {/* Filters */}
      <div className="card mb-16" style={{ padding: "12px 16px" }}>
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

      <div className="card">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Operation</th>
                <th>Version</th>
                {environmentsEnabled && <th>Environment</th>}
                <th>Partition</th>
                <th>Steps</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const partition = partitions.find((t) => t.id === o.partitionId);
                return (
                  <tr key={o.id}>
                    <td>
                      <Link to={`/orders/${o.id}`} className="mono" style={{ fontWeight: 500 }}>
                        {o.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>
                      <Link to={`/operations/${o.operationId}`}>{o.operationName}</Link>
                    </td>
                    <td className="mono">v{o.version}</td>
                    {environmentsEnabled && <td><EnvBadge name={o.environmentName} /></td>}
                    <td>{partition?.name ?? o.partitionId.slice(0, 8)}</td>
                    <td>{o.steps.length}</td>
                    <td className="text-muted" style={{ fontSize: 12 }}>
                      {new Date(o.createdAt).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={environmentsEnabled ? 7 : 6} className="empty-state">
                    <p>No orders yet. Orders are created automatically when you deploy, or you can pre-stage one manually.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
