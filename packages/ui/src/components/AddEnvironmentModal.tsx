import { useState } from "react";
import ModalOverlay from "./ModalOverlay.js";
import { createEnvironment } from "../api.js";
import { invalidate } from "../hooks/useQuery.js";

interface AddEnvironmentModalProps {
  onClose: () => void;
}

export default function AddEnvironmentModal({ onClose }: AddEnvironmentModalProps) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await createEnvironment(name.trim());
      invalidate("list:environments");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create environment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div className="modal-label">Topology</div>
          <h2 className="modal-title">Add Environment</h2>
        </div>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>

      <form onSubmit={handleSubmit}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55, margin: "0 0 18px 0" }}>
          Environments represent deployment targets (e.g. production, staging). You can configure variables and assign envoys after creation.
        </p>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 5, fontFamily: "var(--font-mono)" }}>Name</div>
          <input
            type="text"
            placeholder="production"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            style={{
              width: "100%",
              padding: "9px 12px",
              borderRadius: 7,
              border: "1px solid var(--border)",
              background: "var(--surface-alt)",
              color: "var(--text)",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              boxSizing: "border-box",
            }}
          />
        </div>

        {error && (
          <div style={{ fontSize: 12, color: "var(--status-failed)", marginBottom: 12 }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={saving || !name.trim()}
          style={{
            width: "100%",
            padding: "11px 0",
            borderRadius: 7,
            border: "none",
            cursor: saving || !name.trim() ? "not-allowed" : "pointer",
            background: "var(--accent)",
            color: "var(--bg)",
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "var(--font-mono)",
            opacity: saving || !name.trim() ? 0.5 : 1,
          }}
        >
          {saving ? "Creating…" : "Create Environment"}
        </button>
      </form>
    </ModalOverlay>
  );
}
