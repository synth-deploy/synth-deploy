import { useState, useEffect, useCallback } from "react";
import { getSettings, updateSettings, getCommandInfo, getLlmHealth } from "../api.js";
import type { AppSettings, CommandInfo, ConflictPolicy, LlmProvider, LlmProviderConfig, LlmFallbackConfig } from "../types.js";
import DeployConfigEditor from "../components/DeployConfigEditor.js";
import { useSettings } from "../context/SettingsContext.js";

const LLM_PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: "claude", label: "Claude (Anthropic)" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini (Google)" },
  { value: "grok", label: "Grok (xAI)" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "ollama", label: "Ollama (Local)" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

/** Providers that require a base URL to be configured */
const PROVIDERS_WITH_BASE_URL: LlmProvider[] = ["ollama", "custom"];

/** Default models per provider for pre-fill convenience */
const DEFAULT_MODELS: Record<LlmProvider, { reasoning: string; classification: string }> = {
  claude: { reasoning: "claude-sonnet-4-6", classification: "claude-haiku-4-5-20251001" },
  openai: { reasoning: "gpt-4o", classification: "gpt-4o-mini" },
  gemini: { reasoning: "gemini-2.0-flash", classification: "gemini-2.0-flash-lite" },
  grok: { reasoning: "grok-3", classification: "grok-3-mini" },
  deepseek: { reasoning: "deepseek-chat", classification: "deepseek-chat" },
  ollama: { reasoning: "llama3.2", classification: "llama3.2" },
  custom: { reasoning: "", classification: "" },
};

function defaultLlmConfig(): LlmProviderConfig {
  return {
    provider: "claude",
    apiKeyConfigured: false,
    reasoningModel: DEFAULT_MODELS.claude.reasoning,
    classificationModel: DEFAULT_MODELS.claude.classification,
    timeoutMs: 30000,
    rateLimitPerMin: 20,
  };
}

function defaultFallback(): LlmFallbackConfig {
  return {
    provider: "claude",
    apiKeyConfigured: false,
    model: DEFAULT_MODELS.claude.reasoning,
    timeoutMs: 30000,
  };
}

export default function Settings() {
  const { refresh: refreshGlobalSettings } = useSettings();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [commandInfo, setCommandInfo] = useState<CommandInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentSaved, setAgentSaved] = useState(false);
  const [envoySaved, setEnvoySaved] = useState(false);
  const [llmSaved, setLlmSaved] = useState(false);
  const [llmHealth, setLlmHealth] = useState<{ configured: boolean; healthy: boolean; provider: string | null; lastChecked: string } | null>(null);
  const [llmHealthLoading, setLlmHealthLoading] = useState(false);

  useEffect(() => {
    Promise.all([getSettings(), getCommandInfo()])
      .then(([s, info]) => {
        setSettings(s);
        setCommandInfo(info);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const checkLlmHealth = useCallback(async () => {
    setLlmHealthLoading(true);
    try {
      const health = await getLlmHealth();
      setLlmHealth(health);
    } catch {
      setLlmHealth({ configured: false, healthy: false, provider: null, lastChecked: new Date().toISOString() });
    } finally {
      setLlmHealthLoading(false);
    }
  }, []);

  // Check LLM health on mount
  useEffect(() => {
    checkLlmHealth();
  }, [checkLlmHealth]);

  async function handleSaveAgent() {
    if (!settings) return;
    const updated = await updateSettings({ agent: settings.agent });
    setSettings(updated);
    setAgentSaved(true);
    setTimeout(() => setAgentSaved(false), 2000);
  }

  async function handleSaveDefaultDeployConfig(config: AppSettings["deploymentDefaults"]["defaultDeployConfig"]) {
    if (!settings) return;
    const updated = await updateSettings({
      deploymentDefaults: { ...settings.deploymentDefaults, defaultDeployConfig: config },
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

  async function handleSaveLlm() {
    if (!settings) return;
    const llmConfig = settings.llm ?? defaultLlmConfig();
    const updated = await updateSettings({ llm: llmConfig });
    setSettings(updated);
    setLlmSaved(true);
    setTimeout(() => setLlmSaved(false), 2000);
    // Re-check health after saving
    await checkLlmHealth();
  }

  function updateLlm(partial: Partial<LlmProviderConfig>) {
    if (!settings) return;
    const current = settings.llm ?? defaultLlmConfig();
    setSettings({
      ...settings,
      llm: { ...current, ...partial },
    });
  }

  function handleProviderChange(provider: LlmProvider) {
    if (!settings) return;
    const current = settings.llm ?? defaultLlmConfig();
    const defaults = DEFAULT_MODELS[provider];
    setSettings({
      ...settings,
      llm: {
        ...current,
        provider,
        reasoningModel: defaults.reasoning,
        classificationModel: defaults.classification,
        // Clear base URL when switching away from ollama/custom
        baseUrl: PROVIDERS_WITH_BASE_URL.includes(provider) ? current.baseUrl : undefined,
      },
    });
  }

  function addFallback() {
    if (!settings) return;
    const current = settings.llm ?? defaultLlmConfig();
    const fallbacks = [...(current.fallbacks ?? []), defaultFallback()];
    updateLlm({ fallbacks });
  }

  function removeFallback(index: number) {
    if (!settings) return;
    const current = settings.llm ?? defaultLlmConfig();
    const fallbacks = (current.fallbacks ?? []).filter((_, i) => i !== index);
    updateLlm({ fallbacks: fallbacks.length > 0 ? fallbacks : undefined });
  }

  function updateFallback(index: number, partial: Partial<LlmFallbackConfig>) {
    if (!settings) return;
    const current = settings.llm ?? defaultLlmConfig();
    const fallbacks = [...(current.fallbacks ?? [])];
    fallbacks[index] = { ...fallbacks[index], ...partial };
    updateLlm({ fallbacks });
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (!settings) return <div className="error-msg">Failed to load settings</div>;

  const llmConfig = settings.llm ?? defaultLlmConfig();
  const showBaseUrl = PROVIDERS_WITH_BASE_URL.includes(llmConfig.provider);

  return (
    <div>
      <div className="page-header">
        <h2>Settings</h2>
      </div>

      {/* LLM Provider Configuration */}
      <div className="section">
        <div className="card">
          <div className="card-header" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h3>LLM Provider Configuration</h3>
            {llmHealth && (
              <span
                className={`status-badge status-${llmHealth.healthy ? "succeeded" : llmHealth.configured ? "failed" : "pending"}`}
                style={{ fontSize: "0.8em" }}
              >
                {llmHealth.healthy ? "Connected" : llmHealth.configured ? "Disconnected" : "Not Configured"}
              </span>
            )}
          </div>

          <div className="settings-description" style={{ marginBottom: 16 }}>
            DeployStack requires an LLM connection to function. Configure your
            provider below. API keys are set via the DEPLOYSTACK_LLM_API_KEY
            environment variable and are never stored in settings.
          </div>

          <div className="form-group">
            <label>Provider</label>
            <select
              value={llmConfig.provider}
              onChange={(e) => handleProviderChange(e.target.value as LlmProvider)}
              style={{ maxWidth: 300 }}
            >
              {LLM_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>API Key Status</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                className={`status-badge status-${llmConfig.apiKeyConfigured ? "succeeded" : "failed"}`}
                style={{ fontSize: "0.85em" }}
              >
                {llmConfig.apiKeyConfigured ? "Key Configured" : "Key Not Set"}
              </span>
              <span style={{ color: "var(--text-secondary)", fontSize: "0.85em" }}>
                Set via DEPLOYSTACK_LLM_API_KEY environment variable
              </span>
            </div>
          </div>

          {showBaseUrl && (
            <div className="form-group">
              <label>Base URL</label>
              <input
                value={llmConfig.baseUrl ?? ""}
                onChange={(e) => updateLlm({ baseUrl: e.target.value || undefined })}
                placeholder={llmConfig.provider === "ollama" ? "http://localhost:11434/v1" : "https://your-api-endpoint.com/v1"}
                style={{ maxWidth: 400 }}
              />
              <div className="settings-description">
                {llmConfig.provider === "ollama"
                  ? "Defaults to http://localhost:11434/v1 if left blank."
                  : "The OpenAI-compatible API base URL for your custom provider."}
              </div>
            </div>
          )}

          <div className="form-group">
            <label>Reasoning Model</label>
            <input
              value={llmConfig.reasoningModel}
              onChange={(e) => updateLlm({ reasoningModel: e.target.value })}
              placeholder="e.g. claude-sonnet-4-6"
              style={{ maxWidth: 400 }}
            />
            <div className="settings-description">
              Used for complex tasks: deployment planning, postmortem generation, diagnostic reports.
            </div>
          </div>

          <div className="form-group">
            <label>Classification Model</label>
            <input
              value={llmConfig.classificationModel}
              onChange={(e) => updateLlm({ classificationModel: e.target.value })}
              placeholder="e.g. claude-haiku-4-5-20251001"
              style={{ maxWidth: 400 }}
            />
            <div className="settings-description">
              Used for lightweight tasks: intent parsing, error categorization.
            </div>
          </div>

          <div style={{ display: "flex", gap: 16 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Timeout (ms)</label>
              <input
                type="number"
                min={1000}
                step={1000}
                value={llmConfig.timeoutMs}
                onChange={(e) => updateLlm({ timeoutMs: Number(e.target.value) })}
                style={{ maxWidth: 200 }}
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label>Rate Limit (calls/min)</label>
              <input
                type="number"
                min={1}
                value={llmConfig.rateLimitPerMin}
                onChange={(e) => updateLlm({ rateLimitPerMin: Number(e.target.value) })}
                style={{ maxWidth: 200 }}
              />
            </div>
          </div>

          {/* Fallback Configuration */}
          <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <label style={{ fontWeight: 600, margin: 0 }}>Fallback Providers</label>
              <button
                className="btn btn-secondary"
                onClick={addFallback}
                style={{ fontSize: "0.85em" }}
              >
                + Add Fallback
              </button>
            </div>
            <div className="settings-description" style={{ marginBottom: 12 }}>
              When the primary provider is unavailable, the system will try these
              fallback providers in order.
            </div>

            {(llmConfig.fallbacks ?? []).map((fb, index) => (
              <div
                key={index}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 12,
                  marginBottom: 8,
                  background: "var(--bg-secondary, #f8f9fa)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontWeight: 500, fontSize: "0.9em" }}>Fallback #{index + 1}</span>
                  <button
                    className="btn btn-danger"
                    onClick={() => removeFallback(index)}
                    style={{ fontSize: "0.8em", padding: "2px 8px" }}
                  >
                    Remove
                  </button>
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div className="form-group" style={{ flex: "1 1 140px", margin: 0 }}>
                    <label style={{ fontSize: "0.85em" }}>Provider</label>
                    <select
                      value={fb.provider}
                      onChange={(e) => {
                        const provider = e.target.value as LlmProvider;
                        const defaults = DEFAULT_MODELS[provider];
                        updateFallback(index, {
                          provider,
                          model: defaults.reasoning,
                          baseUrl: PROVIDERS_WITH_BASE_URL.includes(provider) ? fb.baseUrl : undefined,
                        });
                      }}
                      style={{ maxWidth: "100%" }}
                    >
                      {LLM_PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group" style={{ flex: "2 1 200px", margin: 0 }}>
                    <label style={{ fontSize: "0.85em" }}>Model</label>
                    <input
                      value={fb.model}
                      onChange={(e) => updateFallback(index, { model: e.target.value })}
                      style={{ maxWidth: "100%" }}
                    />
                  </div>
                  <div className="form-group" style={{ flex: "1 1 120px", margin: 0 }}>
                    <label style={{ fontSize: "0.85em" }}>Timeout (ms)</label>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={fb.timeoutMs}
                      onChange={(e) => updateFallback(index, { timeoutMs: Number(e.target.value) })}
                      style={{ maxWidth: "100%" }}
                    />
                  </div>
                  {PROVIDERS_WITH_BASE_URL.includes(fb.provider) && (
                    <div className="form-group" style={{ flex: "2 1 250px", margin: 0 }}>
                      <label style={{ fontSize: "0.85em" }}>Base URL</label>
                      <input
                        value={fb.baseUrl ?? ""}
                        onChange={(e) => updateFallback(index, { baseUrl: e.target.value || undefined })}
                        placeholder="http://localhost:11434/v1"
                        style={{ maxWidth: "100%" }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Health Check Status */}
          <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label style={{ fontWeight: 600, margin: 0 }}>Health Status</label>
              <button
                className="btn btn-secondary"
                onClick={checkLlmHealth}
                disabled={llmHealthLoading}
                style={{ fontSize: "0.85em" }}
              >
                {llmHealthLoading ? "Checking..." : "Check Now"}
              </button>
            </div>
            {llmHealth && (
              <div style={{ marginTop: 8, fontSize: "0.9em" }}>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ color: "var(--text-secondary)" }}>Status: </span>
                    <span className={`status-badge status-${llmHealth.healthy ? "succeeded" : llmHealth.configured ? "failed" : "pending"}`}>
                      {llmHealth.healthy ? "Healthy" : llmHealth.configured ? "Unhealthy" : "Not Configured"}
                    </span>
                  </div>
                  {llmHealth.provider && (
                    <div>
                      <span style={{ color: "var(--text-secondary)" }}>Provider: </span>
                      <span>{llmHealth.provider}</span>
                    </div>
                  )}
                  <div>
                    <span style={{ color: "var(--text-secondary)" }}>Last Checked: </span>
                    <span>{new Date(llmHealth.lastChecked).toLocaleString()}</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" onClick={handleSaveLlm}>
              {llmSaved ? "Saved" : "Save LLM Settings"}
            </button>
          </div>
        </div>
      </div>

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
              Existing environment data is preserved and can be re-enabled at any time.
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
          <DeployConfigEditor
            config={settings.deploymentDefaults.defaultDeployConfig}
            onSave={handleSaveDefaultDeployConfig}
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
