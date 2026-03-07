import { useState } from "react";
import {
  listArtifacts,
  listPartitions,
  listEnvironments,
  listEnvoys,
  createDeployment,
  recordPreFlightResponse,
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
}

export default function DeploymentAuthoringPanel({ title, preselectedArtifactId }: Props) {
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

  // Selection state
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>(
    preselectedArtifactId ? [preselectedArtifactId] : [],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>("");
  const [selectedPartitionId, setSelectedPartitionId] = useState<string>("");
  const [selectedEnvoyId, setSelectedEnvoyId] = useState<string>("");
  const [deployScope, setDeployScope] = useState<"environment" | "envoy" | "partition">("environment");
  const [preFlightRec, setPreFlightRec] = useState<PreFlightContext["recommendation"] | null>(null);

  function toggleArtifact(id: string) {
    setSelectedArtifactIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  }

  const primaryArtifactId = selectedArtifactIds[0] ?? "";
  const hasTarget = !!(selectedEnvironmentId || selectedPartitionId || selectedEnvoyId);

  async function handleDeploy() {
    if (!primaryArtifactId || (environmentsEnabled && !hasTarget)) return;

    setSubmitting(true);
    setError(null);

    try {
      // Record user's pre-flight decision (fire-and-forget)
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
        environmentId: environmentsEnabled ? selectedEnvironmentId : undefined,
        partitionId: selectedPartitionId || undefined,
        version: undefined,
      });

      pushPanel({
        type: "deployment-detail",
        title: `Deployment ${result.deployment.version || result.deployment.id.slice(0, 8)}`,
        params: { id: result.deployment.id },
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Derive target name for summary
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

  function getScopeHint(): string {
    if (deployScope === "environment") return "Synth will select the best envoy for this environment.";
    if (deployScope === "envoy") return "Deployment will target this specific envoy directly.";
    if (deployScope === "partition") return "Scoped to partition variables and constraints.";
    return "";
  }

  if (loading)
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );

  const selectedArtifactNames = selectedArtifactIds
    .map((id) => (artifacts ?? []).find((a) => a.id === id)?.name)
    .filter(Boolean);

  const summaryText =
    selectedArtifactNames.length === 1
      ? `Deploy ${selectedArtifactNames[0]} to ${getTargetName()}`
      : `Deploy ${selectedArtifactNames.length} artifacts to ${getTargetName()}`;

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {error && <div className="error-msg">{error}</div>}

        <div style={{ padding: "0 16px" }}>
          {/* v6 page header */}
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 22 }}>
            <div>
              <h1 className="v6-page-title">New Deployment</h1>
              <p className="v6-page-subtitle">Select what and where. Synth and the envoy figure out how.</p>
            </div>
          </div>

          {/* Two-column layout */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            {/* Left column — What */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 8 }}>
                What
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {(artifacts ?? []).length === 0 && (
                  <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>
                    No artifacts registered.
                  </div>
                )}
                {(artifacts ?? []).map((art) => {
                  const selected = selectedArtifactIds.includes(art.id);
                  return (
                    <div
                      key={art.id}
                      onClick={() => toggleArtifact(art.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "10px 12px",
                        borderRadius: 8,
                        cursor: "pointer",
                        border: selected
                          ? "1px solid var(--accent-border)"
                          : "1px solid var(--border)",
                        background: selected ? "var(--accent-dim)" : "var(--surface)",
                        transition: "border-color 0.15s, background 0.15s",
                      }}
                    >
                      {/* Checkbox indicator */}
                      <div
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 4,
                          border: selected
                            ? "2px solid var(--accent)"
                            : "2px solid var(--border)",
                          background: selected ? "var(--accent)" : "transparent",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          transition: "all 0.15s",
                        }}
                      >
                        {selected && (
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                            <path d="M2 5L4.5 7.5L8 3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>

                      {/* Artifact info */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                            {art.name}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {art.type}
                          </span>
                        </div>
                        {art.analysis.summary && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {art.analysis.summary}
                          </div>
                        )}
                      </div>

                      {/* Confidence */}
                      <ConfidenceIndicator value={art.analysis.confidence} />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right column — Where */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 8 }}>
                Where
              </div>

              {/* Scope tabs */}
              <div style={{ display: "flex", gap: 0, marginBottom: 10, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
                {(["environment", "envoy", "partition"] as const).map((scope) => (
                  <button
                    key={scope}
                    onClick={() => setDeployScope(scope)}
                    style={{
                      flex: 1,
                      padding: "6px 0",
                      fontSize: 12,
                      fontWeight: 600,
                      border: "none",
                      cursor: "pointer",
                      background: deployScope === scope ? "var(--accent)" : "var(--surface)",
                      color: deployScope === scope ? "#fff" : "var(--text-muted)",
                      transition: "all 0.15s",
                    }}
                  >
                    {scope === "environment" ? "Environment" : scope === "envoy" ? "Envoy" : "Partition"}
                  </button>
                ))}
              </div>

              {/* Scope content */}
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {deployScope === "environment" && (
                  <>
                    {(environments ?? []).length === 0 && (
                      <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>
                        No environments configured.
                      </div>
                    )}
                    {(environments ?? []).map((env) => {
                      const active = selectedEnvironmentId === env.id;
                      return (
                        <div
                          key={env.id}
                          onClick={() => {
                            setSelectedEnvironmentId(active ? "" : env.id);
                            setSelectedEnvoyId("");
                            setSelectedPartitionId("");
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "10px 12px",
                            borderRadius: 8,
                            cursor: "pointer",
                            border: active
                              ? "1px solid var(--accent-border)"
                              : "1px solid var(--border)",
                            background: active ? "var(--accent-dim)" : "var(--surface)",
                            transition: "border-color 0.15s, background 0.15s",
                          }}
                        >
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, opacity: active ? 1 : 0.3 }} />
                          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{env.name}</span>
                        </div>
                      );
                    })}
                  </>
                )}

                {deployScope === "envoy" && (
                  <>
                    {(envoys ?? []).length === 0 && (
                      <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>
                        No envoys registered.
                      </div>
                    )}
                    {(envoys ?? []).map((envoy) => {
                      const active = selectedEnvoyId === envoy.id;
                      const healthColor =
                        envoy.health === "OK"
                          ? "var(--status-succeeded)"
                          : envoy.health === "Degraded"
                            ? "var(--status-warning)"
                            : "var(--status-failed)";
                      return (
                        <div
                          key={envoy.id}
                          onClick={() => {
                            setSelectedEnvoyId(active ? "" : envoy.id);
                            setSelectedEnvironmentId("");
                            setSelectedPartitionId("");
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "10px 12px",
                            borderRadius: 8,
                            cursor: "pointer",
                            border: active
                              ? "1px solid var(--accent-border)"
                              : "1px solid var(--border)",
                            background: active ? "var(--accent-dim)" : "var(--surface)",
                            transition: "border-color 0.15s, background 0.15s",
                          }}
                        >
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: healthColor, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                              {envoy.hostname ?? envoy.url}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                              {envoy.health}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}

                {deployScope === "partition" && (
                  <>
                    {(partitions ?? []).length === 0 && (
                      <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>
                        No partitions defined.
                      </div>
                    )}
                    {(partitions ?? []).map((part) => {
                      const active = selectedPartitionId === part.id;
                      return (
                        <div
                          key={part.id}
                          onClick={() => {
                            setSelectedPartitionId(active ? "" : part.id);
                            setSelectedEnvironmentId("");
                            setSelectedEnvoyId("");
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "10px 12px",
                            borderRadius: 8,
                            cursor: "pointer",
                            border: active
                              ? "1px solid var(--accent-border)"
                              : "1px solid var(--border)",
                            background: active ? "var(--accent-dim)" : "var(--surface)",
                            transition: "border-color 0.15s, background 0.15s",
                          }}
                        >
                          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)", flexShrink: 0, opacity: active ? 1 : 0.3 }} />
                          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{part.name}</span>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>

              {/* Context hint when target selected */}
              {hasTarget && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, fontStyle: "italic" }}>
                  {getScopeHint()}
                </div>
              )}
            </div>
          </div>

          {/* Pre-flight context — auto-fetched when artifact + environment selected */}
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
          {selectedArtifactIds.length > 0 && (selectedEnvironmentId || selectedPartitionId || selectedEnvoyId) && (
            <div style={{ marginTop: 22, padding: "18px 22px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <SynthMark size={20} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                      {summaryText}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>
                      {getScopeHint()}
                    </div>
                  </div>
                </div>
                <button className="btn btn-primary" onClick={handleDeploy} disabled={submitting}>
                  {submitting ? "Creating..." : selectedArtifactIds.length > 1 ? "Request Coordinated Plan" : "Request Plan"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </CanvasPanelHost>
  );
}
