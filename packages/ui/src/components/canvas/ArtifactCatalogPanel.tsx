import { useState, useEffect } from "react";
import { listArtifacts } from "../../api.js";
import type { Artifact } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
}

export default function ArtifactCatalogPanel({ title }: Props) {
  const { pushPanel } = useCanvas();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listArtifacts()
      .then(setArtifacts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <CanvasPanelHost title={title}>
        <div className="loading">Loading...</div>
      </CanvasPanelHost>
    );

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div style={{ padding: "0 16px" }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>
            Artifact Catalog
          </h3>

          {artifacts.length === 0 && (
            <div className="text-muted" style={{ fontSize: 13 }}>
              No artifacts yet. Use the Command Channel to create one.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {artifacts.map((art) => (
              <div
                key={art.id}
                onClick={() =>
                  pushPanel({
                    type: "deployment-authoring",
                    title: `Deploy ${art.name}`,
                    params: { artifactId: art.id },
                  })
                }
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
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "var(--agent-text)" }}>
                    {art.name}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--agent-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 2 }}>
                    {art.type}
                  </div>
                  {art.analysis.summary && (
                    <div style={{ fontSize: 12, color: "var(--agent-text-muted)", marginTop: 6, lineHeight: 1.4 }}>
                      {art.analysis.summary}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 11, color: "var(--agent-text-muted)", flexShrink: 0 }}>
                  Deploy &rarr;
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </CanvasPanelHost>
  );
}
