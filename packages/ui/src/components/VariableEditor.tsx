import { useState } from "react";

interface Props {
  variables: Record<string, string>;
  onSave: (variables: Record<string, string>) => Promise<void>;
  readOnly?: boolean;
}

export default function VariableEditor({ variables, onSave, readOnly = false }: Props) {
  const [entries, setEntries] = useState<Array<[string, string]>>(
    Object.entries(variables),
  );
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  function handleChange(index: number, field: 0 | 1, value: string) {
    const updated = [...entries];
    updated[index] = [...updated[index]] as [string, string];
    updated[index][field] = value;
    setEntries(updated);
  }

  function handleRemove(index: number) {
    setEntries(entries.filter((_, i) => i !== index));
  }

  function handleAdd() {
    if (!newKey.trim()) return;
    setEntries([...entries, [newKey.trim(), newValue]]);
    setNewKey("");
    setNewValue("");
  }

  async function handleSave() {
    setSaving(true);
    try {
      const obj: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (k.trim()) obj[k.trim()] = v;
      }
      await onSave(obj);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <table className="var-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
            {!readOnly && <th style={{ width: 40 }}></th>}
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, value], i) => (
            <tr key={i}>
              <td>
                {readOnly ? (
                  <span className="mono">{key}</span>
                ) : (
                  <input
                    value={key}
                    onChange={(e) => handleChange(i, 0, e.target.value)}
                  />
                )}
              </td>
              <td>
                {readOnly ? (
                  <span className="mono">{value}</span>
                ) : (
                  <input
                    value={value}
                    onChange={(e) => handleChange(i, 1, e.target.value)}
                  />
                )}
              </td>
              {!readOnly && (
                <td>
                  <button className="remove-btn" onClick={() => handleRemove(i)}>
                    &times;
                  </button>
                </td>
              )}
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={readOnly ? 2 : 3} className="text-muted" style={{ textAlign: "center" }}>
                No variables configured
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!readOnly && (
        <div style={{ marginTop: 8 }}>
          <div className="inline-form">
            <div className="form-group">
              <input
                placeholder="New key"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                style={{ minWidth: 150 }}
              />
            </div>
            <div className="form-group">
              <input
                placeholder="New value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                style={{ minWidth: 150 }}
              />
            </div>
            <button className="btn btn-sm" onClick={handleAdd}>
              Add
            </button>
          </div>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Variables"}
          </button>
        </div>
      )}
    </div>
  );
}
