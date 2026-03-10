import { useState } from "react";
import ModalOverlay from "./ModalOverlay.js";
import { registerEnvoy } from "../api.js";
import { invalidate } from "../hooks/useQuery.js";

interface AddEnvoyModalProps {
  onClose: () => void;
}

export default function AddEnvoyModal({ onClose }: AddEnvoyModalProps) {
  const [mode, setMode] = useState<"install" | "manual">("install");
  const [tab, setTab] = useState<"linux" | "windows">("linux");
  const [copied, setCopied] = useState(false);

  // Manual registration state
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installCmd =
    tab === "linux"
      ? "curl -fsSL https://get.synth.dev/envoy | sh -s -- --token eyJ0b2tlbi..."
      : 'irm https://get.synth.dev/envoy/win | iex  # Token: eyJ0b2tlbi...';

  function handleCopy() {
    navigator.clipboard.writeText(installCmd).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await registerEnvoy(name.trim(), url.trim());
      invalidate("list:envoys");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register envoy");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div className="modal-label">Register Envoy</div>
          <h2 className="modal-title">Add a new Envoy</h2>
        </div>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>

      <div className="segmented-control" style={{ width: "fit-content", marginBottom: 20 }}>
        <button
          className={`segmented-control-btn ${mode === "install" ? "segmented-control-btn-active" : ""}`}
          onClick={() => setMode("install")}
        >
          Install
        </button>
        <button
          className={`segmented-control-btn ${mode === "manual" ? "segmented-control-btn-active" : ""}`}
          onClick={() => setMode("manual")}
        >
          Manual
        </button>
      </div>

      {mode === "install" && (
        <>
          <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55, margin: "0 0 18px 0" }}>
            Run this command on the target machine to install and register the envoy. It will connect to Synth automatically using the embedded token.
          </p>

          <div className="segmented-control" style={{ width: "fit-content", marginBottom: 14 }}>
            <button
              className={`segmented-control-btn ${tab === "linux" ? "segmented-control-btn-active" : ""}`}
              onClick={() => setTab("linux")}
            >
              Linux / macOS
            </button>
            <button
              className={`segmented-control-btn ${tab === "windows" ? "segmented-control-btn-active" : ""}`}
              onClick={() => setTab("windows")}
            >
              Windows
            </button>
          </div>

          <div style={{
            padding: "14px 16px",
            borderRadius: 8,
            background: "var(--surface-alt)",
            border: "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--text)",
            lineHeight: 1.6,
            wordBreak: "break-all",
            marginBottom: 16,
          }}>
            {installCmd}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleCopy}
              style={{
                flex: 1,
                padding: "11px 0",
                borderRadius: 7,
                border: "none",
                cursor: "pointer",
                background: copied ? "var(--status-succeeded)" : "var(--accent)",
                color: "var(--bg)",
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "var(--font-mono)",
                transition: "background 0.2s",
              }}
            >
              {copied ? "\u2713 Copied" : "Copy to Clipboard"}
            </button>
            <button
              style={{
                padding: "11px 18px",
                borderRadius: 7,
                cursor: "pointer",
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text-muted)",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
              }}
            >
              Download Installer
            </button>
          </div>

          <div style={{
            marginTop: 16,
            padding: "10px 14px",
            borderRadius: 8,
            background: "var(--accent-dim)",
            border: "1px solid var(--accent-border)",
          }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600, color: "var(--accent)" }}>Token expires in 24 hours.</span>{" "}
              The envoy will appear in your fleet once it connects. Synth will begin learning the host environment immediately.
            </div>
          </div>
        </>
      )}

      {mode === "manual" && (
        <form onSubmit={handleManualSubmit}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55, margin: "0 0 18px 0" }}>
            Register an envoy by URL. Use this for local development or when the envoy is already running and reachable.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 5, fontFamily: "var(--font-mono)" }}>Name</div>
              <input
                type="text"
                placeholder="local"
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
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 5, fontFamily: "var(--font-mono)" }}>URL</div>
              <input
                type="text"
                placeholder="http://localhost:3001"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
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
          </div>

          {error && (
            <div style={{ fontSize: 12, color: "var(--status-failed)", marginBottom: 12 }}>{error}</div>
          )}

          <button
            type="submit"
            disabled={saving || !name.trim() || !url.trim()}
            style={{
              width: "100%",
              padding: "11px 0",
              borderRadius: 7,
              border: "none",
              cursor: saving || !name.trim() || !url.trim() ? "not-allowed" : "pointer",
              background: "var(--accent)",
              color: "var(--bg)",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: "var(--font-mono)",
              opacity: saving || !name.trim() || !url.trim() ? 0.5 : 1,
            }}
          >
            {saving ? "Connecting…" : "Connect"}
          </button>
        </form>
      )}
    </ModalOverlay>
  );
}
