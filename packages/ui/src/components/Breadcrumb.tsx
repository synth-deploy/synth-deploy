interface BreadcrumbItem {
  label: string;
  onClick?: () => void;
}

interface BreadcrumbProps {
  path: BreadcrumbItem[];
  onHome: () => void;
}

export default function Breadcrumb({ path, onHome }: BreadcrumbProps) {
  return (
    <div className="v2-breadcrumb">
      <span className="v2-breadcrumb-logo" onClick={onHome}>
        DeployStack
      </span>
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
