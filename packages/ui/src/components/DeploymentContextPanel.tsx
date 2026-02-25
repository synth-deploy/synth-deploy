import { useState, useEffect } from "react";
import { getDeploymentContext } from "../api.js";
import type { DeploymentContext, ContextSignal } from "../api.js";

function severityIcon(severity: ContextSignal["severity"]): string {
  switch (severity) {
    case "critical": return "\u25CF"; // filled circle
    case "warning": return "\u25B2"; // triangle
    case "info": return "\u25CB"; // open circle
  }
}

function SignalCard({ signal }: { signal: ContextSignal }) {
  return (
    <div className={`signal-card signal-${signal.severity}`}>
      <div className="signal-header">
        <span className={`signal-icon signal-icon-${signal.severity}`}>
          {severityIcon(signal.severity)}
        </span>
        <span className="signal-type-badge">{signal.type}</span>
        <span className="signal-title">{signal.title}</span>
      </div>
      <div className="signal-detail">{signal.detail}</div>
    </div>
  );
}

export default function DeploymentContextPanel() {
  const [context, setContext] = useState<DeploymentContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    getDeploymentContext()
      .then(setContext)
      .catch((e) => setFetchError(e.message ?? "Failed to load deployment context"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="context-panel"><div className="loading">Loading context...</div></div>;
  }

  if (fetchError) {
    return (
      <div className="context-panel">
        <div className="text-secondary" style={{ padding: 12, fontSize: 13 }}>
          Context unavailable: {fetchError}
        </div>
      </div>
    );
  }

  if (!context) return null;

  const { signals, recentActivity, environmentSummary } = context;

  return (
    <div className="context-panel">
      {/* Recent activity strip */}
      <div className="context-activity-strip">
        <div className="context-activity-item">
          <span className="context-activity-label">24h</span>
          <span className="context-activity-value">{recentActivity.deploymentsLast24h}</span>
        </div>
        <div className="context-activity-item">
          <span className="context-activity-label">Success</span>
          <span className="context-activity-value">{recentActivity.successRate}</span>
        </div>
        {recentActivity.lastDeployment && (
          <div className="context-activity-item">
            <span className="context-activity-label">Last</span>
            <span className="context-activity-value">
              v{recentActivity.lastDeployment.version} {recentActivity.lastDeployment.ago}
            </span>
          </div>
        )}
      </div>

      {/* Signals */}
      {signals.length > 0 && (
        <div className="context-signals">
          {signals.map((signal, i) => (
            <SignalCard key={i} signal={signal} />
          ))}
        </div>
      )}

      {/* Environment summary */}
      <div className="context-env-grid">
        {environmentSummary.map((env) => (
          <div key={env.id} className="context-env-card">
            <div className="context-env-name">{env.name}</div>
            <div className="context-env-stats">
              <span className={`context-env-status ${env.lastDeployStatus ? `status-${env.lastDeployStatus}` : ""}`}>
                {env.lastDeployStatus ?? "no deploys"}
              </span>
              <span className="context-env-count">{env.deployCount} deploys</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
