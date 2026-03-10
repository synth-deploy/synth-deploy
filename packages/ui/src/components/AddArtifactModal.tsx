import { useState } from "react";
import { manualUploadArtifact, createIntakeChannel, addArtifactVersion } from "../api.js";
import { invalidate, invalidateExact } from "../hooks/useQuery.js";
import ModalOverlay from "./ModalOverlay.js";
import SelectField from "./SelectField.js";

const ARTIFACT_TYPE_OPTIONS = [
  { value: "docker", label: "Docker Image" },
  { value: "binary", label: "Binary" },
  { value: "archive", label: "Archive" },
  { value: "script", label: "Script" },
  { value: "helm-chart", label: "Helm Chart" },
];

interface Props {
  onClose: () => void;
  /** When set, modal operates in "new version" mode for the given artifact */
  newVersionFor?: {
    artifactId: string;
    artifactName: string;
    artifactType: string;
  };
}

type IntakePath = "upload" | "registry" | "pipeline";

export default function AddArtifactModal({ onClose, newVersionFor }: Props) {
  const isNewVersion = !!newVersionFor;
  const [path, setPath] = useState<IntakePath>("upload");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Upload state
  const [name, setName] = useState(newVersionFor?.artifactName ?? "");
  const [type, setType] = useState(newVersionFor?.artifactType ?? "docker");
  const [version, setVersion] = useState("");
  const [source, setSource] = useState("");

  // Registry/Pipeline state
  const [channelName, setChannelName] = useState("");
  const [channelUrl, setChannelUrl] = useState("");

  async function handleUpload() {
    if (!isNewVersion && !name.trim()) { setError("Artifact name is required"); return; }
    if (!version.trim()) { setError("Version is required"); return; }
    setSubmitting(true);
    setError(null);
    try {
      if (isNewVersion) {
        await addArtifactVersion(newVersionFor.artifactId, {
          version: version.trim(),
          source: source.trim() || "manual-upload",
        });
        invalidateExact(`artifact:${newVersionFor.artifactId}`);
      } else {
        await manualUploadArtifact({
          artifactName: name.trim(),
          artifactType: type,
          version: version.trim() || "1.0.0",
        });
        invalidate("list:artifacts");
      }
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
          <div className="modal-label">{isNewVersion ? newVersionFor.artifactName : "Artifact Intake"}</div>
          <h2 className="modal-title">{isNewVersion ? "Upload New Version" : "Add Artifact"}</h2>
        </div>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>

      <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.55, margin: "0 0 18px 0" }}>
        {isNewVersion
          ? "Manually upload a new version of this artifact. Synth will re-analyze it and update its understanding."
          : "Choose how to bring an artifact into Synth. Once ingested, Synth will analyze it automatically."}
      </p>

      {/* Path selector — hidden in new-version mode (upload only) */}
      {!isNewVersion && (
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
      )}

      {success && (
        <div style={{
          padding: "10px 14px", borderRadius: 8, marginBottom: 12,
          background: "color-mix(in srgb, var(--status-succeeded) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--status-succeeded) 25%, transparent)",
          color: "var(--status-succeeded)", fontSize: 13, fontWeight: 500,
        }}>
          {isNewVersion ? "New version uploaded." : "Success! Artifact added."}
        </div>
      )}

      {/* Upload path (always shown in new-version mode) */}
      {(isNewVersion || path === "upload") && !success && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {!isNewVersion && (
            <div>
              <label className="modal-form-label">Name</label>
              <input
                className="modal-form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. my-web-app"
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {!isNewVersion && (
              <div style={{ flex: 1 }}>
                <label className="modal-form-label">Type</label>
                <SelectField
                  value={type}
                  onChange={setType}
                  options={ARTIFACT_TYPE_OPTIONS}
                />
              </div>
            )}
            <div style={{ flex: 1 }}>
              <label className="modal-form-label">Version</label>
              <input
                className="modal-form-input"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
              />
            </div>
          </div>
          <div>
            <label className="modal-form-label">Source (optional)</label>
            <input
              className="modal-form-input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={isNewVersion ? "e.g. manual-upload" : "e.g. docker.io/myorg/myapp"}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={handleUpload}
            disabled={submitting}
            style={{ alignSelf: "flex-start", fontSize: 13 }}
          >
            {submitting ? "Uploading..." : isNewVersion ? "Upload New Version" : "Upload Artifact"}
          </button>
        </div>
      )}

      {/* Registry path */}
      {!isNewVersion && path === "registry" && !success && (
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
      {!isNewVersion && path === "pipeline" && !success && (
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
