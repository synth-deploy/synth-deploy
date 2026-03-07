import { useState, useEffect } from "react";
import {
  listDeployments,
  listPartitions,
  listEnvironments,
  listArtifacts,
  listEnvoys,
  createArtifact,
  createDeployment,
  getArtifact,
  getDeployment,
  getRecentDebrief,
  getDeploymentContext,
  getHealth,
  getSystemState,
} from "../../api.js";
import type { Deployment, Partition, Environment, Artifact, DebriefEntry } from "../../types.js";
import type { DeploymentContext, SystemState, AlertSignal, EnvoyRegistryEntry } from "../../api.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useSettings } from "../../context/SettingsContext.js";
import { useQuery } from "../../hooks/useQuery.js";
import SectionHeader from "../SectionHeader.js";
import SynthEye from "../SynthEye.js";
import SynthMark from "../SynthMark.js";
import ConfidenceIndicator from "../ConfidenceIndicator.js";
import StatusBadge from "../StatusBadge.js";

// ---------------------------------------------------------------------------
// Top-level state-driven router
// ---------------------------------------------------------------------------

export default function OperationalOverview() {
  const { data: systemState, loading, refresh } = useQuery<SystemState>(
    "systemState",
    getSystemState,
    { refetchInterval: 30_000 },
  );

  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  if (loading) return <div className="loading">Loading...</div>;
  if (!systemState) return <div className="loading">Failed to load system state.</div>;

  switch (systemState.state) {
    case "empty":
      return <EmptyState onComplete={refresh} />;
    case "alert":
      return <AlertState signals={systemState.signals} stats={systemState.stats} />;
    case "normal":
      return <NormalState stats={systemState.stats} />;
  }
}

// ---------------------------------------------------------------------------
// EmptyState — guided first-deployment onboarding (#137)
// ---------------------------------------------------------------------------

function EmptyState({ onComplete }: { onComplete: () => void }) {
  const { pushPanel } = useCanvas();
  const { settings } = useSettings();
  const environmentsEnabled = settings?.environmentsEnabled ?? true;

  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 state
  const [artifactName, setArtifactName] = useState("");
  const [artifactType, setArtifactType] = useState("docker");
  const [createdArtifact, setCreatedArtifact] = useState<Artifact | null>(null);
  const [analysisSummary, setAnalysisSummary] = useState<string | null>(null);
  const [analysisPolling, setAnalysisPolling] = useState(false);
  const [step1Submitting, setStep1Submitting] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // Step 2 state
  const [envoys, setEnvoys] = useState<EnvoyRegistryEntry[]>([]);
  const [connectedEnvoy, setConnectedEnvoy] = useState<EnvoyRegistryEntry | null>(null);

  // Step 3 state
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState("");
  const [version, setVersion] = useState("");
  const [step3Submitting, setStep3Submitting] = useState(false);
  const [step3Error, setStep3Error] = useState<string | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deploymentStatus, setDeploymentStatus] = useState<string | null>(null);
  const [deploymentDebrief, setDeploymentDebrief] = useState<DebriefEntry[]>([]);

  // Poll for artifact analysis after creation
  useEffect(() => {
    if (!createdArtifact || analysisSummary) return;
    setAnalysisPolling(true);
    const poll = setInterval(() => {
      getArtifact(createdArtifact.id)
        .then(({ artifact }) => {
          if (artifact.analysis.summary) {
            setAnalysisSummary(artifact.analysis.summary);
            setCreatedArtifact(artifact);
            setAnalysisPolling(false);
            clearInterval(poll);
          }
        })
        .catch(() => {});
    }, 3000);
    // Stop after 30s regardless
    const timeout = setTimeout(() => {
      setAnalysisPolling(false);
      clearInterval(poll);
    }, 30000);
    return () => { clearInterval(poll); clearTimeout(timeout); };
  }, [createdArtifact?.id, analysisSummary]);

  // Poll for envoy connection in step 2
  useEffect(() => {
    if (step !== 2) return;

    const poll = () =>
      listEnvoys()
        .then((list) => {
          setEnvoys(list);
          const healthy = list.find((e) => e.health === "OK");
          if (healthy) {
            setConnectedEnvoy(healthy);
            setStep(3);
          }
        })
        .catch(() => {});

    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [step]);

  // Load environments when reaching step 3
  useEffect(() => {
    if (step !== 3) return;
    listEnvironments().then(setEnvironments).catch(() => {});
  }, [step]);

  // Poll deployment status and debrief after creation
  useEffect(() => {
    if (!deploymentId) return;
    const poll = setInterval(() => {
      getDeployment(deploymentId)
        .then(({ deployment, debrief }) => {
          setDeploymentStatus(deployment.status);
          setDeploymentDebrief(debrief);
          if (deployment.status === "succeeded" || deployment.status === "failed" || deployment.status === "rolled_back") {
            clearInterval(poll);
            // Trigger transition to normal state
            setTimeout(onComplete, 2000);
          }
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(poll);
  }, [deploymentId]);

  async function handleCreateArtifact() {
    if (!artifactName.trim()) {
      setStep1Error("Artifact name is required");
      return;
    }
    setStep1Submitting(true);
    setStep1Error(null);
    try {
      const artifact = await createArtifact({ name: artifactName.trim(), type: artifactType });
      setCreatedArtifact(artifact);
      if (artifact.analysis.summary) {
        setAnalysisSummary(artifact.analysis.summary);
      }
      setStep(2);
    } catch (e: unknown) {
      setStep1Error(e instanceof Error ? e.message : String(e));
    } finally {
      setStep1Submitting(false);
    }
  }

  async function handleDeploy() {
    if (!createdArtifact) return;
    if (environmentsEnabled && !selectedEnvId) {
      setStep3Error("Select an environment");
      return;
    }
    setStep3Submitting(true);
    setStep3Error(null);
    try {
      const result = await createDeployment({
        artifactId: createdArtifact.id,
        environmentId: environmentsEnabled ? selectedEnvId : undefined,
        version: version.trim() || "1.0.0",
      });
      setDeploymentId(result.deployment.id);
      setDeploymentStatus(result.deployment.status);
    } catch (e: unknown) {
      setStep3Error(e instanceof Error ? e.message : String(e));
    } finally {
      setStep3Submitting(false);
    }
  }

  const stepStyle = (s: number): React.CSSProperties => ({
    border: "1px solid var(--agent-border)",
    borderRadius: 10,
    padding: 20,
    marginBottom: 12,
    background: step > s ? "rgba(52, 211, 153, 0.04)" : step === s ? "var(--agent-card-bg)" : "rgba(107, 114, 128, 0.04)",
    opacity: step < s ? 0.5 : 1,
    transition: "all 0.2s",
  });

  const stepHeaderStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 10, marginBottom: 12,
  };

  const stepNumberStyle = (s: number): React.CSSProperties => ({
    width: 28, height: 28, borderRadius: "50%",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 13, fontWeight: 700,
    background: step > s ? "#34d399" : step === s ? "rgba(99, 225, 190, 0.2)" : "rgba(107, 114, 128, 0.15)",
    color: step > s ? "#0f1420" : step === s ? "#63e1be" : "#6b7280",
  });

  const statusLabel: Record<string, string> = {
    pending: "Waiting to start...",
    planning: "Generating plan...",
    approved: "Plan approved, executing...",
    running: "Executing deployment...",
    succeeded: "Deployment succeeded!",
    failed: "Deployment failed.",
    rolled_back: "Rolled back.",
  };

  return (
    <div className="v2-dashboard">
      <div style={{ textAlign: "center", padding: "32px 20px 24px" }}>
        <SynthEye />
        <h2 style={{ color: "var(--agent-text)", fontSize: 22, fontWeight: 700, marginTop: 16, marginBottom: 8 }}>
          Welcome to Synth
        </h2>
        <p style={{ color: "var(--agent-text-muted)", fontSize: 14, maxWidth: 460, margin: "0 auto" }}>
          Let&rsquo;s set up your first intelligent deployment. Three steps &mdash; then you&rsquo;re operational.
        </p>
      </div>

      {/* Step 1: Artifact */}
      <div style={stepStyle(1)}>
        <div style={stepHeaderStyle}>
          <div style={stepNumberStyle(1)}>
            {step > 1 ? "\u2713" : "1"}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: "var(--agent-text)" }}>
              What are you deploying?
            </div>
            <div style={{ fontSize: 12, color: "var(--agent-text-muted)" }}>
              An artifact is what you&rsquo;re deploying &mdash; a container image, package, binary, or config bundle. Synth will analyze it.
            </div>
          </div>
        </div>

        {step === 1 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 400 }}>
            <input
              placeholder="Artifact name (e.g. my-web-app)"
              value={artifactName}
              onChange={(e) => setArtifactName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateArtifact()}
              style={{ fontSize: 13, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--agent-border)", background: "var(--agent-bg)", color: "var(--agent-text)" }}
            />
            <select
              value={artifactType}
              onChange={(e) => setArtifactType(e.target.value)}
              style={{ fontSize: 13, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--agent-border)", background: "var(--agent-bg)", color: "var(--agent-text)" }}
            >
              <option value="docker">Docker Image</option>
              <option value="binary">Binary / Executable</option>
              <option value="package">Package (npm, pip, etc.)</option>
              <option value="config">Configuration Bundle</option>
              <option value="other">Other</option>
            </select>
            {step1Error && <div style={{ color: "#dc2626", fontSize: 12 }}>{step1Error}</div>}
            <button
              className="btn btn-primary"
              onClick={handleCreateArtifact}
              disabled={step1Submitting}
              style={{ alignSelf: "flex-start" }}
            >
              {step1Submitting ? "Creating..." : "Create Artifact"}
            </button>
          </div>
        )}

        {step > 1 && createdArtifact && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#34d399" }}>
              <span style={{ fontWeight: 600 }}>{createdArtifact.name}</span>
              <span style={{ color: "var(--agent-text-muted)" }}>({createdArtifact.type})</span>
            </div>
            {analysisPolling && !analysisSummary && (
              <div style={{ fontSize: 12, color: "var(--agent-text-muted)", marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                <span className="v2-envoy-spinner" style={{ width: 12, height: 12, border: "2px solid rgba(99,225,190,0.2)", borderTopColor: "#63e1be", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                Analyzing artifact...
              </div>
            )}
            {analysisSummary && (
              <div style={{ fontSize: 12, color: "var(--agent-text-muted)", marginTop: 6, padding: "6px 10px", background: "rgba(99,225,190,0.05)", borderRadius: 6, borderLeft: "2px solid rgba(99,225,190,0.3)" }}>
                {analysisSummary}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Step 2: Envoy */}
      <div style={stepStyle(2)}>
        <div style={stepHeaderStyle}>
          <div style={stepNumberStyle(2)}>
            {step > 2 ? "\u2713" : "2"}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: "var(--agent-text)" }}>
              Where are you deploying to?
            </div>
            <div style={{ fontSize: 12, color: "var(--agent-text-muted)" }}>
              An envoy runs on your target machine. It scans the system, produces deployment plans, and executes them.
            </div>
          </div>
        </div>

        {step === 2 && (
          <div style={{ maxWidth: 500 }}>
            <div style={{
              background: "rgba(99, 225, 190, 0.05)", border: "1px solid rgba(99, 225, 190, 0.15)",
              borderRadius: 8, padding: 16, marginBottom: 12, fontSize: 13,
            }}>
              <div style={{ fontWeight: 600, color: "var(--agent-text)", marginBottom: 8 }}>
                Register an Envoy
              </div>
              <div style={{ color: "var(--agent-text-muted)", lineHeight: 1.5 }}>
                Install and start an envoy on your target machine. It will connect back to this Synth instance automatically.
              </div>
              <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 12, color: "#63e1be", background: "rgba(0,0,0,0.3)", padding: "8px 12px", borderRadius: 6, wordBreak: "break-all" }}>
                npx @synth-deploy/envoy --command-url {window.location.origin}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--agent-text-muted)" }}>
              <span className="v2-envoy-spinner" style={{ width: 14, height: 14, border: "2px solid rgba(99,225,190,0.2)", borderTopColor: "#63e1be", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
              Waiting for envoy connection...
              {envoys.length > 0 && (
                <span style={{ color: "#f59e0b" }}>
                  ({envoys.length} envoy{envoys.length !== 1 ? "s" : ""} found, none healthy yet)
                </span>
              )}
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setConnectedEnvoy(null);
                setStep(3);
              }}
              style={{ marginTop: 12, fontSize: 12 }}
            >
              Skip &mdash; I&rsquo;ll connect an envoy later
            </button>
          </div>
        )}

        {step > 2 && connectedEnvoy && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#34d399" }}>
            <span style={{ fontWeight: 600 }}>{connectedEnvoy.hostname ?? connectedEnvoy.id.slice(0, 8)}</span>
            <span style={{ color: "var(--agent-text-muted)" }}>({connectedEnvoy.url})</span>
            <span className="v2-synth-status-badge" style={{ fontSize: 10 }}>OK</span>
          </div>
        )}
        {step > 2 && !connectedEnvoy && (
          <div style={{ fontSize: 13, color: "var(--agent-text-muted)", fontStyle: "italic" }}>
            Skipped &mdash; no envoy connected
          </div>
        )}
      </div>

      {/* Step 3: Deploy */}
      <div style={stepStyle(3)}>
        <div style={stepHeaderStyle}>
          <div style={stepNumberStyle(3)}>
            {deploymentStatus === "succeeded" ? "\u2713" : "3"}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: "var(--agent-text)" }}>
              {deploymentId ? (statusLabel[deploymentStatus ?? "pending"] ?? "Processing...") : "Ready for your first intelligent deployment"}
            </div>
            <div style={{ fontSize: 12, color: "var(--agent-text-muted)" }}>
              {deploymentId
                ? "Watch the plan, execution, and debrief unfold below."
                : "Deploy your artifact. Synth will analyze it, generate a plan, and execute it."}
            </div>
          </div>
        </div>

        {step === 3 && !deploymentId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 400 }}>
            {createdArtifact && (
              <div style={{ fontSize: 13, color: "var(--agent-text)" }}>
                <strong>Artifact:</strong> {createdArtifact.name} ({createdArtifact.type})
              </div>
            )}

            {environmentsEnabled && (
              <select
                value={selectedEnvId}
                onChange={(e) => setSelectedEnvId(e.target.value)}
                style={{ fontSize: 13, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--agent-border)", background: "var(--agent-bg)", color: "var(--agent-text)" }}
              >
                <option value="">Select Environment</option>
                {environments.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            )}

            <input
              placeholder="Version (e.g. 1.0.0)"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleDeploy()}
              style={{ fontSize: 13, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--agent-border)", background: "var(--agent-bg)", color: "var(--agent-text)" }}
            />

            {step3Error && <div style={{ color: "#dc2626", fontSize: 12 }}>{step3Error}</div>}
            <button
              className="btn btn-primary"
              onClick={handleDeploy}
              disabled={step3Submitting || !createdArtifact}
              style={{ alignSelf: "flex-start" }}
            >
              {step3Submitting ? "Deploying..." : "Deploy"}
            </button>
          </div>
        )}

        {deploymentId && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Deployment status indicator */}
            {deploymentStatus && deploymentStatus !== "succeeded" && deploymentStatus !== "failed" && deploymentStatus !== "rolled_back" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--agent-text-muted)" }}>
                <span className="v2-envoy-spinner" style={{ width: 14, height: 14, border: "2px solid rgba(99,225,190,0.2)", borderTopColor: "#63e1be", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                {statusLabel[deploymentStatus] ?? "Processing..."}
              </div>
            )}

            {/* Debrief entries — live during deployment */}
            {deploymentDebrief.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Debrief
                </div>
                {deploymentDebrief.map((entry) => (
                  <div key={entry.id} style={{ fontSize: 12, color: "var(--agent-text-muted)", padding: "4px 0", borderBottom: "1px solid rgba(107,114,128,0.1)" }}>
                    <span style={{ color: entry.agent === "envoy" ? "#34d399" : "#63e1be", fontWeight: 500 }}>
                      {entry.agent === "envoy" ? "Envoy" : "Synth"}
                    </span>
                    {" \u2014 "}
                    {entry.decision}
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons */}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                className="btn btn-primary"
                onClick={() => pushPanel({
                  type: "deployment-detail",
                  title: "First Deployment",
                  params: { id: deploymentId },
                })}
              >
                View Full Detail
              </button>
              {(deploymentStatus === "succeeded" || deploymentStatus === "failed" || deploymentStatus === "rolled_back") && (
                <button className="btn btn-secondary" onClick={onComplete}>
                  Continue to Dashboard
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AlertState — delegates to NormalState with signals passed through
// ---------------------------------------------------------------------------

function AlertState({ signals, stats }: { signals: AlertSignal[]; stats: SystemState["stats"] }) {
  return <NormalState stats={stats} signals={signals} />;
}

// ---------------------------------------------------------------------------
// NormalState — v6 operational dashboard
// ---------------------------------------------------------------------------

function NormalState({ stats: _stats, signals }: { stats: SystemState["stats"]; signals?: AlertSignal[] }) {
  const { pushPanel } = useCanvas();

  const { data: _deployments } = useQuery("list:deployments", listDeployments);
  const { data: _environments } = useQuery("list:environments", listEnvironments);
  const { data: _artifacts } = useQuery("list:artifacts", listArtifacts);
  const { data: _partitions } = useQuery("list:partitions", listPartitions);
  const { data: agentContext } = useQuery("dashboard:agentContext", () => getDeploymentContext().catch(() => null));
  const { data: _healthData } = useQuery("dashboard:health", () => getHealth().catch(() => null));
  const { data: _debriefs } = useQuery("list:debriefs", () => getRecentDebrief({ limit: 50 }).catch(() => [] as DebriefEntry[]));

  const deployments = _deployments ?? [];
  const environments = _environments ?? [];
  const artifacts = _artifacts ?? [];
  const partitions = _partitions ?? [];
  const activeDeployments = deployments.filter((d) => d.status === "running" || d.status === "planning" || d.status === "approved" || d.status === "pending");
  const debriefCount = (_debriefs ?? []).length;

  // Time-ago helper
  function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* --- Synth Assessment Card --- */}
      <div className="synth-assessment-card">
        <div className="synth-assessment-header">
          <SynthMark size={28} active />
          <div>
            <div className="synth-assessment-title">Synth Assessment</div>
            <div className="synth-assessment-subtitle">
              Monitoring {artifacts.length} Artifacts · {environments.length} Environments · {partitions.length} Partitions
            </div>
          </div>
        </div>
        <div className="synth-assessment-stats">
          <div className="stat-card">
            <span className="stat-card-value">{debriefCount}</span>
            <span className="stat-card-label">Decisions today</span>
          </div>
          <div className="stat-card">
            <span className="stat-card-value">{activeDeployments.length}</span>
            <span className="stat-card-label">Active deploys</span>
          </div>
          <div className="stat-card">
            <span className="stat-card-value">{agentContext?.signals.filter((s) => s.severity === "critical").length ?? 0}</span>
            <span className="stat-card-label">Escalations</span>
          </div>
        </div>
      </div>

      {/* --- Active Signals --- */}
      {signals && signals.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="v6-section-label" style={{ marginBottom: 8 }}>Active Signals</div>
          {signals.map((signal, i) => (
            <button
              key={i}
              className="canvas-activity-row"
              style={{ borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}
              onClick={() => {
                if (signal.relatedEntity) {
                  const type = signal.relatedEntity.type;
                  if (type === "environment") pushPanel({ type: "environment-detail", title: signal.relatedEntity.name, params: { id: signal.relatedEntity.id } });
                  else if (type === "deployment") pushPanel({ type: "deployment-detail", title: "Deployment", params: { id: signal.relatedEntity.id } });
                  else if (type === "envoy") pushPanel({ type: "envoy-registry", title: "Envoys", params: {} });
                }
              }}
            >
              <span className="status-pip" style={{ background: signal.severity === "critical" ? "var(--status-failed)" : "var(--status-warning)" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500, fontSize: 13, color: "var(--text)" }}>{signal.title}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{signal.detail}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* --- Recent Deployments Table --- */}
      {deployments.length > 0 && (() => {
        const recentDeploys = [...deployments]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 8);
        return (
          <div>
            <div
              className="section-label"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>Recent Deployments</span>
              <button
                className="btn btn-secondary"
                style={{ fontSize: 11, padding: "3px 10px", textTransform: "none", letterSpacing: "normal", fontWeight: 500 }}
                onClick={() => pushPanel({ type: "deployment-list", title: "Deployments", params: {} })}
              >
                View All
              </button>
            </div>
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Artifact</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Version</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Target</th>
                    <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Status</th>
                    <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 600, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {recentDeploys.map((d) => {
                    const artName = artifacts.find((a) => a.id === d.artifactId)?.name ?? d.artifactId.slice(0, 8);
                    const envName = environments.find((e) => e.id === d.environmentId)?.name ?? d.environmentId.slice(0, 8);
                    return (
                      <tr
                        key={d.id}
                        onClick={() => pushPanel({
                          type: "deployment-detail",
                          title: `Deployment ${d.version}`,
                          params: { id: d.id },
                        })}
                        style={{
                          borderBottom: "1px solid var(--border)",
                          cursor: "pointer",
                          background: "var(--surface)",
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "color-mix(in srgb, var(--accent) 4%, var(--surface))"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--surface)"; }}
                      >
                        <td style={{ padding: "10px 12px", fontWeight: 500, color: "var(--text)" }}>{artName}</td>
                        <td style={{ padding: "10px 12px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>v{d.version}</td>
                        <td style={{ padding: "10px 12px", color: "var(--text-muted)" }}>{envName}</td>
                        <td style={{ padding: "10px 12px" }}><StatusBadge status={d.status} /></td>
                        <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--text-muted)", fontSize: 12 }}>{timeAgo(d.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {deployments.length === 0 && artifacts.length === 0 && (
        <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--text-muted)", fontSize: 14 }}>
          No deployment activity yet. Use the Synth Channel below to get started.
        </div>
      )}
    </div>
  );
}
