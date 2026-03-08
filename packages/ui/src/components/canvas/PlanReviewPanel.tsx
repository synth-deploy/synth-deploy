import { useState, useEffect, useRef } from "react";
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
} from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery } from "../../hooks/useQuery.js";
import SynthMark from "../SynthMark.js";
import ConfidenceIndicator from "../ConfidenceIndicator.js";

interface Props {
  deploymentId: string;
  title: string;
}

type ReviewMode = "review" | "refine" | "modify" | "reject-prompt";

function verdictToConfidence(verdict: string): number {
  return verdict === "proceed" ? 0.9 : verdict === "caution" ? 0.65 : 0.3;
}

function buildContextText(enrichment: DeploymentEnrichment | null, envName: string): string {
  if (!enrichment) return `Deploying to ${envName}`;
  const parts: string[] = [];
  if (enrichment.recentDeploymentsToEnv > 0) {
    parts.push(
      `${enrichment.recentDeploymentsToEnv} deployment${enrichment.recentDeploymentsToEnv !== 1 ? "s" : ""} to ${envName} in last 24h`
    );
  } else {
    parts.push(`First deployment to ${envName} today`);
  }
  if (enrichment.lastDeploymentToEnv) {
    parts.push(
      `Previous version (${enrichment.lastDeploymentToEnv.version}) ${enrichment.lastDeploymentToEnv.status}`
    );
  }
  if (enrichment.previouslyRolledBack) {
    parts.push("This version was previously rolled back");
  }
  if (enrichment.conflictingDeployments.length > 0) {
    parts.push(
      `${enrichment.conflictingDeployments.length} other deployment${enrichment.conflictingDeployments.length !== 1 ? "s" : ""} in progress`
    );
  }
  return parts.join(" · ");
}

// ── Modal shell ──────────────────────────────────────────────────────────────
function PlanModal({ children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--overlay-bg)", backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
    }}>
      <div style={{
        width: "100%", maxWidth: 620, maxHeight: "85vh", overflow: "auto",
        background: "var(--surface)", borderRadius: 14,
        border: "1px solid var(--border-strong, rgba(128,128,128,0.18))",
        padding: "30px 34px", boxShadow: "var(--modal-shadow)",
      }}>
        {children}
      </div>
    </div>
  );
}

export default function PlanReviewPanel({ deploymentId }: Props) {
  const { replacePanel, popPanel, minimizeDeployment } = useCanvas();

  const { data: result, loading: l1 } = useQuery(`deployment:${deploymentId}`, () => getDeployment(deploymentId));
  const { data: enrichCtx, loading: l2 } = useQuery(
    `deploymentEnrichment:${deploymentId}`,
    () => getDeploymentEnrichment(deploymentId).catch(() => ({ enrichment: null }) as { enrichment: null; recommendation?: DeploymentRecommendation })
  );
  const { data: environments, loading: l3 } = useQuery("list:environments", () => listEnvironments());
  const { data: artifacts, loading: l4 } = useQuery("list:artifacts", () => listArtifacts());
  const { data: partitions, loading: l5 } = useQuery("list:partitions", () => listPartitions());
  const loading = l1 || l2 || l3 || l4 || l5;

  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const enrichment = enrichCtx?.enrichment ?? null;
  const recommendation = enrichCtx?.recommendation ?? result?.deployment?.recommendation ?? null;

  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ReviewMode>("review");

  // Poll while deployment is pending (plan not yet generated)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (deployment?.status === "pending") {
      pollRef.current = setInterval(async () => {
        try {
          const res = await getDeployment(deploymentId);
          if (res.deployment.status !== "pending") {
            setDeployment(res.deployment);
            if (res.deployment.plan) {
              setModifiedSteps(res.deployment.plan.steps.map((s) => ({ ...s })));
            }
            if (pollRef.current) clearInterval(pollRef.current);
          }
        } catch {
          // ignore transient errors
        }
      }, 2000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [deployment?.status, deploymentId]);
  const [rejectReason, setRejectReason] = useState("");
  const [modifiedSteps, setModifiedSteps] = useState<PlannedStep[]>([]);
  const [modifyReason, setModifyReason] = useState("");
  const [refineFeedback, setRefineFeedback] = useState("");
  const [refining, setRefining] = useState(false);
  const [revised, setRevised] = useState(false);

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
      <PlanModal onClose={popPanel}>
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <SynthMark size={44} active />
          <p style={{ color: "var(--text-secondary)", fontSize: 14, marginTop: 14, marginBottom: 4 }}>
            Loading plan…
          </p>
        </div>
      </PlanModal>
    );
  }

  if (!deployment) {
    return (
      <PlanModal onClose={popPanel}>
        <div className="error-msg">Deployment not found</div>
      </PlanModal>
    );
  }

  // Thinking state: plan is being generated
  if (deployment.status === "pending") {
    const pendingArtName =
      (artifacts ?? []).find((a) => a.id === deployment.artifactId)?.name ?? deployment.artifactId.slice(0, 8);
    return (
      <PlanModal onClose={popPanel}>
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <SynthMark size={44} active />
          <p style={{ color: "var(--text-secondary)", fontSize: 14, marginTop: 14, marginBottom: 4 }}>
            Envoy is reasoning about this deployment…
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
            Scanning local state · Loading previous plans · Building strategy
          </p>
          <button
            onClick={() => minimizeDeployment({ deploymentId, artifactName: pendingArtName, panelType: "plan-review" })}
            style={{
              marginTop: 24,
              padding: "7px 16px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            Minimize ↓
          </button>
        </div>
      </PlanModal>
    );
  }

  if (deployment.status !== "awaiting_approval") {
    return (
      <PlanModal onClose={popPanel}>
        <div className="error-msg">
          This deployment is in &ldquo;{deployment.status}&rdquo; status and is not awaiting approval.
        </div>
      </PlanModal>
    );
  }

  const envName =
    (environments ?? []).find((e) => e.id === deployment.environmentId)?.name ?? deployment.environmentId;
  const artName =
    (artifacts ?? []).find((a) => a.id === deployment.artifactId)?.name ?? deployment.artifactId.slice(0, 8);
  const partName = deployment.partitionId
    ? ((partitions ?? []).find((p) => p.id === deployment.partitionId)?.name ?? deployment.partitionId.slice(0, 8))
    : null;

  const plan = deployment.plan;

  async function handleGreenlight() {
    setActionLoading(true);
    setError(null);
    try {
      const res = await approveDeployment(deploymentId, { approvedBy: "user" });
      replacePanel({
        type: "deployment-detail",
        title: `Deployment ${res.deployment.id.slice(0, 8)}`,
        params: { id: res.deployment.id },
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
      const res = await rejectDeployment(deploymentId, { reason: rejectReason.trim() });
      replacePanel({
        type: "deployment-detail",
        title: `Deployment ${res.deployment.id.slice(0, 8)}`,
        params: { id: res.deployment.id },
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
      const res = await modifyDeploymentPlan(deploymentId, {
        steps: modifiedSteps,
        reason: modifyReason.trim(),
      });
      setDeployment(res.deployment);
      setMode("review");
      setActionLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to modify plan");
      setActionLoading(false);
    }
  }

  async function handleRefine() {
    if (!refineFeedback.trim()) {
      setError("Please describe what Synth should reconsider");
      return;
    }
    setRefining(true);
    setError(null);
    try {
      const res = await modifyDeploymentPlan(deploymentId, {
        steps: deployment!.plan!.steps,
        reason: `Refine request: ${refineFeedback.trim()}`,
      });
      setDeployment(res.deployment);
      setMode("review");
      setRefineFeedback("");
      setRevised(true);
      setRefining(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to refine plan");
      setRefining(false);
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
    <PlanModal onClose={popPanel}>

      {/* ── Plan header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <div style={{
            fontSize: 10,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "1.5px",
            fontWeight: 700,
            fontFamily: "var(--font-mono)",
            marginBottom: 6,
          }}>
            Deployment Plan
            {revised && <span style={{ color: "var(--accent)", marginLeft: 6 }}>· Revised</span>}
          </div>
          <h2 style={{
            fontSize: 22,
            fontWeight: 500,
            color: "var(--text)",
            margin: 0,
            fontFamily: "var(--font-display)",
          }}>
            {artName}{" "}
            <span style={{
              color: "var(--text-muted)",
              fontWeight: 400,
              fontSize: 15,
              fontFamily: "var(--font-mono)",
            }}>
              {deployment.version}
            </span>
          </h2>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 3 }}>
            → {envName}{partName ? ` · ${partName}` : ""}
          </div>
        </div>
        <button
          onClick={popPanel}
          style={{
            width: 30, height: 30, borderRadius: 6,
            border: "1px solid var(--border)", background: "var(--surface)",
            color: "var(--text-muted)", fontSize: 16, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}
        >
          ×
        </button>
      </div>

      {/* ── Synth Assessment ── */}
      {recommendation && (
        <div className="synth-assessment">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <SynthMark size={16} />
            <span className="synth-assessment-label">Synth Assessment</span>
            <ConfidenceIndicator value={verdictToConfidence(recommendation.verdict)} qualifier="confidence" />
          </div>
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, margin: 0 }}>
            {recommendation.summary}
          </p>
          {recommendation.factors.length > 0 && (
            <ul style={{ margin: "8px 0 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-secondary)" }}>
              {recommendation.factors.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* ── Envoy's Plan (review mode) ── */}
      {mode !== "modify" && plan && (
        <div style={{ marginBottom: 22 }}>
          <div style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "1.5px",
            fontFamily: "var(--font-mono)",
            marginBottom: 10,
          }}>
            Envoy&apos;s Plan{revised && " (Revised)"}
          </div>
          {plan.steps.map((step, i) => {
            const risk = !step.reversible ? "high" : step.rollbackAction ? "low" : "none";
            return (
              <div key={i} className="plan-step-row">
                <span className="plan-step-num">{i + 1}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: "var(--text)" }}>
                    {step.description || step.action}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    ↩ {step.rollbackAction || "—"}
                  </div>
                </div>
                <span style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 600,
                  alignSelf: "center",
                  color: risk === "none"
                    ? "var(--text-muted)"
                    : risk === "high"
                      ? "var(--status-failed)"
                      : "var(--status-succeeded)",
                }}>
                  {risk}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Cross-System Context ── */}
      <div style={{
        padding: "12px 16px",
        borderRadius: 8,
        marginBottom: 20,
        background: "var(--surface-alt)",
        border: "1px solid var(--border)",
      }}>
        <div style={{
          fontSize: 10,
          color: "var(--text-muted)",
          fontWeight: 600,
          marginBottom: 6,
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: "1px",
        }}>
          Cross-System Context
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.65 }}>
          {buildContextText(enrichment, envName)}
        </div>
      </div>

      {/* ── Modify mode ── */}
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
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Step {i + 1}</span>
                  <button
                    onClick={() => removeStep(i)}
                    style={{ background: "transparent", border: "none", color: "var(--status-failed)", cursor: "pointer", fontSize: 12 }}
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
                  style={{ fontSize: 12, marginTop: 8 }}
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
            <button onClick={addStep} className="v2-btn" style={{ alignSelf: "flex-start" }}>
              + Add Step
            </button>
            <div>
              <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
                Reason for modification
              </label>
              <textarea
                value={modifyReason}
                onChange={(e) => setModifyReason(e.target.value)}
                placeholder="Why are you modifying this plan?"
                className="v2-input"
                rows={2}
                style={{ resize: "vertical" }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Refine mode ── */}
      {mode === "refine" && (
        <div style={{
          padding: "16px 18px",
          borderRadius: 10,
          marginBottom: 16,
          background: "var(--accent-dim)",
          border: "1px solid var(--accent-border)",
        }}>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--accent)",
            marginBottom: 8,
            fontFamily: "var(--font-mono)",
          }}>
            What should Synth reconsider?
          </div>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 10px 0", lineHeight: 1.5 }}>
            Describe what&apos;s wrong or what&apos;s missing. Synth will regenerate the plan incorporating your
            feedback. This also improves future plans for this artifact.
          </p>
          <textarea
            value={refineFeedback}
            onChange={(e) => setRefineFeedback(e.target.value)}
            placeholder="e.g. CACHE_TTL also changed in this version — make sure that's applied. Also verify the /v2 endpoint responds after deploy, not just /health."
            className="v2-input"
            rows={3}
            style={{ resize: "vertical" }}
            autoFocus
          />
          {refining && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: "var(--accent)" }}>
              <SynthMark size={14} active />
              Re-reasoning...
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
            <button
              onClick={() => { setMode("review"); setError(null); setRefineFeedback(""); }}
              disabled={refining}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-muted)",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleRefine}
              disabled={refining}
              style={{
                padding: "8px 18px",
                borderRadius: 6,
                border: "none",
                background: "var(--accent)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                opacity: refining ? 0.6 : 1,
              }}
            >
              {refining ? "Revising..." : "Revise Plan"}
            </button>
          </div>
        </div>
      )}

      {/* ── Reject prompt ── */}
      {mode === "reject-prompt" && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Reason for rejection
          </label>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Why is this plan being rejected?"
            className="v2-input"
            rows={3}
            style={{ resize: "vertical" }}
            autoFocus
          />
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div style={{
          padding: "8px 12px",
          background: "color-mix(in srgb, var(--status-failed) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--status-failed) 30%, transparent)",
          borderRadius: 6,
          fontSize: 13,
          color: "var(--status-failed)",
          marginBottom: 12,
        }}>
          {error}
        </div>
      )}

      {/* ── Primary action buttons ── */}
      {(mode === "review" || mode === "refine") && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="plan-btn plan-btn-greenlight"
            onClick={handleGreenlight}
            disabled={actionLoading}
          >
            ✓ Greenlight
          </button>
          {mode === "review" && (
            <button
              className="plan-btn plan-btn-refine"
              onClick={() => { setMode("refine"); setError(null); setRefineFeedback(""); }}
              disabled={actionLoading}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
              Refine
            </button>
          )}
          <button
            className="plan-btn plan-btn-reject"
            onClick={() => { setMode("reject-prompt"); setError(null); }}
            disabled={actionLoading}
          >
            Reject
          </button>
        </div>
      )}

      {mode === "reject-prompt" && (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            className="plan-btn plan-btn-reject"
            onClick={() => { setMode("review"); setError(null); setRejectReason(""); }}
            disabled={actionLoading}
          >
            Cancel
          </button>
          <button
            onClick={handleReject}
            disabled={actionLoading}
            style={{
              padding: "13px 20px",
              borderRadius: 8,
              border: "none",
              background: "var(--status-failed)",
              color: "#fff",
              fontSize: 14,
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              cursor: "pointer",
              opacity: actionLoading ? 0.5 : 1,
            }}
          >
            {actionLoading ? "Rejecting..." : "Confirm Rejection"}
          </button>
        </div>
      )}

      {mode === "modify" && (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
          <button
            className="plan-btn plan-btn-reject"
            onClick={() => {
              setMode("review");
              setError(null);
              if (deployment.plan) setModifiedSteps(deployment.plan.steps.map((s) => ({ ...s })));
              setModifyReason("");
            }}
            disabled={actionLoading}
          >
            Cancel
          </button>
          <button
            onClick={handleSaveModifications}
            disabled={actionLoading}
            style={{
              padding: "13px 20px",
              borderRadius: 8,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 14,
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              cursor: "pointer",
              opacity: actionLoading ? 0.5 : 1,
            }}
          >
            {actionLoading ? "Saving..." : "Save Modifications"}
          </button>
        </div>
      )}

    </PlanModal>
  );
}
