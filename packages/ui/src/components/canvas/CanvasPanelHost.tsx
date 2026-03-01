import { useCanvas } from "../../context/CanvasContext.js";
import Breadcrumb from "../Breadcrumb.js";

interface CanvasPanelHostProps {
  title: string;
  dismissible?: boolean;
  children: React.ReactNode;
}

export default function CanvasPanelHost({ title, dismissible = true, children }: CanvasPanelHostProps) {
  const { popPanel, resetToOverview, depth, panels } = useCanvas();

  // Build breadcrumb path from the panel stack
  const breadcrumbPath = panels.slice(1).map((panel, i) => ({
    label: panel.title,
    onClick: i < panels.length - 2
      ? () => {
          // Pop panels to get back to this one
          // For simplicity, just pop one level
          popPanel();
        }
      : undefined,
  }));

  return (
    <div className="canvas-panel">
      <div className="canvas-panel-header">
        <Breadcrumb
          path={breadcrumbPath}
          onHome={resetToOverview}
        />
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
