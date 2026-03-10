import { useState, useRef } from "react";
import {
  listArtifacts,
  listPartitions,
  listEnvironments,
  listEnvoys,
  createDeployment,
  recordPreFlightResponse,
  queryAgent,
} from "../../api.js";
import type { Artifact, Partition, Environment } from "../../types.js";
import type { EnvoyRegistryEntry, PreFlightContext } from "../../api.js";
import { useSettings } from "../../context/SettingsContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import { useCanvas } from "../../context/CanvasContext.js";
import ConfidenceIndicator from "../ConfidenceIndicator.js";
import SynthMark from "../SynthMark.js";
import PreFlightDisplay from "./PreFlightDisplay.js";
import { useQuery } from "../../hooks/useQuery.js";

interface Props {
  title: string;
  preselectedArtifactId?: string;
  preselectedEnvironmentId?: string;
  preselectedPartitionId?: string;
}

type DeployScope = "environment" | "envoy" | "partition";

export default function DeploymentAuthoringPanel({ title, preselectedArtifactId, preselectedEnvironmentId, preselectedPartitionId }: Props) {
  const { pushPanel } = useCanvas();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const { data: artifacts, loading: l1 } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const { data: partitions, loading: l2 } = useQuery<Partition[]>("list:partitions", listPartitions);
  const { data: environments, loading: l3 } = useQuery<Environment[]>("list:environments", listEnvironments);
  const { data: envoys, loading: l4 } = useQuery<EnvoyRegistryEntry[]>("list:envoys", () => listEnvoys().catch(() => [] as EnvoyRegistryEntry[]));
  const loading = l1 || l2 || l3 || l4;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>(
    preselectedArtifactId ? [preselectedArtifactId] : [],
  );
  const [deployScope, setDeployScope] = useState<DeployScope>(
    preselectedPartitionId ? "partition" : "environment",
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>(preselectedEnvironmentId ?? "");
  const [selectedPartitionId, setSelectedPartitionId] = useState<string>(preselectedPartitionId ?? "");
  const [selectedEnvoyId, setSelectedEnvoyId] = useState<string>("");
  const [preFlightRec, setPreFlightRec] = useState<PreFlightContext["recommendation"] | null>(null);

  const [askQuestion, setAskQuestion] = useState("");
  const [askTyping, setAskTyping] = useState(false);
  const [askResponse, setAskResponse] = useState<string | null>(null);
  const askConvId = useRef(crypto.randomUUID());

  function toggleArtifact(id: string) {
    setSelectedArtifactIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  }

  const primaryArtifactId = selectedArtifactIds[0] ?? "";
  const hasTarget = !!(selectedEnvironmentId || selectedPartitionId || selectedEnvoyId);

  async function handleRequestPlan() {
    if (!primaryArtifactId || (environmentsEnabled && !hasTarget)) return;
    setSubmitting(true);
    setError(null);

    try {
      if (preFlightRec) {
        recordPreFlightResponse({
          artifactId: primaryArtifactId,
          environmentId: selectedEnvironmentId,
          partitionId: selectedPartitionId || undefined,
          action: "proceeded",
          recommendedAction: preFlightRec.action,
        }).catch(() => {});
      }

      const result = await createDeployment({
        artifactId: primaryArtifactId,
        environmentId: selectedEnvironmentId || undefined,
        partitionId: selectedPartitionId || undefined,
      });

      pushPanel({
        type: "plan-review",
        title: `Review Plan`,
        params: { id: result.deployment.id },
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAsk() {
    if (!askQuestion.trim()) return;
    const q = askQuestion.trim();
    setAskTyping(true);
    setAskResponse(null);
    setAskQuestion("");
    try {
      const result = await queryAgent(q, askConvId.current);
      setAskResponse(result.title ?? "Let me look into that.");
    } catch {
      setAskResponse("Unable to reach the agent right now.");
    } finally {
      setAskTyping(false);
    }
  }

  function getOverallHealth(): "healthy" | "degraded" | "unhealthy" {
    const list = envoys ?? [];
    if (list.some((e) => e.health === "Unreachable")) return "unhealthy";
    if (list.some((e) => e.health === "Degraded")) return "degraded";
    return "healthy";
  }

  function getTargetName(): string {
    if (deployScope === "environment") {
      return (environments ?? []).find((e) => e.id === selectedEnvironmentId)?.name ?? "";
    }
    if (deployScope === "envoy") {
      const envoy = (envoys ?? []).find((e) => e.id === selectedEnvoyId);
      return envoy?.hostname ?? envoy?.url ?? "";
    }
    if (deployScope === "partition") {
      return (partitions ?? []).find((p) => p.id === selectedPartitionId)?.name ?? "";
    }
    return "";
  }

  function getContextHint(): string {
    const envoyCount = (envoys ?? []).length;
    const targetName = getTargetName();
    if (deployScope === "environment" && selectedEnvironmentId) {
      return `Synth will coordinate deployment across all ${envoyCount} envoy${envoyCount !== 1 ? "s" : ""} in ${targetName}. A representative plan will be generated for your review.`;
    }
    if (deployScope === "envoy" && selectedEnvoyId) {
      return `Deploying directly to ${targetName}. The envoy will produce a plan specific to this host.`;
    }
    if (deployScope === "partition" && selectedPartitionId) {
      return `Deploying across all environments in ${targetName}. Partition-scoped variables will be applied. Synth will generate plans per environment.`;
    }
    return "";
  }

  if (loading) {
    return (
      <CanvasPanelHost title={title} noBreadcrumb>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );
  }

  const envoyList = envoys ?? [];
  const envList = environments ?? [];
  const partList = partitions ?? [];
  const artList = artifacts ?? [];

  const selectedArtifactObjects = selectedArtifactIds
    .map((id) => artList.find((a) => a.id === id))
    .filter(Boolean) as Artifact[];

  const canDeploy = selectedArtifactIds.length > 0 && hasTarget;
  const contextHint = getContextHint();

  return (
    <CanvasPanelHost title={title} noBreadcrumb>
      <div style={{ padding: "0 4px" }}>
        {error && <div className="error-msg">{error}</div>}

        {/* Page title */}
        <div style={{ marginBottom: 22 }}>
          <h1 className="v6-page-title">New Deployment</h1>
          <p className="v6-page-subtitle">
            Select what and where. Synth and the envoy figure out how.
          </p>
        </div>

        {/* Two-column layout */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)", gap: 22 }}>
          {/* WHAT column */}
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <div className="section-label">What</div>
              {selectedArtifactIds.length > 1 && (
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                  }}
                >
                  {selectedArtifactIds.length} artifacts · coordinated deploy
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {artList.map((art) => {
                const isSelected = selectedArtifactIds.includes(art.id);
                return (
                  <div
                    key={art.id}
                    onClick={() => toggleArtifact(art.id)}
                    className={`nd-artifact-card${isSelected ? " nd-artifact-card-selected" : ""}`}
                  >
                    <span
                      className={`nd-artifact-check${isSelected ? " nd-artifact-check-selected" : ""}`}
                    >
                      {isSelected ? "✓" : ""}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                          {art.name}
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {art.type}
                        </span>
                      </div>
                      {art.analysis.summary && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            marginTop: 2,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {art.analysis.summary}
                        </div>
                      )}
                      <div style={{ marginTop: 3 }}>
                        <ConfidenceIndicator
                          value={art.analysis.confidence}
                          qualifier="understanding"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}

              {artList.length === 0 && (
                <div className="nd-empty">No artifacts registered</div>
              )}
            </div>
          </div>

          {/* WHERE column */}
          {environmentsEnabled && (
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 10,
                }}
              >
                <div className="section-label">Where</div>
              </div>

              {/* Scope tabs */}
              <div
                className="segmented-control"
                style={{ width: "100%", marginBottom: 10 }}
              >
                {(
                  [
                    { id: "environment" as DeployScope, label: "Environment" },
                    { id: "envoy" as DeployScope, label: "Envoy" },
                    { id: "partition" as DeployScope, label: "Partition" },
                  ]
                ).map((s) => (
                  <button
                    key={s.id}
                    className={`segmented-control-btn${deployScope === s.id ? " segmented-control-btn-active" : ""}`}
                    style={{ flex: 1, justifyContent: "center" }}
                    onClick={() => {
                      setDeployScope(s.id);
                      setSelectedEnvironmentId("");
                      setSelectedPartitionId("");
                      setSelectedEnvoyId("");
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              {/* Target list */}
              <div className="nd-target-list">
                {/* Environment scope */}
                {deployScope === "environment" &&
                  envList.map((env) => {
                    const active = selectedEnvironmentId === env.id;
                    return (
                      <div
                        key={env.id}
                        onClick={() => {
                          setSelectedEnvironmentId(active ? "" : env.id);
                          setSelectedPartitionId("");
                          setSelectedEnvoyId("");
                        }}
                        className={`nd-target-row${active ? " nd-target-row-selected" : ""}`}
                      >
                        <span className={`status-pip status-pip-${getOverallHealth()}`} />
                        <div style={{ flex: 1 }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                            {env.name}
                          </span>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                            {envoyList.length} envoy{envoyList.length !== 1 ? "s" : ""}
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {envoyList.length} target{envoyList.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    );
                  })}

                {/* Envoy scope */}
                {deployScope === "envoy" &&
                  envoyList.map((envoy) => {
                    const active = selectedEnvoyId === envoy.id;
                    const health =
                      envoy.health === "OK"
                        ? "healthy"
                        : envoy.health === "Degraded"
                          ? "degraded"
                          : "unhealthy";
                    return (
                      <div
                        key={envoy.id}
                        onClick={() => {
                          setSelectedEnvoyId(active ? "" : envoy.id);
                          setSelectedEnvironmentId("");
                          setSelectedPartitionId("");
                        }}
                        className={`nd-target-row${active ? " nd-target-row-selected" : ""}`}
                      >
                        <span className={`status-pip status-pip-${health}`} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              color: "var(--text)",
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {envoy.hostname ?? envoy.url}
                          </span>
                          {envoy.lastSeen && (
                            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                              {envoy.lastSeen}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                {/* Partition scope */}
                {deployScope === "partition" &&
                  partList.map((part) => {
                    const active = selectedPartitionId === part.id;
                    const varCount = Object.keys(part.variables).length;
                    return (
                      <div
                        key={part.id}
                        onClick={() => {
                          setSelectedPartitionId(active ? "" : part.id);
                          setSelectedEnvironmentId("");
                          setSelectedEnvoyId("");
                        }}
                        className={`nd-target-row${active ? " nd-target-row-selected" : ""}`}
                      >
                        <span className="status-pip status-pip-healthy" />
                        <div style={{ flex: 1 }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                            {part.name}
                          </span>
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
                            {varCount} scoped variable{varCount !== 1 ? "s" : ""}
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {envoyList.length} envoy{envoyList.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    );
                  })}

                {deployScope === "environment" && envList.length === 0 && (
                  <div className="nd-empty">No environments configured</div>
                )}
                {deployScope === "envoy" && envoyList.length === 0 && (
                  <div className="nd-empty">No envoys connected</div>
                )}
                {deployScope === "partition" && partList.length === 0 && (
                  <div className="nd-empty">No partitions configured</div>
                )}
              </div>

              {/* Context hint */}
              {contextHint && <div className="nd-context-hint">{contextHint}</div>}
            </div>
          )}
        </div>

        {/* Pre-flight (auto-fetched when artifact + environment selected) */}
        {primaryArtifactId && (!environmentsEnabled || selectedEnvironmentId) && (
          <PreFlightDisplay
            artifactId={primaryArtifactId}
            environmentId={selectedEnvironmentId}
            partitionId={selectedPartitionId || undefined}
            version={undefined}
            onLoaded={(rec) => setPreFlightRec(rec)}
          />
        )}

        {/* Deploy action bar */}
        {canDeploy && (
          <div className="nd-action-bar">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <SynthMark size={20} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                    {selectedArtifactObjects.length === 1 ? (
                      <>
                        {selectedArtifactObjects[0].name} → {getTargetName()}
                      </>
                    ) : (
                      <>
                        {selectedArtifactObjects.length} artifacts → {getTargetName()}
                      </>
                    )}
                    {deployScope !== "envoy" && (
                      <span style={{ fontSize: 12, fontWeight: 400, color: "var(--text-muted)" }}>
                        {" "}
                        ({deployScope})
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>
                    {deployScope === "environment" &&
                      `Synth will request a representative plan from one of ${envoyList.length} envoys.`}
                    {deployScope === "envoy" &&
                      "Synth will request a deployment plan from this envoy."}
                    {deployScope === "partition" &&
                      `Synth will generate plans for each environment in ${getTargetName()}.`}
                  </div>
                </div>
              </div>
              <button
                className="nd-request-plan-btn"
                disabled={submitting}
                onClick={handleRequestPlan}
              >
                {submitting
                  ? "Requesting…"
                  : selectedArtifactIds.length > 1
                    ? "Request Coordinated Plan"
                    : "Request Plan"}
              </button>
            </div>

            {/* Multi-artifact order preview */}
            {selectedArtifactObjects.length > 1 && (
              <div className="nd-order-preview">
                <div className="nd-order-preview-label">
                  Deployment Order (Synth will verify)
                </div>
                {selectedArtifactObjects.map((art, i) => (
                  <div
                    key={art.id}
                    style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}
                  >
                    <span className="nd-order-number">{i + 1}</span>
                    <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
                      {art.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Ask bar */}
        <div className="nd-ask-bar">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="nd-ask-input"
              value={askQuestion}
              onChange={(e) => setAskQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAsk();
              }}
              placeholder="Ask Synth about your systems…"
            />
            <button
              className="nd-ask-btn"
              onClick={handleAsk}
              disabled={!askQuestion.trim()}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              Ask
            </button>
          </div>
          {askTyping && (
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
              <SynthMark size={14} active />
              <span style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>
                Reasoning…
              </span>
            </div>
          )}
          {askResponse && <div className="nd-ask-response">{askResponse}</div>}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
