import { useState, useMemo } from "react";
import {
  getArtifact,
  addArtifactAnnotation,
  addArtifactVersion,
  listDeployments,
  listEnvironments,
} from "../../api.js";
import type { Deployment, Environment } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import { useQuery, invalidateExact } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import SectionHeader from "../SectionHeader.js";

interface Props {
  artifactId: string;
  title: string;
}

type TabKey = "analysis" | "annotations" | "learning" | "versions" | "deployments";

function confidenceColor(c: number): string {
  if (c >= 0.7) return "var(--status-succeeded)";
  if (c >= 0.5) return "var(--status-warning)";
  return "var(--status-failed)";
}

function confidenceLabel(c: number): string {
  if (c >= 0.7) return "HIGH";
  if (c >= 0.5) return "MEDIUM";
  return "LOW";
}

const sourceLabels: Record<string, string> = {
  "initial-analysis": "Initial Analysis",
  "user-correction": "User Correction",
  "pattern-applied": "Pattern Applied",
  "re-analysis": "Re-analysis",
};

export default function ArtifactDetailPanel({ artifactId, title }: Props) {
  const { pushPanel } = useCanvas();

  const { data: artData, loading: l1 } = useQuery(`artifact:${artifactId}`, () => getArtifact(artifactId));
  const { data: deployments, loading: l2 } = useQuery(`deployments:artifact:${artifactId}`, () => listDeployments({ artifactId }).catch(() => [] as Deployment[]));
  const { data: envs, loading: l3 } = useQuery("list:environments", () => listEnvironments().catch(() => [] as Environment[]));
  const loading = l1 || l2 || l3;

  const artifact = artData?.artifact ?? null;
  const versions = artData?.versions ?? [];
  const envNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const e of (envs ?? [])) map[e.id] = e.name;
    return map;
  }, [envs]);

  const [activeTab, setActiveTab] = useState<TabKey>("analysis");

  // Annotation form
  const [annotationField, setAnnotationField] = useState("summary");
  const [annotationCorrection, setAnnotationCorrection] = useState("");
  const [annotationSubmitting, setAnnotationSubmitting] = useState(false);
  const [annotationError, setAnnotationError] = useState<string | null>(null);

  // Version form
  const [showVersionForm, setShowVersionForm] = useState(false);
  const [versionString, setVersionString] = useState("");
  const [versionSource, setVersionSource] = useState("");
  const [versionSubmitting, setVersionSubmitting] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);

  async function handleAnnotationSubmit() {
    if (!annotationCorrection.trim()) {
      setAnnotationError("Correction text is required");
      return;
    }
    setAnnotationSubmitting(true);
    setAnnotationError(null);
    try {
      await addArtifactAnnotation(artifactId, {
        field: annotationField,
        correction: annotationCorrection.trim(),
      });
      invalidateExact(`artifact:${artifactId}`);
      setAnnotationCorrection("");
    } catch (err: unknown) {
      setAnnotationError(err instanceof Error ? err.message : "Failed to add annotation");
    } finally {
      setAnnotationSubmitting(false);
    }
  }

  async function handleVersionSubmit() {
    if (!versionString.trim()) {
      setVersionError("Version string is required");
      return;
    }
    setVersionSubmitting(true);
    setVersionError(null);
    try {
      await addArtifactVersion(artifactId, {
        version: versionString.trim(),
        source: versionSource.trim() || "manual",
      });
      invalidateExact(`artifact:${artifactId}`);
      setVersionString("");
      setVersionSource("");
      setShowVersionForm(false);
    } catch (err: unknown) {
      setVersionError(err instanceof Error ? err.message : "Failed to add version");
    } finally {
      setVersionSubmitting(false);
    }
  }

  if (loading)
    return (
      <CanvasPanelHost title={title} hideRootCrumb>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );

  if (!artifact)
    return (
      <CanvasPanelHost title={title} hideRootCrumb>
        <div className="error-msg">Artifact not found</div>
      </CanvasPanelHost>
    );

  // Fully null-safe analysis — handles legacy DB rows where analysis may be null/missing fields
  const analysis = artifact.analysis ?? { summary: "", dependencies: [], configurationExpectations: {}, confidence: 0 };
  const confidence = analysis.confidence ?? 0;
  const cColor = confidenceColor(confidence);
  const cLabel = confidenceLabel(confidence);
  const isHighConf = confidence >= 0.9;
  const isLowConf = confidence < 0.7;
  const configEntries = Object.entries(analysis.configurationExpectations ?? {});
  const sortedDeployments = [...(deployments ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  // Stats derived from real data
  const deployCount = sortedDeployments.length;
  const successCount = sortedDeployments.filter(d => d.status === "succeeded").length;
  const successRate = deployCount > 0 ? successCount / deployCount : null;
  const annotations = artifact.annotations ?? [];
  const correctionCount = annotations.length;

  // Tech tags from dependencies (first 6)
  const dependencies = analysis.dependencies ?? [];
  const techTags = dependencies.slice(0, 6);

  // Latest version string
  const latestVersion = versions.length > 0
    ? [...versions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.version
    : null;

  return (
    <CanvasPanelHost title={title} hideRootCrumb dismissible={false}>
      <div className="v2-detail-view">

        {/* Header */}
        <div style={{ padding: "4px 16px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 500, color: "var(--text)", margin: "0 0 6px 0", lineHeight: 1.2, fontFamily: "var(--font-display)" }}>
                {artifact.name}
                {latestVersion && (
                  <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)", marginLeft: 10, fontFamily: "monospace" }}>
                    {latestVersion}
                  </span>
                )}
              </h1>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  {artifact.type}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 44, height: 3, borderRadius: 2, background: "color-mix(in srgb, var(--text) 10%, transparent)", overflow: "hidden" }}>
                    <div style={{ width: `${Math.round(confidence * 100)}%`, height: "100%", borderRadius: 2, background: cColor }} />
                  </div>
                  <span style={{ fontSize: 10, fontFamily: "monospace", fontWeight: 600, color: cColor }}>
                    {cLabel}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>understanding</span>
                </div>
              </div>
            </div>
            <button
              onClick={() => pushPanel({ type: "deployment-authoring", title: "New Deployment", params: { artifactId: artifact.id } })}
              style={{
                padding: "9px 18px",
                borderRadius: 6,
                border: "1px solid color-mix(in srgb, var(--status-succeeded) 40%, transparent)",
                background: "color-mix(in srgb, var(--status-succeeded) 10%, transparent)",
                color: "var(--status-succeeded)",
                fontSize: 12,
                fontWeight: 600,
                fontFamily: "monospace",
                cursor: "pointer",
                flexShrink: 0,
                marginTop: 2,
              }}
            >
              Deploy →
            </button>
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            {/* Dependencies */}
            <div style={{ flex: 1, padding: "12px 14px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Dependencies
              </div>
              {techTags.length > 0 ? (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {techTags.map((t, i) => (
                    <span key={i} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, background: "color-mix(in srgb, var(--text) 6%, transparent)", color: "var(--text-muted)", fontFamily: "monospace", border: "1px solid var(--border)" }}>
                      {t}
                    </span>
                  ))}
                </div>
              ) : (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{artifact.type}</span>
              )}
            </div>

            {/* Deployments */}
            <div style={{ flex: 1, padding: "12px 14px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Deployments
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)", fontFamily: "monospace", lineHeight: 1 }}>{deployCount}</div>
              {successRate !== null ? (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{Math.round(successRate * 100)}% success rate</div>
              ) : (
                <div style={{ fontSize: 11, color: "var(--status-warning)", marginTop: 3 }}>Never deployed</div>
              )}
            </div>

            {/* Corrections */}
            <div style={{ flex: 1, padding: "12px 14px", borderRadius: 8, background: "var(--surface)", border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                Corrections
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: correctionCount > 0 ? "var(--accent)" : "var(--text)", fontFamily: "monospace", lineHeight: 1 }}>{correctionCount}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>from user feedback</div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 16px 0" }}>
          <div className="segmented-control">
            {(["analysis", "annotations", "learning", "versions", "deployments"] as const).map((tab) => (
              <button
                key={tab}
                className={`segmented-control-btn ${activeTab === tab ? "segmented-control-btn-active" : ""}`}
                onClick={() => setActiveTab(tab)}
              >
                {tab === "learning" ? "Learning History" : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* --- Analysis Tab --- */}
        {activeTab === "analysis" && (
          <div style={{ padding: "20px 16px" }}>

            {/* What Synth Understands */}
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "var(--text-muted)", fontFamily: "monospace", marginBottom: 10 }}>
              What Synth Understands
            </div>
            <div style={{
              padding: "16px 18px",
              borderRadius: 10,
              marginBottom: 24,
              background: "color-mix(in srgb, var(--accent) 6%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 18%, transparent)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1, fontFamily: "monospace" }}>
                  Analysis
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ width: 44, height: 3, borderRadius: 2, background: "color-mix(in srgb, var(--text) 10%, transparent)", overflow: "hidden" }}>
                    <div style={{ width: `${Math.round(confidence * 100)}%`, height: "100%", borderRadius: 2, background: cColor }} />
                  </div>
                  <span style={{ fontSize: 10, fontFamily: "monospace", fontWeight: 600, color: cColor }}>{cLabel}</span>
                </div>
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>understanding</span>
              </div>
              <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
                {analysis.summary || "No analysis summary available."}
              </div>
            </div>

            {/* Configuration Expectations */}
            {configEntries.length > 0 && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "var(--text-muted)", fontFamily: "monospace", marginBottom: 10 }}>
                  Configuration Expectations
                </div>
                <div className="canvas-var-table" style={{ marginBottom: 24 }}>
                  {configEntries.map(([key, val]) => (
                    <div key={key} className="canvas-var-row">
                      <span className="mono">{key}</span>
                      <span className="mono">{val}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Inferred Deployment Pattern */}
            {analysis.deploymentIntent && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "var(--text-muted)", fontFamily: "monospace", marginBottom: 10 }}>
                  Inferred Deployment Pattern
                </div>
                <div style={{ padding: "14px 18px", borderRadius: 10, marginBottom: 24, background: "var(--surface)", border: "1px solid var(--border)" }}>
                  <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, margin: 0 }}>
                    {analysis.deploymentIntent}
                  </p>
                </div>
              </>
            )}

            {/* Feedback Section */}
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "var(--text-muted)", fontFamily: "monospace", marginBottom: 10 }}>
              Feedback
            </div>
            <div style={{
              padding: "18px 20px",
              borderRadius: 10,
              marginBottom: correctionCount > 0 ? 24 : 0,
              background: isLowConf
                ? "color-mix(in srgb, var(--status-warning) 6%, transparent)"
                : "var(--surface)",
              border: `1px solid ${isLowConf ? "color-mix(in srgb, var(--status-warning) 25%, transparent)" : "var(--border)"}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: isHighConf ? "var(--status-succeeded)" : isLowConf ? "var(--status-warning)" : "var(--text-muted)" }}>
                  {isHighConf
                    ? "✓ Synth is confident, but confidence isn't certainty"
                    : isLowConf
                      ? "⚠ Synth needs your help with this artifact"
                      : "◎ Synth's understanding is developing"}
                </span>
              </div>
              <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55, margin: "0 0 14px 0" }}>
                {isHighConf
                  ? "If anything above looks wrong — a misidentified dependency, an incorrect assumption about config, a wrong port — correcting it now prevents bad plans later. Even small corrections compound."
                  : isLowConf
                    ? "This artifact's structure is unfamiliar. The analysis above is Synth's best guess, but it may contain errors. Corrections are incorporated immediately and improve future plans."
                    : "The analysis is reasonable but could use refinement. Corrections at this stage significantly accelerate understanding."}
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setActiveTab("annotations")}
                  style={{
                    padding: "9px 18px", borderRadius: 6, cursor: "pointer", fontFamily: "monospace", fontSize: 12, fontWeight: 600,
                    border: `1.5px solid ${isLowConf ? "var(--status-warning)" : "var(--accent)"}`,
                    background: "transparent",
                    color: isLowConf ? "var(--status-warning)" : "var(--accent)",
                  }}
                >
                  {isLowConf ? "Annotate Artifact" : "Suggest a Correction"}
                </button>
                <button
                  onClick={() => setActiveTab("annotations")}
                  style={{
                    padding: "9px 18px", borderRadius: 6, cursor: "pointer", fontFamily: "monospace", fontSize: 12, fontWeight: 600,
                    border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)",
                  }}
                >
                  Flag Incorrect Analysis
                </button>
              </div>
            </div>

            {/* Correction History (inline, last 3) */}
            {correctionCount > 0 && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "var(--text-muted)", fontFamily: "monospace", marginBottom: 10 }}>
                  Correction History
                </div>
                <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)" }}>
                  {annotations.slice(0, 3).map((ann, i, arr) => (
                    <div key={i} style={{ padding: "12px 16px", borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{new Date(ann.annotatedAt).toLocaleDateString()}</span>
                        {ann.annotatedBy && <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{ann.annotatedBy}</span>}
                      </div>
                      <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5, margin: 0 }}>{ann.correction}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* --- Annotations Tab --- */}
        {activeTab === "annotations" && (
          <div style={{ padding: "16px" }}>
            <SectionHeader color="var(--status-warning)" shape="diamond" label="Corrections & Annotations" />

            {/* Confidence-adapted feedback section */}
            <div style={{
              padding: "12px 14px",
              borderRadius: 8,
              marginBottom: 16,
              background: confidence >= 0.7
                ? "color-mix(in srgb, var(--status-succeeded) 6%, transparent)"
                : confidence >= 0.5
                  ? "color-mix(in srgb, var(--status-warning) 6%, transparent)"
                  : "color-mix(in srgb, var(--status-failed) 6%, transparent)",
              border: `1px solid ${confidence >= 0.7
                ? "color-mix(in srgb, var(--status-succeeded) 18%, transparent)"
                : confidence >= 0.5
                  ? "color-mix(in srgb, var(--status-warning) 18%, transparent)"
                  : "color-mix(in srgb, var(--status-failed) 18%, transparent)"}`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 4 }}>
                {confidence >= 0.7
                  ? "Synth is confident, but confidence isn't certainty."
                  : confidence >= 0.5
                    ? "Synth's understanding is developing."
                    : "Synth needs your help understanding this artifact."}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {confidence >= 0.7
                  ? "If you notice anything incorrect in the analysis above, correct it so Synth can learn."
                  : confidence >= 0.5
                    ? "Review the analysis and provide corrections to improve future deployments."
                    : "This artifact needs annotations before Synth can deploy it safely. Use the form below to provide corrections."}
              </div>
            </div>

            {/* Add correction form */}
            <div style={{ padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
                {confidence < 0.5 ? "Annotate Artifact" : confidence < 0.7 ? "Suggest a Correction" : "Flag Incorrect Analysis"}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div style={{ flex: "0 0 200px" }}>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>Field</label>
                  <select
                    value={annotationField}
                    onChange={(e) => setAnnotationField(e.target.value)}
                    style={{ width: "100%", fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--text)" }}
                  >
                    <option value="summary">Summary</option>
                    <option value="dependencies">Dependencies</option>
                    <option value="configurationExpectations">Configuration Expectations</option>
                    <option value="deploymentIntent">Deployment Intent</option>
                  </select>
                </div>
                <div style={{ flex: "1 1 250px" }}>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>Correction</label>
                  <input
                    value={annotationCorrection}
                    onChange={(e) => setAnnotationCorrection(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAnnotationSubmit()}
                    placeholder="What should be corrected..."
                    style={{ width: "100%", fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--text)", boxSizing: "border-box" }}
                  />
                </div>
                <button className="btn btn-primary" onClick={handleAnnotationSubmit} disabled={annotationSubmitting} style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }}>
                  {annotationSubmitting ? "Saving..." : "Submit"}
                </button>
              </div>
              {annotationError && <div style={{ color: "var(--status-failed)", fontSize: 12, marginTop: 6 }}>{annotationError}</div>}
            </div>

            {/* Annotations list */}
            {annotations.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {annotations.map((ann, i) => (
                  <div key={i} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--status-warning)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{ann.field}</span>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{new Date(ann.annotatedAt).toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>{ann.correction}</div>
                    {ann.annotatedBy && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>by {ann.annotatedBy}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 0" }}>
                No annotations yet. Use the form above to correct any analysis that needs improvement.
              </div>
            )}
          </div>
        )}

        {/* --- Learning History Tab --- */}
        {activeTab === "learning" && (
          <div style={{ padding: "16px" }}>
            <SectionHeader color="var(--accent)" shape="circle" label="Learning History" />

            {(artifact.learningHistory ?? []).length > 0 ? (
              <div style={{ position: "relative", paddingLeft: 20 }}>
                <div style={{ position: "absolute", left: 6, top: 8, bottom: 8, width: 2, background: "var(--border)" }} />
                {(artifact.learningHistory ?? []).map((entry, i) => {
                  const source = (entry as unknown as Record<string, unknown>).source as string | undefined;
                  return (
                    <div key={i} style={{ position: "relative", marginBottom: 16 }}>
                      <div style={{ position: "absolute", left: -17, top: 6, width: 10, height: 10, borderRadius: "50%", background: "var(--accent)", border: "2px solid var(--input-bg)" }} />
                      <div style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{entry.event}</span>
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{new Date(entry.timestamp).toLocaleString()}</span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{entry.details}</div>
                        {source && (
                          <div style={{ marginTop: 6, fontSize: 10, fontWeight: 600, color: "var(--accent)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {sourceLabels[source] ?? source}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 0" }}>No learning history entries yet.</div>
            )}
          </div>
        )}

        {/* --- Versions Tab --- */}
        {activeTab === "versions" && (
          <div style={{ padding: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <SectionHeader color="var(--accent)" shape="square" label="Versions" />
              <button className="btn btn-primary" onClick={() => setShowVersionForm(!showVersionForm)} style={{ fontSize: 12, padding: "6px 14px" }}>
                {showVersionForm ? "Cancel" : "+ Add Version"}
              </button>
            </div>

            {showVersionForm && (
              <div style={{ padding: 12, borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", marginBottom: 16, display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 150px" }}>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>Version</label>
                  <input value={versionString} onChange={(e) => setVersionString(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleVersionSubmit()} placeholder="e.g. 2.1.0" style={{ width: "100%", fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--text)" }} />
                </div>
                <div style={{ flex: "1 1 150px" }}>
                  <label style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 3 }}>Source</label>
                  <input value={versionSource} onChange={(e) => setVersionSource(e.target.value)} placeholder="e.g. ci-pipeline" style={{ width: "100%", fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--text)" }} />
                </div>
                <button className="btn btn-primary" onClick={handleVersionSubmit} disabled={versionSubmitting} style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }}>
                  {versionSubmitting ? "Adding..." : "Add"}
                </button>
                {versionError && <div style={{ width: "100%", color: "var(--status-failed)", fontSize: 12 }}>{versionError}</div>}
              </div>
            )}

            {versions.length > 0 ? (
              <div style={{ borderRadius: 10, border: "1px solid var(--border)", background: "var(--surface)" }}>
                {[...versions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).map((ver, i, arr) => (
                  <div key={ver.id} style={{ padding: "12px 16px", borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none", display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: "var(--accent)", fontFamily: "monospace" }}>{ver.version}</span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{ver.source}</span>
                    {ver.metadata && Object.keys(ver.metadata).length > 0 && (
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{Object.entries(ver.metadata).map(([k, v]) => `${k}=${v}`).join(", ")}</span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>{new Date(ver.createdAt).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 0" }}>No versions recorded yet.</div>
            )}
          </div>
        )}

        {/* --- Deployments Tab --- */}
        {activeTab === "deployments" && (
          <div style={{ padding: "16px" }}>
            <SectionHeader color="var(--status-succeeded)" shape="circle" label="Related Deployments" />

            {sortedDeployments.length > 0 ? (
              <div className="v2-scoped-list">
                {sortedDeployments.map((d) => (
                  <div
                    key={d.id}
                    className="v2-deploy-row"
                    onClick={() => pushPanel({ type: "deployment-detail", title: `Deployment ${d.version}`, params: { id: d.id } })}
                  >
                    <div className={`v2-deploy-dot v2-deploy-${d.status}`} />
                    <div className="v2-deploy-info">
                      <span className="v2-deploy-version">{d.version}</span>
                      <span className="v2-deploy-env">{envNameMap[d.environmentId] ?? d.environmentId}</span>
                    </div>
                    <span className="v2-deploy-time">{new Date(d.createdAt).toLocaleString()}</span>
                    <div className={`v2-deploy-status-pill v2-pill-${d.status}`}>{d.status}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 0" }}>No deployments for this artifact yet.</div>
            )}
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
