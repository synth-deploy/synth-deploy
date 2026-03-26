import { useState } from "react";
import {
  listArtifacts,
  listPartitions,
  listEnvironments,
  listEnvoys,
  listDeployments,
  createOperation,
  recordPreFlightResponse,
} from "../../api.js";
import type { Artifact, Partition, Environment, Deployment, ApprovalMode } from "../../types.js";
import { DEFAULT_APPROVAL_DEFAULTS } from "../../types.js";
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
  preselectedOpType?: OpType;
  preselectedIntent?: string;
  preselectedTriggerCondition?: string;
  preselectedTriggerResponseIntent?: string;
}

type DeployScope = "environment" | "envoy" | "partition";
type OpType = "deploy" | "maintain" | "query" | "investigate" | "trigger" | "composite";

export default function OperationAuthoringPanel({ title, preselectedArtifactId, preselectedEnvironmentId, preselectedPartitionId, preselectedOpType, preselectedIntent, preselectedTriggerCondition, preselectedTriggerResponseIntent }: Props) {
  const { pushPanel } = useCanvas();
  const { settings: appSettings } = useSettings();
  const environmentsEnabled = appSettings?.environmentsEnabled ?? true;

  const { data: artifacts, loading: l1 } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const { data: partitions, loading: l2 } = useQuery<Partition[]>("list:partitions", listPartitions);
  const { data: environments, loading: l3 } = useQuery<Environment[]>("list:environments", listEnvironments);
  const { data: envoys, loading: l4 } = useQuery<EnvoyRegistryEntry[]>("list:envoys", () => listEnvoys().catch(() => [] as EnvoyRegistryEntry[]));
  const { data: recentDeployments } = useQuery<Deployment[]>("list:deployments", listDeployments);
  const loading = l1 || l2 || l3 || l4;

  const [opType, setOpType] = useState<OpType>(preselectedOpType ?? "deploy");
  const [intent, setIntent] = useState(preselectedIntent ?? "");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>(
    preselectedArtifactId ? [preselectedArtifactId] : [],
  );
  const [deployScope, setDeployScope] = useState<DeployScope>(
    preselectedPartitionId ? "partition" : preselectedEnvironmentId ? "environment" : "envoy",
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>(preselectedEnvironmentId ?? "");
  const [selectedPartitionId, setSelectedPartitionId] = useState<string>(preselectedPartitionId ?? "");
  const [selectedEnvoyId, setSelectedEnvoyId] = useState<string>("");
  const [preFlightRec, setPreFlightRec] = useState<PreFlightContext["recommendation"] | null>(null);

  const [allowWrite, setAllowWrite] = useState(false);
  const [triggerCondition, setTriggerCondition] = useState(preselectedTriggerCondition ?? "");
  const [triggerResponseIntent, setTriggerResponseIntent] = useState(preselectedTriggerResponseIntent ?? "");
  const [forceManualApproval, setForceManualApproval] = useState(false);

  // Composite: child operation list
  const [compositeChildren, setCompositeChildren] = useState<Array<{
    id: string;
    type: "deploy" | "maintain" | "query" | "investigate";
    intent: string;
    artifactId?: string;
  }>>([]);

  function addCompositeChild() {
    setCompositeChildren((prev) => [
      ...prev,
      { id: crypto.randomUUID(), type: "query", intent: "" },
    ]);
  }

  function removeCompositeChild(id: string) {
    setCompositeChildren((prev) => prev.filter((c) => c.id !== id));
  }

  function updateCompositeChild(id: string, updates: Partial<(typeof compositeChildren)[0]>) {
    setCompositeChildren((prev) => prev.map((c) => c.id === id ? { ...c, ...updates } : c));
  }

  function toggleArtifact(id: string) {
    setSelectedArtifactIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  }

  const primaryArtifactId = selectedArtifactIds[0] ?? "";
  const hasTarget = !!(selectedEnvironmentId || selectedPartitionId || selectedEnvoyId);

  async function handleRequestPlan() {
    if (opType === "deploy" && (!primaryArtifactId || (environmentsEnabled && !hasTarget))) return;
    if (opType === "trigger" && (!triggerCondition.trim() || !triggerResponseIntent.trim())) return;
    if (opType === "composite" && (compositeChildren.length === 0 || !hasTarget)) return;
    if (opType === "composite" && compositeChildren.some((c) => !c.intent.trim() && c.type !== "deploy")) return;
    if (opType !== "deploy" && opType !== "trigger" && opType !== "composite" && !intent.trim()) return;
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

      const result = await createOperation({
        artifactId: primaryArtifactId || undefined,
        environmentId: selectedEnvironmentId || undefined,
        partitionId: selectedPartitionId || undefined,
        envoyId: deployScope === "envoy" ? (selectedEnvoyId || undefined) : undefined,
        type: opType,
        intent: opType === "deploy" || opType === "trigger" || opType === "composite" ? undefined : (intent.trim() || undefined),
        ...(opType === "investigate" ? { allowWrite } : {}),
        ...(opType === "trigger" ? {
          condition: triggerCondition.trim(),
          responseIntent: triggerResponseIntent.trim(),
        } : {}),
        ...(forceManualApproval ? { requireApproval: true } : {}),
        ...(opType === "composite" ? {
          operations: compositeChildren.map((c) =>
            c.type === "deploy"
              ? { type: "deploy" as const, artifactId: c.artifactId ?? "" }
              : { type: c.type as "maintain" | "query" | "investigate", intent: c.intent }
          ),
        } : {}),
      } as Parameters<typeof createOperation>[0]);

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

  function getResolvedApprovalMode(): ApprovalMode {
    const defaults = appSettings?.approvalDefaults;
    if (defaults) {
      // Check environment-specific override
      if (selectedEnvironmentId && defaults.environmentOverrides) {
        const envName = (environments ?? []).find((e) => e.id === selectedEnvironmentId)?.name;
        if (envName && defaults.environmentOverrides[envName]) {
          const override = defaults.environmentOverrides[envName][opType];
          if (override) return override;
        }
      }
      // Per-type default from settings
      const typeDefault = defaults[opType as keyof typeof defaults];
      if (typeDefault === "auto" || typeDefault === "required") return typeDefault;
    }
    // Fall back to canonical defaults from core
    return DEFAULT_APPROVAL_DEFAULTS[opType as keyof typeof DEFAULT_APPROVAL_DEFAULTS] ?? "required";
  }

  const resolvedApprovalMode = getResolvedApprovalMode();
  const effectiveApprovalMode: ApprovalMode = forceManualApproval ? "required" : resolvedApprovalMode;

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

  const lowConfidenceArtifacts = selectedArtifactObjects.filter((a) => a.analysis.confidence < 0.5);
  const canDeploy = opType === "deploy"
    ? selectedArtifactIds.length > 0 && hasTarget
    : opType === "trigger"
      ? triggerCondition.trim().length > 0 && triggerResponseIntent.trim().length > 0
      : opType === "composite"
        ? compositeChildren.length > 0 && hasTarget && compositeChildren.every((c) => c.type === "deploy" ? !!c.artifactId : c.intent.trim().length > 0)
        : intent.trim().length > 0;
  const contextHint = getContextHint();

  return (
    <CanvasPanelHost title={title} noBreadcrumb>
      <div style={{ padding: "0 4px" }}>
        {error && <div className="error-msg">{error}</div>}

        {/* Page title */}
        <div style={{ marginBottom: 18 }}>
          <h1 className="v6-page-title">New Operation</h1>
          <p className="v6-page-subtitle">
            Select what and where. Synth and the envoy figure out how.
          </p>
        </div>

        {/* Operation type selector */}
        <div style={{ marginBottom: 18 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Operation type</div>
          <div style={{ display: "flex", gap: 4 }}>
            {(["deploy", "maintain", "query", "investigate", "trigger", "composite"] as OpType[]).map((t) => {
              const isAvailable = t === "deploy" || t === "maintain" || t === "query" || t === "investigate" || t === "trigger" || t === "composite";
              return (
                <button
                  key={t}
                  disabled={!isAvailable}
                  onClick={() => { if (isAvailable) { setOpType(t); setForceManualApproval(false); } }}
                  title={isAvailable ? undefined : "Coming soon"}
                  style={{
                    padding: "5px 12px",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 600,
                    background: opType === t ? "var(--accent)" : "var(--surface-2)",
                    color: opType === t ? "var(--bg)" : "var(--text-muted)",
                    border: "1px solid " + (opType === t ? "var(--accent)" : "var(--border)"),
                    borderRadius: 4,
                    cursor: isAvailable ? "pointer" : "not-allowed",
                    textTransform: "capitalize",
                    opacity: isAvailable ? 1 : 0.4,
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>

        {/* Trigger-specific: condition + response intent */}
        {opType === "trigger" ? (
          <div style={{ marginBottom: 20 }}>
            <div className="section-label" style={{ marginBottom: 8 }}>Condition</div>
            <textarea
              value={triggerCondition}
              onChange={(e) => setTriggerCondition(e.target.value)}
              placeholder="When disk_usage > 85"
              rows={2}
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                background: "var(--surface-2)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                resize: "vertical",
                boxSizing: "border-box",
                marginBottom: 12,
              }}
            />
            <div className="section-label" style={{ marginBottom: 8 }}>Response</div>
            <textarea
              value={triggerResponseIntent}
              onChange={(e) => setTriggerResponseIntent(e.target.value)}
              placeholder="Run log cleanup on /var/log"
              rows={2}
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                background: "var(--surface-2)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
          </div>
        ) : opType === "composite" || opType === "deploy" ? null : (
          /* Intent / objective field */
          <div style={{ marginBottom: 20 }}>
            <div className="section-label" style={{ marginBottom: 8 }}>
              Objective
            </div>
            <textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Describe what you want Synth to do…"
              rows={2}
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
                background: "var(--surface-2)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}

        {/* Composite: child operation builder */}
        {opType === "composite" && (
          <div style={{ marginBottom: 20 }}>
            <div className="section-label" style={{ marginBottom: 8 }}>Child operations (executed sequentially)</div>
            {compositeChildren.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 10 }}>
                No operations added yet. Add child operations to build the sequence.
              </div>
            )}
            {compositeChildren.map((child, idx) => (
              <div key={child.id} style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 6, padding: "12px", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontWeight: 600, minWidth: 20 }}>
                    {idx + 1}.
                  </span>
                  <select
                    value={child.type}
                    onChange={(e) => updateCompositeChild(child.id, { type: e.target.value as "deploy" | "maintain" | "query" | "investigate", intent: "" })}
                    style={{
                      padding: "4px 8px",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      background: "var(--surface-3, var(--surface))",
                      color: "var(--text)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                    }}
                  >
                    <option value="deploy">deploy</option>
                    <option value="maintain">maintain</option>
                    <option value="query">query</option>
                    <option value="investigate">investigate</option>
                  </select>
                  <button
                    onClick={() => removeCompositeChild(child.id)}
                    style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: "2px 6px" }}
                  >
                    ✕
                  </button>
                </div>
                {child.type === "deploy" ? (
                  <select
                    value={child.artifactId ?? ""}
                    onChange={(e) => updateCompositeChild(child.id, { artifactId: e.target.value })}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      background: "var(--surface-3, var(--surface))",
                      color: "var(--text)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      boxSizing: "border-box",
                    }}
                  >
                    <option value="">— select artifact —</option>
                    {(artifacts ?? []).map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={child.intent}
                    onChange={(e) => updateCompositeChild(child.id, { intent: e.target.value })}
                    placeholder={
                      child.type === "query" ? "What to check…" :
                      child.type === "maintain" ? "What to do…" :
                      "What to investigate…"
                    }
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      background: "var(--surface-3, var(--surface))",
                      color: "var(--text)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      boxSizing: "border-box",
                    }}
                  />
                )}
              </div>
            ))}
            <button
              onClick={addCompositeChild}
              style={{
                padding: "6px 14px",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                background: "var(--surface-2)",
                color: "var(--accent)",
                border: "1px solid var(--accent)",
                borderRadius: 4,
                cursor: "pointer",
                marginTop: 4,
              }}
            >
              + Add operation
            </button>
          </div>
        )}

        {/* Allow write toggle — investigate only */}
        {opType === "investigate" && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={allowWrite}
                onChange={(e) => setAllowWrite(e.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              Allow write access during investigation
            </label>
          </div>
        )}

        {/* Two-column layout for deploy; single-column Where for query/investigate */}
        {opType === "deploy" ? (
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
        ) : (opType === "maintain" || opType === "query" || opType === "investigate" || opType === "trigger" || opType === "composite") ? (
          /* Single-column Where section for maintain/query/investigate/trigger/composite */
          <div style={{ marginBottom: 20 }}>
            <div className="section-label" style={{ marginBottom: 10 }}>Where</div>

            {/* Scope tabs */}
            <div className="segmented-control" style={{ width: "100%", marginBottom: 10 }}>
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
                      <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                        {envoyList.length} target{envoyList.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                  );
                })}

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
                        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
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
                      <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
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

            {contextHint && <div className="nd-context-hint">{contextHint}</div>}
          </div>
        ) : null}

        {/* Low-confidence artifact warning */}
        {lowConfidenceArtifacts.length > 0 && (
          <div style={{
            marginTop: 16,
            padding: "12px 16px",
            borderRadius: 8,
            background: "color-mix(in srgb, var(--status-warning) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--status-warning) 25%, transparent)",
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
          }}>
            <span style={{ color: "var(--status-warning)", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>!</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--status-warning)", marginBottom: 3 }}>
                Low confidence {lowConfidenceArtifacts.length === 1 ? "artifact" : "artifacts"} selected
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {lowConfidenceArtifacts.map((a) => a.name).join(", ")}{" "}
                {lowConfidenceArtifacts.length === 1 ? "has" : "have"} low analysis confidence. Synth may produce a less accurate plan. Consider annotating {lowConfidenceArtifacts.length === 1 ? "this artifact" : "these artifacts"} first to improve understanding.
              </div>
            </div>
          </div>
        )}

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
        {canDeploy && opType === "deploy" && (
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

            {/* Approval mode */}
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, paddingLeft: 32 }}>
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 4,
                color: effectiveApprovalMode === "auto" ? "var(--status-succeeded)" : "var(--text-muted)",
                background: effectiveApprovalMode === "auto"
                  ? "color-mix(in srgb, var(--status-succeeded) 12%, transparent)"
                  : "color-mix(in srgb, var(--text-muted) 12%, transparent)",
              }}>
                {effectiveApprovalMode === "auto" ? "Auto-approved" : "Requires approval"}
              </span>
              {resolvedApprovalMode === "auto" && (
                <button
                  onClick={() => setForceManualApproval((v) => !v)}
                  style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  {forceManualApproval ? "Allow auto-approve" : "Require approval"}
                </button>
              )}
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

        {/* Non-deploy action bar — for maintain, query, and investigate */}
        {canDeploy && (opType === "maintain" || opType === "query" || opType === "investigate") && (
          <div className="nd-action-bar">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                  {intent.trim() || "No objective specified"}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  {hasTarget
                    ? `→ ${getTargetName()}`
                    : "Select a target below"}
                </div>
              </div>
              <button
                className="nd-request-plan-btn"
                disabled={submitting || !hasTarget}
                onClick={handleRequestPlan}
              >
                {submitting
                  ? "Running…"
                  : opType === "maintain"
                  ? "Plan Maintenance"
                  : opType === "query"
                  ? "Run Query"
                  : "Begin Investigation"}
              </button>
            </div>
            {/* Approval mode */}
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 4,
                color: effectiveApprovalMode === "auto" ? "var(--status-succeeded)" : "var(--text-muted)",
                background: effectiveApprovalMode === "auto"
                  ? "color-mix(in srgb, var(--status-succeeded) 12%, transparent)"
                  : "color-mix(in srgb, var(--text-muted) 12%, transparent)",
              }}>
                {effectiveApprovalMode === "auto" ? "Auto-approved" : "Requires approval"}
              </span>
              {resolvedApprovalMode === "auto" && (
                <button
                  onClick={() => setForceManualApproval((v) => !v)}
                  style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  {forceManualApproval ? "Allow auto-approve" : "Require approval"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Trigger action bar */}
        {canDeploy && opType === "trigger" && (
          <div className="nd-action-bar">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                  When: {triggerCondition.trim()}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  Then: {triggerResponseIntent.trim()}
                  {hasTarget ? ` → ${getTargetName()}` : ""}
                </div>
              </div>
              <button
                className="nd-request-plan-btn"
                disabled={submitting}
                onClick={handleRequestPlan}
              >
                {submitting ? "Creating…" : "Create Trigger"}
              </button>
            </div>
            {/* Approval mode */}
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 4,
                color: effectiveApprovalMode === "auto" ? "var(--status-succeeded)" : "var(--text-muted)",
                background: effectiveApprovalMode === "auto"
                  ? "color-mix(in srgb, var(--status-succeeded) 12%, transparent)"
                  : "color-mix(in srgb, var(--text-muted) 12%, transparent)",
              }}>
                {effectiveApprovalMode === "auto" ? "Auto-approved" : "Requires approval"}
              </span>
              {resolvedApprovalMode === "auto" && (
                <button
                  onClick={() => setForceManualApproval((v) => !v)}
                  style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  {forceManualApproval ? "Allow auto-approve" : "Require approval"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Composite action bar */}
        {canDeploy && opType === "composite" && (
          <div className="nd-action-bar">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
                  {compositeChildren.length} operation{compositeChildren.length !== 1 ? "s" : ""} → {getTargetName()}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  Sequential execution
                </div>
              </div>
              <button
                className="nd-request-plan-btn"
                disabled={submitting}
                onClick={handleRequestPlan}
              >
                {submitting ? "Planning…" : "Plan Sequence"}
              </button>
            </div>
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 4,
                color: effectiveApprovalMode === "auto" ? "var(--status-succeeded)" : "var(--text-muted)",
                background: effectiveApprovalMode === "auto"
                  ? "color-mix(in srgb, var(--status-succeeded) 12%, transparent)"
                  : "color-mix(in srgb, var(--text-muted) 12%, transparent)",
              }}>
                {effectiveApprovalMode === "auto" ? "Auto-approved" : "Requires approval"}
              </span>
              {resolvedApprovalMode === "auto" && (
                <button
                  onClick={() => setForceManualApproval((v) => !v)}
                  style={{ fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                >
                  {forceManualApproval ? "Allow auto-approve" : "Require approval"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Recent deployments */}
        {(recentDeployments ?? []).length > 0 && (
          <div style={{ marginTop: 28 }}>
            <div className="section-label">Recent Deployments</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(recentDeployments ?? [])
                .slice()
                .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                .slice(0, 5)
                .map((dep) => {
                    const depArtifactId = dep.artifactId ?? (dep.input?.type === "deploy" ? dep.input.artifactId : undefined);
                  const art = artList.find((a) => a.id === depArtifactId);
                  const env = (environments ?? []).find((e) => e.id === dep.environmentId);
                  const isAwaiting = dep.status === "awaiting_approval";
                  const statusColors: Record<string, string> = {
                    succeeded: "var(--status-succeeded)",
                    failed: "var(--status-failed)",
                    rolled_back: "var(--status-warning)",
                    awaiting_approval: "var(--status-warning)",
                    running: "var(--accent)",
                    pending: "var(--text-muted)",
                  };
                  const statusColor = statusColors[dep.status] ?? "var(--text-muted)";
                  const ageMs = Date.now() - new Date(dep.createdAt).getTime();
                  const ageLabel = ageMs < 60000 ? "just now"
                    : ageMs < 3600000 ? `${Math.floor(ageMs / 60000)}m ago`
                    : ageMs < 86400000 ? `${Math.floor(ageMs / 3600000)}h ago`
                    : `${Math.floor(ageMs / 86400000)}d ago`;
                  return (
                    <div
                      key={dep.id}
                      onClick={() => {
                        if (isAwaiting) {
                          pushPanel({ type: "plan-review", title: "Review Plan", params: { id: dep.id } });
                        } else {
                          pushPanel({ type: "debrief", title: "Debriefs", params: { deploymentId: dep.id } });
                        }
                      }}
                      style={{
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                        background: "var(--surface)", border: "1px solid var(--border)",
                        transition: "background 0.15s",
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                          {art?.name ?? depArtifactId?.slice(0, 8) ?? dep.intent ?? dep.input?.type ?? "—"}
                        </span>
                        {env && (
                          <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 6 }}>
                            → {env.name}
                          </span>
                        )}
                      </div>
                      <span style={{ fontSize: 11, color: statusColor, fontWeight: 500, flexShrink: 0 }}>
                        {dep.status.replace(/_/g, " ")}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{ageLabel}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

      </div>
    </CanvasPanelHost>
  );
}
