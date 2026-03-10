import { useRef, useState } from "react";
import { uploadArtifactFile, createIntakeChannel } from "../api.js";
import { invalidate } from "../hooks/useQuery.js";
import ModalOverlay from "./ModalOverlay.js";

interface Props {
  onClose: () => void;
}

type IntakePath = "upload" | "registry" | "pipeline";

export default function AddArtifactModal({ onClose }: Props) {
  const [path, setPath] = useState<IntakePath>("upload");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // File upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // Registry/Pipeline state
  const [channelName, setChannelName] = useState("");
  const [channelUrl, setChannelUrl] = useState("");

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError(null);
  }

  async function handleUpload() {
    if (!selectedFile) { setError("Select a file to upload"); return; }
    setSubmitting(true);
    setError(null);
    try {
      await uploadArtifactFile(selectedFile);
      invalidate("list:artifacts");
      setSuccess(true);
      setTimeout(onClose, 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
    setSubmitting(false);
  }

  async function handleCreateChannel(channelType: "registry" | "webhook") {
    if (!channelName.trim()) { setError("Channel name is required"); return; }
    setSubmitting(true);
    setError(null);
    try {
      await createIntakeChannel({
        name: channelName.trim(),
        type: channelType,
        config: { url: channelUrl.trim() || undefined },
      });
      invalidate("list:artifacts");
      setSuccess(true);
      setTimeout(onClose, 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create intake channel");
    }
    setSubmitting(false);
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div className="modal-label">Artifact Intake</div>
          <h2 className="modal-title">Add Artifact</h2>
        </div>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>

      <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55, margin: "0 0 18px 0" }}>
        Choose how to bring an artifact into Synth. Once ingested, Synth will analyze it automatically.
      </p>

      <div className="segmented-control" style={{ width: "fit-content", marginBottom: 18 }}>
        {([
          { key: "upload" as const, label: "Upload" },
          { key: "registry" as const, label: "Container Registry" },
          { key: "pipeline" as const, label: "CI/CD Pipeline" },
        ]).map(({ key, label }) => (
          <button
            key={key}
            className={`segmented-control-btn ${path === key ? "segmented-control-btn-active" : ""}`}
            onClick={() => { setPath(key); setError(null); }}
          >
            {label}
          </button>
        ))}
      </div>

      {success && (
        <div style={{
          padding: "10px 14px", borderRadius: 8, marginBottom: 12,
          background: "color-mix(in srgb, var(--status-succeeded) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--status-succeeded) 25%, transparent)",
          color: "var(--status-succeeded)", fontSize: 13, fontWeight: 500,
        }}>
          Artifact ingested. Synth is analyzing it.
        </div>
      )}

      {/* Upload path */}
      {path === "upload" && !success && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0, lineHeight: 1.5 }}>
            Upload an artifact file. Synth will analyze it to determine its type, version, and deployment requirements.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <div
            onClick={() => fileInputRef.current?.click()}
            style={{
              padding: "24px 16px",
              borderRadius: 8,
              border: `2px dashed ${selectedFile ? "var(--accent)" : "var(--border)"}`,
              background: selectedFile ? "color-mix(in srgb, var(--accent) 5%, transparent)" : "var(--surface)",
              cursor: "pointer",
              textAlign: "center",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            {selectedFile ? (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "monospace", marginBottom: 4 }}>
                  {selectedFile.name}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {(selectedFile.size / 1024).toFixed(1)} KB — click to change
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4 }}>Click to select a file</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", opacity: 0.7 }}>
                  Supported: archives, scripts, Helm charts, binaries, Dockerfiles, package manifests
                </div>
              </div>
            )}
          </div>
          <button
            className="btn btn-primary"
            onClick={handleUpload}
            disabled={submitting || !selectedFile}
            style={{ alignSelf: "flex-start", fontSize: 13 }}
          >
            {submitting ? "Uploading..." : "Upload"}
          </button>
        </div>
      )}

      {/* Registry path */}
      {path === "registry" && !success && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
            Connect a container registry. Synth will watch for new images and ingest them automatically.
          </p>
          <div>
            <label className="modal-form-label">Channel Name</label>
            <input
              className="modal-form-input"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="e.g. production-registry"
            />
          </div>
          <div>
            <label className="modal-form-label">Registry URL</label>
            <input
              className="modal-form-input"
              value={channelUrl}
              onChange={(e) => setChannelUrl(e.target.value)}
              placeholder="e.g. docker.io/myorg"
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={() => handleCreateChannel("registry")}
            disabled={submitting}
            style={{ alignSelf: "flex-start", fontSize: 13 }}
          >
            {submitting ? "Connecting..." : "Connect Registry"}
          </button>
        </div>
      )}

      {/* Pipeline path */}
      {path === "pipeline" && !success && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
            Set up a CI/CD webhook. Your pipeline will push artifacts to Synth on each build.
          </p>
          <div>
            <label className="modal-form-label">Channel Name</label>
            <input
              className="modal-form-input"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="e.g. github-actions-prod"
            />
          </div>
          <div>
            <label className="modal-form-label">Webhook URL (optional)</label>
            <input
              className="modal-form-input"
              value={channelUrl}
              onChange={(e) => setChannelUrl(e.target.value)}
              placeholder="Auto-generated if blank"
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={() => handleCreateChannel("webhook")}
            disabled={submitting}
            style={{ alignSelf: "flex-start", fontSize: 13 }}
          >
            {submitting ? "Creating..." : "Create Pipeline Channel"}
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 10, color: "var(--status-failed)", fontSize: 12 }}>{error}</div>
      )}
    </ModalOverlay>
  );
}
