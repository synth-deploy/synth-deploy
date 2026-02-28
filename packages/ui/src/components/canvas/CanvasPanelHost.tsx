import { useCanvas } from "../../context/CanvasContext.js";

interface CanvasPanelHostProps {
  title: string;
  dismissible?: boolean;
  children: React.ReactNode;
}

export default function CanvasPanelHost({ title, dismissible = true, children }: CanvasPanelHostProps) {
  const { popPanel, depth } = useCanvas();

  return (
    <div className="canvas-panel">
      <div className="canvas-panel-header">
        <div className="canvas-panel-breadcrumb">
          {depth > 1 && dismissible && (
            <button className="canvas-panel-back" onClick={popPanel} title="Back">
              &#8592;
            </button>
          )}
          <h2 className="canvas-panel-title">{title}</h2>
        </div>
        {depth > 1 && dismissible && (
          <button className="canvas-panel-dismiss" onClick={popPanel} title="Close panel">
            &times;
          </button>
        )}
      </div>
      <div className="canvas-panel-body">
        {children}
      </div>
    </div>
  );
}
