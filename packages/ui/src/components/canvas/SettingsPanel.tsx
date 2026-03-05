import { useState, useEffect } from "react";
import { getSettings, updateSettings, getCommandInfo, verifyTaskModel, listIdpProviders, createIdpProvider, updateIdpProvider, deleteIdpProvider, testIdpProvider, listRoleMappings, createRoleMapping, deleteRoleMapping, testLdapUser } from "../../api.js";
import type { AppSettings, CommandInfo, ConflictPolicy, McpServerConfig, TaskModelTask, CapabilityVerificationResult, IdpProvider, RoleMappingRule } from "../../types.js";
import { TASK_MODEL_META } from "../../types.js";
import { useSettings } from "../../context/SettingsContext.js";
import { useAuth } from "../../context/AuthContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

interface Props {
  title: string;
}

export default function SettingsPanel({ title }: Props) {
  const { refresh: refreshGlobalSettings } = useSettings();
  const { permissions } = useAuth();
  const canManageSettings = permissions.includes("settings.manage");
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

  // --- IdP state ---
  const [idpProviders, setIdpProviders] = useState<IdpProvider[]>([]);
  const [idpShowForm, setIdpShowForm] = useState(false);
  const [idpNewType, setIdpNewType] = useState<"oidc" | "saml" | "ldap">("oidc");
  const [idpNewName, setIdpNewName] = useState("");
  // OIDC fields
  const [idpNewIssuerUrl, setIdpNewIssuerUrl] = useState("");
  const [idpNewClientId, setIdpNewClientId] = useState("");
  const [idpNewClientSecret, setIdpNewClientSecret] = useState("");
  const [idpNewScopes, setIdpNewScopes] = useState("openid profile email");
  const [idpNewGroupsClaim, setIdpNewGroupsClaim] = useState("groups");
  // SAML fields
  const [idpNewEntryPoint, setIdpNewEntryPoint] = useState("");
  const [idpNewSamlIssuer, setIdpNewSamlIssuer] = useState("");
  const [idpNewSamlCert, setIdpNewSamlCert] = useState("");
  const [idpNewSignatureAlgorithm, setIdpNewSignatureAlgorithm] = useState<"sha256" | "sha512">("sha256");
  const [idpNewGroupsAttribute, setIdpNewGroupsAttribute] = useState("memberOf");
  // LDAP fields
  const [idpNewLdapUrl, setIdpNewLdapUrl] = useState("");
  const [idpNewLdapBindDn, setIdpNewLdapBindDn] = useState("");
  const [idpNewLdapBindCredential, setIdpNewLdapBindCredential] = useState("");
  const [idpNewLdapSearchBase, setIdpNewLdapSearchBase] = useState("");
  const [idpNewLdapSearchFilter, setIdpNewLdapSearchFilter] = useState("(sAMAccountName={{username}})");
  const [idpNewLdapGroupSearchBase, setIdpNewLdapGroupSearchBase] = useState("");
  const [idpNewLdapGroupSearchFilter, setIdpNewLdapGroupSearchFilter] = useState("(member={{dn}})");
  const [idpNewLdapUseTls, setIdpNewLdapUseTls] = useState(true);
  const [idpNewLdapTlsCaPath, setIdpNewLdapTlsCaPath] = useState("");
  // LDAP test user
  const [ldapTestUsername, setLdapTestUsername] = useState<Record<string, string>>({});
  const [ldapTestUserResults, setLdapTestUserResults] = useState<Record<string, { found: boolean; userDn?: string; email?: string; displayName?: string; error?: string }>>({});
  const [ldapTestingUser, setLdapTestingUser] = useState<string | null>(null);
  const [idpTesting, setIdpTesting] = useState<string | null>(null);
  const [idpTestResults, setIdpTestResults] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [idpMappings, setIdpMappings] = useState<Record<string, RoleMappingRule[]>>({});
  const [idpMappingNewGroup, setIdpMappingNewGroup] = useState("");
  const [idpMappingNewRole, setIdpMappingNewRole] = useState("");
  const [idpMappingProviderId, setIdpMappingProviderId] = useState<string | null>(null);

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
    // Load IdP providers
    listIdpProviders().then(setIdpProviders).catch(() => {});
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
    const updated = await updateSettings({ coBranding: undefined } as Partial<AppSettings>);
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

  // --- IdP handlers ---

  async function handleAddIdpProvider() {
    if (!idpNewName) return;

    let config: Record<string, unknown>;

    if (idpNewType === "saml") {
      if (!idpNewEntryPoint || !idpNewSamlIssuer || !idpNewSamlCert) return;
      config = {
        entryPoint: idpNewEntryPoint,
        issuer: idpNewSamlIssuer,
        cert: idpNewSamlCert,
        callbackUrl: "", // will be computed server-side from request
        signatureAlgorithm: idpNewSignatureAlgorithm,
        groupsAttribute: idpNewGroupsAttribute || "memberOf",
      };
    } else if (idpNewType === "ldap") {
      if (!idpNewLdapUrl || !idpNewLdapBindDn || !idpNewLdapBindCredential || !idpNewLdapSearchBase || !idpNewLdapGroupSearchBase) return;
      config = {
        url: idpNewLdapUrl,
        bindDn: idpNewLdapBindDn,
        bindCredential: idpNewLdapBindCredential,
        searchBase: idpNewLdapSearchBase,
        searchFilter: idpNewLdapSearchFilter || "(sAMAccountName={{username}})",
        groupSearchBase: idpNewLdapGroupSearchBase,
        groupSearchFilter: idpNewLdapGroupSearchFilter || "(member={{dn}})",
        useTls: idpNewLdapUseTls,
        ...(idpNewLdapTlsCaPath ? { tlsCaPath: idpNewLdapTlsCaPath } : {}),
      };
    } else {
      if (!idpNewIssuerUrl || !idpNewClientId || !idpNewClientSecret) return;
      config = {
        issuerUrl: idpNewIssuerUrl,
        clientId: idpNewClientId,
        clientSecret: idpNewClientSecret,
        scopes: idpNewScopes.split(/\s+/).filter(Boolean),
        groupsClaim: idpNewGroupsClaim || "groups",
      };
    }

    const provider = await createIdpProvider({
      type: idpNewType,
      name: idpNewName,
      enabled: true,
      config,
    });
    setIdpProviders([...idpProviders, provider]);
    // Reset all fields
    setIdpNewName("");
    setIdpNewType("oidc");
    setIdpNewIssuerUrl("");
    setIdpNewClientId("");
    setIdpNewClientSecret("");
    setIdpNewScopes("openid profile email");
    setIdpNewGroupsClaim("groups");
    setIdpNewEntryPoint("");
    setIdpNewSamlIssuer("");
    setIdpNewSamlCert("");
    setIdpNewSignatureAlgorithm("sha256");
    setIdpNewGroupsAttribute("memberOf");
    setIdpNewLdapUrl("");
    setIdpNewLdapBindDn("");
    setIdpNewLdapBindCredential("");
    setIdpNewLdapSearchBase("");
    setIdpNewLdapSearchFilter("(sAMAccountName={{username}})");
    setIdpNewLdapGroupSearchBase("");
    setIdpNewLdapGroupSearchFilter("(member={{dn}})");
    setIdpNewLdapUseTls(true);
    setIdpNewLdapTlsCaPath("");
    setIdpShowForm(false);
  }

  async function handleTestLdapUser(providerId: string) {
    const username = ldapTestUsername[providerId];
    if (!username) return;
    setLdapTestingUser(providerId);
    try {
      const result = await testLdapUser(providerId, username);
      setLdapTestUserResults((prev) => ({ ...prev, [providerId]: result }));
    } catch {
      setLdapTestUserResults((prev) => ({ ...prev, [providerId]: { found: false, error: "Test request failed" } }));
    } finally {
      setLdapTestingUser(null);
    }
  }

  async function handleToggleIdpProvider(id: string, enabled: boolean) {
    const updated = await updateIdpProvider(id, { enabled });
    setIdpProviders(idpProviders.map((p) => (p.id === id ? updated : p)));
  }

  async function handleDeleteIdpProvider(id: string) {
    await deleteIdpProvider(id);
    setIdpProviders(idpProviders.filter((p) => p.id !== id));
  }

  async function handleTestIdpProvider(id: string) {
    setIdpTesting(id);
    try {
      const result = await testIdpProvider(id);
      setIdpTestResults((prev) => ({ ...prev, [id]: result }));
    } catch {
      setIdpTestResults((prev) => ({ ...prev, [id]: { success: false, error: "Test request failed" } }));
    } finally {
      setIdpTesting(null);
    }
  }

  async function handleLoadMappings(providerId: string) {
    if (idpMappingProviderId === providerId) {
      setIdpMappingProviderId(null);
      return;
    }
    const mappings = await listRoleMappings(providerId);
    setIdpMappings((prev) => ({ ...prev, [providerId]: mappings }));
    setIdpMappingProviderId(providerId);
    setIdpMappingNewGroup("");
    setIdpMappingNewRole("");
  }

  async function handleAddRoleMapping(providerId: string) {
    if (!idpMappingNewGroup || !idpMappingNewRole) return;
    const mapping = await createRoleMapping(providerId, {
      idpGroup: idpMappingNewGroup,
      deployStackRole: idpMappingNewRole,
    });
    setIdpMappings((prev) => ({
      ...prev,
      [providerId]: [...(prev[providerId] ?? []), mapping],
    }));
    setIdpMappingNewGroup("");
    setIdpMappingNewRole("");
  }

  async function handleDeleteRoleMapping(providerId: string, mappingId: string) {
    await deleteRoleMapping(mappingId);
    setIdpMappings((prev) => ({
      ...prev,
      [providerId]: (prev[providerId] ?? []).filter((m) => m.id !== mappingId),
    }));
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

        {/* Identity Providers (admin only) */}
        {canManageSettings && (
        <div className="section">
          <div className="card">
            <div className="card-header">
              <h3>Identity Providers</h3>
            </div>
            <div className="settings-description" style={{ marginBottom: 12 }}>
              Configure SSO providers for your team. Users can sign in via configured identity providers
              instead of local credentials.
            </div>

            {idpProviders.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {idpProviders.map((provider) => {
                  const testResult = idpTestResults[provider.id];
                  return (
                    <div key={provider.id} style={{ padding: "12px 0", borderBottom: "1px solid var(--border-color, #e2e8f0)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 500 }}>{provider.name}</div>
                          <div style={{ fontSize: "0.85em", opacity: 0.7 }}>
                            {provider.type.toUpperCase()} — {
                              provider.type === "saml"
                                ? (provider.config.entryPoint as string) || "No entry point"
                                : provider.type === "ldap"
                                ? (provider.config.url as string) || "No LDAP URL"
                                : (provider.config.issuerUrl as string) || "No issuer URL"
                            }
                          </div>
                        </div>
                        <span
                          className={`status-badge status-${provider.enabled ? "succeeded" : "failed"}`}
                          style={{ fontSize: "0.8em" }}
                        >
                          {provider.enabled ? "Enabled" : "Disabled"}
                        </span>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: "0.85em" }}>
                          <input
                            type="checkbox"
                            checked={provider.enabled}
                            onChange={(e) => handleToggleIdpProvider(provider.id, e.target.checked)}
                          />
                        </label>
                        <button
                          className="btn"
                          onClick={() => handleTestIdpProvider(provider.id)}
                          disabled={idpTesting === provider.id}
                          style={{ padding: "4px 8px", fontSize: "0.85em" }}
                        >
                          {idpTesting === provider.id ? "..." : "Test"}
                        </button>
                        {provider.type === "saml" && (
                          <a
                            href={`/api/auth/saml/${provider.id}/metadata`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn"
                            style={{ padding: "4px 8px", fontSize: "0.85em", textDecoration: "none" }}
                          >
                            SP Metadata
                          </a>
                        )}
                        <button
                          className="btn"
                          onClick={() => handleLoadMappings(provider.id)}
                          style={{ padding: "4px 8px", fontSize: "0.85em" }}
                        >
                          {idpMappingProviderId === provider.id ? "Hide Mappings" : "Mappings"}
                        </button>
                        <button
                          className="btn"
                          onClick={() => handleDeleteIdpProvider(provider.id)}
                          style={{ padding: "4px 8px", fontSize: "0.85em" }}
                        >
                          Remove
                        </button>
                      </div>
                      {testResult && (
                        <div style={{ marginTop: 4, fontSize: "0.85em", color: testResult.success ? "var(--color-success, #22c55e)" : "var(--color-error, #ef4444)" }}>
                          {testResult.success ? "Connection successful" : `Connection failed: ${testResult.error}`}
                        </div>
                      )}

                      {/* LDAP Test User */}
                      {provider.type === "ldap" && (
                        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            value={ldapTestUsername[provider.id] ?? ""}
                            onChange={(e) => setLdapTestUsername((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                            placeholder="Test username (e.g. jdoe)"
                            style={{ maxWidth: 200, fontSize: "0.85em" }}
                          />
                          <button
                            className="btn"
                            onClick={() => handleTestLdapUser(provider.id)}
                            disabled={!ldapTestUsername[provider.id] || ldapTestingUser === provider.id}
                            style={{ padding: "4px 8px", fontSize: "0.85em" }}
                          >
                            {ldapTestingUser === provider.id ? "..." : "Test User"}
                          </button>
                          {ldapTestUserResults[provider.id] && (
                            <div style={{ width: "100%", fontSize: "0.85em", marginTop: 4, color: ldapTestUserResults[provider.id].found ? "var(--color-success, #22c55e)" : "var(--color-error, #ef4444)" }}>
                              {ldapTestUserResults[provider.id].found
                                ? `Found: ${ldapTestUserResults[provider.id].displayName ?? "unknown"} (${ldapTestUserResults[provider.id].email ?? "no email"}) — DN: ${ldapTestUserResults[provider.id].userDn}`
                                : `Not found: ${ldapTestUserResults[provider.id].error}`}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Role Mappings */}
                      {idpMappingProviderId === provider.id && (
                        <div style={{ marginTop: 12, paddingLeft: 16, borderLeft: "2px solid var(--border-color, #e2e8f0)" }}>
                          <div style={{ fontWeight: 500, fontSize: "0.9em", marginBottom: 8 }}>Role Mappings</div>
                          {(idpMappings[provider.id] ?? []).length > 0 && (
                            <div style={{ marginBottom: 8 }}>
                              {(idpMappings[provider.id] ?? []).map((mapping) => (
                                <div
                                  key={mapping.id}
                                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: "0.85em" }}
                                >
                                  <span style={{ flex: 1 }}>
                                    <strong>{mapping.idpGroup}</strong> &rarr; {mapping.deployStackRole}
                                  </span>
                                  <button
                                    className="btn"
                                    onClick={() => handleDeleteRoleMapping(provider.id, mapping.id)}
                                    style={{ padding: "2px 6px", fontSize: "0.8em" }}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
                              value={idpMappingNewGroup}
                              onChange={(e) => setIdpMappingNewGroup(e.target.value)}
                              placeholder="IdP Group"
                              style={{ maxWidth: 180, fontSize: "0.85em" }}
                            />
                            <input
                              value={idpMappingNewRole}
                              onChange={(e) => setIdpMappingNewRole(e.target.value)}
                              placeholder="DeployStack Role"
                              style={{ maxWidth: 180, fontSize: "0.85em" }}
                            />
                            <button
                              className="btn"
                              onClick={() => handleAddRoleMapping(provider.id)}
                              disabled={!idpMappingNewGroup || !idpMappingNewRole}
                              style={{ padding: "4px 8px", fontSize: "0.85em" }}
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {idpShowForm ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Provider Type</label>
                  <select
                    value={idpNewType}
                    onChange={(e) => setIdpNewType(e.target.value as "oidc" | "saml" | "ldap")}
                    style={{ maxWidth: 300 }}
                  >
                    <option value="oidc">OIDC (OpenID Connect)</option>
                    <option value="saml">SAML 2.0</option>
                    <option value="ldap">LDAP / Active Directory</option>
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Provider Name</label>
                  <input
                    value={idpNewName}
                    onChange={(e) => setIdpNewName(e.target.value)}
                    placeholder="e.g. Okta, Auth0, Azure AD"
                    style={{ maxWidth: 300 }}
                  />
                </div>

                {idpNewType === "oidc" && (
                  <>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Issuer URL</label>
                      <input
                        value={idpNewIssuerUrl}
                        onChange={(e) => setIdpNewIssuerUrl(e.target.value)}
                        placeholder="https://login.example.com"
                        style={{ maxWidth: 400 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Client ID</label>
                      <input
                        value={idpNewClientId}
                        onChange={(e) => setIdpNewClientId(e.target.value)}
                        placeholder="client-id"
                        style={{ maxWidth: 400 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Client Secret</label>
                      <input
                        type="password"
                        value={idpNewClientSecret}
                        onChange={(e) => setIdpNewClientSecret(e.target.value)}
                        placeholder="client-secret"
                        style={{ maxWidth: 400 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Scopes</label>
                      <input
                        value={idpNewScopes}
                        onChange={(e) => setIdpNewScopes(e.target.value)}
                        placeholder="openid profile email"
                        style={{ maxWidth: 400 }}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Groups Claim</label>
                      <input
                        value={idpNewGroupsClaim}
                        onChange={(e) => setIdpNewGroupsClaim(e.target.value)}
                        placeholder="groups"
                        style={{ maxWidth: 300 }}
                      />
                      <div className="settings-description">
                        The JWT claim that contains the user's group memberships for role mapping.
                      </div>
                    </div>
                  </>
                )}

                {idpNewType === "saml" && (
                  <>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Entry Point URL</label>
                      <input
                        value={idpNewEntryPoint}
                        onChange={(e) => setIdpNewEntryPoint(e.target.value)}
                        placeholder="https://idp.example.com/sso/saml"
                        style={{ maxWidth: 400 }}
                      />
                      <div className="settings-description">
                        The IdP's SSO URL where AuthnRequests are sent.
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Issuer / Entity ID</label>
                      <input
                        value={idpNewSamlIssuer}
                        onChange={(e) => setIdpNewSamlIssuer(e.target.value)}
                        placeholder="https://deploystack.example.com/sp"
                        style={{ maxWidth: 400 }}
                      />
                      <div className="settings-description">
                        The Service Provider entity ID that identifies this DeployStack instance to the IdP.
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>IdP Certificate (PEM)</label>
                      <textarea
                        value={idpNewSamlCert}
                        onChange={(e) => setIdpNewSamlCert(e.target.value)}
                        placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"}
                        rows={6}
                        style={{ maxWidth: 500, fontFamily: "monospace", fontSize: "0.85em" }}
                      />
                      <div className="settings-description">
                        The IdP's X.509 signing certificate in PEM format. Used to verify SAML Response signatures.
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Signature Algorithm</label>
                      <select
                        value={idpNewSignatureAlgorithm}
                        onChange={(e) => setIdpNewSignatureAlgorithm(e.target.value as "sha256" | "sha512")}
                        style={{ maxWidth: 300 }}
                      >
                        <option value="sha256">SHA-256</option>
                        <option value="sha512">SHA-512</option>
                      </select>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Groups Attribute</label>
                      <input
                        value={idpNewGroupsAttribute}
                        onChange={(e) => setIdpNewGroupsAttribute(e.target.value)}
                        placeholder="memberOf"
                        style={{ maxWidth: 300 }}
                      />
                      <div className="settings-description">
                        The SAML attribute that contains the user's group memberships for role mapping.
                      </div>
                    </div>
                  </>
                )}

                {idpNewType === "ldap" && (
                  <>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>URL</label>
                      <input
                        value={idpNewLdapUrl}
                        onChange={(e) => setIdpNewLdapUrl(e.target.value)}
                        placeholder="ldaps://dc.corp.example.com:636"
                        style={{ maxWidth: 400 }}
                      />
                      <div className="settings-description">
                        The LDAP server URL. Use ldaps:// for TLS or ldap:// for plain (not recommended).
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Bind DN</label>
                      <input
                        value={idpNewLdapBindDn}
                        onChange={(e) => setIdpNewLdapBindDn(e.target.value)}
                        placeholder="cn=svc-deploystack,ou=ServiceAccounts,dc=corp,dc=example,dc=com"
                        style={{ maxWidth: 500 }}
                      />
                      <div className="settings-description">
                        The distinguished name of the service account used to search the directory.
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Bind Credential</label>
                      <input
                        type="password"
                        value={idpNewLdapBindCredential}
                        onChange={(e) => setIdpNewLdapBindCredential(e.target.value)}
                        placeholder="Service account password"
                        style={{ maxWidth: 400 }}
                      />
                      <div className="settings-description">
                        Password for the service account. Encrypted at rest.
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Search Base</label>
                      <input
                        value={idpNewLdapSearchBase}
                        onChange={(e) => setIdpNewLdapSearchBase(e.target.value)}
                        placeholder="ou=Users,dc=corp,dc=example,dc=com"
                        style={{ maxWidth: 500 }}
                      />
                      <div className="settings-description">
                        The base DN to search for user entries.
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Search Filter</label>
                      <input
                        value={idpNewLdapSearchFilter}
                        onChange={(e) => setIdpNewLdapSearchFilter(e.target.value)}
                        placeholder="(sAMAccountName={{username}})"
                        style={{ maxWidth: 500 }}
                      />
                      <div className="settings-description">
                        {"LDAP filter to find users. Use {{username}} as the placeholder for the login username."}
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Group Search Base</label>
                      <input
                        value={idpNewLdapGroupSearchBase}
                        onChange={(e) => setIdpNewLdapGroupSearchBase(e.target.value)}
                        placeholder="ou=Groups,dc=corp,dc=example,dc=com"
                        style={{ maxWidth: 500 }}
                      />
                      <div className="settings-description">
                        The base DN to search for group entries.
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Group Search Filter</label>
                      <input
                        value={idpNewLdapGroupSearchFilter}
                        onChange={(e) => setIdpNewLdapGroupSearchFilter(e.target.value)}
                        placeholder="(member={{dn}})"
                        style={{ maxWidth: 500 }}
                      />
                      <div className="settings-description">
                        {"LDAP filter to find groups. Use {{dn}} as the placeholder for the user's DN. For AD nested groups, use (member={{dn}}) which is automatically enhanced with the transitive membership matching rule."}
                      </div>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={idpNewLdapUseTls}
                          onChange={(e) => setIdpNewLdapUseTls(e.target.checked)}
                        />
                        Use TLS
                      </label>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>TLS CA Path (optional)</label>
                      <input
                        value={idpNewLdapTlsCaPath}
                        onChange={(e) => setIdpNewLdapTlsCaPath(e.target.value)}
                        placeholder="/etc/ssl/certs/ldap-ca.pem"
                        style={{ maxWidth: 400 }}
                      />
                      <div className="settings-description">
                        Path to a custom CA certificate file for verifying the LDAP server's TLS certificate.
                      </div>
                    </div>
                  </>
                )}

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    onClick={handleAddIdpProvider}
                    disabled={
                      !idpNewName || (
                        idpNewType === "oidc"
                          ? (!idpNewIssuerUrl || !idpNewClientId || !idpNewClientSecret)
                          : idpNewType === "saml"
                          ? (!idpNewEntryPoint || !idpNewSamlIssuer || !idpNewSamlCert)
                          : (!idpNewLdapUrl || !idpNewLdapBindDn || !idpNewLdapBindCredential || !idpNewLdapSearchBase || !idpNewLdapGroupSearchBase)
                      )
                    }
                  >
                    Add Provider
                  </button>
                  <button className="btn" onClick={() => setIdpShowForm(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn" onClick={() => setIdpShowForm(true)}>
                Add Identity Provider
              </button>
            )}
          </div>
        </div>
        )}
      </div>
    </CanvasPanelHost>
  );
}
