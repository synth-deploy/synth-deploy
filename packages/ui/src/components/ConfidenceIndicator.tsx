interface ConfidenceIndicatorProps {
  value: number; // 0-1
  qualifier?: string; // "confidence" | "understanding"
  wide?: boolean;
}

export default function ConfidenceIndicator({
  value,
  qualifier = "confidence",
  wide = false,
}: ConfidenceIndicatorProps) {
  const pct = Math.round(value * 100);
  const w = wide ? 72 : 44;
  const level =
    pct >= 70
      ? { cls: "ci-high", word: "High" }
      : pct >= 50
        ? { cls: "ci-medium", word: "Medium" }
        : { cls: "ci-low", word: "Low" };

  return (
    <span className={`confidence-indicator ${level.cls}`}>
      <span className="ci-bar" style={{ width: w }}>
        <span className="ci-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="ci-level">{level.word}</span>
      <span className="ci-qualifier">{qualifier}</span>
    </span>
  );
}
