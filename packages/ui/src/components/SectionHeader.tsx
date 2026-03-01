type ShapeType = "square" | "circle" | "hollow" | "diamond";

interface SectionHeaderProps {
  color: string;
  shape: ShapeType;
  label: string;
  subtitle?: string;
  onClick?: () => void;
  count?: number;
}

export default function SectionHeader({ color, shape, label, subtitle, onClick, count }: SectionHeaderProps) {
  return (
    <div className="v2-section-header">
      <div
        className="v2-section-shape"
        style={{
          width: 8,
          height: 8,
          borderRadius: shape === "circle" ? "50%" : 2,
          background: shape === "hollow" ? "transparent" : color,
          border: shape === "hollow" ? `2px solid ${color}` : "none",
          boxShadow: shape === "circle" ? `0 0 6px ${color}` : "none",
          transform: shape === "diamond" ? "rotate(45deg)" : "none",
        }}
      />
      <span
        onClick={onClick}
        className="v2-section-label"
        style={{
          color,
          cursor: onClick ? "pointer" : "default",
          borderBottom: onClick ? `1px dashed ${color}40` : "none",
        }}
      >
        {label}{count != null ? ` (${count})` : ""}
      </span>
      {subtitle && (
        <span className="v2-section-subtitle">
          &mdash; {subtitle}
        </span>
      )}
      {onClick && (
        <span className="v2-section-manage">
          click to manage &rarr;
        </span>
      )}
    </div>
  );
}
