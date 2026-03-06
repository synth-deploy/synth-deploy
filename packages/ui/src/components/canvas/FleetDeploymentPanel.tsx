import { useState } from "react";
import {
  getFleetDeployment,
  approveFleetDeployment,
  executeFleetDeployment,
  pauseFleetDeployment,
  resumeFleetDeployment,
} from "../../api.js";
import type { FleetDeployment, FleetDeploymentStatus } from "../../api.js";
import { useQuery } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import SectionHeader from "../SectionHeader.js";

interface Props {
  fleetDeploymentId: string;
  title: string;
}

// ---------------------------------------------------------------------------
// Status colors and labels
// ---------------------------------------------------------------------------

const statusConfig: Record<FleetDeploymentStatus, { color: string; label: string }> = {
  selecting_representatives: { color: "#8b5cf6", label: "Selecting Representatives" },
  planning: { color: "#6366f1", label: "Planning" },
  awaiting_approval: { color: "#f59e0b", label: "Awaiting Approval" },
  validating: { color: "#06b6d4", label: "Validating" },
  validated: { color: "#10b981", label: "Validated" },
  executing: { color: "#3b82f6", label: "Executing" },
  paused: { color: "#ca8a04", label: "Paused" },
  completed: { color: "#16a34a", label: "Completed" },
  failed: { color: "#dc2626", label: "Failed" },
  rolled_back: { color: "#dc2626", label: "Rolled Back" },
};

const strategyLabels: Record<string, string> = {
  "all-at-once": "All at Once",
  batched: "Batched",
  canary: "Canary",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FleetDeploymentPanel({ fleetDeploymentId, title }: Props) {
  const { data: fleet, loading, error, refresh } = useQuery<FleetDeployment>(
    `fleetDeployment:${fleetDeploymentId}`,
    () => getFleetDeployment(fleetDeploymentId),
    { refetchInterval: 3000 },
  );
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleAction = async (action: () => Promise<FleetDeployment>) => {
    setActionLoading(true);
    setActionError(null);
    try {
      await action();
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading fleet deployment...</div>
      </CanvasPanelHost>
    );
  }

  if (error && !fleet) {
    return (
      <CanvasPanelHost title={title}>
        <div style={{ color: "#dc2626", padding: 16 }}>{error.message}</div>
      </CanvasPanelHost>
    );
  }

  if (!fleet) return null;

  const status = statusConfig[fleet.status] ?? { color: "#6b7280", label: fleet.status };
  const progress = fleet.progress;
  const progressPercent = progress.totalEnvoys > 0
    ? Math.round(((progress.succeeded + progress.failed) / progress.totalEnvoys) * 100)
    : 0;

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {/* Status header */}
        <SectionHeader
          color={status.color}
          shape="diamond"
          label="Fleet Deployment"
          subtitle={`${progress.totalEnvoys} envoys`}
        />

        {/* Status badge and ID */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: status.color,
              border: `1px solid ${status.color}30`,
              background: `${status.color}15`,
              borderRadius: 12,
              padding: "3px 12px",
            }}
          >
            {status.label}
          </span>
          <span style={{ fontSize: 11, color: "#888", fontFamily: "monospace" }}>
            {fleet.id.slice(0, 8)}
          </span>
        </div>

        {/* Progress bar */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12, color: "#aaa" }}>
            <span>Progress</span>
            <span>{progressPercent}%</span>
          </div>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: "rgba(255,255,255,0.06)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                borderRadius: 4,
                width: `${progressPercent}%`,
                background: progress.failed > 0
                  ? "linear-gradient(90deg, #16a34a, #dc2626)"
                  : "#16a34a",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 6, fontSize: 11, color: "#888" }}>
            <span>{progress.succeeded} succeeded</span>
            <span>{progress.failed} failed</span>
            <span>{progress.pending} pending</span>
            {progress.executing > 0 && <span>{progress.executing} executing</span>}
          </div>
        </div>

        {/* Batch progress indicator */}
        {progress.totalBatches != null && progress.totalBatches > 1 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#aaa", marginBottom: 6 }}>
              Batch {(progress.currentBatch ?? 0) + 1} of {progress.totalBatches}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {Array.from({ length: progress.totalBatches }, (_, i) => {
                const isCurrent = i === (progress.currentBatch ?? 0);
                const isPast = i < (progress.currentBatch ?? 0);
                return (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      height: 4,
                      borderRadius: 2,
                      background: isPast
                        ? "#16a34a"
                        : isCurrent
                          ? "#3b82f6"
                          : "rgba(255,255,255,0.08)",
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Rollout config display */}
        <div
          style={{
            background: "rgba(99,102,241,0.04)",
            border: "1px solid rgba(99,102,241,0.15)",
            borderRadius: 8,
            padding: "12px 16px",
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: "#aaa", marginBottom: 8 }}>
            Rollout Configuration
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", fontSize: 12 }}>
            <div>
              <span style={{ color: "#888" }}>Strategy: </span>
              <span style={{ color: "#e5e5e5" }}>
                {strategyLabels[fleet.rolloutConfig.strategy] ?? fleet.rolloutConfig.strategy}
              </span>
            </div>
            {fleet.rolloutConfig.batchSize != null && (
              <div>
                <span style={{ color: "#888" }}>Batch Size: </span>
                <span style={{ color: "#e5e5e5" }}>{fleet.rolloutConfig.batchSize}</span>
              </div>
            )}
            {fleet.rolloutConfig.batchPercent != null && (
              <div>
                <span style={{ color: "#888" }}>Batch %: </span>
                <span style={{ color: "#e5e5e5" }}>{fleet.rolloutConfig.batchPercent}%</span>
              </div>
            )}
            <div>
              <span style={{ color: "#888" }}>Halt on: </span>
              <span style={{ color: "#e5e5e5" }}>{fleet.rolloutConfig.haltOnFailureCount} failure(s)</span>
            </div>
            <div>
              <span style={{ color: "#888" }}>Health wait: </span>
              <span style={{ color: "#e5e5e5" }}>{fleet.rolloutConfig.healthCheckWaitMs}ms</span>
            </div>
            <div>
              <span style={{ color: "#888" }}>Pause between: </span>
              <span style={{ color: "#e5e5e5" }}>{fleet.rolloutConfig.pauseBetweenBatches ? "Yes" : "No"}</span>
            </div>
          </div>
        </div>

        {/* Per-envoy status table */}
        {fleet.validationResult && fleet.validationResult.results.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#aaa", marginBottom: 8 }}>
              Envoy Status ({fleet.validationResult.validated}/{fleet.validationResult.total} validated)
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {fleet.validationResult.results.map((result) => (
                <div
                  key={result.envoyId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    background: result.validated
                      ? "rgba(16,185,129,0.04)"
                      : "rgba(220,38,38,0.04)",
                    border: `1px solid ${result.validated ? "rgba(16,185,129,0.15)" : "rgba(220,38,38,0.15)"}`,
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: result.validated ? "#16a34a" : "#dc2626",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, color: "#e5e5e5" }}>{result.envoyName}</span>
                    <span style={{ color: "#888", marginLeft: 6, fontFamily: "monospace", fontSize: 10 }}>
                      {result.envoyId.slice(0, 8)}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: result.validated ? "#16a34a" : "#dc2626",
                      padding: "2px 8px",
                      border: `1px solid ${result.validated ? "#16a34a" : "#dc2626"}30`,
                      borderRadius: 10,
                    }}
                  >
                    {result.validated ? "Validated" : "Failed"}
                  </span>
                  {result.issues && result.issues.length > 0 && (
                    <div style={{ width: "100%", marginTop: 4, paddingLeft: 18, color: "#f87171", fontSize: 11 }}>
                      {result.issues.map((issue, i) => (
                        <div key={i}>{issue}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {(fleet.status === "selecting_representatives" || fleet.status === "awaiting_approval") && (
            <button
              className="v2-btn v2-btn-primary"
              disabled={actionLoading}
              onClick={() => handleAction(() => approveFleetDeployment(fleet.id))}
              style={{
                background: "#6366f1",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer",
                opacity: actionLoading ? 0.6 : 1,
              }}
            >
              {actionLoading ? "Approving..." : "Approve & Validate"}
            </button>
          )}

          {(fleet.status === "validated" || fleet.status === "paused") && (
            <button
              className="v2-btn v2-btn-primary"
              disabled={actionLoading}
              onClick={() => handleAction(() => executeFleetDeployment(fleet.id))}
              style={{
                background: "#16a34a",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer",
                opacity: actionLoading ? 0.6 : 1,
              }}
            >
              {actionLoading ? "Starting..." : fleet.status === "paused" ? "Resume Rollout" : "Execute Rollout"}
            </button>
          )}

          {fleet.status === "executing" && (
            <button
              className="v2-btn"
              disabled={actionLoading}
              onClick={() => handleAction(() => pauseFleetDeployment(fleet.id))}
              style={{
                background: "transparent",
                color: "#ca8a04",
                border: "1px solid #ca8a04",
                borderRadius: 6,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 600,
                cursor: actionLoading ? "not-allowed" : "pointer",
                opacity: actionLoading ? 0.6 : 1,
              }}
            >
              {actionLoading ? "Pausing..." : "Pause Rollout"}
            </button>
          )}
        </div>

        {/* Error display */}
        {actionError && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 12px",
              background: "rgba(220,38,38,0.08)",
              border: "1px solid rgba(220,38,38,0.2)",
              borderRadius: 6,
              color: "#f87171",
              fontSize: 12,
            }}
          >
            {actionError}
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
