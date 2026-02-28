import { useState, useEffect } from "react";
import type { DeployConfig } from "../types.js";

interface Props {
  config: DeployConfig;
  onSave: (config: DeployConfig) => Promise<void>;
}

export default function DeployConfigEditor({ config, onSave }: Props) {
  const [draft, setDraft] = useState<DeployConfig>(config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await onSave(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  const changed =
    draft.healthCheckEnabled !== config.healthCheckEnabled ||
    draft.healthCheckRetries !== config.healthCheckRetries ||
    draft.timeoutMs !== config.timeoutMs ||
    draft.verificationStrategy !== config.verificationStrategy;

  return (
    <div className="deploy-config-form">
      <div className="toggle-field">
        <label>
          <input
            type="checkbox"
            checked={draft.healthCheckEnabled}
            onChange={(e) => setDraft({ ...draft, healthCheckEnabled: e.target.checked })}
          />
          Health Check Enabled
        </label>
      </div>

      <div className="form-group">
        <label>Health Check Retries</label>
        <input
          type="number"
          min={0}
          max={10}
          value={draft.healthCheckRetries}
          onChange={(e) => setDraft({ ...draft, healthCheckRetries: Number(e.target.value) })}
          disabled={!draft.healthCheckEnabled}
        />
      </div>

      <div className="form-group">
        <label>Timeout (ms)</label>
        <input
          type="number"
          min={1000}
          step={1000}
          value={draft.timeoutMs}
          onChange={(e) => setDraft({ ...draft, timeoutMs: Number(e.target.value) })}
        />
      </div>

      <div className="form-group">
        <label>Verification Strategy</label>
        <select
          value={draft.verificationStrategy}
          onChange={(e) => setDraft({ ...draft, verificationStrategy: e.target.value as DeployConfig["verificationStrategy"] })}
        >
          <option value="basic">Basic</option>
          <option value="full">Full</option>
          <option value="none">None</option>
        </select>
      </div>

      <button
        className="btn btn-primary"
        onClick={handleSave}
        disabled={saving || !changed}
      >
        {saving ? "Saving..." : saved ? "Saved" : "Save Configuration"}
      </button>
    </div>
  );
}
