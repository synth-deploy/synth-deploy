import { useState, useRef, useEffect } from "react";

interface Option {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  className?: string;
}

export default function SelectField({ value, onChange, options, className }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className={`synth-select ${className ?? ""}`} style={{ position: "relative" }}>
      <button
        type="button"
        className={`synth-select-trigger modal-form-input ${open ? "synth-select-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{selected?.label ?? value}</span>
        <span className="synth-select-arrow">▾</span>
      </button>
      {open && (
        <div className="synth-select-dropdown">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`synth-select-option ${opt.value === value ? "synth-select-option-active" : ""}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
