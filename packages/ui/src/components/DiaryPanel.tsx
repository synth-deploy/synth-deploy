import { useState, useEffect } from "react";
import { Link } from "react-router";
import { getRecentDebrief } from "../api.js";
import type { DebriefEntry } from "../types.js";

const DT_COLORS: Record<string, string> = {
  "pipeline-plan": "#6366f1",
  "configuration-resolved": "#8b5cf6",
  "variable-conflict": "#f59e0b",
  "health-check": "#06b6d4",
  "deployment-execution": "#3b82f6",
  "deployment-verification": "#10b981",
  "deployment-completion": "#16a34a",
  "deployment-failure": "#dc2626",
  "diagnostic-investigation": "#ec4899",
  "environment-scan": "#14b8a6",
  system: "#6b7280",
  "llm-call": "#6b7280",
  "artifact-analysis": "#ec4899",
  "plan-generation": "#6366f1",
  "plan-approval": "#16a34a",
  "plan-rejection": "#dc2626",
  "rollback-execution": "#dc2626",
  "cross-system-context": "#14b8a6",
};

function formatTime(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function DiaryEntry({ entry }: { entry: DebriefEntry }) {
  const [expanded, setExpanded] = useState(false);
  const borderColor = DT_COLORS[entry.decisionType] ?? "#6b7280";

  return (
    <div
      className="diary-panel-entry"
      style={{ borderLeftColor: borderColor }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="diary-panel-entry-header">
        <span className="diary-panel-entry-time">{formatTime(entry.timestamp)}</span>
        <span
          className="diary-panel-entry-agent"
          style={{
            color: entry.agent === "command" ? "#7c3aed" : "#0891b2",
            background: entry.agent === "command" ? "rgba(124,58,237,0.1)" : "rgba(8,145,178,0.1)",
          }}
        >
          {entry.agent}
        </span>
      </div>
      <div className="diary-panel-entry-decision">{entry.decision}</div>
      {expanded && (
        <div className="diary-panel-entry-reasoning">
          {entry.reasoning}
          {entry.deploymentId && (
            <div style={{ marginTop: 6 }}>
              <Link
                to={`/deployments/${entry.deploymentId}`}
                className="debrief-entry-deploy-link"
                onClick={(e) => e.stopPropagation()}
              >
                View deployment
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DiaryPanel() {
  const [entries, setEntries] = useState<DebriefEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = () => {
    setError(null);
    setLoading(true);
    getRecentDebrief({ limit: 10 })
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load decision diary"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchEntries();
  }, []);

  return (
    <div className="diary-panel diary-panel-visible">
      <div className="diary-panel-content">
        <div className="diary-panel-header">
          <span className="diary-panel-title">Decision Diary</span>
          <Link to="/debrief" className="diary-panel-link">View all</Link>
        </div>

        {loading && (
          <div className="diary-panel-loading">Loading...</div>
        )}

        {!loading && error && (
          <div className="diary-panel-error">
            <span>{error}</span>
            <button className="diary-panel-retry" onClick={fetchEntries}>Retry</button>
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="diary-panel-empty">No recent decisions</div>
        )}

        {!loading && !error && entries.map((entry) => (
          <DiaryEntry key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
