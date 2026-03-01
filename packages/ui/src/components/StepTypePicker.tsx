import { useState, useEffect } from "react";
import type { StepTypeDefinition, StepTypeCategory } from "../types.js";
import { listStepTypes } from "../api.js";

const CATEGORIES: StepTypeCategory[] = [
  "General",
  "File & Artifact",
  "Service",
  "Verification",
  "Database",
  "Container",
  "Traffic",
];

interface Props {
  onSelect: (stepType: StepTypeDefinition) => void;
  onCancel: () => void;
}

export default function StepTypePicker({ onSelect, onCancel }: Props) {
  const [stepTypes, setStepTypes] = useState<StepTypeDefinition[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listStepTypes()
      .then(setStepTypes)
      .catch(() => setStepTypes([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = filter
    ? stepTypes.filter(
        (st) =>
          st.name.toLowerCase().includes(filter.toLowerCase()) ||
          st.description.toLowerCase().includes(filter.toLowerCase()),
      )
    : stepTypes;

  const grouped = CATEGORIES.map((cat) => ({
    category: cat,
    types: filtered.filter((st) => st.category === cat),
  })).filter((g) => g.types.length > 0);

  return (
    <div className="step-type-picker">
      <div className="step-type-picker-header">
        <h4>Select Step Type</h4>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
      <input
        className="step-type-search"
        placeholder="Search step types..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        autoFocus
      />
      {loading && <p className="text-muted" style={{ padding: 12 }}>Loading step types...</p>}
      <div className="step-type-grid">
        {grouped.map((group) => (
          <div key={group.category}>
            <div className="step-type-category-label">{group.category}</div>
            {group.types.map((st) => (
              <button
                key={st.id}
                className="step-type-option"
                onClick={() => onSelect(st)}
              >
                <span className="step-type-option-name">{st.name}</span>
                <span className="step-type-option-desc">{st.description}</span>
                {st.source !== "predefined" && (
                  <span className={`step-type-source-badge step-type-source-${st.source}`}>
                    {st.source}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        {!loading && grouped.length === 0 && (
          <p className="text-muted" style={{ padding: 12 }}>No matching step types found.</p>
        )}
      </div>
    </div>
  );
}
