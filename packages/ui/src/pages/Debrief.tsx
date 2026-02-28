import { useState, useEffect } from "react";
import { getRecentDebrief, listPartitions } from "../api.js";
import type { DebriefEntry, Partition, DecisionType } from "../types.js";
import DebriefTimeline from "../components/DebriefTimeline.js";

const DECISION_TYPES: { value: DecisionType; label: string }[] = [
  { value: "pipeline-plan", label: "Plan" },
  { value: "configuration-resolved", label: "Config" },
  { value: "variable-conflict", label: "Conflict" },
  { value: "health-check", label: "Health" },
  { value: "deployment-execution", label: "Execute" },
  { value: "deployment-verification", label: "Verify" },
  { value: "deployment-completion", label: "Complete" },
  { value: "deployment-failure", label: "Failure" },
  { value: "diagnostic-investigation", label: "Diagnostic" },
  { value: "environment-scan", label: "Scan" },
  { value: "system", label: "System" },
];

export default function Debrief() {
  const [entries, setEntries] = useState<DebriefEntry[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterPartition, setFilterPartition] = useState("");
  const [filterType, setFilterType] = useState("");

  function fetchEntries(partitionId?: string, decisionType?: string) {
    setLoading(true);
    setError(null);
    getRecentDebrief({
      limit: 100,
      partitionId: partitionId || undefined,
      decisionType: decisionType || undefined,
    })
      .then((e) => {
        setEntries(e);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }

  useEffect(() => {
    Promise.all([
      getRecentDebrief({ limit: 100 }),
      listPartitions(),
    ])
      .then(([e, t]) => {
        setEntries(e);
        setPartitions(t);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  function handlePartitionChange(partition: string) {
    setFilterPartition(partition);
    fetchEntries(partition, filterType);
  }

  function handleTypeChange(type: string) {
    setFilterType(type);
    fetchEntries(filterPartition, type);
  }

  const typeBreakdown = new Map<string, number>();
  for (const entry of entries) {
    typeBreakdown.set(
      entry.decisionType,
      (typeBreakdown.get(entry.decisionType) ?? 0) + 1,
    );
  }

  const uniquePartitions = new Set(
    entries.filter((e) => e.partitionId).map((e) => e.partitionId),
  );

  const uniqueDeployments = new Set(
    entries.filter((e) => e.deploymentId).map((e) => e.deploymentId),
  );

  return (
    <div>
      <div className="page-header">
        <h2>Debrief</h2>
      </div>

      <div className="summary-grid">
        <div className="summary-card">
          <div className="label">Decisions</div>
          <div className="value">{entries.length}</div>
        </div>
        <div className="summary-card">
          <div className="label">Partitions</div>
          <div className="value">{uniquePartitions.size}</div>
        </div>
        <div className="summary-card">
          <div className="label">Deployments</div>
          <div className="value">{uniqueDeployments.size}</div>
        </div>
        <div className="summary-card">
          <div className="label">Decision Types</div>
          <div className="value">{typeBreakdown.size}</div>
        </div>
      </div>

      <div className="card mb-16">
        <div className="inline-form">
          <div className="form-group">
            <label>Filter by Partition</label>
            <select
              value={filterPartition}
              onChange={(e) => handlePartitionChange(e.target.value)}
              style={{ minWidth: 200 }}
            >
              <option value="">All Partitions</option>
              {partitions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Filter by Type</label>
            <select
              value={filterType}
              onChange={(e) => handleTypeChange(e.target.value)}
              style={{ minWidth: 200 }}
            >
              <option value="">All Types</option>
              {DECISION_TYPES.map((dt) => (
                <option key={dt.value} value={dt.value}>
                  {dt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>
              {filterPartition || filterType ? "Filtered" : "Recent"} Decisions
            </h3>
            <span className="text-muted" style={{ fontSize: 12 }}>
              {entries.length} entr{entries.length !== 1 ? "ies" : "y"}
            </span>
          </div>
          {loading ? (
            <div className="loading">Loading...</div>
          ) : (
            <DebriefTimeline entries={entries} />
          )}
        </div>
      </div>
    </div>
  );
}
