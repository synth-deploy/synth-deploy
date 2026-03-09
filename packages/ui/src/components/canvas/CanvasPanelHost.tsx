import { useCanvas } from "../../context/CanvasContext.js";
import { useSettings } from "../../context/SettingsContext.js";

interface CanvasPanelHostProps {
  title: string;
  dismissible?: boolean;
  noBreadcrumb?: boolean;
  /** Hide the root Home/logo item — breadcrumb starts from the first panel in the stack */
  hideRootCrumb?: boolean;
  children: React.ReactNode;
}

export default function CanvasPanelHost({ title, dismissible = true, noBreadcrumb = false, hideRootCrumb = false, children }: CanvasPanelHostProps) {
  const { popPanel, resetToOverview, depth, panels } = useCanvas();
  const { settings } = useSettings();
  const coBranding = settings?.coBranding;

  // Build breadcrumb path from the panel stack
  // For topology children, replace "Topology" with the sub-category name (Envoys/Environments/Partitions)
  const topologyChildCategory: Record<string, string> = {
    "envoy-detail": "Envoys",
    "environment-detail": "Environments",
    "partition-detail": "Partitions",
  };
  const sliced = panels.slice(1);
  const breadcrumbPath = sliced.map((panel, i) => {
    let label = panel.title;
    if (panel.type === "topology" && i + 1 < sliced.length) {
      const childType = sliced[i + 1].type;
      if (childType in topologyChildCategory) {
        label = topologyChildCategory[childType];
      }
    }
    return {
      label,
      onClick: i < panels.length - 2
        ? () => {
            popPanel();
          }
        : undefined,
    };
  });

  if (noBreadcrumb) {
    return (
      <div className="canvas-panel">
        <div className="canvas-panel-body">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="canvas-panel">
      <div className="canvas-panel-body">
        <div
          className="v2-breadcrumb"
          style={coBranding?.accentColor ? { borderColor: coBranding.accentColor } : undefined}
        >
          {!hideRootCrumb && (coBranding ? (
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
              Home
            </span>
          ))}
          {breadcrumbPath.map((item, i) => (
            <div key={i} className="v2-breadcrumb-segment">
              {(i > 0 || !hideRootCrumb) && <span className="v2-breadcrumb-separator">&rsaquo;</span>}
              <span
                onClick={item.onClick}
                className={`v2-breadcrumb-item ${i === breadcrumbPath.length - 1 ? "v2-breadcrumb-current" : ""}`}
                style={{ cursor: item.onClick ? "pointer" : "default" }}
              >
                {item.label}
              </span>
            </div>
          ))}
          {depth > 1 && dismissible && (
            <button className="canvas-panel-dismiss" onClick={popPanel} title="Close panel" style={{ marginLeft: "auto" }}>
              &times;
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
