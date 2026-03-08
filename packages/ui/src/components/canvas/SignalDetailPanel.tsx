import { useCanvas } from "../../context/CanvasContext.js";
import type { AlertSignal } from "../../api.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import SynthMark from "../SynthMark.js";
import ConfidenceIndicator from "../ConfidenceIndicator.js";
import StatusBadge from "../StatusBadge.js";

interface Props {
  signal: AlertSignal;
  title: string;
}

export default function SignalDetailPanel({ signal, title }: Props) {
  const { popPanel, pushPanel } = useCanvas();
  const inv = signal.investigation;
  const isWarn = signal.severity === "warning" || signal.severity === "critical";
  const severityColor = isWarn ? "var(--status-warning)" : "var(--accent)";
  const severityBg = isWarn
    ? "color-mix(in srgb, var(--status-warning) 8%, transparent)"
    : "color-mix(in srgb, var(--accent) 8%, transparent)";
  const severityBorder = isWarn
    ? "color-mix(in srgb, var(--status-warning) 22%, transparent)"
    : "color-mix(in srgb, var(--accent) 22%, transparent)";

  const evidenceColor = (status: string) => {
    if (status === "warning") return "var(--status-warning)";
    if (status === "healthy") return "var(--status-succeeded)";
    return "var(--text-muted)";
  };

  const priorityStyle = (p: string): React.CSSProperties => {
    if (p === "high") return {
      background: "color-mix(in srgb, var(--status-warning) 8%, transparent)",
      color: "var(--status-warning)",
      border: "1px solid color-mix(in srgb, var(--status-warning) 22%, transparent)",
    };
    if (p === "medium") return {
      background: "color-mix(in srgb, var(--accent) 8%, transparent)",
      color: "var(--accent)",
      border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
    };
    return {
      background: "transparent",
      color: "var(--text-muted)",
      border: "1px solid var(--border)",
    };
  };

  const numBadgeStyle = (p: string): React.CSSProperties => ({
    width: 22, height: 22, borderRadius: 5,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 11, fontWeight: 700, fontFamily: "var(--font-mono)", flexShrink: 0, marginTop: 1,
    ...priorityStyle(p),
  });

  return (
    <CanvasPanelHost title={title}>
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>

        {/* ── Header ── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: severityColor, display: "inline-block", flexShrink: 0 }} />
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                letterSpacing: "0.1em", fontFamily: "var(--font-mono)", color: severityColor,
              }}>
                {signal.severity} · {inv.status}
              </span>
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 500, color: "var(--text)", margin: "0 0 6px 0", lineHeight: 1.25, fontFamily: "var(--font-display)" }}>
              {inv.title}
            </h1>
            <div style={{ fontSize: 13, color: "var(--text-muted)", display: "flex", alignItems: "center", gap: 0 }}>
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 500 }}>{inv.entity}</span>
              <span style={{ margin: "0 8px", color: "var(--border)" }}>·</span>
              <span>{inv.entityType}</span>
              <span style={{ margin: "0 8px", color: "var(--border)" }}>·</span>
              <span>Detected {inv.detectedAt}</span>
            </div>
          </div>
          <span style={{
            padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700,
            fontFamily: "var(--font-mono)", textTransform: "uppercase", flexShrink: 0,
            background: severityBg, color: severityColor, border: `1px solid ${severityBorder}`,
          }}>
            {signal.severity}
          </span>
        </div>

        {/* ── Synth's Assessment ── */}
        <div className="v6-section-label" style={{ marginBottom: 8 }}>Synth's Assessment</div>
        <div style={{
          padding: "16px 20px", borderRadius: 10, marginBottom: 24,
          background: "color-mix(in srgb, var(--accent) 8%, transparent)",
          border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <SynthMark size={16} active />
            <span style={{
              fontSize: 10, fontWeight: 700, color: "var(--accent)",
              textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "var(--font-mono)",
            }}>
              Analysis
            </span>
            <ConfidenceIndicator value={inv.synthAssessment.confidence} qualifier="confidence" />
          </div>
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.65, margin: 0 }}>
            {inv.synthAssessment.summary}
          </p>
        </div>

        {/* ── Configuration Drift ── */}
        {inv.driftConflicts && inv.driftConflicts.length > 0 && (
          <>
            <div className="v6-section-label" style={{ marginBottom: 12 }}>Configuration Drift</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
              {inv.driftConflicts.map((conflict, i) => (
                <div
                  key={i}
                  style={{
                    borderRadius: 10,
                    border: `1px solid ${severityBorder}`,
                    background: severityBg,
                    padding: "16px 20px",
                  }}
                >
                  <div style={{
                    fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono)",
                    color: "var(--text)", marginBottom: 14, letterSpacing: "0.02em",
                  }}>
                    {conflict.variable}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                    <div style={{
                      borderRadius: 8, padding: "12px 14px",
                      background: "color-mix(in srgb, var(--status-succeeded) 6%, var(--canvas))",
                      border: "1px solid color-mix(in srgb, var(--status-succeeded) 18%, transparent)",
                    }}>
                      <div style={{
                        fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)",
                        textTransform: "uppercase", letterSpacing: "0.1em",
                        color: "var(--status-succeeded)", marginBottom: 8,
                      }}>
                        In Partition
                      </div>
                      <div style={{
                        fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", lineHeight: 1.5,
                        wordBreak: "break-all",
                      }}>
                        {conflict.partitionValue}
                      </div>
                    </div>
                    <div style={{
                      borderRadius: 8, padding: "12px 14px",
                      background: "color-mix(in srgb, var(--status-warning) 6%, var(--canvas))",
                      border: "1px solid color-mix(in srgb, var(--status-warning) 18%, transparent)",
                    }}>
                      <div style={{
                        fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)",
                        textTransform: "uppercase", letterSpacing: "0.1em",
                        color: "var(--status-warning)", marginBottom: 8,
                      }}>
                        Violated Rule
                      </div>
                      <div style={{
                        fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", lineHeight: 1.5,
                      }}>
                        {conflict.violatedRule}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    Affected: <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text)" }}>{conflict.affectedEnvoy}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Evidence ── */}
        {inv.evidence.length > 0 && (
          <>
            <div className="v6-section-label" style={{ marginBottom: 8 }}>Evidence</div>
            <div style={{
              borderRadius: 10, overflow: "hidden",
              border: "1px solid var(--border)", background: "var(--surface)", marginBottom: 24,
            }}>
              {inv.evidence.map((e, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex", alignItems: "center", padding: "11px 16px",
                    borderBottom: i < inv.evidence.length - 1 ? "1px solid var(--border)" : "none",
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                    background: evidenceColor(e.status), display: "inline-block",
                  }} />
                  <span style={{ flex: 1, fontSize: 13, color: "var(--text)", marginLeft: 10 }}>{e.label}</span>
                  <span style={{
                    fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 500,
                    color: evidenceColor(e.status),
                  }}>
                    {e.value}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Recommendations ── */}
        {inv.recommendations.length > 0 && (
          <>
            <div className="v6-section-label" style={{ marginBottom: 8 }}>Recommendations</div>
            <div style={{ marginBottom: 24 }}>
              {inv.recommendations.map((r, i) => (
                <div
                  key={i}
                  style={{
                    padding: "14px 18px", borderRadius: 10, marginBottom: 8,
                    background: "var(--surface)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "flex-start", gap: 14,
                  }}
                >
                  <span style={numBadgeStyle(r.priority)}>{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>{r.action}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{r.detail}</div>
                  </div>
                  <span style={{
                    padding: "2px 8px", borderRadius: 3, fontSize: 9, fontWeight: 700,
                    fontFamily: "var(--font-mono)", textTransform: "uppercase", alignSelf: "center",
                    flexShrink: 0, ...priorityStyle(r.priority),
                  }}>
                    {r.priority}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Timeline ── */}
        {inv.timeline.length > 0 && (
          <>
            <div className="v6-section-label" style={{ marginBottom: 8 }}>Timeline</div>
            <div style={{
              borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)",
              marginBottom: 24, padding: "4px 0",
            }}>
              {inv.timeline.map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 14, padding: "9px 16px", alignItems: "flex-start" }}>
                  <span style={{
                    fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)",
                    minWidth: 70, paddingTop: 1, flexShrink: 0,
                  }}>
                    {t.time}
                  </span>
                  <div style={{ width: 8, display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0, paddingTop: 5 }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                      background: i === inv.timeline.length - 1 ? severityColor : "var(--text-muted)",
                      display: "inline-block",
                    }} />
                    {i < inv.timeline.length - 1 && (
                      <div style={{ width: 1, height: 20, background: "var(--border)", marginTop: 2 }} />
                    )}
                  </div>
                  <span style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.45 }}>{t.event}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Related Deployments ── */}
        {inv.relatedDeployments.length > 0 && (
          <>
            <div className="v6-section-label" style={{ marginBottom: 8 }}>Related Deployments</div>
            <div style={{
              borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)", marginBottom: 24,
            }}>
              {inv.relatedDeployments.map((d, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "11px 16px",
                    borderBottom: i < inv.relatedDeployments.length - 1 ? "1px solid var(--border)" : "none",
                  }}
                >
                  <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{d.artifact}</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{d.version}</span>
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>→</span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{d.target}</span>
                  </div>
                  <StatusBadge status={d.status as import("../../types.js").DeploymentStatus} />
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{d.time}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Action bar ── */}
        <div style={{
          padding: "16px 20px", borderRadius: 10,
          background: "var(--surface)", border: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>
          {inv.entityType === "envoy" && signal.relatedEntity && (
            <button
              style={{
                padding: "9px 18px", borderRadius: 6, cursor: "pointer",
                border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
                background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                color: "var(--accent)", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)",
              }}
              onClick={() => pushPanel({ type: "envoy-detail", title: signal.relatedEntity!.name, params: { id: signal.relatedEntity!.id } })}
            >
              View Envoy →
            </button>
          )}
          {inv.entityType === "artifact" && signal.relatedEntity?.type === "deployment" && (
            <button
              style={{
                padding: "9px 18px", borderRadius: 6, cursor: "pointer",
                border: "1px solid color-mix(in srgb, var(--status-succeeded) 22%, transparent)",
                background: "color-mix(in srgb, var(--status-succeeded) 8%, transparent)",
                color: "var(--status-succeeded)", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)",
              }}
              onClick={() => pushPanel({ type: "debrief", title: "Debriefs", params: { deploymentId: signal.relatedEntity!.id } })}
            >
              View Debrief →
            </button>
          )}
          {inv.entityType === "partition" && signal.relatedEntity && (
            <>
              <button
                style={{
                  padding: "9px 18px", borderRadius: 6, cursor: "pointer",
                  border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
                  background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                  color: "var(--accent)", fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)",
                }}
                onClick={() => pushPanel({ type: "environment-detail", title: signal.relatedEntity!.name, params: { id: signal.relatedEntity!.id } })}
              >
                View Environment →
              </button>
              <button
                style={{
                  padding: "9px 18px", borderRadius: 6, cursor: "pointer",
                  border: `1px solid ${severityBorder}`,
                  background: severityBg,
                  color: severityColor, fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)",
                }}
              >
                Resolve Drift →
              </button>
            </>
          )}
          <button
            style={{
              padding: "9px 18px", borderRadius: 6, cursor: "pointer",
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-muted)", fontSize: 12, fontFamily: "var(--font-mono)",
            }}
            onClick={() => popPanel()}
          >
            Dismiss Signal
          </button>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {signal.type}
          </span>
        </div>

      </div>
    </CanvasPanelHost>
  );
}
