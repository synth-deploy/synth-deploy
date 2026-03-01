import { useSettings } from "../context/SettingsContext.js";

interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

interface BreadcrumbProps {
  path: BreadcrumbItem[];
  onHome: () => void;
}

export default function Breadcrumb({ path, onHome }: BreadcrumbProps) {
  const { settings } = useSettings();
  const coBranding = settings?.coBranding;

  return (
    <div
      className="v2-breadcrumb"
      style={coBranding?.accentColor ? { borderColor: coBranding.accentColor } : undefined}
    >
      {coBranding ? (
        <span className="v2-breadcrumb-logo v2-cobranding-logo" onClick={onHome}>
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
          <span className="v2-cobranding-powered-by">by DeployStack</span>
        </span>
      ) : (
        <span className="v2-breadcrumb-logo" onClick={onHome}>
          DeployStack
        </span>
      )}
      {path.map((item, i) => (
        <div key={i} className="v2-breadcrumb-segment">
          <span className="v2-breadcrumb-separator">&rsaquo;</span>
          <span
            onClick={item.onClick}
            className={`v2-breadcrumb-item ${i === path.length - 1 ? "v2-breadcrumb-current" : ""}`}
            style={{ cursor: item.onClick ? "pointer" : "default" }}
          >
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}
