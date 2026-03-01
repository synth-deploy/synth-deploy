import { useState, useEffect } from "react";
import { listPartitions } from "../../api.js";
import type { Partition } from "../../types.js";
import { useCanvas } from "../../context/CanvasContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
}

export default function PartitionListPanel({ title }: Props) {
  const { pushPanel } = useCanvas();

  const [partitions, setPartitions] = useState<Partition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listPartitions()
      .then((t) => {
        setPartitions(t);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div className="canvas-summary-strip">
          <div className="canvas-summary-item">
            <span className="canvas-summary-value">{partitions.length}</span>
            <span className="canvas-summary-label">Partitions</span>
          </div>
        </div>

        {partitions.length > 0 ? (
          <div className="canvas-activity-list">
            {partitions.map((t) => (
              <button
                key={t.id}
                className="canvas-activity-row"
                onClick={() => pushPanel({
                  type: "partition-detail",
                  title: t.name,
                  params: { id: t.id },
                })}
              >
                <span style={{ fontWeight: 500 }}>{t.name}</span>
                <span className="text-muted" style={{ fontSize: 12 }}>
                  {Object.keys(t.variables).length} vars
                </span>
                <span className="text-secondary" style={{ fontSize: 12 }}>
                  {new Date(t.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
                <span className="mono text-muted" style={{ fontSize: 12 }}>
                  {t.id.slice(0, 8)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="canvas-empty">
            <p>No partitions yet. Use the intent bar to create one.</p>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
