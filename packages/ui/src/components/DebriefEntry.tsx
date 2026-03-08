import { useState } from "react";
import type { DebriefEntry } from "../types.js";

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
  "llm-call": "dt-system",
  "artifact-analysis": "dt-diagnostic",
  "plan-generation": "dt-plan",
  "plan-approval": "dt-completion",
  "plan-rejection": "dt-failure",
  "rollback-execution": "dt-failure",
  "cross-system-context": "dt-scan",
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
  "llm-call": "LLM",
  "artifact-analysis": "Analysis",
  "plan-generation": "Plan Gen",
  "plan-approval": "Approved",
  "plan-rejection": "Rejected",
  "rollback-execution": "Rollback",
  "cross-system-context": "Cross-System",
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

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toLowerCase());
}

function humanizeValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return value.toLocaleString();
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    return value.map(String).join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${humanizeKey(k)}: ${humanizeValue(v)}`)
      .join("; ");
  }
  return String(value);
}

function formatContext(ctx: Record<string, unknown>): string {
  const entries = Object.entries(ctx).filter(([k]) => !k.startsWith("_"));
  if (entries.length === 0) return "";

  return entries
    .map(([key, value]) => `${humanizeKey(key)}: ${humanizeValue(value)}`)
    .join("\n");
}

export default function DebriefEntryCard({ entry }: { entry: DebriefEntry }) {
  const [expanded, setExpanded] = useState(false);
  const dtClass = dtClassMap[entry.decisionType] ?? "";
  const dtLabel = dtLabels[entry.decisionType] ?? entry.decisionType;

  return (
    <div className={`debrief-entry ${dtClass}`}>
      <div className="debrief-entry-header">
        <span className="debrief-entry-time">{formatTs(entry.timestamp)}</span>
        <span className={`dt-badge`} style={{ color: `var(--${dtClass})`, background: `color-mix(in srgb, var(--${dtClass}) 12%, transparent)` }}>
          {dtLabel}
        </span>
        <span className={`agent-badge agent-badge-${entry.agent === "command" ? "server" : entry.agent}`}>
          {entry.agent === "command" ? "server" : entry.agent}
        </span>
        {entry.actor && (
          <span className="debrief-entry-actor text-muted" style={{ fontSize: 11 }}>
            Actor: {entry.actor}
          </span>
        )}
        {entry.deploymentId && (
          <span className="debrief-entry-deploy-link mono" style={{ fontSize: 11 }}>
            {entry.deploymentId.slice(0, 8)}
          </span>
        )}
        {entry.partitionId && (
          <span className="debrief-entry-partition text-muted" style={{ fontSize: 11, marginLeft: "auto" }}>
            partition: {entry.partitionId.slice(0, 8)}
          </span>
        )}
      </div>
      <div className="debrief-entry-decision">{entry.decision}</div>
      <button
        className="btn btn-sm mt-16"
        onClick={() => setExpanded(!expanded)}
        style={{ marginTop: 8 }}
      >
        {expanded ? "Hide reasoning" : "Show reasoning"}
      </button>
      {expanded && (
        <>
          <div className="debrief-entry-reasoning">{entry.reasoning}</div>
          {formatContext(entry.context) && (
            <div className="debrief-entry-context" style={{ whiteSpace: "pre-line", fontSize: 12, lineHeight: 1.5, color: "var(--text-secondary)", marginTop: 8, padding: "8px 12px", background: "var(--surface-alt)", borderRadius: 6 }}>
              {formatContext(entry.context)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
