export type EntityType = "Envoy" | "Partition" | "Artifact" | "Deployment" | "Debrief" | "Synth" | "Command";

const ENTITY_COLORS: Record<EntityType, { color: string; bg: string; border: string }> = {
  Envoy: { color: "var(--status-succeeded)", bg: "color-mix(in srgb, var(--status-succeeded) 10%, transparent)", border: "color-mix(in srgb, var(--status-succeeded) 20%, transparent)" },
  Partition: { color: "var(--accent)", bg: "color-mix(in srgb, var(--accent) 10%, transparent)", border: "color-mix(in srgb, var(--accent) 20%, transparent)" },
  Artifact: { color: "var(--text-muted)", bg: "color-mix(in srgb, var(--text-muted) 10%, transparent)", border: "color-mix(in srgb, var(--text-muted) 20%, transparent)" },
  Deployment: { color: "var(--status-warning)", bg: "color-mix(in srgb, var(--status-warning) 10%, transparent)", border: "color-mix(in srgb, var(--status-warning) 20%, transparent)" },
  Debrief: { color: "var(--accent)", bg: "color-mix(in srgb, var(--accent) 10%, transparent)", border: "color-mix(in srgb, var(--accent) 20%, transparent)" },
  Synth: { color: "var(--accent)", bg: "var(--accent-dim)", border: "var(--accent-border)" },
  Command: { color: "var(--accent)", bg: "var(--accent-dim)", border: "var(--accent-border)" },
};

interface EntityTagProps {
  type: EntityType;
  label: string;
  onClick?: () => void;
}

export default function EntityTag({ type, label, onClick }: EntityTagProps) {
  const c = ENTITY_COLORS[type] ?? ENTITY_COLORS.Synth;
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
