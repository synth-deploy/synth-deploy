import { useState, useEffect, useRef } from "react";
import {
  getDeployment,
  getDeploymentEnrichment,
  approveDeployment,
  rejectDeployment,
  modifyDeploymentPlan,
  replanDeployment,
  listEnvironments,
  listArtifacts,
  listPartitions,
  createOperation,
} from "../../api.js";
import { invalidateExact } from "../../hooks/useQuery.js";
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
import CanvasPanelHost from "./CanvasPanelHost.js";

// ── FindingsView ─────────────────────────────────────────────────────────────

function FindingsView({
  deployment,
  onLaunchResolution,
}: {
  deployment: Deployment;
  onLaunchResolution: () => void;
}) {
  const findings = deployment.queryFindings ?? deployment.investigationFindings;
  if (!findings) return null;
  const isInvestigation = !!deployment.investigationFindings;

  return (
    <div style={{ padding: "0 4px" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text)" }}>
            {isInvestigation ? "Investigation Complete" : "Query Complete"}
          </h2>
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 20,
            background: "var(--success-bg, #1a3a2a)",
            color: "var(--success, #4caf50)",
            fontFamily: "var(--font-mono)",
          }}>
            Complete
          </span>
        </div>
        {deployment.intent && (
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{deployment.intent}</div>
        )}
      </div>

      {/* Targets surveyed */}
      {findings.targetsSurveyed.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Targets surveyed</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {findings.targetsSurveyed.map((t) => (
              <span key={t} style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "3px 8px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--text-muted)",
              }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Summary */}
      <div style={{ marginBottom: 20 }}>
        <div className="section-label" style={{ marginBottom: 8 }}>Summary</div>
        <div style={{
          fontSize: 13,
          color: "var(--text)",
          lineHeight: 1.6,
          padding: "12px 14px",
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 4,
        }}>
          {findings.summary}
        </div>
      </div>

      {/* Per-target findings */}
      {findings.findings.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div className="section-label" style={{ marginBottom: 10 }}>Findings</div>
          {findings.findings.map((f, i) => (
            <div key={i} style={{
              marginBottom: 10,
              padding: "12px 14px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 4,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--text-muted)", marginBottom: 6 }}>
                {f.target}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {f.observations.map((obs, j) => (
                  <li key={j} style={{ fontSize: 13, color: "var(--text)", marginBottom: 3, lineHeight: 1.5 }}>
                    {obs}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Investigation-specific: root cause */}
      {isInvestigation && deployment.investigationFindings?.rootCause && (
        <div style={{ marginBottom: 20 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Root cause</div>
          <div style={{
            fontSize: 13,
            color: "var(--text)",
            lineHeight: 1.6,
            padding: "12px 14px",
            background: "var(--surface-2)",
            border: "1px solid var(--border-warning, var(--border))",
            borderRadius: 4,
          }}>
            {deployment.investigationFindings.rootCause}
          </div>
        </div>
      )}

      {/* Investigation-specific: proposed resolution */}
      {isInvestigation && !deployment.investigationFindings?.proposedResolution && (
        <div style={{ marginTop: 16, padding: "12px 14px", background: "var(--surface-2)", borderRadius: 6, fontSize: 13, color: "var(--text-muted)" }}>
          No resolution proposed — investigation found no actionable root cause.
        </div>
      )}
      {isInvestigation && deployment.investigationFindings?.proposedResolution && (
        <div style={{ marginBottom: 20 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Proposed resolution</div>
          <div style={{
            padding: "14px 16px",
            background: "var(--surface-2)",
            border: "1px solid var(--accent)",
            borderRadius: 4,
          }}>
            <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 10, lineHeight: 1.5 }}>
              {deployment.investigationFindings.proposedResolution.intent}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                Type: {deployment.investigationFindings.proposedResolution.operationType}
              </span>
              <button
                onClick={onLaunchResolution}
                style={{
                  padding: "6px 14px",
                  fontSize: 12,
                  fontWeight: 600,
                  fontFamily: "var(--font-mono)",
                  background: "var(--accent)",
                  color: "var(--bg)",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                }}
              >
                Launch Resolution
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
  if (enrichment.recentOperationsToEnv > 0) {
    parts.push(
      `${enrichment.recentOperationsToEnv} operation${enrichment.recentOperationsToEnv !== 1 ? "s" : ""} to ${envName} in last 24h`
    );
  } else {
    parts.push(`First operation to ${envName} today`);
  }
  if (enrichment.lastOperationToEnv) {
    parts.push(
      `Previous version (${enrichment.lastOperationToEnv.version}) ${enrichment.lastOperationToEnv.status}`
    );
  }
  if (enrichment.previouslyRolledBack) {
    parts.push("This version was previously rolled back");
  }
  if (enrichment.conflictingOperations.length > 0) {
    parts.push(
      `${enrichment.conflictingOperations.length} other operation${enrichment.conflictingOperations.length !== 1 ? "s" : ""} in progress`
    );
  }
  return parts.join(" · ");
}

// ── Pending / reasoning view ─────────────────────────────────────────────────

const REASONING_STEPS = [
  "Scanning local environment state",
  "Loading previous deployment history",
  "Analyzing artifact dependencies",
  "Reasoning about deployment strategy",
  "Building rollback plan",
  "Finalizing plan",
];

function PlanPendingView({
  artifactName,
  createdAt,
  onMinimize,
}: {
  deploymentId: string;
  artifactName: string;
  createdAt: Date | string;
  onMinimize: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    const start = new Date(createdAt).getTime();
    const tick = setInterval(() => {
      const secs = Math.floor((Date.now() - start) / 1000);
      setElapsed(secs);
      // Advance through reasoning steps roughly every 4 seconds
      setStepIndex(Math.min(Math.floor(secs / 4), REASONING_STEPS.length - 1));
    }, 1000);
    return () => clearInterval(tick);
  }, [createdAt]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const elapsedLabel = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const slow = elapsed > 45;

  return (
    <div className="modal-overlay">
      <div className="modal-card" style={{ maxWidth: 520, padding: "40px 32px", textAlign: "center" }}>
        <SynthMark size={44} active />
        <p style={{ color: "var(--text-secondary)", fontSize: 15, fontWeight: 600, marginTop: 16, marginBottom: 6 }}>
          Reasoning about {artifactName}
        </p>
        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 20px", fontFamily: "var(--font-mono)" }}>
          {REASONING_STEPS[stepIndex]}…
        </p>

        {/* Step progress dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 20 }}>
          {REASONING_STEPS.map((_, i) => (
            <div
              key={i}
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: i <= stepIndex ? "var(--accent)" : "var(--border)",
                transition: "background 0.4s",
              }}
            />
          ))}
        </div>

        <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 4px", fontFamily: "var(--font-mono)" }}>
          {elapsedLabel} elapsed
        </p>

        {slow && (
          <p style={{ color: "var(--text-muted)", fontSize: 11, margin: "0 0 16px", opacity: 0.7 }}>
            LLM reasoning can take a moment — hang tight
          </p>
        )}

        <button
          onClick={onMinimize}
          style={{
            marginTop: 12,
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
    </div>
  );
}

// ── Modal shell ──────────────────────────────────────────────────────────────
function PlanModal({ children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-overlay">
      <div
        className="modal-card"
        style={{ maxWidth: 620, maxHeight: "85vh", overflow: "auto" }}
      >
        {children}
      </div>
    </div>
  );
}

export default function PlanReviewPanel({ deploymentId }: Props) {
  const { replacePanel, popPanel, minimizeDeployment, pushPanel } = useCanvas();

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
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  function toggleStep(i: number) {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }
  const [rejectReason, setRejectReason] = useState("");
  const [modifiedSteps, setModifiedSteps] = useState<PlannedStep[]>([]);
  const [modifyReason, setModifyReason] = useState("");
  const [refineFeedback, setRefineFeedback] = useState("");
  const [refining, setRefining] = useState(false);
  const [revised, setRevised] = useState(false);
  const [refineAnswer, setRefineAnswer] = useState<string | null>(null);

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

  // Query / investigate operations — show findings or loading state
  const isFindings =
    deployment.input?.type === "query" || deployment.input?.type === "investigate";
  const opType = deployment.input?.type;

  if (isFindings && deployment.status === "pending") {
    return (
      <CanvasPanelHost title={opType === "query" ? "Running Query…" : "Investigating…"}>
        <div className="loading">Envoy is probing the environment…</div>
      </CanvasPanelHost>
    );
  }

  if (isFindings && deployment.status === "succeeded") {
    const handleLaunchResolution = async () => {
      const res = deployment.investigationFindings?.proposedResolution;
      if (!res) return;
      try {
        const result = await createOperation({
          type: res.operationType,
          intent: res.intent,
          environmentId: deployment.environmentId,
          partitionId: deployment.partitionId,
          parentOperationId: deploymentId,
        });
        pushPanel({
          type: "plan-review",
          title: "Review Resolution Plan",
          params: { id: result.deployment.id },
        });
      } catch (e) {
        console.error("Failed to launch resolution:", e);
      }
    };

    return (
      <CanvasPanelHost title={deployment.investigationFindings ? "Investigation Results" : "Query Results"}>
        <FindingsView deployment={deployment} onLaunchResolution={handleLaunchResolution} />
      </CanvasPanelHost>
    );
  }

  // Thinking state: plan is being generated
  if (deployment.status === "pending") {
    const pendingArtName =
      (artifacts ?? []).find((a) => a.id === deployment.artifactId)?.name ?? deployment.artifactId.slice(0, 8);
    return <PlanPendingView
      deploymentId={deploymentId}
      artifactName={pendingArtName}
      createdAt={deployment.createdAt}
      onMinimize={() => minimizeDeployment({ deploymentId, artifactName: pendingArtName, panelType: "plan-review" })}
    />;
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
      invalidateExact(`deployment:${deploymentId}`);
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
    setRefineAnswer(null);
    try {
      const res = await replanDeployment(deploymentId, refineFeedback.trim());
      if (!("deployment" in res)) {
        // mode === "response" — answer the question inline, no replan
        setRefineAnswer(res.message);
        setRefining(false);
        return;
      }
      // mode === "replan" completed — update deployment
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
          <div className="modal-label">
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
          className="modal-close"
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
          <div className="section-label">
            Envoy&apos;s Plan{revised && " (Revised)"}
          </div>
          {plan.steps.map((step, i) => {
            const risk = !step.reversible ? "high" : step.rollbackAction ? "low" : "none";
            return (
              <div key={i} className="plan-step-row">
                <span className="plan-step-num">{i + 1}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                      color: risk === "none"
                        ? "var(--text-muted)"
                        : risk === "high"
                          ? "var(--status-failed)"
                          : "var(--status-succeeded)",
                    }}>
                      {risk}
                    </span>
                    <button
                      onClick={() => toggleStep(i)}
                      style={{
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        padding: "2px 4px",
                        color: "var(--text-muted)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                        flexShrink: 0,
                      }}
                      title={expandedSteps.has(i) ? "Hide execution detail" : "Show execution detail"}
                    >
                      {expandedSteps.has(i) ? "▲" : "▼"}
                    </button>
                  </div>
                  {expandedSteps.has(i) && (
                    <div className="plan-step-exec-preview">
                      {step.execPreview
                        ? step.execPreview
                        : `${step.action}${step.target ? ` ${step.target}` : ""}`
                      }
                    </div>
                  )}
                </div>
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
        {/* letterSpacing and fontWeight differ from .section-label (1px vs 1.5px, 600 vs 700) — no exact class match */}
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
            onChange={(e) => { setRefineFeedback(e.target.value); setRefineAnswer(null); }}
            placeholder="e.g. CACHE_TTL also changed in this version — make sure that's applied. Also verify the /v2 endpoint responds after deploy, not just /health."
            className="v2-input"
            rows={3}
            style={{ resize: "vertical" }}
            autoFocus
          />
          {refineAnswer && (
            <div style={{
              marginTop: 10,
              padding: "10px 14px",
              borderRadius: 8,
              background: "var(--accent-dim)",
              border: "1px solid var(--accent-border)",
            }}>
              <div style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--accent)",
                marginBottom: 4,
                fontFamily: "var(--font-mono)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}>
                Synth
              </div>
              <p style={{ fontSize: 13, color: "var(--text)", margin: "0 0 8px 0", lineHeight: 1.6 }}>{refineAnswer}</p>
              <button
                className="plan-btn plan-btn-reject"
                onClick={() => setRefineAnswer(null)}
                style={{ fontSize: 11, padding: "3px 10px" }}
              >
                Dismiss
              </button>
            </div>
          )}
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
              className="plan-btn plan-btn-reject"
            >
              Cancel
            </button>
            {/* --text-on-dark does not exist; color: #fff left as-is until var is added to app.css */}
            <button
              onClick={handleRefine}
              disabled={refining}
              className="v2-btn v2-btn-primary"
              style={{ opacity: refining ? 0.6 : 1 }}
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
          {/* --text-on-dark does not exist; color: #fff left as-is until var is added to app.css */}
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
          {/* --text-on-dark does not exist; color: #fff left as-is until var is added to app.css */}
          <button
            onClick={handleSaveModifications}
            disabled={actionLoading}
            className="v2-btn v2-btn-primary"
            style={{ opacity: actionLoading ? 0.5 : 1 }}
          >
            {actionLoading ? "Saving..." : "Save Modifications"}
          </button>
        </div>
      )}

    </PlanModal>
  );
}
