import { useCanvas } from "../../context/CanvasContext.js";
import type { ContextSignal } from "../../api.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  signal: ContextSignal;
  title: string;
}

export default function SignalDetailPanel({ signal, title }: Props) {
  const { pushPanel } = useCanvas();

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        <div className={`canvas-signal-detail-card canvas-signal-${signal.severity}`}>
          <div className="canvas-signal-severity-large">{signal.severity.toUpperCase()}</div>
          <div className="canvas-signal-type-badge">{signal.type}</div>
          <h3>{signal.title}</h3>
          <p>{signal.detail}</p>
        </div>

        {signal.relatedEntity && (
          <div className="canvas-section">
            <h3 className="canvas-section-title">Related Entity</h3>
            <button
              className="canvas-entity-link"
              onClick={() => pushPanel({
                type: `${signal.relatedEntity!.type === "environment" ? "environment" : "partition"}-detail`,
                title: signal.relatedEntity!.name,
                params: { id: signal.relatedEntity!.id },
              })}
            >
              {signal.relatedEntity.type}: {signal.relatedEntity.name}
            </button>
          </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
