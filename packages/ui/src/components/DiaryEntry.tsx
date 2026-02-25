import { useState } from "react";
import type { DiaryEntry, DecisionType } from "../types.js";

const dtClassMap: Record<string, string> = {
  "pipeline-plan": "dt-plan",
  "configuration-resolved": "dt-config",
  "variable-conflict": "dt-conflict",
  "health-check": "dt-health",
  "deployment-execution": "dt-execution",
  "deployment-verification": "dt-verification",
  "deployment-completion": "dt-completion",
  "deployment-failure": "dt-failure",
  "diagnostic-investigation": "dt-diagnostic",
  "environment-scan": "dt-scan",
  system: "dt-system",
};

const dtLabels: Record<string, string> = {
  "pipeline-plan": "Plan",
  "configuration-resolved": "Config",
  "variable-conflict": "Conflict",
  "health-check": "Health",
  "deployment-execution": "Execute",
  "deployment-verification": "Verify",
  "deployment-completion": "Complete",
  "deployment-failure": "Failure",
  "diagnostic-investigation": "Diagnostic",
  "environment-scan": "Scan",
  system: "System",
};

function formatTs(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatContext(ctx: Record<string, unknown>): string {
  const filtered = Object.entries(ctx).filter(
    ([k]) => !k.startsWith("_"),
  );
  if (filtered.length === 0) return "";
  return JSON.stringify(Object.fromEntries(filtered), null, 2);
}

export default function DiaryEntryCard({ entry }: { entry: DiaryEntry }) {
  const [expanded, setExpanded] = useState(false);
  const dtClass = dtClassMap[entry.decisionType] ?? "";
  const dtLabel = dtLabels[entry.decisionType] ?? entry.decisionType;

  return (
    <div className={`diary-entry ${dtClass}`}>
      <div className="diary-entry-header">
        <span className="diary-entry-time">{formatTs(entry.timestamp)}</span>
        <span className={`dt-badge`} style={{ color: `var(--${dtClass})`, background: `color-mix(in srgb, var(--${dtClass}) 12%, transparent)` }}>
          {dtLabel}
        </span>
        <span className={`agent-badge agent-badge-${entry.agent}`}>
          {entry.agent}
        </span>
      </div>
      <div className="diary-entry-decision">{entry.decision}</div>
      <button
        className="btn btn-sm mt-16"
        onClick={() => setExpanded(!expanded)}
        style={{ marginTop: 8 }}
      >
        {expanded ? "Hide reasoning" : "Show reasoning"}
      </button>
      {expanded && (
        <>
          <div className="diary-entry-reasoning">{entry.reasoning}</div>
          {formatContext(entry.context) && (
            <pre className="diary-entry-context">{formatContext(entry.context)}</pre>
          )}
        </>
      )}
    </div>
  );
}
