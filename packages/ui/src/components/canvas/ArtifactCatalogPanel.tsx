import { useState, useMemo } from "react";
import { listArtifacts, createArtifact } from "../../api.js";
import type { Artifact } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import ConfidenceIndicator from "../ConfidenceIndicator.js";
import SynthMark from "../SynthMark.js";
import { useQuery, invalidate } from "../../hooks/useQuery.js";
import AddArtifactModal from "../AddArtifactModal.js";

interface Props {
  title: string;
}

type ConfidenceLevel = "high" | "medium" | "low";

function getConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

const confColors: Record<ConfidenceLevel, string> = { high: "var(--status-succeeded)", medium: "var(--status-warning)", low: "var(--status-failed)" };
const confLabels: Record<ConfidenceLevel, string> = { high: "HIGH", medium: "MEDIUM", low: "LOW" };

export default function ArtifactCatalogPanel({ title }: Props) {
  const { pushPanel } = useCanvas();
  const { data: artifacts, loading } = useQuery<Artifact[]>("list:artifacts", listArtifacts);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceLevel | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("docker");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const artifactTypes = useMemo(
    () => [...new Set((artifacts ?? []).map((a) => a.type))],
    [artifacts],
  );

  const filtered = useMemo(() => {
    let result = artifacts ?? [];
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((a) => a.name.toLowerCase().includes(q));
    }
    if (typeFilter) {
      result = result.filter((a) => a.type === typeFilter);
    }
    if (confidenceFilter) {
      result = result.filter(
        (a) => getConfidenceLevel(a.analysis.confidence) === confidenceFilter,
      );
    }
    return result;
  }, [artifacts, search, typeFilter, confidenceFilter]);

  const needsReview = useMemo(
    () => filtered.filter((a) => a.analysis.confidence < 0.5),
    [filtered],
  );

  const reviewed = useMemo(
    () => filtered.filter((a) => a.analysis.confidence >= 0.5),
    [filtered],
  );

  async function handleCreate() {
    if (!newName.trim()) {
      setCreateError("Name is required");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const artifact = await createArtifact({ name: newName.trim(), type: newType });
      invalidate("list:artifacts");
      setNewName("");
      setNewType("docker");
      setShowAddForm(false);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create artifact");
    } finally {
      setCreating(false);
    }
  }

  function handleArtifactClick(art: Artifact) {
    setSelectedArtifact(art);
  }

  if (loading)
    return (
      <CanvasPanelHost title={title} noBreadcrumb>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );

  const chipStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 11,
    padding: "4px 10px",
    borderRadius: 12,
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    background: active ? "var(--accent-dim)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-muted)",
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
    whiteSpace: "nowrap" as const,
  });

  const typeIcons: Record<string, string> = {
    docker: "◉",
    container: "◉",
    helm: "⎈",
    nodejs: "▣",
    binary: "▣",
    jar: "▣",
    zip: "◇",
  };

  function getTypeIcon(type: string): string {
    const key = type.toLowerCase();
    return Object.entries(typeIcons).find(([k]) => key.includes(k))?.[1] ?? "◇";
  }

  function renderArtifactRow(art: Artifact) {
    const isSelected = selectedArtifact?.id === art.id;
    return (
      <div
        key={art.id}
        onClick={() => handleArtifactClick(art)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "14px 16px",
          borderRadius: 8,
          border: `1px solid ${isSelected ? "var(--accent-border)" : "var(--border)"}`,
          background: isSelected ? "var(--accent-dim)" : "var(--surface)",
          cursor: "pointer",
          transition: "all 0.15s",
        }}
      >
        <span style={{
          width: 34,
          height: 34,
          borderRadius: 7,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: isSelected ? "var(--accent-border)" : "var(--surface-alt)",
          fontSize: 16,
          color: isSelected ? "var(--accent)" : "var(--text-muted)",
          flexShrink: 0,
        }}>
          {getTypeIcon(art.type)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text)" }}>
              {art.name}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {art.type}
            </span>
            <ConfidenceIndicator value={art.analysis.confidence} />
          </div>
        </div>
      </div>
    );
  }

  const technologies = selectedArtifact?.analysis.dependencies ?? [];
  const sidePanelConfidence = selectedArtifact?.analysis.confidence ?? 0;

  return (
    <CanvasPanelHost title={title} noBreadcrumb>
      {/* Header, search, filters — full width above the split */}
      <div style={{ padding: "0 16px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <h1 className="v6-page-title">Artifact Catalog</h1>
            <p className="v6-page-subtitle">
              Synth's understanding of your deployable artifacts. Review, correct, and teach.
              <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
                {(artifacts ?? []).length} artifact{(artifacts ?? []).length !== 1 ? "s" : ""}
              </span>
            </p>
          </div>
          <button className="btn-accent-outline" onClick={() => setShowAddModal(true)}>
            <svg className="icon-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Add Artifact
          </button>
        </div>

        {showAddModal && (
          <AddArtifactModal onClose={() => setShowAddModal(false)} />
        )}

        <input
          type="text"
          placeholder="Search artifacts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%",
            fontSize: 13,
            padding: "8px 12px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--input-bg)",
            color: "var(--text)",
            marginBottom: 12,
            boxSizing: "border-box",
          }}
        />

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {artifactTypes.map((t) => (
            <button
              key={t}
              style={chipStyle(typeFilter === t)}
              onClick={() => setTypeFilter(typeFilter === t ? null : t)}
            >
              {t}
            </button>
          ))}
          {artifactTypes.length > 0 && (
            <span style={{ borderLeft: "1px solid var(--border)", margin: "0 4px" }} />
          )}
          {(["high", "medium", "low"] as const).map((level) => (
            <button
              key={level}
              style={{
                ...chipStyle(confidenceFilter === level),
                borderColor: confidenceFilter === level ? confColors[level] : "var(--border)",
                color: confidenceFilter === level ? confColors[level] : "var(--text-muted)",
                background: confidenceFilter === level ? confColors[level] + "15" : "transparent",
              }}
              onClick={() => setConfidenceFilter(confidenceFilter === level ? null : level)}
            >
              {confLabels[level]}
            </button>
          ))}
        </div>
      </div>

      {/* Cards + side panel — horizontally split */}
      <div className="canvas-detail" style={{ display: "flex", gap: 0, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0, padding: "0 16px" }}>
          {/* Content */}
          {filtered.length === 0 && (
            <div className="text-muted" style={{ fontSize: 13, padding: "20px 0" }}>
              {(artifacts ?? []).length === 0
                ? "No artifacts yet. Use the Synth Channel to create one, or click Add Artifact above."
                : "No artifacts match your filters."}
            </div>
          )}

          {/* Needs Review section */}
          {needsReview.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  background: "color-mix(in srgb, var(--status-failed) 8%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--status-failed) 25%, transparent)",
                  marginBottom: 10,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 14 }}>!</span>
                <span style={{ fontSize: 13, color: "var(--status-failed)", fontWeight: 500 }}>
                  Needs Review
                </span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {needsReview.length} artifact{needsReview.length !== 1 ? "s" : ""} with low confidence analysis
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {needsReview.map(renderArtifactRow)}
              </div>
            </div>
          )}

          {/* Regular artifacts */}
          {reviewed.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {reviewed.map(renderArtifactRow)}
            </div>
          )}
        </div>

        {/* Side panel — quick analysis view */}
        {selectedArtifact && (
          <div style={{
            width: 320,
            flexShrink: 0,
            padding: "20px 22px",
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            margin: "0 16px 16px 0",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <SynthMark size={16} active />
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--accent)",
                textTransform: "uppercase",
                letterSpacing: 1.2,
                fontFamily: "var(--font-mono, monospace)",
              }}>
                Synth&rsquo;s Analysis
              </span>
              <button
                style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 }}
                onClick={() => setSelectedArtifact(null)}
              >
                ✕
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "var(--text-faint, var(--text-muted))", marginBottom: 3 }}>Type</div>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>{selectedArtifact.type}</div>
            </div>

            {technologies.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: "var(--text-faint, var(--text-muted))", marginBottom: 5 }}>Detected Technologies</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                  {technologies.slice(0, 6).map((dep, i) => (
                    <span key={i} style={{
                      padding: "2px 9px", borderRadius: 4,
                      fontSize: 11, background: "var(--surface-alt)",
                      color: "var(--text-muted)",
                      border: "1px solid var(--border)",
                      fontFamily: "var(--font-mono, monospace)",
                    }}>
                      {dep}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: "var(--text-faint, var(--text-muted))", marginBottom: 3 }}>Synth&rsquo;s Understanding</div>
              <ConfidenceIndicator value={sidePanelConfidence} qualifier="understanding" wide />
            </div>

            {sidePanelConfidence < 0.7 && (
              <div style={{
                padding: "11px 14px", borderRadius: 8, marginBottom: 14,
                background: "color-mix(in srgb, var(--status-warning) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--status-warning) 20%, transparent)",
                fontSize: 12, color: "var(--status-warning)", lineHeight: 1.5,
              }}>
                Low confidence — consider annotating this artifact to improve Synth&rsquo;s understanding.
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
              <button
                style={{
                  width: "100%", padding: "10px 0", borderRadius: 6,
                  border: "1px solid var(--accent-border)",
                  background: "var(--accent-dim)",
                  color: "var(--accent)",
                  fontSize: 13, fontWeight: 600,
                  fontFamily: "var(--font-mono, monospace)",
                  cursor: "pointer",
                }}
                onClick={() => pushPanel({
                  type: "artifact-detail",
                  title: selectedArtifact.name,
                  params: { artifactId: selectedArtifact.id },
                })}
              >
                Examine Full Analysis →
              </button>
              <button
                style={{
                  width: "100%", padding: "10px 0", borderRadius: 6,
                  border: "1px solid var(--status-succeeded-border)",
                  background: "var(--status-succeeded-bg)",
                  color: "var(--status-succeeded)",
                  fontSize: 13, fontWeight: 600,
                  fontFamily: "var(--font-mono, monospace)",
                  cursor: "pointer",
                }}
                onClick={() => pushPanel({
                  type: "deployment-authoring",
                  title: "New Deployment",
                  params: { artifactId: selectedArtifact.id },
                })}
              >
                Deploy This Artifact →
              </button>
            </div>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
