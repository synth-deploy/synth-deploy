import { useCanvas } from "../../context/CanvasContext.js";
import type { ContextSignal } from "../../api.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  signal: ContextSignal;
  title: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--status-failed)",
  warning: "var(--status-warning)",
  info: "var(--status-running)",
};

function getResolutionSteps(signal: ContextSignal): string[] {
  const entityName = signal.relatedEntity?.name ?? "the affected resource";

  switch (signal.type) {
    case "trend": {
      const failureMatch = signal.title.match(/(\d+)\s+failed/i);
      const failureCount = failureMatch ? failureMatch[1] : "multiple";
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
      const consecMatch = signal.title.match(/(\d+)\s+consecutive/i);
      const consecutiveCount = consecMatch ? consecMatch[1] : null;
      const steps = [
        `Check that ${entityName} is reachable and its host process is running`,
        "Review the latest deployment logs for this environment in the Debrief panel",
      ];
      if (consecutiveCount) {
        steps.push(
          `${consecutiveCount} consecutive failures indicate a persistent issue — check infrastructure (network, disk, permissions) before retrying`,
        );
      }
      steps.push(`Navigate to the ${entityName} detail panel for full deployment history and variable inspection`);
      return steps;
    }

    case "drift": {
      const varMatch = signal.detail.match(/:\s*(.+)$/);
      const variables = varMatch ? varMatch[1] : "the listed variables";
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
  const color = SEVERITY_COLOR[signal.severity] ?? SEVERITY_COLOR.info;
  const resolutionSteps = getResolutionSteps(signal);

  return (
    <CanvasPanelHost title={title}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: "20px 24px", maxWidth: 680 }}>

        {/* Severity banner */}
        <div style={{
          padding: "16px 20px",
          borderRadius: 10,
          border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
          background: `color-mix(in srgb, ${color} 8%, var(--surface))`,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.8px",
              textTransform: "uppercase",
              color,
              fontFamily: "var(--font-mono)",
              padding: "2px 8px",
              borderRadius: 4,
              border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
            }}>
              {signal.severity}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{signalTypeLabel(signal.type)}</span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", lineHeight: 1.3 }}>
            {signal.title}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {signal.detail}
          </div>
        </div>

        {/* Context rows */}
        {signal.relatedEntity && (
          <div>
            <div className="v6-section-label" style={{ marginBottom: 8 }}>Affected Resource</div>
            <div style={{ borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", background: "var(--surface)" }}>
              <div style={{ display: "flex", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                <span style={{ color: "var(--text-muted)", minWidth: 120, flexShrink: 0, textTransform: "capitalize" }}>
                  {signal.relatedEntity.type}
                </span>
                <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)" }}>
                  {signal.relatedEntity.name}
                </span>
              </div>
              <div style={{ display: "flex", gap: 12, padding: "10px 14px", fontSize: 13 }}>
                <span style={{ color: "var(--text-muted)", minWidth: 120, flexShrink: 0 }}>Signal type</span>
                <span style={{ color: "var(--text)" }}>{signalTypeLabel(signal.type)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Resolution steps */}
        <div>
          <div className="v6-section-label" style={{ marginBottom: 8 }}>Resolution Guidance</div>
          <div style={{ borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden", background: "var(--surface)" }}>
            {resolutionSteps.map((step, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 14,
                  padding: "12px 16px",
                  borderBottom: i < resolutionSteps.length - 1 ? "1px solid var(--border)" : "none",
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: "var(--text)",
                  alignItems: "flex-start",
                }}
              >
                <span style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "var(--accent-dim)",
                  color: "var(--accent)",
                  fontSize: 11,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginTop: 1,
                }}>
                  {i + 1}
                </span>
                {step}
              </div>
            ))}
          </div>
        </div>

        {/* Investigate further */}
        {signal.relatedEntity && (
          <div>
            <div className="v6-section-label" style={{ marginBottom: 8 }}>Investigate Further</div>
            <button
              className="btn btn-secondary"
              style={{ fontSize: 13, padding: "8px 16px" }}
              onClick={() => pushPanel({
                type: `${signal.relatedEntity!.type === "environment" ? "environment" : "partition"}-detail`,
                title: signal.relatedEntity!.name,
                params: { id: signal.relatedEntity!.id },
              })}
            >
              Open {signal.relatedEntity.type} detail: {signal.relatedEntity.name} →
            </button>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
