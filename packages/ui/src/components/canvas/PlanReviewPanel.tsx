import { useState, useEffect } from "react";
import {
  getDeployment,
  getDeploymentEnrichment,
  approveDeployment,
  rejectDeployment,
  modifyDeploymentPlan,
  listEnvironments,
  listArtifacts,
  listPartitions,
} from "../../api.js";
import type {
  Deployment,
  DeploymentEnrichment,
  DeploymentRecommendation,
  PlannedStep,
  DebriefEntry,
  Environment,
  Artifact,
  Partition,
} from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  deploymentId: string;
  title: string;
}

type ReviewMode = "review" | "modify" | "reject-prompt";

export default function PlanReviewPanel({ deploymentId, title }: Props) {
  const { replacePanel } = useCanvas();

  const { data: result, loading: l1 } = useQuery(`deployment:${deploymentId}`, () => getDeployment(deploymentId));
  const { data: enrichCtx, loading: l2 } = useQuery(`deploymentEnrichment:${deploymentId}`, () => getDeploymentEnrichment(deploymentId).catch(() => ({ enrichment: null }) as { enrichment: null; recommendation?: DeploymentRecommendation }));
  const { data: environments, loading: l3 } = useQuery("list:environments", () => listEnvironments());
  const { data: artifacts, loading: l4 } = useQuery("list:artifacts", () => listArtifacts());
  const { data: partitions, loading: l5 } = useQuery("list:partitions", () => listPartitions());
  const loading = l1 || l2 || l3 || l4 || l5;

  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const debrief = result?.debrief ?? [];
  const enrichment = enrichCtx?.enrichment ?? null;
  const recommendation = enrichCtx?.recommendation ?? result?.deployment?.recommendation ?? null;

  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Review mode state
  const [mode, setMode] = useState<ReviewMode>("review");
  const [rejectReason, setRejectReason] = useState("");
  const [modifiedSteps, setModifiedSteps] = useState<PlannedStep[]>([]);
  const [modifyReason, setModifyReason] = useState("");

  // Sync deployment from query result and initialize modifiedSteps
  useEffect(() => {
    if (result?.deployment) {
      setDeployment(result.deployment);
      if (result.deployment.plan) {
        setModifiedSteps(result.deployment.plan.steps.map((s) => ({ ...s })));
      }
    }
  }, [result]);

  if (loading) {
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading plan review...</div>
      </CanvasPanelHost>
    );
  }

  if (!deployment) {
    return (
      <CanvasPanelHost title={title}>
        <div className="error-msg">Deployment not found</div>
      </CanvasPanelHost>
    );
  }

  if (deployment.status !== "awaiting_approval") {
    return (
      <CanvasPanelHost title={title}>
        <div className="error-msg">
          This deployment is in &ldquo;{deployment.status}&rdquo; status and is not awaiting approval.
        </div>
      </CanvasPanelHost>
    );
  }

  const envName = (environments ?? []).find((e) => e.id === deployment.environmentId)?.name ?? deployment.environmentId;
  const artName = (artifacts ?? []).find((a) => a.id === deployment.artifactId)?.name ?? deployment.artifactId.slice(0, 8);
  const partName = deployment.partitionId
    ? ((partitions ?? []).find((p) => p.id === deployment.partitionId)?.name ?? deployment.partitionId.slice(0, 8))
    : null;

  const plan = deployment.plan;

  async function handleGreenlight() {
    setActionLoading(true);
    setError(null);
    try {
      const result = await approveDeployment(deploymentId, { approvedBy: "user" });
      replacePanel({
        type: "deployment-detail",
        title: `Deployment ${result.deployment.id.slice(0, 8)}`,
        params: { id: result.deployment.id },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to approve deployment");
      setActionLoading(false);
    }
  }

  async function handleReject() {
    if (!rejectReason.trim()) {
      setError("A rejection reason is required");
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      const result = await rejectDeployment(deploymentId, { reason: rejectReason.trim() });
      replacePanel({
        type: "deployment-detail",
        title: `Deployment ${result.deployment.id.slice(0, 8)}`,
        params: { id: result.deployment.id },
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to reject deployment");
      setActionLoading(false);
    }
  }

  async function handleSaveModifications() {
    if (!modifyReason.trim()) {
      setError("A reason for the modification is required");
      return;
    }
    if (modifiedSteps.length === 0) {
      setError("Plan must contain at least one step");
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      const result = await modifyDeploymentPlan(deploymentId, {
        steps: modifiedSteps,
        reason: modifyReason.trim(),
      });
      setDeployment(result.deployment);
      setMode("review");
      setActionLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to modify plan");
      setActionLoading(false);
    }
  }

  function updateStep(index: number, field: keyof PlannedStep, value: string | boolean) {
    setModifiedSteps((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function removeStep(index: number) {
    setModifiedSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function addStep() {
    setModifiedSteps((prev) => [
      ...prev,
      { description: "", action: "", target: "", reversible: true },
    ]);
  }

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {/* Header */}
        <div className="canvas-deploy-header">
          <span className="badge badge-awaiting_approval">awaiting approval</span>
          <span className="canvas-deploy-version">{deployment.version}</span>
        </div>

        <div className="canvas-deploy-meta">
          <span>Artifact: {artName}</span>
          {partName && <span>Partition: {partName}</span>}
          <span>Environment: {envName}</span>
          <span>Created: {new Date(deployment.createdAt).toLocaleString()}</span>
        </div>

        {/* Cross-system enrichment warnings */}
        {enrichment && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Cross-System Context</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {enrichment.previouslyRolledBack && (
                <div style={{
                  padding: "8px 12px",
                  background: "rgba(220, 38, 38, 0.12)",
                  border: "1px solid rgba(220, 38, 38, 0.3)",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "var(--status-failed)",
                }}>
                  Warning: This artifact version was previously rolled back
                </div>
              )}
              {enrichment.conflictingDeployments.length > 0 && (
                <div style={{
                  padding: "8px 12px",
                  background: "rgba(245, 158, 11, 0.12)",
                  border: "1px solid rgba(245, 158, 11, 0.3)",
                  borderRadius: 6,
                  fontSize: 13,
                  color: "var(--status-warning)",
                }}>
                  {enrichment.conflictingDeployments.length} other deployment(s) in progress for this environment
                </div>
              )}
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {enrichment.recentDeploymentsToEnv} deployment(s) to this environment in the last 24h
              </div>
              {enrichment.lastDeploymentToEnv && (
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                  Last deployment: v{enrichment.lastDeploymentToEnv.version} ({enrichment.lastDeploymentToEnv.status})
                </div>
              )}
            </div>
          </div>
        )}

        {/* Diffs */}
        {plan?.diffFromCurrent && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">What&apos;s Changing</h3>
            <pre style={{
              fontSize: 12,
              background: "var(--surface-alt)",
              padding: 12,
              borderRadius: 6,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              color: "var(--text-muted)",
            }}>
              {plan.diffFromCurrent}
            </pre>
          </div>
        )}

        {plan?.diffFromPreviousPlan && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Changes From Previous Plan</h3>
            <pre style={{
              fontSize: 12,
              background: "var(--surface-alt)",
              padding: 12,
              borderRadius: 6,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              color: "var(--status-warning)",
            }}>
              {plan.diffFromPreviousPlan}
            </pre>
          </div>
        )}

        {/* Plan reasoning */}
        {plan && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Reasoning</h3>
            <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {plan.reasoning}
            </div>
          </div>
        )}

        {/* Combined recommendation */}
        {recommendation && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Recommendation</h3>
            <div style={{
              padding: "10px 14px",
              background: recommendation.verdict === "proceed"
                ? "rgba(22, 163, 74, 0.12)"
                : recommendation.verdict === "caution"
                ? "rgba(245, 158, 11, 0.12)"
                : "rgba(220, 38, 38, 0.12)",
              border: `1px solid ${
                recommendation.verdict === "proceed"
                  ? "rgba(22, 163, 74, 0.3)"
                  : recommendation.verdict === "caution"
                  ? "rgba(245, 158, 11, 0.3)"
                  : "rgba(220, 38, 38, 0.3)"
              }`,
              borderRadius: 6,
            }}>
              <div style={{
                fontSize: 14,
                fontWeight: 600,
                color: recommendation.verdict === "proceed"
                  ? "var(--status-succeeded)"
                  : recommendation.verdict === "caution"
                  ? "var(--status-warning)"
                  : "var(--status-failed)",
                marginBottom: 4,
              }}>
                {recommendation.verdict === "proceed" ? "Proceed" : recommendation.verdict === "caution" ? "Proceed with Caution" : "Hold"}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 6 }}>
                {recommendation.summary}
              </div>
              {recommendation.factors.length > 0 && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--text-muted)" }}>
                  {recommendation.factors.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Plan steps — review mode */}
        {mode === "review" && plan && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Proposed Plan ({plan.steps.length} steps)</h3>
            <div className="canvas-timeline">
              {plan.steps.map((step, i) => (
                <div key={i} className="canvas-timeline-entry" style={{ cursor: "default" }}>
                  <div className="canvas-timeline-dot" style={{
                    background: step.reversible ? "var(--status-succeeded)" : "var(--status-warning)",
                  }} />
                  <div className="canvas-timeline-content">
                    <div className="canvas-timeline-header">
                      <span className="canvas-timeline-type">
                        {i + 1}. {step.action}
                      </span>
                      <span className="canvas-timeline-time">{step.target}</span>
                    </div>
                    <div className="canvas-timeline-decision">{step.description}</div>
                    {!step.reversible && (
                      <div style={{ fontSize: 11, color: "var(--status-warning)", marginTop: 2 }}>
                        Non-reversible
                      </div>
                    )}
                    {step.rollbackAction && (
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                        Rollback: {step.rollbackAction}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Rollback plan */}
        {mode === "review" && deployment.rollbackPlan && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Rollback Plan</h3>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
              {deployment.rollbackPlan.reasoning}
            </div>
            <div className="canvas-timeline">
              {deployment.rollbackPlan.steps.map((step, i) => (
                <div key={i} className="canvas-timeline-entry" style={{ cursor: "default" }}>
                  <div className="canvas-timeline-dot" style={{ background: "#6366f1" }} />
                  <div className="canvas-timeline-content">
                    <div className="canvas-timeline-header">
                      <span className="canvas-timeline-type">{step.action}</span>
                      <span className="canvas-timeline-time">{step.target}</span>
                    </div>
                    <div className="canvas-timeline-decision">{step.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Modify mode — inline step editor */}
        {mode === "modify" && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Edit Plan Steps</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {modifiedSteps.map((step, i) => (
                <div key={i} style={{
                  background: "var(--surface-alt)",
                  padding: 12,
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                      Step {i + 1}
                    </span>
                    <button
                      onClick={() => removeStep(i)}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "var(--status-failed)",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <input
                      value={step.action}
                      onChange={(e) => updateStep(i, "action", e.target.value)}
                      placeholder="Action"
                      className="v2-input"
                      style={{ fontSize: 12 }}
                    />
                    <input
                      value={step.target}
                      onChange={(e) => updateStep(i, "target", e.target.value)}
                      placeholder="Target"
                      className="v2-input"
                      style={{ fontSize: 12 }}
                    />
                  </div>
                  <input
                    value={step.description}
                    onChange={(e) => updateStep(i, "description", e.target.value)}
                    placeholder="Description"
                    className="v2-input"
                    style={{ fontSize: 12, marginTop: 8, width: "100%", boxSizing: "border-box" }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                    <label style={{ fontSize: 12, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={step.reversible}
                        onChange={(e) => updateStep(i, "reversible", e.target.checked)}
                      />
                      Reversible
                    </label>
                    {step.reversible && (
                      <input
                        value={step.rollbackAction ?? ""}
                        onChange={(e) => updateStep(i, "rollbackAction", e.target.value)}
                        placeholder="Rollback action"
                        className="v2-input"
                        style={{ fontSize: 12, flex: 1 }}
                      />
                    )}
                  </div>
                </div>
              ))}
              <button
                onClick={addStep}
                className="v2-btn v2-btn-secondary"
                style={{ alignSelf: "flex-start", fontSize: 12 }}
              >
                + Add Step
              </button>
              <div style={{ marginTop: 8 }}>
                <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                  Reason for modification
                </label>
                <textarea
                  value={modifyReason}
                  onChange={(e) => setModifyReason(e.target.value)}
                  placeholder="Why are you modifying this plan?"
                  className="v2-input"
                  rows={2}
                  style={{ fontSize: 12, width: "100%", boxSizing: "border-box", resize: "vertical" }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Reject prompt */}
        {mode === "reject-prompt" && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Reject Deployment</h3>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                Reason for rejection
              </label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Why is this plan being rejected?"
                className="v2-input"
                rows={3}
                style={{ fontSize: 12, width: "100%", boxSizing: "border-box", resize: "vertical" }}
                autoFocus
              />
            </div>
          </div>
        )}

        {/* Error display */}
        {error && (
          <div style={{
            padding: "8px 12px",
            background: "rgba(220, 38, 38, 0.12)",
            border: "1px solid rgba(220, 38, 38, 0.3)",
            borderRadius: 6,
            fontSize: 13,
            color: "var(--status-failed)",
            marginTop: 8,
          }}>
            {error}
          </div>
        )}

        {/* Action buttons */}
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          marginTop: 16,
          paddingTop: 16,
          borderTop: "1px solid var(--border)",
        }}>
          {mode === "review" && (
            <>
              <button
                className="v2-btn v2-btn-danger"
                onClick={() => { setMode("reject-prompt"); setError(null); }}
                disabled={actionLoading}
                style={{ fontSize: 13 }}
              >
                Reject
              </button>
              <button
                className="v2-btn v2-btn-secondary"
                onClick={() => { setMode("modify"); setError(null); }}
                disabled={actionLoading}
                style={{ fontSize: 13 }}
              >
                Modify Plan
              </button>
              <button
                className="v2-btn v2-btn-primary"
                onClick={handleGreenlight}
                disabled={actionLoading}
                style={{ fontSize: 13 }}
              >
                {actionLoading ? "Approving..." : "Greenlight"}
              </button>
            </>
          )}

          {mode === "modify" && (
            <>
              <button
                className="v2-btn v2-btn-secondary"
                onClick={() => {
                  setMode("review");
                  setError(null);
                  if (deployment.plan) {
                    setModifiedSteps(deployment.plan.steps.map((s) => ({ ...s })));
                  }
                  setModifyReason("");
                }}
                disabled={actionLoading}
                style={{ fontSize: 13 }}
              >
                Cancel
              </button>
              <button
                className="v2-btn v2-btn-primary"
                onClick={handleSaveModifications}
                disabled={actionLoading}
                style={{ fontSize: 13 }}
              >
                {actionLoading ? "Saving..." : "Save Modifications"}
              </button>
            </>
          )}

          {mode === "reject-prompt" && (
            <>
              <button
                className="v2-btn v2-btn-secondary"
                onClick={() => { setMode("review"); setError(null); setRejectReason(""); }}
                disabled={actionLoading}
                style={{ fontSize: 13 }}
              >
                Cancel
              </button>
              <button
                className="v2-btn v2-btn-danger"
                onClick={handleReject}
                disabled={actionLoading}
                style={{ fontSize: 13 }}
              >
                {actionLoading ? "Rejecting..." : "Confirm Rejection"}
              </button>
            </>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
