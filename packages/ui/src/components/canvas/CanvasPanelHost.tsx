import { useCanvas } from "../../context/CanvasContext.js";
import { useSettings } from "../../context/SettingsContext.js";

interface CanvasPanelHostProps {
  title: string;
  dismissible?: boolean;
  children: React.ReactNode;
}

export default function CanvasPanelHost({ title, dismissible = true, children }: CanvasPanelHostProps) {
  const { popPanel, resetToOverview, depth, panels } = useCanvas();
  const { settings } = useSettings();
  const coBranding = settings?.coBranding;

  // Build breadcrumb path from the panel stack
  const breadcrumbPath = panels.slice(1).map((panel, i) => ({
    label: panel.title,
    onClick: i < panels.length - 2
      ? () => {
          popPanel();
        }
      : undefined,
  }));

  return (
    <div className="canvas-panel">
      <div className="canvas-panel-header">
        <div
          className="v2-breadcrumb"
          style={coBranding?.accentColor ? { borderColor: coBranding.accentColor } : undefined}
        >
          {coBranding ? (
            <span className="v2-breadcrumb-logo v2-cobranding-logo" onClick={resetToOverview}>
              <img
                src={coBranding.logoUrl}
                alt={coBranding.operatorName}
                className="v2-cobranding-img"
              />
              <span
                className="v2-cobranding-name"
                style={coBranding.accentColor ? { color: coBranding.accentColor } : undefined}
              >
                {coBranding.operatorName}
              </span>
              <span className="v2-cobranding-powered-by">by Synth</span>
            </span>
          ) : (
            <span className="v2-breadcrumb-logo" onClick={resetToOverview}>
              Synth
            </span>
          )}
          {breadcrumbPath.map((item, i) => (
            <div key={i} className="v2-breadcrumb-segment">
              <span className="v2-breadcrumb-separator">&rsaquo;</span>
              <span
                onClick={item.onClick}
                className={`v2-breadcrumb-item ${i === breadcrumbPath.length - 1 ? "v2-breadcrumb-current" : ""}`}
                style={{ cursor: item.onClick ? "pointer" : "default" }}
              >
                {item.label}
              </span>
            </div>
          ))}
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
