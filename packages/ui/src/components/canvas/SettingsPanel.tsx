import { useState, useEffect } from "react";
import { getSettings, updateSettings, getCommandInfo, verifyTaskModel } from "../../api.js";
import type { AppSettings, CommandInfo, ConflictPolicy, McpServerConfig, TaskModelTask, CapabilityVerificationResult } from "../../types.js";
import { TASK_MODEL_META } from "../../types.js";
import { useSettings } from "../../context/SettingsContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
}

export default function SettingsPanel({ title }: Props) {
  const { refresh: refreshGlobalSettings } = useSettings();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [commandInfo, setCommandInfo] = useState<CommandInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentSaved, setAgentSaved] = useState(false);
  const [envoySaved, setEnvoySaved] = useState(false);
  const [coBrandingSaved, setCoBrandingSaved] = useState(false);
  const [coBrandingOperatorName, setCoBrandingOperatorName] = useState("");
  const [coBrandingLogoUrl, setCoBrandingLogoUrl] = useState("");
  const [coBrandingAccentColor, setCoBrandingAccentColor] = useState("");
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpSaved, setMcpSaved] = useState(false);
  const [mcpNewName, setMcpNewName] = useState("");
  const [mcpNewUrl, setMcpNewUrl] = useState("");
  const [mcpNewDescription, setMcpNewDescription] = useState("");
  const [useOneModel, setUseOneModel] = useState(true);
  const [taskModelSaved, setTaskModelSaved] = useState(false);
  const [verificationResults, setVerificationResults] = useState<Record<string, CapabilityVerificationResult>>({});
  const [verifyingTask, setVerifyingTask] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getSettings(), getCommandInfo()])
      .then(([s, info]) => {
        setSettings(s);
        setCommandInfo(info);
        setCoBrandingOperatorName(s.coBranding?.operatorName ?? "");
        setCoBrandingLogoUrl(s.coBranding?.logoUrl ?? "");
        setCoBrandingAccentColor(s.coBranding?.accentColor ?? "");
        setMcpServers(s.mcpServers ?? []);
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

  async function handleSaveDeploymentDefaults() {
    if (!settings) return;
    const updated = await updateSettings({
      deploymentDefaults: settings.deploymentDefaults,
    });
    setSettings(updated);
  }

  async function handleToggleEnvironments() {
    if (!settings) return;
    const updated = await updateSettings({ environmentsEnabled: !settings.environmentsEnabled });
    setSettings(updated);
    await refreshGlobalSettings();
  }

  async function handleSaveEnvoy() {
    if (!settings) return;
    const updated = await updateSettings({ envoy: settings.envoy });
    setSettings(updated);
    setEnvoySaved(true);
    setTimeout(() => setEnvoySaved(false), 2000);
  }

  async function handleSaveCoBranding() {
    if (!settings) return;
    const coBranding = coBrandingOperatorName && coBrandingLogoUrl
      ? {
          operatorName: coBrandingOperatorName,
          logoUrl: coBrandingLogoUrl,
          ...(coBrandingAccentColor ? { accentColor: coBrandingAccentColor } : {}),
        }
      : null;
    const updated = await updateSettings({ coBranding } as Partial<AppSettings>);
    setSettings(updated);
    setCoBrandingSaved(true);
    await refreshGlobalSettings();
    setTimeout(() => setCoBrandingSaved(false), 2000);
  }

  async function handleClearCoBranding() {
    if (!settings) return;
    const updated = await updateSettings({ coBranding: null } as Partial<AppSettings>);
    setSettings(updated);
    setCoBrandingOperatorName("");
    setCoBrandingLogoUrl("");
    setCoBrandingAccentColor("");
    await refreshGlobalSettings();
  }

  function handleAddMcpServer() {
    if (!mcpNewName || !mcpNewUrl) return;
    const server: McpServerConfig = {
      name: mcpNewName,
      url: mcpNewUrl,
      ...(mcpNewDescription ? { description: mcpNewDescription } : {}),
    };
    setMcpServers([...mcpServers, server]);
    setMcpNewName("");
    setMcpNewUrl("");
    setMcpNewDescription("");
  }

  function handleRemoveMcpServer(index: number) {
    setMcpServers(mcpServers.filter((_, i) => i !== index));
  }

  async function handleSaveMcpServers() {
    if (!settings) return;
    const updated = await updateSettings({ mcpServers } as Partial<AppSettings>);
    setSettings(updated);
    setMcpServers(updated.mcpServers ?? []);
    setMcpSaved(true);
    setTimeout(() => setMcpSaved(false), 2000);
  }

  // --- Task Model handlers ---

  useEffect(() => {
    if (settings?.agent?.taskModels) {
      const tm = settings.agent.taskModels;
      const hasAny = Object.values(tm).some((v) => v && v.length > 0);
      if (hasAny) setUseOneModel(false);
    }
  }, [settings?.agent?.taskModels]);

  function getTaskModel(task: TaskModelTask): string {
    return settings?.agent?.taskModels?.[task] ?? "";
  }

  function updateTaskModel(task: TaskModelTask, model: string) {
    if (!settings) return;
    const current = settings.agent.taskModels ?? {};
    setSettings({
      ...settings,
      agent: {
        ...settings.agent,
        taskModels: { ...current, [task]: model || undefined },
      },
    });
  }

  async function handleSaveTaskModels() {
    if (!settings) return;
    const updated = await updateSettings({
      agent: { ...settings.agent, taskModels: settings.agent.taskModels },
    });
    setSettings(updated);
    setTaskModelSaved(true);
    setTimeout(() => setTaskModelSaved(false), 2000);
  }

  function handleClearTaskModels() {
    if (!settings) return;
    setSettings({
      ...settings,
      agent: { ...settings.agent, taskModels: undefined },
    });
    setUseOneModel(true);
    setVerificationResults({});
  }

  async function handleVerifyTaskModel(task: TaskModelTask) {
    const model = getTaskModel(task);
    if (!model) return;
    setVerifyingTask(task);
    try {
      const result = await verifyTaskModel(task, model);
      setVerificationResults((prev) => ({ ...prev, [task]: result }));
    } catch {
      setVerificationResults((prev) => ({
        ...prev,
        [task]: {
          task,
          model,
          status: "insufficient" as const,
          explanation: "Verification request failed.",
        },
      }));
    } finally {
      setVerifyingTask(null);
    }
  }

  if (loading) return <CanvasPanelHost title={title}><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!settings) return <CanvasPanelHost title={title}><div className="error-msg">Failed to load settings</div></CanvasPanelHost>;

  return (
    <CanvasPanelHost title={title}>
      <div className="canvas-detail">
        {/* Feature Toggles */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Feature Toggles</h3>
            </div>
            <div className="form-group">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.environmentsEnabled}
                  onChange={handleToggleEnvironments}
                />
                Enable Environments
              </label>
              <div className="settings-description">
                When disabled, environment selection is hidden from the UI and
                deployments proceed without environment-level variable merging.
              </div>
            </div>
          </div>
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
              <h3>Default Deployment Configuration</h3>
            </div>
            <div className="form-group">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={settings.deploymentDefaults.defaultHealthCheckEnabled}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      deploymentDefaults: { ...settings.deploymentDefaults, defaultHealthCheckEnabled: e.target.checked },
                    })
                  }
                />
                Enable Health Checks
              </label>
            </div>
            <div className="form-group">
              <label>Default Health Check Retries</label>
              <input
                type="number"
                min={0}
                max={10}
                value={settings.deploymentDefaults.defaultHealthCheckRetries}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    deploymentDefaults: { ...settings.deploymentDefaults, defaultHealthCheckRetries: Number(e.target.value) },
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
                value={settings.deploymentDefaults.defaultTimeoutMs}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    deploymentDefaults: { ...settings.deploymentDefaults, defaultTimeoutMs: Number(e.target.value) },
                  })
                }
                style={{ maxWidth: 300 }}
              />
            </div>
            <div className="form-group">
              <label>Default Verification Strategy</label>
              <select
                value={settings.deploymentDefaults.defaultVerificationStrategy}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    deploymentDefaults: {
                      ...settings.deploymentDefaults,
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
            <button className="btn btn-primary" onClick={handleSaveDeploymentDefaults}>
              Save Deployment Defaults
            </button>
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

        {/* Per-Task Model Configuration */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Per-Task Model Configuration</h3>
            </div>
            <div className="settings-description" style={{ marginBottom: 12 }}>
              Route different tasks to different models for cost and performance optimization.
            </div>
            <div className="form-group">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={useOneModel}
                  onChange={() => {
                    if (!useOneModel) {
                      handleClearTaskModels();
                    } else {
                      setUseOneModel(false);
                    }
                  }}
                />
                Use one model for all tasks
              </label>
            </div>
            {!useOneModel && (
              <>
                {(["logClassification", "diagnosticSynthesis", "postmortemGeneration", "queryAnswering"] as TaskModelTask[]).map((task) => {
                  const meta = TASK_MODEL_META[task];
                  const result = verificationResults[task];
                  return (
                    <div key={task} className="form-group" style={{ marginBottom: 8 }}>
                      <label style={{ fontSize: "0.9em" }}>
                        {meta.label}
                        <span style={{ fontSize: "0.8em", color: "var(--text-secondary)", marginLeft: 8 }}>
                          ({meta.tier} | {meta.tokenBudget})
                        </span>
                      </label>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          value={getTaskModel(task)}
                          onChange={(e) => updateTaskModel(task, e.target.value)}
                          placeholder="Model ID (leave empty for default)"
                          style={{ flex: 1, maxWidth: 300 }}
                        />
                        <button
                          className="btn"
                          onClick={() => handleVerifyTaskModel(task)}
                          disabled={!getTaskModel(task) || verifyingTask === task}
                          style={{ fontSize: "0.8em", padding: "4px 8px" }}
                        >
                          {verifyingTask === task ? "..." : "Test"}
                        </button>
                        {result && (
                          <span
                            title={result.explanation}
                            className={`status-badge status-${result.status === "verified" ? "succeeded" : result.status === "marginal" ? "pending" : "failed"}`}
                            style={{ fontSize: "0.8em" }}
                          >
                            {result.status}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <button className="btn btn-primary" onClick={handleSaveTaskModels}>
                  {taskModelSaved ? "Saved" : "Save Task Models"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Co-Branding (Optional) */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Co-Branding (Optional)</h3>
            </div>
            <div className="settings-description" style={{ marginBottom: 12 }}>
              Optionally brand this instance with your organization's identity.
              When configured, the UI shows your name and logo with "by DeployStack" beneath.
            </div>
            <div className="form-group">
              <label>Operator Name</label>
              <input
                value={coBrandingOperatorName}
                onChange={(e) => setCoBrandingOperatorName(e.target.value)}
                placeholder="Your Company Name"
                style={{ maxWidth: 400 }}
              />
            </div>
            <div className="form-group">
              <label>Logo URL</label>
              <input
                value={coBrandingLogoUrl}
                onChange={(e) => setCoBrandingLogoUrl(e.target.value)}
                placeholder="https://example.com/logo.png"
                style={{ maxWidth: 400 }}
              />
            </div>
            <div className="form-group">
              <label>Accent Color (optional)</label>
              <input
                value={coBrandingAccentColor}
                onChange={(e) => setCoBrandingAccentColor(e.target.value)}
                placeholder="#63e1be"
                style={{ maxWidth: 300 }}
              />
              <div className="settings-description">
                A CSS color value applied to header accents when co-branding is active.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={handleSaveCoBranding}>
                {coBrandingSaved ? "Saved" : "Save Co-Branding"}
              </button>
              {settings.coBranding && (
                <button className="btn" onClick={handleClearCoBranding}>
                  Clear Co-Branding
                </button>
              )}
            </div>
          </div>
        </div>

        {/* MCP Servers */}
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>External MCP Servers</h3>
            </div>
            <div className="settings-description" style={{ marginBottom: 12 }}>
              Connect to external MCP servers (monitoring, incident management, etc.)
              for pre-deployment intelligence. Unreachable servers are skipped gracefully.
            </div>

            {mcpServers.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {mcpServers.map((server, index) => (
                  <div
                    key={index}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 0",
                      borderBottom: "1px solid var(--border-color, #e2e8f0)",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{server.name}</div>
                      <div style={{ fontSize: "0.85em", opacity: 0.7 }}>{server.url}</div>
                      {server.description && (
                        <div style={{ fontSize: "0.85em", opacity: 0.6 }}>{server.description}</div>
                      )}
                    </div>
                    <button
                      className="btn"
                      onClick={() => handleRemoveMcpServer(index)}
                      style={{ padding: "4px 8px", fontSize: "0.85em" }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Server Name</label>
                <input
                  value={mcpNewName}
                  onChange={(e) => setMcpNewName(e.target.value)}
                  placeholder="e.g. datadog-monitor"
                  style={{ maxWidth: 300 }}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Server URL</label>
                <input
                  value={mcpNewUrl}
                  onChange={(e) => setMcpNewUrl(e.target.value)}
                  placeholder="http://localhost:4000/mcp"
                  style={{ maxWidth: 400 }}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Description (optional)</label>
                <input
                  value={mcpNewDescription}
                  onChange={(e) => setMcpNewDescription(e.target.value)}
                  placeholder="Datadog monitoring integration"
                  style={{ maxWidth: 400 }}
                />
              </div>
              <div>
                <button
                  className="btn"
                  onClick={handleAddMcpServer}
                  disabled={!mcpNewName || !mcpNewUrl}
                >
                  Add Server
                </button>
              </div>
            </div>

            <button className="btn btn-primary" onClick={handleSaveMcpServers}>
              {mcpSaved ? "Saved" : "Save MCP Servers"}
            </button>
          </div>
        </div>
      </div>
    </CanvasPanelHost>
  );
}
