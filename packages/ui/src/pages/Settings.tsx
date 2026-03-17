import { useState, useEffect, useCallback } from "react";
import { getSettings, updateSettings, getCommandInfo, getLlmHealth, verifyTaskModel } from "../api.js";
import type { AppSettings, CommandInfo, ConflictPolicy, LlmProvider, LlmProviderConfig, LlmFallbackConfig, TaskModelTask, TaskModelConfig, CapabilityVerificationResult } from "../types.js";
import { TASK_MODEL_META } from "../types.js";
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
  const [deployDefaultsSaved, setDeployDefaultsSaved] = useState(false);
  const [llmHealth, setLlmHealth] = useState<{ configured: boolean; healthy: boolean; provider?: string; lastChecked?: string } | null>(null);
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
      setLlmHealth({ configured: false, healthy: false, lastChecked: new Date().toISOString() });
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

  async function handleSaveDeploymentDefaults() {
    if (!settings) return;
    const updated = await updateSettings({
      deploymentDefaults: settings.deploymentDefaults,
    });
    setSettings(updated);
    setDeployDefaultsSaved(true);
    setTimeout(() => setDeployDefaultsSaved(false), 2000);
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

  // --- Task Model Configuration state ---
  const [useOneModel, setUseOneModel] = useState(true);
  const [taskModelSaved, setTaskModelSaved] = useState(false);
  const [verificationResults, setVerificationResults] = useState<Record<string, CapabilityVerificationResult>>({});
  const [verifyingTask, setVerifyingTask] = useState<string | null>(null);

  // Initialize useOneModel toggle based on whether any task model overrides exist
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

  async function handleVerifyTask(task: TaskModelTask) {
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
          explanation: "Verification request failed. Check LLM connection.",
        },
      }));
    } finally {
      setVerifyingTask(null);
    }
  }

  async function handleVerifyAll() {
    const tasks: TaskModelTask[] = ["logClassification", "diagnosticSynthesis", "postmortemGeneration", "queryAnswering"];
    for (const task of tasks) {
      const model = getTaskModel(task);
      if (model) {
        await handleVerifyTask(task);
      }
    }
  }

  if (loading) return <div className="loading">Loading...</div>;
  if (!settings) return <div className="error-msg">Failed to load settings</div>;

  const llmConfig = settings.llm ?? defaultLlmConfig();
  const showBaseUrl = PROVIDERS_WITH_BASE_URL.includes(llmConfig.provider);
  const TASK_KEYS: TaskModelTask[] = ["logClassification", "diagnosticSynthesis", "postmortemGeneration", "queryAnswering"];

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
            Synth requires an LLM connection to function. Configure your
            provider below. API keys are set via the SYNTH_LLM_API_KEY
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
                Set via SYNTH_LLM_API_KEY environment variable
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
                    <span>{llmHealth.lastChecked ? new Date(llmHealth.lastChecked).toLocaleString() : "Never"}</span>
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

      {/* Per-Task Model Configuration */}
      <div className="section">
        <div className="card">
          <div className="card-header">
            <h3>Per-Task Model Configuration</h3>
          </div>

          <div className="settings-description" style={{ marginBottom: 16 }}>
            Route different tasks to different models. Lightweight tasks like log
            classification can use smaller, faster models. Complex tasks like
            postmortem generation benefit from more capable models.
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
            <div className="settings-description">
              When enabled, all tasks use the reasoning and classification models
              configured above. Disable to assign specific models per task.
            </div>
          </div>

          {!useOneModel && (
            <>
              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9em" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--border, #e2e8f0)" }}>
                      <th style={{ textAlign: "left", padding: "8px 12px" }}>Task</th>
                      <th style={{ textAlign: "left", padding: "8px 12px" }}>
                        Tier
                        <span
                          title="Recommended model capability level for this task"
                          style={{ cursor: "help", marginLeft: 4, opacity: 0.6 }}
                        >
                          (i)
                        </span>
                      </th>
                      <th style={{ textAlign: "left", padding: "8px 12px" }}>
                        Token Budget
                        <span
                          title="Approximate max tokens for typical responses"
                          style={{ cursor: "help", marginLeft: 4, opacity: 0.6 }}
                        >
                          (i)
                        </span>
                      </th>
                      <th style={{ textAlign: "left", padding: "8px 12px" }}>
                        Reasoning Depth
                        <span
                          title="Type of reasoning the task requires"
                          style={{ cursor: "help", marginLeft: 4, opacity: 0.6 }}
                        >
                          (i)
                        </span>
                      </th>
                      <th style={{ textAlign: "left", padding: "8px 12px", minWidth: 200 }}>Model</th>
                      <th style={{ textAlign: "center", padding: "8px 12px" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TASK_KEYS.map((task) => {
                      const meta = TASK_MODEL_META[task];
                      const result = verificationResults[task];
                      return (
                        <tr key={task} style={{ borderBottom: "1px solid var(--border, #e2e8f0)" }}>
                          <td style={{ padding: "8px 12px", fontWeight: 500 }}>{meta.label}</td>
                          <td style={{ padding: "8px 12px" }}>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 8px",
                                borderRadius: 4,
                                fontSize: "0.85em",
                                background: meta.tier === "Lightweight" ? "var(--bg-success, #d4edda)" :
                                           meta.tier === "Mid-range" ? "var(--bg-warning, #fff3cd)" :
                                           "var(--bg-info, #d1ecf1)",
                                color: "var(--text-primary, #333)",
                              }}
                            >
                              {meta.tier}
                            </span>
                          </td>
                          <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: "0.85em" }}>{meta.tokenBudget}</td>
                          <td style={{ padding: "8px 12px", fontSize: "0.85em", color: "var(--text-secondary)" }}>{meta.reasoningDepth}</td>
                          <td style={{ padding: "8px 12px" }}>
                            <input
                              value={getTaskModel(task)}
                              onChange={(e) => updateTaskModel(task, e.target.value)}
                              placeholder={task === "logClassification"
                                ? llmConfig.classificationModel
                                : llmConfig.reasoningModel}
                              style={{ width: "100%", fontSize: "0.9em" }}
                            />
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}>
                              <button
                                className="btn btn-secondary"
                                onClick={() => handleVerifyTask(task)}
                                disabled={!getTaskModel(task) || verifyingTask === task}
                                style={{ fontSize: "0.8em", padding: "2px 8px" }}
                              >
                                {verifyingTask === task ? "..." : "Test"}
                              </button>
                              {result && (
                                <span
                                  title={result.explanation}
                                  style={{
                                    cursor: "help",
                                    fontSize: "1em",
                                  }}
                                >
                                  {result.status === "verified" ? "\u2705" :
                                   result.status === "marginal" ? "\u26A0\uFE0F" : "\u274C"}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Verification results detail */}
              {Object.keys(verificationResults).length > 0 && (
                <div style={{ marginTop: 12, padding: 12, background: "var(--bg-secondary, #f8f9fa)", borderRadius: 6, fontSize: "0.85em" }}>
                  {TASK_KEYS.map((task) => {
                    const result = verificationResults[task];
                    if (!result) return null;
                    return (
                      <div key={task} style={{ marginBottom: 4 }}>
                        <span style={{ fontWeight: 500 }}>{TASK_MODEL_META[task].label}:</span>{" "}
                        <span
                          className={`status-badge status-${result.status === "verified" ? "succeeded" : result.status === "marginal" ? "pending" : "failed"}`}
                          style={{ fontSize: "0.9em" }}
                        >
                          {result.status}
                        </span>{" "}
                        <span style={{ color: "var(--text-secondary)" }}>{result.explanation}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button className="btn btn-primary" onClick={handleSaveTaskModels}>
                  {taskModelSaved ? "Saved" : "Save Task Models"}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={handleVerifyAll}
                  disabled={verifyingTask !== null || !TASK_KEYS.some((t) => getTaskModel(t))}
                >
                  Test All
                </button>
              </div>
            </>
          )}
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
          <div className="form-group">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={settings.deploymentDefaults.defaultHealthCheckEnabled}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    deploymentDefaults: {
                      ...settings.deploymentDefaults,
                      defaultHealthCheckEnabled: e.target.checked,
                    },
                  })
                }
              />
              Enable Health Checks
            </label>
          </div>
          <div className="form-group">
            <label>Health Check Retries</label>
            <input
              type="number"
              min={0}
              max={10}
              value={settings.deploymentDefaults.defaultHealthCheckRetries}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  deploymentDefaults: {
                    ...settings.deploymentDefaults,
                    defaultHealthCheckRetries: Number(e.target.value),
                  },
                })
              }
              style={{ maxWidth: 300 }}
            />
          </div>
          <div className="form-group">
            <label>Timeout (ms)</label>
            <input
              type="number"
              min={1000}
              step={1000}
              value={settings.deploymentDefaults.defaultTimeoutMs}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  deploymentDefaults: {
                    ...settings.deploymentDefaults,
                    defaultTimeoutMs: Number(e.target.value),
                  },
                })
              }
              style={{ maxWidth: 300 }}
            />
          </div>
          <div className="form-group">
            <label>Verification Strategy</label>
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
            {deployDefaultsSaved ? "Saved" : "Save Deployment Defaults"}
          </button>
        </div>
      </div>

      {/* Synth Connection Info */}
      {commandInfo && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Synth Connection</h3>
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
              placeholder="http://localhost:9411"
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
