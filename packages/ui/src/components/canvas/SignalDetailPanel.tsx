import { useCanvas } from "../../context/CanvasContext.js";
import type { ContextSignal } from "../../api.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  signal: ContextSignal;
  title: string;
}

/**
 * Severity configuration for visual treatment.
 * Maps severity levels to CSS color tokens and display labels.
 */
const SEVERITY_CONFIG: Record<string, { color: string; bg: string; border: string; label: string }> = {
  critical: {
    color: "var(--status-failed)",
    bg: "var(--status-failed-bg)",
    border: "color-mix(in srgb, var(--status-failed) 30%, transparent)",
    label: "CRITICAL",
  },
  warning: {
    color: "var(--status-warning)",
    bg: "color-mix(in srgb, var(--status-warning) 10%, transparent)",
    border: "color-mix(in srgb, var(--status-warning) 30%, transparent)",
    label: "WARNING",
  },
  info: {
    color: "var(--status-running)",
    bg: "var(--status-running-bg)",
    border: "color-mix(in srgb, var(--accent) 30%, transparent)",
    label: "INFO",
  },
};

/**
 * Generates actionable resolution steps based on signal type and detail.
 * Each signal type has a static template enriched with context data
 * extracted from the signal's detail and relatedEntity fields.
 */
function getResolutionSteps(signal: ContextSignal): string[] {
  const entityName = signal.relatedEntity?.name ?? "the affected resource";
  const entityType = signal.relatedEntity?.type ?? "entity";

  switch (signal.type) {
    case "trend": {
      // Extract failure count from titles like "3 failed deployments in last 24h"
      const failureMatch = signal.title.match(/(\d+)\s+failed/i);
      const failureCount = failureMatch ? failureMatch[1] : "multiple";
      // Extract rate from details like "67% failure rate across 3 recent deployments"
      const rateMatch = signal.detail.match(/(\d+)%\s+failure/i);
      const rate = rateMatch ? rateMatch[1] + "%" : null;

      const steps = [
        `Review the last ${failureCount} deployment logs for common failure patterns`,
        "Check if a recent code or configuration change correlates with the failure onset",
        "Verify that deployment targets (environments, envoys) are reachable and healthy",
      ];
      if (rate && parseInt(rateMatch![1]) > 50) {
        steps.push("Consider pausing deployments until the root cause is identified — failure rate exceeds 50%");
      }
      steps.push("If failures are environment-specific, navigate to the environment detail panel for infrastructure diagnostics");
      return steps;
    }

    case "health": {
      // Extract consecutive failure count from titles like "staging: 3 consecutive failures"
      const consecMatch = signal.title.match(/(\d+)\s+consecutive/i);
      const consecutiveCount = consecMatch ? consecMatch[1] : null;

      const steps = [
        `Check that ${entityName} (${entityType}) is reachable and its host process is running`,
        "Review the latest deployment logs for this environment in the Debrief panel",
      ];
      if (consecutiveCount) {
        steps.push(
          `${consecutiveCount} consecutive failures indicate a persistent issue — check infrastructure (network, disk, permissions) before retrying`,
        );
      }
      if (signal.detail.toLowerCase().includes("fail")) {
        steps.push("Inspect the failure reason in the deployment detail to determine if this is a code issue or an infrastructure issue");
      }
      steps.push(`Navigate to the ${entityName} detail panel for full deployment history and variable inspection`);
      return steps;
    }

    case "drift": {
      // Extract variable names from details like "2 variables may conflict: DB_HOST, API_URL"
      const varMatch = signal.detail.match(/:\s*(.+)$/);
      const variables = varMatch ? varMatch[1] : "the listed variables";
      // Extract environment pair from title like "Config drift: prod-partition / staging"
      const pairMatch = signal.title.match(/Config drift:\s*(.+)\s*\/\s*(.+)/i);
      const partitionName = pairMatch ? pairMatch[1].trim() : entityName;
      const envName = pairMatch ? pairMatch[2].trim() : "the target environment";

      return [
        `Review the following variables for environment-inappropriate values: ${variables}`,
        `Open the ${partitionName} partition detail and verify each variable matches what ${envName} expects`,
        "If the variable values reference the wrong environment (e.g., staging URLs in a production partition), update them before the next deployment",
        "Redeploy after correcting variables to confirm the drift is resolved",
      ];
    }

    default:
      return [
        "Review the signal detail above for diagnostic information",
        `Navigate to ${entityName} for deeper investigation`,
      ];
  }
}

/**
 * Returns a human-readable label for the signal type.
 */
function signalTypeLabel(type: string): string {
  switch (type) {
    case "trend": return "Deployment Trend";
    case "health": return "Environment Health";
    case "drift": return "Configuration Drift";
    default: return type;
  }
}

export default function SignalDetailPanel({ signal, title }: Props) {
  const { pushPanel } = useCanvas();
  const severity = SEVERITY_CONFIG[signal.severity] ?? SEVERITY_CONFIG.info;
  const resolutionSteps = getResolutionSteps(signal);

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {/* Warning header — severity, type, and title */}
        <div
          className="signal-detail-header"
          style={{
            borderColor: severity.border,
            background: severity.bg,
          }}
        >
          <div className="signal-detail-severity-row">
            <span
              className="signal-detail-severity-badge"
              style={{ color: severity.color, borderColor: severity.border }}
            >
              {severity.label}
            </span>
            <span className="signal-detail-type-badge">{signalTypeLabel(signal.type)}</span>
          </div>
          <h2 className="signal-detail-title">{signal.title}</h2>
        </div>

        {/* Contextual data — affected entity, detail, metrics */}
        <div className="signal-detail-section">
          <h3 className="canvas-section-title">Signal Detail</h3>
          <div className="signal-detail-context">
            {signal.relatedEntity && (
              <div className="signal-detail-context-row">
                <span className="signal-detail-context-label">Affected {signal.relatedEntity.type}</span>
                <span className="signal-detail-context-value">{signal.relatedEntity.name}</span>
              </div>
            )}
            <div className="signal-detail-context-row">
              <span className="signal-detail-context-label">Signal type</span>
              <span className="signal-detail-context-value">{signalTypeLabel(signal.type)}</span>
            </div>
            <div className="signal-detail-context-row">
              <span className="signal-detail-context-label">Detail</span>
              <span className="signal-detail-context-value">{signal.detail}</span>
            </div>
          </div>
        </div>

        {/* Resolution guidance — actionable steps */}
        <div className="signal-detail-section">
          <h3 className="canvas-section-title">Resolution Guidance</h3>
          <ol className="signal-detail-steps">
            {resolutionSteps.map((step, i) => (
              <li key={i} className="signal-detail-step">
                {step}
              </li>
            ))}
          </ol>
        </div>

        {/* Navigation link — to related entity */}
        {signal.relatedEntity && (
          <div className="signal-detail-section">
            <h3 className="canvas-section-title">Investigate Further</h3>
            <button
              className="canvas-entity-link"
              onClick={() => pushPanel({
                type: `${signal.relatedEntity!.type === "environment" ? "environment" : "partition"}-detail`,
                title: signal.relatedEntity!.name,
                params: { id: signal.relatedEntity!.id },
              })}
            >
              Open {signal.relatedEntity.type} detail: {signal.relatedEntity.name}
            </button>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
