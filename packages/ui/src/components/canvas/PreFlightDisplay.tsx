import { useState, useEffect } from "react";
import { getPreFlightContext } from "../../api.js";
import type { PreFlightContext } from "../../api.js";

interface Props {
  artifactId: string;
  environmentId: string;
  partitionId?: string;
  version?: string;
  onLoaded?: (recommendation: PreFlightContext["recommendation"]) => void;
}

const SEVERITY_COLORS = {
  proceed: { bg: "rgba(46, 160, 67, 0.12)", border: "#2ea043", text: "#3fb950" },
  wait: { bg: "rgba(210, 153, 34, 0.12)", border: "#d29922", text: "#e3b341" },
  investigate: { bg: "rgba(218, 54, 51, 0.12)", border: "#da3633", text: "#f85149" },
} as const;

const STATUS_COLORS = {
  healthy: { bg: "rgba(46, 160, 67, 0.12)", text: "#3fb950", label: "Healthy" },
  degraded: { bg: "rgba(210, 153, 34, 0.12)", text: "#e3b341", label: "Degraded" },
  unreachable: { bg: "rgba(218, 54, 51, 0.12)", text: "#f85149", label: "Unreachable" },
} as const;

export default function PreFlightDisplay({ artifactId, environmentId, partitionId, version, onLoaded }: Props) {
  const [context, setContext] = useState<PreFlightContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContext(null);

    getPreFlightContext({
      artifactId,
      environmentId,
      partitionId: partitionId || undefined,
      version: version || undefined,
    })
      .then((ctx) => {
        setContext(ctx);
        setLoading(false);
        onLoaded?.(ctx.recommendation);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
  }, [artifactId, environmentId, partitionId, version]);

  if (loading) {
    return (
      <div style={{ padding: "12px 0", fontSize: 13, color: "var(--agent-text-muted)" }}>
        Analyzing deployment context...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "12px 0", fontSize: 13, color: "var(--agent-text-muted)" }}>
        Pre-flight check unavailable: {error}
      </div>
    );
  }

  if (!context) return null;

  const recAction = context.recommendation.action;
  const colors = SEVERITY_COLORS[recAction];
  const healthColors = STATUS_COLORS[context.targetHealth.status];

  return (
    <div
      style={{
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        padding: 16,
        marginBottom: 16,
        background: colors.bg,
      }}
    >
      {/* Recommendation — prominent */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, marginBottom: 4 }}>
          {recAction === "proceed" && "Proceed"}
          {recAction === "wait" && "Wait"}
          {recAction === "investigate" && "Investigate First"}
          {context.recommendation.confidence > 0 && (
            <span style={{ fontSize: 11, fontWeight: 400, marginLeft: 8, opacity: 0.7 }}>
              {Math.round(context.recommendation.confidence * 100)}% confidence
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: "var(--agent-text-primary)", lineHeight: 1.4 }}>
          {context.recommendation.reasoning}
        </div>
        {!context.llmAvailable && (
          <div style={{ fontSize: 11, color: "var(--agent-text-muted)", marginTop: 4, fontStyle: "italic" }}>
            Agent recommendation unavailable — showing deterministic analysis only
          </div>
        )}
      </div>

      {/* Summary cards row */}
      <div style={{ display: "flex", gap: 8, marginBottom: expanded ? 12 : 0 }}>
        {/* Target health */}
        <div
          style={{
            flex: 1,
            padding: "8px 10px",
            borderRadius: 6,
            background: healthColors.bg,
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, color: healthColors.text, marginBottom: 2 }}>
            {healthColors.label}
          </div>
          <div style={{ color: "var(--agent-text-muted)", fontSize: 11 }}>
            Target Envoy
          </div>
        </div>

        {/* Recent history */}
        <div
          style={{
            flex: 1,
            padding: "8px 10px",
            borderRadius: 6,
            background: context.recentHistory.recentFailures > 0
              ? "rgba(218, 54, 51, 0.08)"
              : "rgba(255,255,255,0.04)",
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, color: "var(--agent-text-primary)", marginBottom: 2 }}>
            {context.recentHistory.deploymentsToday} today
            {context.recentHistory.recentFailures > 0 && (
              <span style={{ color: "#f85149", marginLeft: 6 }}>
                {context.recentHistory.recentFailures} failed (7d)
              </span>
            )}
          </div>
          <div style={{ color: "var(--agent-text-muted)", fontSize: 11 }}>
            Deployments
          </div>
        </div>

        {/* Cross-system signals */}
        {context.crossSystemContext.length > 0 && (
          <div
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(210, 153, 34, 0.08)",
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 600, color: "#e3b341", marginBottom: 2 }}>
              {context.crossSystemContext.length} signal{context.crossSystemContext.length !== 1 ? "s" : ""}
            </div>
            <div style={{ color: "var(--agent-text-muted)", fontSize: 11 }}>
              Cross-system
            </div>
          </div>
        )}
      </div>

      {/* Expand/collapse detail */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: "none",
          border: "none",
          color: "var(--agent-text-muted)",
          cursor: "pointer",
          fontSize: 11,
          padding: "4px 0",
          marginTop: 8,
        }}
      >
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--agent-text-secondary)" }}>
          {/* Target health detail */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Target Health</div>
            <div>{context.targetHealth.details}</div>
          </div>

          {/* Last deployment */}
          {context.recentHistory.lastDeployment && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Last Deployment to Environment</div>
              <div>
                Version {context.recentHistory.lastDeployment.version} &mdash;{" "}
                {context.recentHistory.lastDeployment.status}
                {" "}({new Date(context.recentHistory.lastDeployment.completedAt).toLocaleString()})
              </div>
            </div>
          )}

          {/* Cross-system context */}
          {context.crossSystemContext.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Cross-System Observations</div>
              <ul style={{ margin: "4px 0", paddingLeft: 16 }}>
                {context.crossSystemContext.map((obs, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>{obs}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
