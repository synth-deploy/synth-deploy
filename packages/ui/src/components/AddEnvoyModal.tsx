import { useState } from "react";
import ModalOverlay from "./ModalOverlay.js";

interface AddEnvoyModalProps {
  onClose: () => void;
}

export default function AddEnvoyModal({ onClose }: AddEnvoyModalProps) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"linux" | "windows">("linux");

  const installCmd =
    tab === "linux"
      ? "curl -fsSL https://get.synth.dev/envoy | sh -s -- --token eyJ0b2tlbi..."
      : 'irm https://get.synth.dev/envoy/win | iex  # Token: eyJ0b2tlbi...';

  function handleCopy() {
    navigator.clipboard.writeText(installCmd).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
    </ModalOverlay>
  );
}
