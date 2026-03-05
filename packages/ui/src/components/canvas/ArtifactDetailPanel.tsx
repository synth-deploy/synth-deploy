import { useState, useEffect } from "react";
import {
  getArtifact,
  addArtifactAnnotation,
  listArtifactVersions,
  addArtifactVersion,
  listDeployments,
} from "../../api.js";
import type { Artifact, ArtifactVersion, Deployment } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import SectionHeader from "../SectionHeader.js";

interface Props {
  artifactId: string;
  title: string;
}

type TabKey = "analysis" | "annotations" | "learning" | "versions" | "deployments";

function confidenceColor(c: number): string {
  if (c >= 0.7) return "#16a34a";
  if (c >= 0.5) return "#ca8a04";
  return "#dc2626";
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

  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    Promise.all([
      getArtifact(artifactId),
      listArtifactVersions(artifactId).catch(() => []),
      listDeployments({ artifactId }).catch(() => []),
    ])
      .then(([artData, vers, deps]) => {
        setArtifact(artData.artifact);
        setVersions(artData.versions ?? vers);
        setDeployments(deps);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [artifactId]);

  async function handleAnnotationSubmit() {
    if (!annotationCorrection.trim()) {
      setAnnotationError("Correction text is required");
      return;
    }
    setAnnotationSubmitting(true);
    setAnnotationError(null);
    try {
      const updated = await addArtifactAnnotation(artifactId, {
        field: annotationField,
        correction: annotationCorrection.trim(),
      });
      setArtifact(updated);
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
      const ver = await addArtifactVersion(artifactId, {
        version: versionString.trim(),
        source: versionSource.trim() || "manual",
      });
      setVersions((prev) => [...prev, ver]);
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
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );

  if (!artifact)
    return (
      <CanvasPanelHost title={title}>
        <div className="error-msg">Artifact not found</div>
      </CanvasPanelHost>
    );

  const confidence = artifact.analysis.confidence;
  const cColor = confidenceColor(confidence);
  const cLabel = confidenceLabel(confidence);
  const configEntries = Object.entries(artifact.analysis.configurationExpectations ?? {});
  const sortedDeployments = [...deployments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <CanvasPanelHost title={title}>
      <div className="v2-detail-view">
        {/* Low confidence banner */}
        {confidence < 0.5 && (
          <div
            style={{
              padding: "12px 16px",
              background: "rgba(220,38,38,0.08)",
              border: "1px solid rgba(220,38,38,0.25)",
              borderRadius: 8,
              margin: "0 16px 16px",
              fontSize: 13,
              color: "#dc2626",
              lineHeight: 1.5,
            }}
          >
            Command's analysis of this artifact has low confidence. Review and correct to improve future deployments.
          </div>
        )}

        {/* Header */}
        <div style={{ padding: "0 16px 16px", borderBottom: "1px solid var(--agent-border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: "rgba(99,225,190,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: 16,
                color: "var(--agent-accent, #63e1be)",
              }}
            >
              {artifact.name[0]?.toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 16, color: "var(--agent-text)" }}>
                {artifact.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--agent-text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {artifact.type}
              </div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  height: 6,
                  width: 60,
                  borderRadius: 3,
                  background: "rgba(255,255,255,0.1)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${Math.round(confidence * 100)}%`,
                    background: cColor,
                    borderRadius: 3,
                  }}
                />
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: cColor,
                  letterSpacing: "0.04em",
                }}
              >
                {cLabel} ({Math.round(confidence * 100)}%)
              </span>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="v2-tab-bar">
          {(["analysis", "annotations", "learning", "versions", "deployments"] as const).map((tab) => (
            <button
              key={tab}
              className={`v2-tab ${activeTab === tab ? "v2-tab-active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "learning" ? "learning history" : tab}
            </button>
          ))}
        </div>

        {/* --- Analysis Tab --- */}
        {activeTab === "analysis" && (
          <div style={{ padding: "16px" }}>
            {/* Summary */}
            <SectionHeader color="#63e1be" shape="circle" label="Summary" />
            <div
              style={{
                fontSize: 13,
                color: "var(--agent-text)",
                lineHeight: 1.6,
                marginBottom: 20,
                padding: "8px 12px",
                background: "rgba(255,255,255,0.03)",
                borderRadius: 6,
                borderLeft: "2px solid rgba(99,225,190,0.3)",
              }}
            >
              {artifact.analysis.summary || "No analysis summary available."}
            </div>

            {/* Dependencies */}
            <SectionHeader color="#6366f1" shape="diamond" label="Dependencies" />
            {artifact.analysis.dependencies.length > 0 ? (
              <ul style={{ margin: "0 0 20px", paddingLeft: 20, fontSize: 13, color: "var(--agent-text)", lineHeight: 1.8 }}>
                {artifact.analysis.dependencies.map((dep, i) => (
                  <li key={i}>{dep}</li>
                ))}
              </ul>
            ) : (
              <div style={{ fontSize: 13, color: "var(--agent-text-muted)", marginBottom: 20 }}>
                No dependencies identified.
              </div>
            )}

            {/* Configuration Expectations */}
            <SectionHeader color="#f59e0b" shape="square" label="Configuration Expectations" />
            {configEntries.length > 0 ? (
              <div className="canvas-var-table" style={{ marginBottom: 20 }}>
                {configEntries.map(([key, val]) => (
                  <div key={key} className="canvas-var-row">
                    <span className="mono">{key}</span>
                    <span className="mono">{val}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--agent-text-muted)", marginBottom: 20 }}>
                No configuration expectations identified.
              </div>
            )}

            {/* Deployment Intent */}
            {artifact.analysis.deploymentIntent && (
              <>
                <SectionHeader color="#e879f9" shape="circle" label="Deployment Intent" />
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--agent-text)",
                    lineHeight: 1.6,
                    padding: "8px 12px",
                    background: "rgba(255,255,255,0.03)",
                    borderRadius: 6,
                    borderLeft: "2px solid rgba(232,121,249,0.3)",
                  }}
                >
                  {artifact.analysis.deploymentIntent}
                </div>
              </>
            )}
          </div>
        )}

        {/* --- Annotations Tab --- */}
        {activeTab === "annotations" && (
          <div style={{ padding: "16px" }}>
            <SectionHeader color="#f59e0b" shape="diamond" label="Corrections & Annotations" />

            {/* Add correction form */}
            <div
              style={{
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--agent-border)",
                background: "var(--agent-card-bg)",
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--agent-text)", marginBottom: 8 }}>
                Add Correction
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div style={{ flex: "0 0 200px" }}>
                  <label style={{ fontSize: 11, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
                    Field
                  </label>
                  <select
                    value={annotationField}
                    onChange={(e) => setAnnotationField(e.target.value)}
                    style={{
                      width: "100%",
                      fontSize: 13,
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--agent-border)",
                      background: "var(--agent-bg)",
                      color: "var(--agent-text)",
                    }}
                  >
                    <option value="summary">Summary</option>
                    <option value="dependencies">Dependencies</option>
                    <option value="configurationExpectations">Configuration Expectations</option>
                    <option value="deploymentIntent">Deployment Intent</option>
                  </select>
                </div>
                <div style={{ flex: "1 1 250px" }}>
                  <label style={{ fontSize: 11, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
                    Correction
                  </label>
                  <input
                    value={annotationCorrection}
                    onChange={(e) => setAnnotationCorrection(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAnnotationSubmit()}
                    placeholder="What should be corrected..."
                    style={{
                      width: "100%",
                      fontSize: 13,
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--agent-border)",
                      background: "var(--agent-bg)",
                      color: "var(--agent-text)",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleAnnotationSubmit}
                  disabled={annotationSubmitting}
                  style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }}
                >
                  {annotationSubmitting ? "Saving..." : "Submit"}
                </button>
              </div>
              {annotationError && (
                <div style={{ color: "#dc2626", fontSize: 12, marginTop: 6 }}>{annotationError}</div>
              )}
            </div>

            {/* Annotations list */}
            {artifact.annotations.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {artifact.annotations.map((ann, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--agent-border)",
                      background: "var(--agent-card-bg)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: "#f59e0b",
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                        }}
                      >
                        {ann.field}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--agent-text-muted)" }}>
                        {new Date(ann.annotatedAt).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--agent-text)", lineHeight: 1.5 }}>
                      {ann.correction}
                    </div>
                    {ann.annotatedBy && (
                      <div style={{ fontSize: 11, color: "var(--agent-text-muted)", marginTop: 4 }}>
                        by {ann.annotatedBy}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--agent-text-muted)", padding: "8px 0" }}>
                No annotations yet. Use the form above to correct any analysis that needs improvement.
              </div>
            )}
          </div>
        )}

        {/* --- Learning History Tab --- */}
        {activeTab === "learning" && (
          <div style={{ padding: "16px" }}>
            <SectionHeader color="#e879f9" shape="circle" label="Learning History" />

            {artifact.learningHistory.length > 0 ? (
              <div style={{ position: "relative", paddingLeft: 20 }}>
                {/* Timeline line */}
                <div
                  style={{
                    position: "absolute",
                    left: 6,
                    top: 8,
                    bottom: 8,
                    width: 2,
                    background: "var(--agent-border)",
                  }}
                />
                {artifact.learningHistory.map((entry, i) => {
                  const source = (entry as Record<string, unknown>).source as string | undefined;
                  return (
                    <div key={i} style={{ position: "relative", marginBottom: 16 }}>
                      {/* Timeline dot */}
                      <div
                        style={{
                          position: "absolute",
                          left: -17,
                          top: 6,
                          width: 10,
                          height: 10,
                          borderRadius: "50%",
                          background: "#e879f9",
                          border: "2px solid var(--agent-bg)",
                        }}
                      />
                      <div
                        style={{
                          padding: "10px 14px",
                          borderRadius: 8,
                          border: "1px solid var(--agent-border)",
                          background: "var(--agent-card-bg)",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--agent-text)" }}>
                            {entry.event}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--agent-text-muted)" }}>
                            {new Date(entry.timestamp).toLocaleString()}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--agent-text-muted)", lineHeight: 1.5 }}>
                          {entry.details}
                        </div>
                        {source && (
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 10,
                              fontWeight: 600,
                              color: "#e879f9",
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                            }}
                          >
                            {sourceLabels[source] ?? source}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--agent-text-muted)", padding: "8px 0" }}>
                No learning history entries yet.
              </div>
            )}
          </div>
        )}

        {/* --- Versions Tab --- */}
        {activeTab === "versions" && (
          <div style={{ padding: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <SectionHeader color="#6366f1" shape="square" label="Versions" />
              <button
                className="btn btn-primary"
                onClick={() => setShowVersionForm(!showVersionForm)}
                style={{ fontSize: 12, padding: "6px 14px" }}
              >
                {showVersionForm ? "Cancel" : "+ Add Version"}
              </button>
            </div>

            {/* Add version form */}
            {showVersionForm && (
              <div
                style={{
                  padding: 12,
                  borderRadius: 8,
                  border: "1px solid var(--agent-border)",
                  background: "var(--agent-card-bg)",
                  marginBottom: 16,
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-end",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flex: "1 1 150px" }}>
                  <label style={{ fontSize: 11, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
                    Version
                  </label>
                  <input
                    value={versionString}
                    onChange={(e) => setVersionString(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleVersionSubmit()}
                    placeholder="e.g. 2.1.0"
                    style={{
                      width: "100%",
                      fontSize: 13,
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--agent-border)",
                      background: "var(--agent-bg)",
                      color: "var(--agent-text)",
                    }}
                  />
                </div>
                <div style={{ flex: "1 1 150px" }}>
                  <label style={{ fontSize: 11, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
                    Source
                  </label>
                  <input
                    value={versionSource}
                    onChange={(e) => setVersionSource(e.target.value)}
                    placeholder="e.g. ci-pipeline"
                    style={{
                      width: "100%",
                      fontSize: 13,
                      padding: "6px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--agent-border)",
                      background: "var(--agent-bg)",
                      color: "var(--agent-text)",
                    }}
                  />
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleVersionSubmit}
                  disabled={versionSubmitting}
                  style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }}
                >
                  {versionSubmitting ? "Adding..." : "Add"}
                </button>
                {versionError && (
                  <div style={{ width: "100%", color: "#dc2626", fontSize: 12 }}>{versionError}</div>
                )}
              </div>
            )}

            {/* Versions list */}
            {versions.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {versions.map((ver) => (
                  <div
                    key={ver.id}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: "1px solid var(--agent-border)",
                      background: "var(--agent-card-bg)",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        color: "#6366f1",
                        fontFamily: "monospace",
                      }}
                    >
                      {ver.version}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--agent-text-muted)" }}>
                      {ver.source}
                    </span>
                    {ver.metadata && Object.keys(ver.metadata).length > 0 && (
                      <span style={{ fontSize: 11, color: "var(--agent-text-muted)" }}>
                        {Object.entries(ver.metadata).map(([k, v]) => `${k}=${v}`).join(", ")}
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--agent-text-muted)" }}>
                      {new Date(ver.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--agent-text-muted)", padding: "8px 0" }}>
                No versions recorded yet.
              </div>
            )}
          </div>
        )}

        {/* --- Deployments Tab --- */}
        {activeTab === "deployments" && (
          <div style={{ padding: "16px" }}>
            <SectionHeader color="#34d399" shape="circle" label="Related Deployments" />

            {sortedDeployments.length > 0 ? (
              <div className="v2-scoped-list">
                {sortedDeployments.map((d) => (
                  <div
                    key={d.id}
                    className="v2-deploy-row"
                    onClick={() =>
                      pushPanel({
                        type: "deployment-detail",
                        title: `Deployment ${d.version}`,
                        params: { id: d.id },
                      })
                    }
                  >
                    <div className={`v2-deploy-dot v2-deploy-${d.status}`} />
                    <div className="v2-deploy-info">
                      <span className="v2-deploy-version">{d.version}</span>
                      <span className="v2-deploy-env">{d.environmentId}</span>
                    </div>
                    <span className="v2-deploy-time">
                      {new Date(d.createdAt).toLocaleString()}
                    </span>
                    <div className={`v2-deploy-status-pill v2-pill-${d.status}`}>
                      {d.status}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--agent-text-muted)", padding: "8px 0" }}>
                No deployments for this artifact yet.
              </div>
            )}
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
