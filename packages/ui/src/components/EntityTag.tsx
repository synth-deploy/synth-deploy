export type EntityType = "Envoy" | "Partition" | "Artifact" | "Deployment" | "Debrief" | "Command";

const ENTITY_COLORS: Record<EntityType, { color: string; bg: string; border: string }> = {
  Envoy: { color: "#34d399", bg: "rgba(52, 211, 153, 0.1)", border: "rgba(52, 211, 153, 0.2)" },
  Partition: { color: "#818cf8", bg: "rgba(129, 140, 248, 0.1)", border: "rgba(129, 140, 248, 0.2)" },
  Artifact: { color: "#6b7280", bg: "rgba(107, 114, 128, 0.1)", border: "rgba(107, 114, 128, 0.2)" },
  Deployment: { color: "#f59e0b", bg: "rgba(245, 158, 11, 0.1)", border: "rgba(245, 158, 11, 0.2)" },
  Debrief: { color: "#e879f9", bg: "rgba(232, 121, 249, 0.1)", border: "rgba(232, 121, 249, 0.2)" },
  Command: { color: "#63e1be", bg: "rgba(99, 225, 190, 0.1)", border: "rgba(99, 225, 190, 0.2)" },
};

interface EntityTagProps {
  type: EntityType;
  label: string;
  onClick?: () => void;
}

export default function EntityTag({ type, label, onClick }: EntityTagProps) {
  const c = ENTITY_COLORS[type] ?? ENTITY_COLORS.Command;
  return (
    <span
      className="entity-tag"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        borderRadius: 5,
        background: c.bg,
        border: `1px solid ${c.border}`,
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        color: c.color,
        cursor: onClick ? "pointer" : "default",
        letterSpacing: "0.03em",
      }}
    >
      <span style={{ fontSize: 7, opacity: 0.7 }}>&#9679;</span>
      {type} &rsaquo; {label}
    </span>
  );
}

export { ENTITY_COLORS };
