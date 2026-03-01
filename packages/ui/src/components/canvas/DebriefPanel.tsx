import { useState, useEffect } from "react";
import { getRecentDebrief, listPartitions } from "../../api.js";
import type { DebriefEntry, Partition, DecisionType } from "../../types.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import DebriefTimeline from "../DebriefTimeline.js";

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

interface Props {
  title: string;
  filterPartitionId?: string;
  filterDecisionType?: string;
}

export default function DebriefPanel({ title, filterPartitionId, filterDecisionType }: Props) {
  const [entries, setEntries] = useState<DebriefEntry[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterPartition, setFilterPartition] = useState(filterPartitionId ?? "");
  const [filterType, setFilterType] = useState(filterDecisionType ?? "");

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
      getRecentDebrief({
        limit: 100,
        partitionId: filterPartitionId || undefined,
        decisionType: filterDecisionType || undefined,
      }),
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

  const uniquePartitions = new Set(
    entries.filter((e) => e.partitionId).map((e) => e.partitionId),
  );
  const uniqueDeployments = new Set(
    entries.filter((e) => e.deploymentId).map((e) => e.deploymentId),
  );
  const typeBreakdown = new Map<string, number>();
  for (const entry of entries) {
    typeBreakdown.set(entry.decisionType, (typeBreakdown.get(entry.decisionType) ?? 0) + 1);
  }

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div className="canvas-summary-strip">
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{entries.length}</span>
            <span className="canvas-summary-label">Decisions</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{uniquePartitions.size}</span>
            <span className="canvas-summary-label">Partitions</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{uniqueDeployments.size}</span>
            <span className="canvas-summary-label">Deployments</span>
          </div>
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{typeBreakdown.size}</span>
            <span className="canvas-summary-label">Types</span>
          </div>
        </div>

        <div className="card" style={{ margin: "0 16px 16px", padding: "12px 16px" }}>
          <div className="flex gap-8 items-center">
            <span className="text-muted" style={{ fontSize: 12 }}>Filter:</span>
            <select
              value={filterPartition}
              onChange={(e) => handlePartitionChange(e.target.value)}
              style={{ fontSize: 13, padding: "4px 8px" }}
            >
              <option value="">All Partitions</option>
              {partitions.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <select
              value={filterType}
              onChange={(e) => handleTypeChange(e.target.value)}
              style={{ fontSize: 13, padding: "4px 8px" }}
            >
              <option value="">All Types</option>
              {DECISION_TYPES.map((dt) => (
                <option key={dt.value} value={dt.value}>{dt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {error && <div className="error-msg" style={{ margin: "0 16px 12px" }}>{error}</div>}

        <div style={{ padding: "0 16px" }}>
          {loading ? (
            <div className="loading">Loading...</div>
          ) : (
            <DebriefTimeline entries={entries} />
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
