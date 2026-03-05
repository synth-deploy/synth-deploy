import { useState, useEffect, useMemo } from "react";
import { listArtifacts, createArtifact } from "../../api.js";
import type { Artifact } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
}

type ConfidenceLevel = "high" | "medium" | "low";

function getConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.7) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function getConfidenceColor(level: ConfidenceLevel): string {
  switch (level) {
    case "high": return "#16a34a";
    case "medium": return "#ca8a04";
    case "low": return "#dc2626";
  }
}

function getConfidenceLabel(level: ConfidenceLevel): string {
  switch (level) {
    case "high": return "HIGH";
    case "medium": return "MEDIUM";
    case "low": return "LOW";
  }
}

export default function ArtifactCatalogPanel({ title }: Props) {
  const { pushPanel } = useCanvas();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceLevel | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("docker");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    listArtifacts()
      .then(setArtifacts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const artifactTypes = useMemo(
    () => [...new Set(artifacts.map((a) => a.type))],
    [artifacts],
  );

  const filtered = useMemo(() => {
    let result = artifacts;
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
      setArtifacts((prev) => [...prev, artifact]);
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
    pushPanel({
      type: "artifact-detail",
      title: art.name,
      params: { artifactId: art.id },
    });
  }

  if (loading)
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );

  const chipStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 11,
    padding: "4px 10px",
    borderRadius: 12,
    border: `1px solid ${active ? "var(--agent-accent, #63e1be)" : "var(--agent-border)"}`,
    background: active ? "rgba(99,225,190,0.15)" : "transparent",
    color: active ? "var(--agent-accent, #63e1be)" : "var(--agent-text-muted)",
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
    whiteSpace: "nowrap" as const,
  });

  function renderArtifactRow(art: Artifact) {
    const level = getConfidenceLevel(art.analysis.confidence);
    const color = getConfidenceColor(level);
    const label = getConfidenceLabel(level);

    return (
      <div
        key={art.id}
        onClick={() => handleArtifactClick(art)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          padding: "12px 16px",
          borderRadius: 8,
          border: "1px solid var(--agent-border)",
          background: "var(--agent-card-bg)",
          cursor: "pointer",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: "var(--agent-text)" }}>
              {art.name}
            </span>
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "2px 6px",
                borderRadius: 4,
                background: `${color}22`,
                color,
                letterSpacing: "0.04em",
              }}
            >
              {label}
            </span>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--agent-text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginTop: 2,
            }}
          >
            {art.type}
          </div>
          {art.analysis.summary && (
            <div
              style={{
                fontSize: 12,
                color: "var(--agent-text-muted)",
                marginTop: 6,
                lineHeight: 1.4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {art.analysis.summary}
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 6,
              fontSize: 11,
              color: "var(--agent-text-muted)",
            }}
          >
            <span>{art.annotations.length} annotation{art.annotations.length !== 1 ? "s" : ""}</span>
            <span>Updated {new Date(art.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
        <span style={{ fontSize: 11, color: "var(--agent-text-muted)", flexShrink: 0 }}>
          View &rarr;
        </span>
      </div>
    );
  }

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div style={{ padding: "0 16px" }}>
          {/* Header row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
              Artifact Catalog
              <span style={{ fontSize: 12, fontWeight: 400, color: "var(--agent-text-muted)", marginLeft: 8 }}>
                {artifacts.length} artifact{artifacts.length !== 1 ? "s" : ""}
              </span>
            </h3>
            <button
              className="btn btn-primary"
              onClick={() => setShowAddForm(!showAddForm)}
              style={{ fontSize: 12, padding: "6px 14px" }}
            >
              {showAddForm ? "Cancel" : "+ Add Artifact"}
            </button>
          </div>

          {/* Add artifact form */}
          {showAddForm && (
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
              <div style={{ flex: "1 1 200px" }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
                  Name
                </label>
                <input
                  placeholder="e.g. my-web-app"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
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
              <div style={{ flex: "0 0 150px" }}>
                <label style={{ fontSize: 11, fontWeight: 600, color: "var(--agent-text-muted)", display: "block", marginBottom: 3 }}>
                  Type
                </label>
                <select
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
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
                  <option value="docker">Docker Image</option>
                  <option value="binary">Binary</option>
                  <option value="archive">Archive</option>
                  <option value="script">Script</option>
                  <option value="helm-chart">Helm Chart</option>
                </select>
              </div>
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={creating}
                style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }}
              >
                {creating ? "Creating..." : "Create"}
              </button>
              {createError && (
                <div style={{ width: "100%", color: "#dc2626", fontSize: 12 }}>{createError}</div>
              )}
            </div>
          )}

          {/* Search bar */}
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
              border: "1px solid var(--agent-border)",
              background: "var(--agent-bg)",
              color: "var(--agent-text)",
              marginBottom: 12,
              boxSizing: "border-box",
            }}
          />

          {/* Filter chips */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
            {/* Type filters */}
            {artifactTypes.map((t) => (
              <button
                key={t}
                style={chipStyle(typeFilter === t)}
                onClick={() => setTypeFilter(typeFilter === t ? null : t)}
              >
                {t}
              </button>
            ))}

            {/* Divider */}
            {artifactTypes.length > 0 && (
              <span style={{ borderLeft: "1px solid var(--agent-border)", margin: "0 4px" }} />
            )}

            {/* Confidence filters */}
            {(["high", "medium", "low"] as const).map((level) => {
              const color = getConfidenceColor(level);
              return (
                <button
                  key={level}
                  style={{
                    ...chipStyle(confidenceFilter === level),
                    borderColor: confidenceFilter === level ? color : "var(--agent-border)",
                    color: confidenceFilter === level ? color : "var(--agent-text-muted)",
                    background: confidenceFilter === level ? `${color}15` : "transparent",
                  }}
                  onClick={() => setConfidenceFilter(confidenceFilter === level ? null : level)}
                >
                  {getConfidenceLabel(level)}
                </button>
              );
            })}
          </div>

          {/* Content */}
          {filtered.length === 0 && (
            <div className="text-muted" style={{ fontSize: 13, padding: "20px 0" }}>
              {artifacts.length === 0
                ? "No artifacts yet. Use the Command Channel to create one, or click Add Artifact above."
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
                  background: "rgba(220,38,38,0.08)",
                  border: "1px solid rgba(220,38,38,0.25)",
                  marginBottom: 10,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ fontSize: 14 }}>!</span>
                <span style={{ fontSize: 13, color: "#dc2626", fontWeight: 500 }}>
                  Needs Review
                </span>
                <span style={{ fontSize: 12, color: "var(--agent-text-muted)" }}>
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
      </div>
    </CanvasPanelHost>
  );
}
