import { useState, useRef, useEffect } from "react";

interface Props {
  value: string;
  onSave: (newValue: string) => Promise<void>;
  tag?: "h2" | "h3" | "span";
}

export default function InlineEdit({ value, onSave, tag = "h2" }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) {
      setEditing(false);
      setDraft(value);
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch {
      setDraft(value);
      setEditing(false);
    }
    setSaving(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <div className="inline-edit">
        <input
          ref={inputRef}
          className={`inline-edit-input inline-edit-input-${tag}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          disabled={saving}
        />
      </div>
    );
  }

  const Tag = tag;
  return (
    <Tag
      className="inline-edit-display"
      onClick={() => { setDraft(value); setEditing(true); }}
      title="Click to edit"
    >
      {value} <span className="inline-edit-icon">&#9998;</span>
    </Tag>
  );
}
