import { useState, useEffect } from "react";
import { getSettings, updateSettings, getCommandInfo } from "../api.js";
import type { AppSettings, CommandInfo, ConflictPolicy } from "../types.js";
import PipelineConfigEditor from "../components/PipelineConfigEditor.js";

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [commandInfo, setCommandInfo] = useState<CommandInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentSaved, setAgentSaved] = useState(false);
  const [envoySaved, setEnvoySaved] = useState(false);

  useEffect(() => {
    Promise.all([getSettings(), getCommandInfo()])
      .then(([s, info]) => {
        setSettings(s);
        setCommandInfo(info);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function handleSaveAgent() {
    if (!settings) return;
    const updated = await updateSettings({ agent: settings.agent });
    setSettings(updated);
    setAgentSaved(true);
    setTimeout(() => setAgentSaved(false), 2000);
  }

  async function handleSaveDefaultPipeline(config: AppSettings["deploymentDefaults"]["defaultPipelineConfig"]) {
    if (!settings) return;
    const updated = await updateSettings({
      deploymentDefaults: { ...settings.deploymentDefaults, defaultPipelineConfig: config },
    });
    setSettings(updated);
  }

  async function handleSaveEnvoy() {
    if (!settings) return;
    const updated = await updateSettings({ envoy: settings.envoy });
    setSettings(updated);
    setEnvoySaved(true);
    setTimeout(() => setEnvoySaved(false), 2000);
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (!settings) return <div className="error-msg">Failed to load settings</div>;

  return (
    <div>
      <div className="page-header">
        <h2>Settings</h2>
      </div>

      {/* Agent Configuration */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Agent Configuration</h3>
          </div>
          <div className="form-group">
            <label>Default Health Check Retries</label>
            <input
              type="number"
              min={0}
              max={10}
              value={settings.agent.defaultHealthCheckRetries}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  agent: { ...settings.agent, defaultHealthCheckRetries: Number(e.target.value) },
                })
              }
              style={{ maxWidth: 300 }}
            />
          </div>
          <div className="form-group">
            <label>Default Timeout (ms)</label>
            <input
              type="number"
              min={1000}
              step={1000}
              value={settings.agent.defaultTimeoutMs}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  agent: { ...settings.agent, defaultTimeoutMs: Number(e.target.value) },
                })
              }
              style={{ maxWidth: 300 }}
            />
          </div>
          <div className="form-group">
            <label>Cross-Environment Conflict Policy</label>
            <select
              value={settings.agent.conflictPolicy}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  agent: { ...settings.agent, conflictPolicy: e.target.value as ConflictPolicy },
                })
              }
              style={{ maxWidth: 300 }}
            >
              <option value="strict">Strict (block deployment)</option>
              <option value="permissive">Permissive (proceed with warning)</option>
            </select>
            <div className="settings-description">
              Strict mode blocks deployments when cross-environment variable conflicts are detected.
              Permissive mode proceeds but logs a warning in the Debrief.
            </div>
          </div>
          <div className="form-group">
            <label>Default Verification Strategy</label>
            <select
              value={settings.agent.defaultVerificationStrategy}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  agent: {
                    ...settings.agent,
                    defaultVerificationStrategy: e.target.value as "basic" | "full" | "none",
                  },
                })
              }
              style={{ maxWidth: 300 }}
            >
              <option value="basic">Basic</option>
              <option value="full">Full</option>
              <option value="none">None</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={handleSaveAgent}>
            {agentSaved ? "Saved" : "Save Agent Settings"}
          </button>
        </div>
      </div>

      {/* Deployment Defaults */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Default Pipeline Configuration</h3>
          </div>
          <PipelineConfigEditor
            config={settings.deploymentDefaults.defaultPipelineConfig}
            onSave={handleSaveDefaultPipeline}
          />
        </div>
      </div>

      {/* Command Connection Info */}
      {commandInfo && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Command Connection</h3>
            </div>
            <div className="command-info-grid">
              <div className="command-info-item">
                <div className="command-info-label">Version</div>
                <div className="command-info-value">{commandInfo.version}</div>
              </div>
              <div className="command-info-item">
                <div className="command-info-label">Host</div>
                <div className="command-info-value">{commandInfo.host}</div>
              </div>
              <div className="command-info-item">
                <div className="command-info-label">Port</div>
                <div className="command-info-value">{commandInfo.port}</div>
              </div>
              <div className="command-info-item">
                <div className="command-info-label">Started</div>
                <div className="command-info-value">
                  {new Date(commandInfo.startedAt).toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Envoy Configuration */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Envoy Configuration</h3>
          </div>
          <div className="form-group">
            <label>Envoy URL</label>
            <input
              value={settings.envoy.url}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  envoy: { ...settings.envoy, url: e.target.value },
                })
              }
              placeholder="http://localhost:3001"
              style={{ maxWidth: 400 }}
            />
          </div>
          <div className="form-group">
            <label>Connection Timeout (ms)</label>
            <input
              type="number"
              min={1000}
              step={1000}
              value={settings.envoy.timeoutMs}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  envoy: { ...settings.envoy, timeoutMs: Number(e.target.value) },
                })
              }
              style={{ maxWidth: 300 }}
            />
          </div>
          <button className="btn btn-primary" onClick={handleSaveEnvoy}>
            {envoySaved ? "Saved" : "Save Envoy Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}
