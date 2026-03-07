import { useState, useEffect } from "react";
import { Link } from "react-router";
import { getRecentDebrief } from "../api.js";
import type { DebriefEntry } from "../types.js";

const DT_COLORS: Record<string, string> = {
  "pipeline-plan": "var(--dt-plan)",
  "configuration-resolved": "var(--accent)",
  "variable-conflict": "var(--status-warning)",
  "health-check": "var(--dt-health)",
  "deployment-execution": "var(--accent)",
  "deployment-verification": "var(--dt-verification)",
  "deployment-completion": "var(--status-succeeded)",
  "deployment-failure": "var(--status-failed)",
  "diagnostic-investigation": "var(--dt-diagnostic)",
  "environment-scan": "var(--dt-scan)",
  system: "var(--dt-system)",
  "llm-call": "var(--dt-system)",
  "artifact-analysis": "var(--dt-diagnostic)",
  "plan-generation": "var(--dt-plan)",
  "plan-approval": "var(--status-succeeded)",
  "plan-rejection": "var(--status-failed)",
  "rollback-execution": "var(--status-failed)",
  "cross-system-context": "var(--dt-scan)",
};

function formatTime(date: string | Date): string {
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function DiaryEntry({ entry }: { entry: DebriefEntry }) {
  const [expanded, setExpanded] = useState(false);
  const borderColor = DT_COLORS[entry.decisionType] ?? "var(--text-muted)";

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
            color: "var(--accent)",
            background: "var(--accent-dim)",
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
