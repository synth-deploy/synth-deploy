import { useState } from "react";
import {
  getEnvoyHealth,
  getEnvoySecurityBoundaries,
  getEnvoyKnowledge,
  listEnvironments,
  listPartitions,
  listDeployments,
  listArtifacts,
  updateEnvoy,
} from "../../api.js";
import type {
  EnvoyRegistryEntry,
  EnvoySecurityBoundary,
  EnvoyKnowledgeItem,
} from "../../api.js";
import type { Environment, Partition, Deployment, Artifact } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery, invalidateExact } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  envoyId: string;
  title: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function HealthBadge({ health }: { health: EnvoyRegistryEntry["health"] }) {
  const styles: Record<string, React.CSSProperties> = {
    OK: { background: "var(--status-succeeded-bg)", color: "var(--status-succeeded)", border: "1px solid var(--status-succeeded-border)" },
    Degraded: { background: "var(--status-warning-bg)", color: "var(--status-warning)", border: "1px solid var(--status-warning-border)" },
    Unreachable: { background: "var(--status-failed-bg)", color: "var(--status-failed)", border: "1px solid color-mix(in srgb, var(--status-failed) 25%, transparent)" },
  };
  const labels: Record<string, string> = { OK: "Healthy", Degraded: "Degraded", Unreachable: "Unreachable" };
  return (
    <span style={{
      padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
      fontFamily: "var(--font-mono)", textTransform: "uppercase", whiteSpace: "nowrap",
      ...styles[health],
    }}>
      {labels[health]}
    </span>
  );
}

function DeploymentBadge({ status }: { status: string }) {
  const isSuccess = status === "succeeded";
  const isRolledBack = status === "rolled_back" || status === "rolled-back";
  const isRunning = status === "executing";
  let style: React.CSSProperties;
  let label: string;
  if (isSuccess) {
    style = { background: "var(--status-succeeded-bg)", color: "var(--status-succeeded)", border: "1px solid var(--status-succeeded-border)" };
    label = "SUCCESS";
  } else if (isRolledBack) {
    style = { background: "var(--status-failed-bg)", color: "var(--status-failed)", border: "1px solid color-mix(in srgb, var(--status-failed) 25%, transparent)" };
    label = "ROLLED BACK";
  } else if (isRunning) {
    style = { background: "var(--accent-dim)", color: "var(--accent)", border: "1px solid var(--accent-border)" };
    label = "EXECUTING";
  } else {
    style = { background: "var(--surface)", color: "var(--text-muted)", border: "1px solid var(--border)" };
    label = status.toUpperCase();
  }
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700,
      fontFamily: "var(--font-mono)", textTransform: "uppercase", whiteSpace: "nowrap",
      ...style,
    }}>
      {label}
    </span>
  );
}

const healthPipColor = (h: EnvoyRegistryEntry["health"]) =>
  h === "OK" ? "var(--status-succeeded)" : h === "Degraded" ? "var(--status-warning)" : "var(--status-failed)";

const BOUNDARY_LABEL: Record<string, string> = {
  filesystem: "Filesystem",
  service: "Services",
  network: "Network",
  credential: "Credentials",
  execution: "Execution",
};

function boundaryDescription(b: EnvoySecurityBoundary): string {
  const cfg = b.config;
  switch (b.boundaryType) {
    case "filesystem": {
      const paths = (cfg.allowedPaths as string[] | undefined) ?? [];
      return `Read/write limited to ${paths.join(", ") || "no paths configured"}`;
    }
    case "service": {
      const svcs = (cfg.allowedServices as string[] | undefined) ?? [];
      return `Can manage: ${svcs.join(", ") || "no services configured"}`;
    }
    case "network": {
      const allowed = (cfg.allowedHosts as string[] | undefined) ?? [];
      return `Outbound allowed to ${allowed.join(", ") || "no hosts configured"}. All other egress blocked.`;
    }
    case "credential": {
      const path = (cfg.vaultPath as string | undefined) ?? "";
      const account = (cfg.serviceAccount as string | undefined) ?? "";
      return `Access to vault path ${path} via ${account || "service account"}`;
    }
    default:
      return JSON.stringify(cfg);
  }
}

const StatCard = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div style={{ flex: 1, padding: "14px 16px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
    <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>
      {label}
    </div>
    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>
      {value}
    </div>
  </div>
);

const KnowledgeCard = ({ label, value, color }: { label: string; value: React.ReactNode; color: string }) => (
  <div style={{ flex: 1, padding: "14px 16px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
    <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>
      {label}
    </div>
    <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "var(--font-mono)", lineHeight: 1 }}>
      {value}
    </div>
  </div>
);

export default function EnvoyDetailPanel({ envoyId, title }: Props) {
  const { pushPanel } = useCanvas();
  const { data: envoy, loading: l1, error } = useQuery<EnvoyRegistryEntry>(`envoyHealth:${envoyId}`, () => getEnvoyHealth(envoyId));
  const { data: environments, loading: l2 } = useQuery<Environment[]>("list:environments", listEnvironments);
  const { data: partitions, loading: l3 } = useQuery<Partition[]>("list:partitions", listPartitions);
  const { data: boundaries, loading: l4 } = useQuery<EnvoySecurityBoundary[]>(`envoyBoundaries:${envoyId}`, () => getEnvoySecurityBoundaries(envoyId));
  const { data: knowledge, loading: l5 } = useQuery<EnvoyKnowledgeItem[]>(`envoyKnowledge:${envoyId}`, () => getEnvoyKnowledge(envoyId));
  const { data: deploymentList, loading: l6 } = useQuery<Deployment[]>(`envoyDeployments:${envoyId}`, () => listDeployments({ envoyId }));
  const { data: artifacts, loading: l7 } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const loading = l1 || l2 || l3;
  const [showEnvPicker, setShowEnvPicker] = useState(false);
  const [showPartPicker, setShowPartPicker] = useState(false);
  const [localEnvIds, setLocalEnvIds] = useState<string[] | null>(null);
  const [localPartIds, setLocalPartIds] = useState<string[] | null>(null);

  if (loading) {
    return (
      <CanvasPanelHost title={title} hideRootCrumb>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );
  }

  if (error || !envoy) {
    return (
      <CanvasPanelHost title={title} hideRootCrumb>
        <div className="error-msg">{error?.message ?? "Envoy not found"}</div>
      </CanvasPanelHost>
    );
  }

  const effectiveEnvIds = localEnvIds ?? envoy.assignedEnvironments;
  const effectivePartIds = localPartIds ?? (envoy.assignedPartitions ?? []);

  const assignedEnvs = (environments ?? []).filter(
    (e) => effectiveEnvIds.includes(e.id) || effectiveEnvIds.includes(e.name)
  );
  const assignedParts = (partitions ?? []).filter(
    (p) => effectivePartIds.includes(p.id) || effectivePartIds.includes(p.name)
  );

  async function assignEnvironment(env: Environment) {
    const next = [...effectiveEnvIds, env.id];
    setLocalEnvIds(next);
    setShowEnvPicker(false);
    try {
      await updateEnvoy(envoyId, { assignedEnvironments: next });
      invalidateExact(`envoyHealth:${envoyId}`);
    } catch {
      setLocalEnvIds(effectiveEnvIds);
    }
  }

  async function removeEnvironment(env: Environment) {
    const next = effectiveEnvIds.filter((id) => id !== env.id && id !== env.name);
    setLocalEnvIds(next);
    try {
      await updateEnvoy(envoyId, { assignedEnvironments: next });
      invalidateExact(`envoyHealth:${envoyId}`);
    } catch {
      setLocalEnvIds(effectiveEnvIds);
    }
  }

  async function assignPartition(part: Partition) {
    const next = [...effectivePartIds, part.id];
    setLocalPartIds(next);
    setShowPartPicker(false);
    try {
      await updateEnvoy(envoyId, { assignedPartitions: next });
      invalidateExact(`envoyHealth:${envoyId}`);
    } catch {
      setLocalPartIds(effectivePartIds);
    }
  }

  async function removePartition(part: Partition) {
    const next = effectivePartIds.filter((id) => id !== part.id && id !== part.name);
    setLocalPartIds(next);
    try {
      await updateEnvoy(envoyId, { assignedPartitions: next });
      invalidateExact(`envoyHealth:${envoyId}`);
    } catch {
      setLocalPartIds(effectivePartIds);
    }
  }

  const envLabel = envoy.assignedEnvironments[0] ?? "No environment";

  // Build artifact name lookup
  const artifactMap = new Map<string, string>((artifacts ?? []).map((a) => [a.id, a.name]));

  // Currently deployed: latest successful deployment per artifact
  const allDeployments = deploymentList ?? [];
  const latestByArtifact = new Map<string, Deployment>();
  for (const d of allDeployments) {
    if (d.status === "succeeded") {
      const existing = latestByArtifact.get(d.artifactId);
      if (!existing || new Date(d.completedAt ?? d.createdAt) > new Date(existing.completedAt ?? existing.createdAt)) {
        latestByArtifact.set(d.artifactId, d);
      }
    }
  }
  const currentlyDeployed = Array.from(latestByArtifact.values()).sort(
    (a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime()
  );

  // Recent plans: all deployments sorted newest first
  const recentPlans = [...allDeployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ).slice(0, 10);

  return (
    <CanvasPanelHost title={title} hideRootCrumb>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span
              className="status-pip"
              style={{ background: healthPipColor(envoy.health), width: 9, height: 9, flexShrink: 0 }}
            />
            <h1 style={{ fontSize: 24, fontWeight: 500, color: "var(--text)", margin: 0, fontFamily: "var(--font-mono)" }}>
              {envoy.name}
            </h1>
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
            {envLabel} environment · {envoy.os ?? "Unknown OS"}
          </p>
        </div>
        <HealthBadge health={envoy.health} />
      </div>

      {/* ── Identity & System Info ── */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        <StatCard label="Hostname" value={envoy.hostname ?? "Unknown"} />
        <StatCard label="OS" value={envoy.os ?? "Unknown"} />
        <StatCard label="Last Heartbeat" value={envoy.lastSeen ? relativeTime(envoy.lastSeen) : "Never"} />
        <StatCard label="Uptime" value="—" />
      </div>

      {/* ── Knowledge Store ── */}
      <div style={{ marginBottom: 24 }}>
        <div className="section-label">Knowledge Store</div>
        <div style={{ display: "flex", gap: 12 }}>
          <KnowledgeCard label="Successful Plans" value={envoy.summary?.succeeded ?? 0} color="var(--status-succeeded)" />
          <KnowledgeCard label="Failed Plans" value={envoy.summary?.failed ?? 0} color="var(--status-failed)" />
          <KnowledgeCard label="System Observations" value={l5 ? "…" : (knowledge?.length ?? 0)} color="var(--accent)" />
          <KnowledgeCard label="Total Knowledge Items" value={envoy.summary?.totalDeployments ?? 0} color="var(--text)" />
        </div>
      </div>

      {/* ── Connections ── */}
      <div style={{ marginBottom: 24 }}>
        <div className="section-label">Connections</div>
        <div style={{ display: "flex", gap: 12 }}>
          {/* Environments */}
          <div style={{ flex: 1, padding: "14px 18px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div className="section-label" style={{ margin: 0 }}>
                Environments
              </div>
              <button
                className="btn-accent-outline"
                style={{ padding: "3px 10px", fontSize: 10 }}
                onClick={() => setShowEnvPicker(!showEnvPicker)}
              >
                + Assign
              </button>
            </div>
            {showEnvPicker && (
              <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                {(environments ?? []).filter((e) => !effectiveEnvIds.includes(e.id) && !effectiveEnvIds.includes(e.name)).map((env) => (
                  <button
                    key={env.id}
                    className="canvas-activity-row"
                    style={{ fontSize: 12, padding: "4px 8px", textAlign: "left" }}
                    onClick={() => assignEnvironment(env)}
                  >
                    {env.name}
                  </button>
                ))}
              </div>
            )}
            {assignedEnvs.length > 0 ? (
              assignedEnvs.map((env) => (
                <div key={env.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                  <span className="status-pip" style={{ background: "var(--status-succeeded)", width: 6, height: 6, flexShrink: 0 }} />
                  <button
                    style={{ background: "none", border: "none", color: "var(--text)", fontWeight: 500, fontSize: 13, cursor: "pointer", padding: 0, flex: 1, textAlign: "left" }}
                    onClick={() => pushPanel({ type: "environment-detail", title: env.name, params: { id: env.id } })}
                  >
                    {env.name}
                  </button>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", cursor: "pointer" }} onClick={() => removeEnvironment(env)}>✕</span>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No environments linked</div>
            )}
          </div>

          {/* Partitions */}
          <div style={{ flex: 1, padding: "14px 18px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div className="section-label" style={{ margin: 0 }}>
                Partitions
              </div>
              <button
                className="btn-accent-outline"
                style={{ padding: "3px 10px", fontSize: 10 }}
                onClick={() => setShowPartPicker(!showPartPicker)}
              >
                + Assign
              </button>
            </div>
            {showPartPicker && (
              <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 2 }}>
                {(partitions ?? []).filter((p) => !effectivePartIds.includes(p.id) && !effectivePartIds.includes(p.name)).map((part) => (
                  <button
                    key={part.id}
                    className="canvas-activity-row"
                    style={{ fontSize: 12, padding: "4px 8px", textAlign: "left" }}
                    onClick={() => assignPartition(part)}
                  >
                    {part.name}
                  </button>
                ))}
              </div>
            )}
            {assignedParts.length > 0 ? (
              assignedParts.map((part) => (
                <div key={part.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                  <span className="status-pip" style={{ background: "var(--status-succeeded)", width: 6, height: 6, flexShrink: 0 }} />
                  <button
                    style={{ background: "none", border: "none", color: "var(--text)", fontWeight: 500, fontSize: 13, cursor: "pointer", padding: 0, flex: 1, textAlign: "left" }}
                    onClick={() => pushPanel({ type: "partition-detail", title: part.name, params: { id: part.id } })}
                  >
                    {part.name}
                  </button>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", cursor: "pointer" }} onClick={() => removePartition(part)}>✕</span>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No partitions linked</div>
            )}
          </div>
        </div>
      </div>

      {/* ── Security Boundaries ── */}
      {!l4 && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-label">Security Boundaries</div>
          <div style={{ padding: "16px 20px", borderRadius: 10, background: "var(--surface)", border: "1px solid var(--border)" }}>
            {(boundaries ?? []).length > 0 ? (
              (boundaries ?? []).map((b, i, arr) => (
                <div key={b.id} style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "10px 0", borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-mono)", minWidth: 80, paddingTop: 1 }}>
                    {BOUNDARY_LABEL[b.boundaryType] ?? b.boundaryType}
                  </span>
                  <span style={{ fontSize: 13, color: "var(--text)", flex: 1, lineHeight: 1.5 }}>
                    {boundaryDescription(b)}
                  </span>
                  <span style={{
                    padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)",
                    background: "var(--status-succeeded-bg)", color: "var(--status-succeeded)",
                    border: "1px solid var(--status-succeeded-border)", textTransform: "uppercase",
                    whiteSpace: "nowrap", alignSelf: "center",
                  }}>
                    Enforced
                  </span>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No security boundaries configured</div>
            )}
          </div>
        </div>
      )}

      {/* ── Currently Deployed ── */}
      {!l6 && !l7 && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-label">Currently Deployed</div>
          <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface)" }}>
            {currentlyDeployed.length > 0 ? (
              currentlyDeployed.map((d, i, arr) => (
                <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <span className="status-pip" style={{ background: "var(--status-succeeded)", width: 6, height: 6, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                        {artifactMap.get(d.artifactId) ?? d.artifactId}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{d.version}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      Deployed {relativeTime(d.completedAt ?? d.createdAt)}
                    </div>
                  </div>
                  <span style={{
                    padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)",
                    background: "var(--status-succeeded-bg)", color: "var(--status-succeeded)",
                    border: "1px solid var(--status-succeeded-border)", textTransform: "uppercase",
                  }}>
                    Healthy
                  </span>
                </div>
              ))
            ) : (
              <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--text-muted)" }}>No deployments on this envoy</div>
            )}
          </div>
        </div>
      )}

      {/* ── Recent Plans ── */}
      {!l6 && recentPlans.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-label">Recent Plans</div>
          <div style={{ borderRadius: 10, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface)" }}>
            {recentPlans.map((d, i, arr) => {
              const artifactName = artifactMap.get(d.artifactId) ?? d.artifactId;
              const stepCount = d.plan?.steps.length;
              const execStart = d.executionRecord?.startedAt;
              const execEnd = d.executionRecord?.completedAt;
              const durationMs = execStart && execEnd
                ? new Date(execEnd).getTime() - new Date(execStart).getTime()
                : null;
              const delta = d.plan?.diffFromPreviousPlan;
              return (
                <div key={d.id} style={{ padding: "12px 16px", borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                        {d.id.slice(0, 8)}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                        {artifactName} {d.version}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {(stepCount != null || durationMs != null) && (
                        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                          {stepCount != null ? `${stepCount} steps` : ""}
                          {stepCount != null && durationMs != null ? " · " : ""}
                          {durationMs != null ? formatDuration(durationMs) : ""}
                        </span>
                      )}
                      <DeploymentBadge status={d.status} />
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.4 }}>
                    <span style={{ color: "var(--text-muted)" }}>{relativeTime(d.createdAt)}</span>
                    {delta && (
                      <>
                        <span style={{ margin: "0 6px", color: "var(--border)" }}>·</span>
                        {delta}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Accumulated System Knowledge ── */}
      {!l5 && (knowledge ?? []).length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="section-label">Accumulated System Knowledge</div>
          <div style={{ padding: "16px 20px", borderRadius: 10, background: "var(--surface-alt, var(--surface))", border: "1px solid var(--border)" }}>
            {(knowledge ?? []).map((item) => (
              <div key={item.id} style={{ display: "flex", gap: 10, padding: "5px 0" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 2, flexShrink: 0 }}>•</span>
                <span style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </CanvasPanelHost>
  );
}
