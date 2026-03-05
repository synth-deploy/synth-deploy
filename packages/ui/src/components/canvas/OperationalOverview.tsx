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
import SectionHeader from "../SectionHeader.js";
import CommandEye from "../CommandEye.js";
import DeploymentParticles from "../DeploymentParticles.js";

// ---------------------------------------------------------------------------
// Top-level state-driven router
// ---------------------------------------------------------------------------

export default function OperationalOverview() {
  const [systemState, setSystemState] = useState<SystemState | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchState = () =>
    getSystemState()
      .then(setSystemState)
      .catch(() => {});

  useEffect(() => {
    fetchState().then(() => setLoading(false));

    const interval = setInterval(fetchState, 30000);

    const onFocus = () => fetchState();
    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (loading) return <div className="loading">Loading...</div>;
  if (!systemState) return <div className="loading">Failed to load system state.</div>;

  switch (systemState.state) {
    case "empty":
      return <EmptyState onComplete={fetchState} />;
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
        <CommandEye />
        <h2 style={{ color: "var(--agent-text)", fontSize: 22, fontWeight: 700, marginTop: 16, marginBottom: 8 }}>
          Welcome to DeployStack
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
              An artifact is what you&rsquo;re deploying &mdash; a container image, package, binary, or config bundle. DeployStack will analyze it.
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
                Install and start an envoy on your target machine. It will connect back to this DeployStack instance automatically.
              </div>
              <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 12, color: "#63e1be", background: "rgba(0,0,0,0.3)", padding: "8px 12px", borderRadius: 6, wordBreak: "break-all" }}>
                npx @deploystack/envoy --command-url {window.location.origin}
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
            <span className="v2-command-status-badge" style={{ fontSize: 10 }}>OK</span>
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
                : "Deploy your artifact. DeployStack will analyze it, generate a plan, and execute it."}
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
                      {entry.agent === "envoy" ? "Envoy" : "Command"}
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
// AlertState — leads with actionable signals, then shows NormalState below
// ---------------------------------------------------------------------------

function AlertState({ signals, stats }: { signals: AlertSignal[]; stats: SystemState["stats"] }) {
  const { pushPanel } = useCanvas();

  return (
    <div className="v2-dashboard">
      {/* Alert banner */}
      <div style={{
        background: "rgba(220, 38, 38, 0.08)",
        border: "1px solid rgba(220, 38, 38, 0.25)",
        borderRadius: 8,
        padding: "16px",
        marginBottom: 16,
      }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: "#dc2626", marginBottom: 8 }}>
          Attention Required
        </div>
        <div style={{ fontSize: 13, color: "var(--agent-text-muted)" }}>
          {signals.length} signal{signals.length !== 1 ? "s" : ""} need review
        </div>
      </div>

      {/* Signal cards — each clickable for drill-in */}
      {signals.map((signal, i) => {
        const severityColor = signal.severity === "critical" ? "#dc2626" : "#f59e0b";
        return (
          <div
            key={i}
            onClick={() => {
              if (signal.relatedEntity) {
                const type = signal.relatedEntity.type;
                if (type === "environment") {
                  pushPanel({ type: "environment-detail", title: signal.relatedEntity.name, params: { id: signal.relatedEntity.id } });
                } else if (type === "deployment") {
                  pushPanel({ type: "deployment-detail", title: "Deployment", params: { id: signal.relatedEntity.id } });
                } else if (type === "envoy") {
                  pushPanel({ type: "envoy-registry", title: "Envoys", params: {} });
                }
              }
            }}
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "12px 16px", borderRadius: 8,
              border: `1px solid ${severityColor}30`,
              background: `${severityColor}08`,
              cursor: signal.relatedEntity ? "pointer" : "default",
              marginBottom: 8,
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: severityColor, flexShrink: 0,
            }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--agent-text)" }}>
                {signal.title}
              </div>
              <div style={{ fontSize: 12, color: "var(--agent-text-muted)", marginTop: 2 }}>
                {signal.detail}
              </div>
            </div>
            {signal.relatedEntity && (
              <span style={{ fontSize: 11, color: "var(--agent-text-muted)" }}>
                {signal.relatedEntity.name} &rarr;
              </span>
            )}
          </div>
        );
      })}

      {/* Still show deployment authoring below signals */}
      <div style={{ marginTop: 24 }}>
        <NormalState stats={stats} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NormalState — artifact-centric dashboard
// ---------------------------------------------------------------------------

function NormalState({ stats: _stats }: { stats: SystemState["stats"] }) {
  const { pushPanel } = useCanvas();
  const { settings } = useSettings();
  const environmentsEnabled = settings?.environmentsEnabled ?? true;

  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [envoys, setEnvoys] = useState<EnvoyRegistryEntry[]>([]);
  const [debriefEntries, setDebriefEntries] = useState<DebriefEntry[]>([]);
  const [agentContext, setAgentContext] = useState<DeploymentContext | null>(null);
  const [commandStatus, setCommandStatus] = useState<string>("observing");
  const [signalsExpanded, setSignalsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // Inline deployment authoring state
  const [deployArtifactId, setDeployArtifactId] = useState("");
  const [deployEnvId, setDeployEnvId] = useState("");
  const [deployPartitionId, setDeployPartitionId] = useState("");
  const [deployVersion, setDeployVersion] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    Promise.all([
      listDeployments(),
      listPartitions(),
      listEnvironments(),
      listArtifacts(),
      listEnvoys().catch(() => []),
      getRecentDebrief({ limit: 10 }),
      getDeploymentContext().catch(() => null),
      getHealth().catch(() => null),
    ])
      .then(([d, parts, envs, arts, envoyList, db, ctx, health]) => {
        setDeployments(d);
        setPartitions(parts);
        setEnvironments(envs);
        setArtifacts(arts);
        setEnvoys(envoyList);
        setDebriefEntries(db);
        setAgentContext(ctx);
        if (health) setCommandStatus("observing");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function handleInlineDeploy() {
    if (!deployArtifactId || (environmentsEnabled && !deployEnvId)) return;
    setDeploying(true);
    setDeployError(null);
    try {
      const result = await createDeployment({
        artifactId: deployArtifactId,
        environmentId: environmentsEnabled ? deployEnvId : undefined,
        partitionId: deployPartitionId || undefined,
        version: deployVersion.trim() || undefined,
      });
      setDeploying(false);
      pushPanel({
        type: "deployment-detail",
        title: `Deployment ${result.deployment.version || result.deployment.id.slice(0, 8)}`,
        params: { id: result.deployment.id },
      });
    } catch (e: unknown) {
      setDeployError(e instanceof Error ? e.message : String(e));
      setDeploying(false);
    }
  }

  const healthyEnvoyCount = envoys.filter((e) => e.health === "OK").length;

  if (loading) return <div className="loading">Loading...</div>;

  const activeDeployments = deployments.filter(
    (d) => d.status === "running" || d.status === "pending",
  );
  const debriefCount = debriefEntries.length;

  // Debrief status helpers
  const debriefStatusIcons: Record<string, { icon: string; color: string; bg: string }> = {
    complete: { icon: "\u2713", color: "#34d399", bg: "rgba(52,211,153,0.1)" },
    escalated: { icon: "\u2191", color: "#f87171", bg: "rgba(248,113,113,0.1)" },
    decision: { icon: "\u25C6", color: "#63e1be", bg: "rgba(99,225,190,0.1)" },
  };

  function getDebriefStatus(entry: DebriefEntry): string {
    if (entry.decisionType === "deployment-failure" || entry.decisionType === "diagnostic-investigation") return "escalated";
    if (entry.decisionType === "deployment-completion") return "complete";
    return "decision";
  }

  function getDebriefRouting(entry: DebriefEntry): string {
    if (entry.decisionType === "deployment-failure") return "\u2192 Command";
    if (entry.decisionType === "deployment-completion") return "filed";
    return "held";
  }

  return (
    <div className="v2-dashboard">
      <div className="v2-breadcrumb">
        {settings?.coBranding ? (
          <span className="v2-breadcrumb-logo v2-cobranding-logo">
            <img
              src={settings.coBranding.logoUrl}
              alt={settings.coBranding.operatorName}
              className="v2-cobranding-img"
            />
            <span
              className="v2-cobranding-name"
              style={settings.coBranding.accentColor ? { color: settings.coBranding.accentColor } : undefined}
            >
              {settings.coBranding.operatorName}
            </span>
            <span className="v2-cobranding-powered-by">by DeployStack</span>
          </span>
        ) : (
          <span className="v2-breadcrumb-logo">DeployStack</span>
        )}
      </div>

      {/* Command status card */}
      <div className="v2-command-card">
        <div className="v2-command-card-glow" />
        <div className="v2-command-card-content">
          <CommandEye />
          <div className="v2-command-info">
            <div className="v2-command-title-row">
              <span className="v2-command-label">Command</span>
              <div className="v2-command-status-badge">
                <span>{commandStatus.toUpperCase()}</span>
              </div>
            </div>
            <div className="v2-command-subtitle">
              Monitoring {artifacts.length} Artifacts &middot; {environments.length} Environments &middot; {partitions.length} Partitions
            </div>
            <div className="v2-command-stats">
              <div className="v2-command-stat">
                <span className="v2-command-stat-value">{debriefCount}</span>
                <span className="v2-command-stat-label">Decisions today</span>
              </div>
              <div className="v2-command-stat">
                <span className="v2-command-stat-value">{activeDeployments.length}</span>
                <span className="v2-command-stat-label">Active deploys</span>
              </div>
              <div className="v2-command-stat">
                <span className="v2-command-stat-value">{agentContext?.signals.filter((s) => s.severity === "critical").length ?? 0}</span>
                <span className="v2-command-stat-label">Escalations</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Active signals section — collapsible */}
      {agentContext && agentContext.signals.length > 0 && (
        <>
          <div
            className="v2-signals-collapse-header"
            onClick={() => setSignalsExpanded(!signalsExpanded)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 16px",
              cursor: "pointer",
              borderRadius: 8,
              border: "1px solid var(--agent-border)",
              background: "var(--agent-card-bg)",
              marginBottom: signalsExpanded ? 8 : 0,
              userSelect: "none",
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: "50%",
              background: agentContext.signals.some(s => s.severity === "critical") ? "#dc2626"
                : agentContext.signals.some(s => s.severity === "warning") ? "#f59e0b" : "#2563eb",
              flexShrink: 0,
            }} />
            <span style={{ fontWeight: 600, fontSize: 13, color: "var(--agent-text)" }}>
              Active Signals
            </span>
            <span style={{
              fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)",
              background: "rgba(255,255,255,0.06)", padding: "2px 8px", borderRadius: 10,
            }}>
              {agentContext.signals.length}
            </span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--agent-text-muted)" }}>
              {signalsExpanded ? "\u25B2" : "\u25BC"}
            </span>
          </div>
          {signalsExpanded && (
            <div className="v2-signals-list" style={{ gap: 4 }}>
              {agentContext.signals.map((signal, i) => {
                const severityColor =
                  signal.severity === "critical" ? "#dc2626"
                  : signal.severity === "warning" ? "#f59e0b"
                  : "#2563eb";
                return (
                  <div
                    key={i}
                    className={`v2-signal-compact v2-signal-${signal.severity}`}
                    onClick={() =>
                      pushPanel({
                        type: "signal-detail",
                        title: signal.title,
                        params: { signal: JSON.stringify(signal) },
                      })
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--agent-border)",
                      background: "var(--agent-card-bg)",
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%",
                      background: severityColor, flexShrink: 0,
                    }} />
                    <span style={{ fontWeight: 500, color: "var(--agent-text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {signal.title}
                    </span>
                    {signal.relatedEntity && (
                      <span style={{ fontSize: 11, color: "var(--agent-text-muted)", flexShrink: 0 }}>
                        {signal.relatedEntity.name}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Inline Deployment Authoring — front and center */}
      <div style={{
        border: "1px solid rgba(99, 225, 190, 0.2)",
        borderRadius: 10,
        padding: 20,
        background: "rgba(99, 225, 190, 0.03)",
        marginBottom: 16,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: "var(--agent-text)" }}>Deploy</div>
            <div style={{ fontSize: 12, color: "var(--agent-text-muted)" }}>
              Select what and where &mdash; DeployStack handles the rest
            </div>
          </div>
          <button
            className="btn btn-secondary"
            onClick={() => pushPanel({ type: "deployment-authoring", title: "Deploy", params: {} })}
            style={{ fontSize: 11 }}
          >
            Full View
          </button>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          {/* Artifact */}
          <div style={{ flex: "1 1 180px", minWidth: 0 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
              Artifact
            </label>
            <select
              value={deployArtifactId}
              onChange={(e) => setDeployArtifactId(e.target.value)}
              style={{ width: "100%", fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--agent-border)", background: "var(--agent-bg)", color: "var(--agent-text)" }}
            >
              <option value="">Select...</option>
              {artifacts.map((art) => (
                <option key={art.id} value={art.id}>
                  {art.name} ({art.type})
                </option>
              ))}
            </select>
          </div>

          {/* Environment */}
          {environmentsEnabled && (
            <div style={{ flex: "1 1 160px", minWidth: 0 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
                Environment
              </label>
              <select
                value={deployEnvId}
                onChange={(e) => setDeployEnvId(e.target.value)}
                style={{ width: "100%", fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--agent-border)", background: "var(--agent-bg)", color: "var(--agent-text)" }}
              >
                <option value="">Select...</option>
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>{env.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Partition (optional) */}
          {partitions.length > 0 && (
            <div style={{ flex: "1 1 140px", minWidth: 0 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
                Partition
              </label>
              <select
                value={deployPartitionId}
                onChange={(e) => setDeployPartitionId(e.target.value)}
                style={{ width: "100%", fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--agent-border)", background: "var(--agent-bg)", color: "var(--agent-text)" }}
              >
                <option value="">None</option>
                {partitions.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Version */}
          <div style={{ flex: "0 1 110px", minWidth: 0 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
              Version
            </label>
            <input
              placeholder="1.0.0"
              value={deployVersion}
              onChange={(e) => setDeployVersion(e.target.value)}
              style={{ width: "100%", fontSize: 13, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--agent-border)", background: "var(--agent-bg)", color: "var(--agent-text)" }}
            />
          </div>

          {/* Deploy button */}
          <button
            className="btn btn-primary"
            onClick={handleInlineDeploy}
            disabled={deploying || !deployArtifactId || (environmentsEnabled && !deployEnvId)}
            style={{ flexShrink: 0, whiteSpace: "nowrap" }}
          >
            {deploying ? "Deploying..." : "Deploy"}
          </button>
        </div>

        {/* Selected artifact analysis preview */}
        {deployArtifactId && (() => {
          const art = artifacts.find((a) => a.id === deployArtifactId);
          return art?.analysis.summary ? (
            <div style={{ fontSize: 12, color: "var(--agent-text-muted)", marginTop: 8, padding: "6px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 6, borderLeft: "2px solid rgba(99,225,190,0.3)" }}>
              {art.analysis.summary}
            </div>
          ) : null;
        })()}

        {deployError && <div style={{ color: "#dc2626", fontSize: 12, marginTop: 8 }}>{deployError}</div>}
      </div>

      {/* Recent Deployments */}
      {deployments.length > 0 && (() => {
        const recentDeploys = [...deployments]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 8);
        return (
          <>
            <SectionHeader
              color="#f59e0b"
              shape="square"
              label="Recent Deployments"
              subtitle="latest activity"
              count={deployments.length}
              onClick={() => pushPanel({ type: "deployment-list", title: "Deployments", params: {} })}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16 }}>
              {recentDeploys.map((d) => {
                const artName = artifacts.find((a) => a.id === d.artifactId)?.name ?? d.artifactId.slice(0, 8);
                const envName = environments.find((e) => e.id === d.environmentId)?.name ?? d.environmentId.slice(0, 8);
                return (
                  <div
                    key={d.id}
                    onClick={() => pushPanel({
                      type: "deployment-detail",
                      title: `Deployment ${d.version}`,
                      params: { id: d.id },
                    })}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "8px 12px", borderRadius: 6,
                      border: "1px solid var(--agent-border)", background: "var(--agent-card-bg)",
                      cursor: "pointer", fontSize: 13,
                    }}
                  >
                    <span className={`badge badge-${d.status}`} style={{ fontSize: 10 }}>{d.status}</span>
                    <span style={{ fontWeight: 500, color: "var(--agent-text)" }}>{artName}</span>
                    <span style={{ color: "var(--agent-text-muted)" }}>v{d.version}</span>
                    <span style={{ color: "var(--agent-text-muted)", fontSize: 11 }}>&rarr; {envName}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--agent-text-muted)" }}>
                      {new Date(d.createdAt).toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* Artifacts section */}
      <SectionHeader
        color="#6b7280"
        shape="square"
        label="Artifacts"
        subtitle="what you're deploying"
        count={artifacts.length}
        onClick={() =>
          pushPanel({ type: "artifact-catalog", title: "Artifact Catalog", params: {} })
        }
      />
      <div className="v2-artifacts-grid">
        {artifacts.map((art) => (
          <div
            key={art.id}
            className="v2-artifact-card"
            onClick={() =>
              pushPanel({
                type: "artifact-detail",
                title: art.name,
                params: { artifactId: art.id },
              })
            }
          >
            <div className="v2-artifact-card-grid-bg" />
            <div className="v2-artifact-card-inner">
              <div className="v2-artifact-id">{art.type}</div>
              <div className="v2-artifact-name">{art.name}</div>
              <div className="v2-artifact-meta">
                {art.analysis.summary
                  ? art.analysis.summary.slice(0, 60) + (art.analysis.summary.length > 60 ? "..." : "")
                  : "Pending analysis"}
              </div>
            </div>
          </div>
        ))}
        {artifacts.length === 0 && (
          <div className="v2-empty-hint">No artifacts yet. Use the Command Channel to add one.</div>
        )}
      </div>

      {/* Deployment particles */}
      {activeDeployments.length > 0 && (
        <div className="v2-deployment-particles-section">
          <span className="v2-particles-label">
            Deployments &mdash; routing Artifacts to Envoys
          </span>
          <DeploymentParticles />
          <div className="v2-active-deploys-row">
            {activeDeployments.slice(0, 4).map((d) => {
              const artName =
                artifacts.find((a) => a.id === d.artifactId)?.name ?? d.artifactId.slice(0, 8);
              const envName =
                environments.find((e) => e.id === d.environmentId)?.name ?? d.environmentId.slice(0, 8);
              return (
                <div
                  key={d.id}
                  className="v2-active-deploy-tag"
                  onClick={() =>
                    pushPanel({
                      type: "deployment-detail",
                      title: `Deployment ${d.version}`,
                      params: { id: d.id },
                    })
                  }
                >
                  {artName} v{d.version} &rarr; {envName}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ height: 24 }} />

      {/* Partitions section */}
      <SectionHeader
        color="#818cf8"
        shape="hollow"
        label="Partitions"
        subtitle="isolated boundaries, each walled off"
        count={partitions.length}
        onClick={() =>
          pushPanel({ type: "partition-list", title: "Partitions", params: {} })
        }
      />
      <div className="v2-partitions-grid">
        {partitions.map((p) => {
          const deployCount = deployments.filter((d) => d.partitionId === p.id).length;
          const isDormant = Object.keys(p.variables).length === 0 && deployCount === 0;
          return (
            <div
              key={p.id}
              className={`v2-partition-card ${isDormant ? "v2-partition-dormant" : ""}`}
              onClick={() => {
                if (!isDormant) {
                  pushPanel({
                    type: "partition-detail",
                    title: p.name,
                    params: { id: p.id },
                  });
                }
              }}
            >
              {!isDormant && (
                <>
                  <div className="v2-partition-barrier-top" />
                  <div className="v2-partition-barrier-bottom" />
                </>
              )}
              <div className="v2-partition-name">{p.name}</div>
              <div className="v2-partition-envs">
                {environments.map((e) => (
                  <div
                    key={e.id}
                    className={`v2-partition-env-badge ${isDormant ? "v2-partition-env-dormant" : ""}`}
                  >
                    {e.name}
                  </div>
                ))}
              </div>
              <div className="v2-partition-meta">
                {isDormant
                  ? "Dormant"
                  : `${deployCount} deployment${deployCount !== 1 ? "s" : ""}`}
              </div>
            </div>
          );
        })}
        {partitions.length === 0 && (
          <div className="v2-empty-hint">No partitions yet.</div>
        )}
      </div>

      {/* Envoys section — shown as deployment context summary */}
      <SectionHeader
        color="#34d399"
        shape="circle"
        label="Envoys"
        subtitle={`${healthyEnvoyCount} healthy / ${envoys.length} total`}
        onClick={() =>
          pushPanel({ type: "envoy-registry", title: "Envoys", params: {} })
        }
      />
      <div className="v2-envoys-list">
        {agentContext?.environmentSummary.map((envSummary) => {
          const isExecuting = deployments.some(
            (d) => d.environmentId === envSummary.id && d.status === "running",
          );
          const statusCfg = isExecuting
            ? { color: "#63e1be", bg: "rgba(99,225,190,0.04)", border: "rgba(99,225,190,0.2)", label: "EXECUTING" }
            : { color: "#6b7280", bg: "rgba(15,20,30,0.4)", border: "rgba(107,114,128,0.12)", label: "READY" };
          return (
            <div
              key={envSummary.id}
              className="v2-envoy-row"
              style={{ background: statusCfg.bg, borderColor: statusCfg.border }}
              onClick={() =>
                pushPanel({
                  type: "environment-detail",
                  title: envSummary.name,
                  params: { id: envSummary.id },
                })
              }
            >
              <div className="v2-envoy-indicator">
                <div
                  className="v2-envoy-ring"
                  style={{
                    borderColor: statusCfg.color,
                    opacity: isExecuting
                      ? 0.3 + 0.3 * Math.sin(tick * 0.1)
                      : 0.15,
                  }}
                />
                {isExecuting && (
                  <div className="v2-envoy-spinner" style={{ borderTopColor: statusCfg.color }} />
                )}
                <div
                  className="v2-envoy-dot"
                  style={{
                    background: statusCfg.color,
                    opacity: isExecuting ? 0.8 : 0.3,
                  }}
                />
              </div>
              <div className="v2-envoy-info">
                <div className="v2-envoy-name-row">
                  <span className="v2-envoy-env-name">{envSummary.name}</span>
                  <span className="v2-envoy-deploy-count">{envSummary.deployCount} deploys</span>
                </div>
                <div className="v2-envoy-last-status">
                  {envSummary.lastDeployStatus
                    ? `Last: ${envSummary.lastDeployStatus}`
                    : "No deploys yet"}
                </div>
              </div>
              <div className="v2-envoy-status-pill" style={{ color: statusCfg.color, borderColor: `${statusCfg.color}30`, background: `${statusCfg.color}15` }}>
                {statusCfg.label}
              </div>
            </div>
          );
        })}
        {(!agentContext || agentContext.environmentSummary.length === 0) && (
          <div className="v2-empty-hint">No environments configured.</div>
        )}
      </div>

      {/* Debriefs section */}
      <SectionHeader
        color="#e879f9"
        shape="diamond"
        label="Debriefs"
        subtitle="reasoned records, handed off"
        onClick={() =>
          pushPanel({ type: "debrief", title: "Debrief", params: {} })
        }
      />
      <div className="v2-debriefs-list">
        {debriefEntries.slice(0, 5).map((entry) => {
          const status = getDebriefStatus(entry);
          const s = debriefStatusIcons[status] ?? debriefStatusIcons.decision;
          const routing = getDebriefRouting(entry);
          const partName =
            partitions.find((t) => t.id === entry.partitionId)?.name ?? "System";
          const statusBarColor =
            status === "escalated"
              ? "linear-gradient(180deg, #f87171, rgba(248,113,113,0.2))"
              : status === "complete"
                ? "linear-gradient(180deg, #34d399, rgba(52,211,153,0.2))"
                : "linear-gradient(180deg, #63e1be, rgba(99,225,190,0.2))";
          return (
            <div key={entry.id} className="v2-debrief-row">
              <div
                className="v2-debrief-status-bar"
                style={{ background: statusBarColor }}
              />
              <div className="v2-debrief-content">
                <div className="v2-debrief-icon" style={{ background: s.bg }}>
                  <span style={{ color: s.color }}>{s.icon}</span>
                </div>
                <div className="v2-debrief-body">
                  <div className="v2-debrief-header">
                    <span className="v2-debrief-time">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                    </span>
                    <span className="v2-debrief-from">
                      {entry.agent === "envoy" ? `Envoy \u203A ${partName}` : "Command"}
                    </span>
                    <span
                      className="v2-debrief-routing"
                      style={{
                        color: routing === "\u2192 Command" ? "#f87171" : "#6b7280",
                        background: routing === "\u2192 Command" ? "rgba(248,113,113,0.08)" : "rgba(107,114,128,0.08)",
                        borderColor: routing === "\u2192 Command" ? "rgba(248,113,113,0.15)" : "rgba(107,114,128,0.1)",
                      }}
                    >
                      {routing}
                    </span>
                  </div>
                  <div className="v2-debrief-summary">{entry.decision}</div>
                </div>
              </div>
            </div>
          );
        })}
        {debriefEntries.length === 0 && (
          <div className="v2-empty-hint">No debrief entries yet.</div>
        )}
      </div>

      {deployments.length === 0 && partitions.length === 0 && artifacts.length === 0 && (
        <div className="v2-empty-state">
          <p>No data yet. Use the Command Channel below to get started.</p>
        </div>
      )}
    </div>
  );
}
