import type { DebriefEntry } from "./types.js";

/**
 * Format a debrief entry for human reading.
 *
 * Produces output specific enough that an engineer at 2am can read it
 * and know exactly what happened without further investigation.
 */
export function formatDebriefEntry(entry: DebriefEntry): string {
  const ts = entry.timestamp.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  const type = entry.decisionType.toUpperCase();
  const tenant = entry.tenantId ?? "system";
  const deployment = entry.deploymentId ? entry.deploymentId.slice(0, 8) : "n/a";

  const lines = [
    `[${ts}] ${type}`,
    `  Tenant: ${tenant} | Deployment: ${deployment} | Agent: ${entry.agent}`,
    `  Decision: ${entry.decision}`,
    `  Reasoning: ${entry.reasoning}`,
  ];

  const contextKeys = Object.keys(entry.context);
  if (contextKeys.length > 0) {
    const pairs = contextKeys
      .map((k) => {
        const v = entry.context[k];
        if (typeof v === "object" && v !== null) return `${k}=${JSON.stringify(v)}`;
        return `${k}=${v}`;
      })
      .join(", ");
    lines.push(`  Context: ${pairs}`);
  }

  return lines.join("\n");
}

/**
 * Format multiple debrief entries with visual separators.
 */
export function formatDebriefEntries(entries: DebriefEntry[]): string {
  if (entries.length === 0) return "No debrief entries found.";
  return entries.map(formatDebriefEntry).join("\n---\n");
}
