import { useState, useEffect } from "react";
import { getSettings, updateSettings, getCommandInfo, verifyTaskModel, listIdpProviders, createIdpProvider, updateIdpProvider, deleteIdpProvider, testIdpProvider, listRoleMappings, createRoleMapping, deleteRoleMapping, testLdapUser, listIntakeChannels, createIntakeChannel, updateIntakeChannel, deleteIntakeChannel, testIntakeChannel, manualUploadArtifact, listIntakeEvents, listEnvoys } from "../../api.js";
import type { EnvoyRegistryEntry } from "../../api.js";
import type { AppSettings, CommandInfo, ConflictPolicy, McpServerConfig, TaskModelTask, CapabilityVerificationResult, IdpProvider, RoleMappingRule, IntakeChannel, IntakeEvent, LlmProvider } from "../../types.js";
import { TASK_MODEL_META } from "../../types.js";
import { useSettings } from "../../context/SettingsContext.js";
import { useAuth } from "../../context/AuthContext.js";
import { useQuery } from "../../hooks/useQuery.js";
import CanvasPanelHost from "./CanvasPanelHost.js";

// ─── Sub-components ───────────────────────────────────────────────────────────

function SettingRow({ label, description, children, last }: { label: string; description?: string; children?: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, padding: "14px 0", borderBottom: last ? "none" : "1px solid var(--border)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text)" }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.45 }}>{description}</div>}
      </div>
      {children && <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>{children}</div>}
    </div>
  );
}

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <div
      onClick={onChange}
      style={{ width: 38, height: 22, borderRadius: 11, border: "1px solid var(--border)", background: on ? "var(--accent-dim)" : "var(--surface-alt)", cursor: "pointer", position: "relative", transition: "all 0.2s", flexShrink: 0 }}
    >
      <div style={{ width: 16, height: 16, borderRadius: "50%", background: on ? "var(--accent)" : "var(--text-muted)", position: "absolute", top: 2, left: on ? 19 : 2, transition: "left 0.2s" }} />
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 10, marginTop: 24 }}>
      {children}
    </div>
  );
}

const INPUT_STYLE: React.CSSProperties = {
  padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)",
  background: "var(--input-bg, var(--surface))", color: "var(--text)",
  fontSize: 13, fontFamily: "var(--font-mono)", boxSizing: "border-box",
  outline: "none", transition: "border-color 0.15s",
};

function SI({ value, onChange, placeholder, type = "text", width = 220, mono = true }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string; width?: number; mono?: boolean }) {
  return <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} type={type} style={{ ...INPUT_STYLE, width, fontFamily: mono ? "var(--font-mono)" : "var(--font)" }} />;
}

function SS({ value, onChange, options, width = 160 }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; width?: number }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)} style={{ ...INPUT_STYLE, width }}>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Pill({ text, success, muted }: { text: string; success?: boolean; muted?: boolean }) {
  const color = success ? "var(--accent)" : muted ? "var(--text-muted)" : "var(--text-muted)";
  return (
    <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600, fontFamily: "var(--font-mono)", textTransform: "uppercase", color, border: `1px solid ${color}30`, background: `${color}18` }}>
      {text}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

type Tab = "general" | "llm" | "agent" | "deploy" | "envoy" | "identity" | "intake" | "branding";

interface Props { title: string; }

export default function SettingsPanel({ title }: Props) {
  const { refresh: refreshGlobalSettings } = useSettings();
  const { permissions } = useAuth();
  const canManageSettings = permissions.includes("settings.manage");

  const { data: fetchedSettings, loading: l1 } = useQuery("settings", getSettings);
  const { data: fetchedCommandInfo, loading: l2 } = useQuery("commandInfo", getCommandInfo);
  const { data: envoysData } = useQuery("list:envoys", listEnvoys);
  const loading = l1 || l2;

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [commandInfo, setCommandInfo] = useState<CommandInfo | null>(null);
  const [envoys, setEnvoys] = useState<EnvoyRegistryEntry[]>([]);
  const [settingsTab, setSettingsTab] = useState<Tab>("general");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // MCP sub-state
  const [mcpNewName, setMcpNewName] = useState("");
  const [mcpNewUrl, setMcpNewUrl] = useState("");
  const [mcpNewDescription, setMcpNewDescription] = useState("");

  // Task model sub-state
  const [useOneModel, setUseOneModel] = useState(true);
  const [verificationResults, setVerificationResults] = useState<Record<string, CapabilityVerificationResult>>({});
  const [verifyingTask, setVerifyingTask] = useState<string | null>(null);

  // IdP state
  const { data: idpData } = useQuery("list:idpProviders", listIdpProviders);
  const [idpProviders, setIdpProviders] = useState<IdpProvider[]>([]);
  const [idpShowForm, setIdpShowForm] = useState(false);
  const [idpNewType, setIdpNewType] = useState<"oidc" | "saml" | "ldap">("oidc");
  const [idpNewName, setIdpNewName] = useState("");
  const [idpNewIssuerUrl, setIdpNewIssuerUrl] = useState("");
  const [idpNewClientId, setIdpNewClientId] = useState("");
  const [idpNewClientSecret, setIdpNewClientSecret] = useState("");
  const [idpNewScopes, setIdpNewScopes] = useState("openid profile email");
  const [idpNewGroupsClaim, setIdpNewGroupsClaim] = useState("groups");
  const [idpNewEntryPoint, setIdpNewEntryPoint] = useState("");
  const [idpNewSamlIssuer, setIdpNewSamlIssuer] = useState("");
  const [idpNewSamlCert, setIdpNewSamlCert] = useState("");
  const [idpNewSignatureAlgorithm, setIdpNewSignatureAlgorithm] = useState<"sha256" | "sha512">("sha256");
  const [idpNewGroupsAttribute, setIdpNewGroupsAttribute] = useState("memberOf");
  const [idpNewLdapUrl, setIdpNewLdapUrl] = useState("");
  const [idpNewLdapBindDn, setIdpNewLdapBindDn] = useState("");
  const [idpNewLdapBindCredential, setIdpNewLdapBindCredential] = useState("");
  const [idpNewLdapSearchBase, setIdpNewLdapSearchBase] = useState("");
  const [idpNewLdapSearchFilter, setIdpNewLdapSearchFilter] = useState("(sAMAccountName={{username}})");
  const [idpNewLdapGroupSearchBase, setIdpNewLdapGroupSearchBase] = useState("");
  const [idpNewLdapGroupSearchFilter, setIdpNewLdapGroupSearchFilter] = useState("(member={{dn}})");
  const [idpNewLdapUseTls, setIdpNewLdapUseTls] = useState(true);
  const [idpNewLdapTlsCaPath, setIdpNewLdapTlsCaPath] = useState("");
  const [ldapTestUsername, setLdapTestUsername] = useState<Record<string, string>>({});
  const [ldapTestUserResults, setLdapTestUserResults] = useState<Record<string, { found: boolean; userDn?: string; email?: string; displayName?: string; error?: string }>>({});
  const [ldapTestingUser, setLdapTestingUser] = useState<string | null>(null);
  const [idpTesting, setIdpTesting] = useState<string | null>(null);
  const [idpTestResults, setIdpTestResults] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [idpMappings, setIdpMappings] = useState<Record<string, RoleMappingRule[]>>({});
  const [idpMappingNewGroup, setIdpMappingNewGroup] = useState("");
  const [idpMappingNewRole, setIdpMappingNewRole] = useState("");
  const [idpMappingProviderId, setIdpMappingProviderId] = useState<string | null>(null);

  // Intake state
  const { data: intakeChannelsData } = useQuery("list:intakeChannels", listIntakeChannels);
  const { data: intakeEventsData } = useQuery("list:intakeEvents", () => listIntakeEvents({ limit: 20 }), { refetchInterval: 10_000 });
  const [intakeChannels, setIntakeChannels] = useState<IntakeChannel[]>([]);
  const [intakeShowForm, setIntakeShowForm] = useState(false);
  const [intakeNewType, setIntakeNewType] = useState<"webhook" | "registry">("webhook");
  const [intakeNewName, setIntakeNewName] = useState("");
  const [intakeNewWebhookSource, setIntakeNewWebhookSource] = useState<string>("github-actions");
  const [intakeNewRegistryType, setIntakeNewRegistryType] = useState<"docker" | "npm" | "nuget">("docker");
  const [intakeNewRegistryUrl, setIntakeNewRegistryUrl] = useState("");
  const [intakeNewRegistryUsername, setIntakeNewRegistryUsername] = useState("");
  const [intakeNewRegistryPassword, setIntakeNewRegistryPassword] = useState("");
  const [intakeNewTrackedItems, setIntakeNewTrackedItems] = useState("");
  const [intakeNewPollInterval, setIntakeNewPollInterval] = useState("300000");
  const [intakeTesting, setIntakeTesting] = useState<string | null>(null);
  const [intakeTestResults, setIntakeTestResults] = useState<Record<string, { success: boolean; error?: string }>>({});
  const [intakeCreatedToken, setIntakeCreatedToken] = useState<string | null>(null);
  const [intakeEvents, setIntakeEvents] = useState<IntakeEvent[]>([]);

  // Manual upload state
  const [manualArtifactName, setManualArtifactName] = useState("");
  const [manualArtifactType, setManualArtifactType] = useState("docker");
  const [manualVersion, setManualVersion] = useState("");
  const [manualUploading, setManualUploading] = useState(false);
  const [manualUploadResult, setManualUploadResult] = useState<{ success: boolean; message: string } | null>(null);

  // ── Sync effects ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (fetchedSettings && !settings) {
      setSettings(fetchedSettings);
      if (fetchedSettings.agent?.taskModels) {
        const hasAny = Object.values(fetchedSettings.agent.taskModels).some(v => v && v.length > 0);
        if (hasAny) setUseOneModel(false);
      }
    }
  }, [fetchedSettings]);

  useEffect(() => { if (fetchedCommandInfo) setCommandInfo(fetchedCommandInfo); }, [fetchedCommandInfo]);
  useEffect(() => { if (idpData) setIdpProviders(idpData); }, [idpData]);
  useEffect(() => { if (intakeChannelsData) setIntakeChannels(intakeChannelsData); }, [intakeChannelsData]);
  useEffect(() => { if (intakeEventsData) setIntakeEvents(intakeEventsData); }, [intakeEventsData]);
  useEffect(() => { if (envoysData) setEnvoys(envoysData); }, [envoysData]);

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!settings || saving) return;
    setSaving(true);
    try {
      const updated = await updateSettings(settings);
      setSettings(updated);
      setSavedAt(new Date().toLocaleTimeString());
      await refreshGlobalSettings();
      setTimeout(() => setSavedAt(null), 3000);
    } finally {
      setSaving(false);
    }
  }

  // ── Task model helpers ────────────────────────────────────────────────────────

  function getTaskModel(task: TaskModelTask): string {
    return settings?.agent?.taskModels?.[task] ?? "";
  }

  function updateTaskModel(task: TaskModelTask, model: string) {
    if (!settings) return;
    const current = settings.agent.taskModels ?? {};
    setSettings({ ...settings, agent: { ...settings.agent, taskModels: { ...current, [task]: model || undefined } } });
  }

  function handleClearTaskModels() {
    if (!settings) return;
    setSettings({ ...settings, agent: { ...settings.agent, taskModels: undefined } });
    setUseOneModel(true);
    setVerificationResults({});
  }

  async function handleVerifyTaskModel(task: TaskModelTask) {
    const model = getTaskModel(task);
    if (!model) return;
    setVerifyingTask(task);
    try {
      const result = await verifyTaskModel(task, model);
      setVerificationResults(prev => ({ ...prev, [task]: result }));
    } catch {
      setVerificationResults(prev => ({ ...prev, [task]: { task, model, status: "insufficient" as const, explanation: "Verification request failed." } }));
    } finally {
      setVerifyingTask(null);
    }
  }

  // ── MCP helpers ───────────────────────────────────────────────────────────────

  function handleAddMcpServer() {
    if (!mcpNewName || !mcpNewUrl || !settings) return;
    const server: McpServerConfig = { name: mcpNewName, url: mcpNewUrl, ...(mcpNewDescription ? { description: mcpNewDescription } : {}) };
    setSettings({ ...settings, mcpServers: [...(settings.mcpServers ?? []), server] });
    setMcpNewName(""); setMcpNewUrl(""); setMcpNewDescription("");
  }

  function handleRemoveMcpServer(index: number) {
    if (!settings) return;
    setSettings({ ...settings, mcpServers: (settings.mcpServers ?? []).filter((_, i) => i !== index) });
  }

  // ── IdP handlers ─────────────────────────────────────────────────────────────

  async function handleAddIdpProvider() {
    if (!idpNewName) return;
    let config: Record<string, unknown>;
    if (idpNewType === "saml") {
      if (!idpNewEntryPoint || !idpNewSamlIssuer || !idpNewSamlCert) return;
      config = { entryPoint: idpNewEntryPoint, issuer: idpNewSamlIssuer, cert: idpNewSamlCert, callbackUrl: "", signatureAlgorithm: idpNewSignatureAlgorithm, groupsAttribute: idpNewGroupsAttribute || "memberOf" };
    } else if (idpNewType === "ldap") {
      if (!idpNewLdapUrl || !idpNewLdapBindDn || !idpNewLdapBindCredential || !idpNewLdapSearchBase || !idpNewLdapGroupSearchBase) return;
      config = { url: idpNewLdapUrl, bindDn: idpNewLdapBindDn, bindCredential: idpNewLdapBindCredential, searchBase: idpNewLdapSearchBase, searchFilter: idpNewLdapSearchFilter || "(sAMAccountName={{username}})", groupSearchBase: idpNewLdapGroupSearchBase, groupSearchFilter: idpNewLdapGroupSearchFilter || "(member={{dn}})", useTls: idpNewLdapUseTls, ...(idpNewLdapTlsCaPath ? { tlsCaPath: idpNewLdapTlsCaPath } : {}) };
    } else {
      if (!idpNewIssuerUrl || !idpNewClientId || !idpNewClientSecret) return;
      config = { issuerUrl: idpNewIssuerUrl, clientId: idpNewClientId, clientSecret: idpNewClientSecret, scopes: idpNewScopes.split(/\s+/).filter(Boolean), groupsClaim: idpNewGroupsClaim || "groups" };
    }
    const provider = await createIdpProvider({ type: idpNewType, name: idpNewName, enabled: true, config });
    setIdpProviders([...idpProviders, provider]);
    setIdpNewName(""); setIdpNewType("oidc"); setIdpNewIssuerUrl(""); setIdpNewClientId(""); setIdpNewClientSecret(""); setIdpNewScopes("openid profile email"); setIdpNewGroupsClaim("groups"); setIdpNewEntryPoint(""); setIdpNewSamlIssuer(""); setIdpNewSamlCert(""); setIdpNewSignatureAlgorithm("sha256"); setIdpNewGroupsAttribute("memberOf"); setIdpNewLdapUrl(""); setIdpNewLdapBindDn(""); setIdpNewLdapBindCredential(""); setIdpNewLdapSearchBase(""); setIdpNewLdapSearchFilter("(sAMAccountName={{username}})"); setIdpNewLdapGroupSearchBase(""); setIdpNewLdapGroupSearchFilter("(member={{dn}})"); setIdpNewLdapUseTls(true); setIdpNewLdapTlsCaPath("");
    setIdpShowForm(false);
  }

  async function handleTestLdapUser(providerId: string) {
    const username = ldapTestUsername[providerId];
    if (!username) return;
    setLdapTestingUser(providerId);
    try {
      const result = await testLdapUser(providerId, username);
      setLdapTestUserResults(prev => ({ ...prev, [providerId]: result }));
    } catch {
      setLdapTestUserResults(prev => ({ ...prev, [providerId]: { found: false, error: "Test request failed" } }));
    } finally {
      setLdapTestingUser(null);
    }
  }

  async function handleToggleIdpProvider(id: string, enabled: boolean) {
    const updated = await updateIdpProvider(id, { enabled });
    setIdpProviders(idpProviders.map(p => p.id === id ? updated : p));
  }

  async function handleDeleteIdpProvider(id: string) {
    await deleteIdpProvider(id);
    setIdpProviders(idpProviders.filter(p => p.id !== id));
  }

  async function handleTestIdpProvider(id: string) {
    setIdpTesting(id);
    try {
      const result = await testIdpProvider(id);
      setIdpTestResults(prev => ({ ...prev, [id]: result }));
    } catch {
      setIdpTestResults(prev => ({ ...prev, [id]: { success: false, error: "Test request failed" } }));
    } finally {
      setIdpTesting(null);
    }
  }

  async function handleLoadMappings(providerId: string) {
    if (idpMappingProviderId === providerId) { setIdpMappingProviderId(null); return; }
    const mappings = await listRoleMappings(providerId);
    setIdpMappings(prev => ({ ...prev, [providerId]: mappings }));
    setIdpMappingProviderId(providerId);
    setIdpMappingNewGroup(""); setIdpMappingNewRole("");
  }

  async function handleAddRoleMapping(providerId: string) {
    if (!idpMappingNewGroup || !idpMappingNewRole) return;
    const mapping = await createRoleMapping(providerId, { idpGroup: idpMappingNewGroup, synthRole: idpMappingNewRole });
    setIdpMappings(prev => ({ ...prev, [providerId]: [...(prev[providerId] ?? []), mapping] }));
    setIdpMappingNewGroup(""); setIdpMappingNewRole("");
  }

  async function handleDeleteRoleMapping(providerId: string, mappingId: string) {
    await deleteRoleMapping(mappingId);
    setIdpMappings(prev => ({ ...prev, [providerId]: (prev[providerId] ?? []).filter(m => m.id !== mappingId) }));
  }

  // ── Intake handlers ───────────────────────────────────────────────────────────

  async function handleAddIntakeChannel() {
    const config: Record<string, unknown> = {};
    if (intakeNewType === "webhook") {
      config.source = intakeNewWebhookSource;
    } else {
      config.type = intakeNewRegistryType;
      config.url = intakeNewRegistryUrl;
      if (intakeNewRegistryUsername) config.credentials = { username: intakeNewRegistryUsername, password: intakeNewRegistryPassword };
      const items = intakeNewTrackedItems.split(",").map(s => s.trim()).filter(Boolean);
      if (intakeNewRegistryType === "docker") config.trackedImages = items; else config.trackedPackages = items;
      config.pollIntervalMs = parseInt(intakeNewPollInterval, 10) || 300000;
    }
    const channel = await createIntakeChannel({ type: intakeNewType, name: intakeNewName, enabled: true, config });
    if (channel.authToken) setIntakeCreatedToken(channel.authToken);
    setIntakeChannels(prev => [...prev, channel]);
    setIntakeShowForm(false);
    setIntakeNewName(""); setIntakeNewWebhookSource("github-actions"); setIntakeNewRegistryType("docker"); setIntakeNewRegistryUrl(""); setIntakeNewRegistryUsername(""); setIntakeNewRegistryPassword(""); setIntakeNewTrackedItems(""); setIntakeNewPollInterval("300000");
  }

  async function handleToggleIntakeChannel(id: string, enabled: boolean) {
    const updated = await updateIntakeChannel(id, { enabled });
    setIntakeChannels(prev => prev.map(ch => ch.id === id ? updated : ch));
  }

  async function handleDeleteIntakeChannel(id: string) {
    await deleteIntakeChannel(id);
    setIntakeChannels(prev => prev.filter(ch => ch.id !== id));
  }

  async function handleTestIntakeChannel(id: string) {
    setIntakeTesting(id);
    try {
      const result = await testIntakeChannel(id);
      setIntakeTestResults(prev => ({ ...prev, [id]: result }));
    } catch (err) {
      setIntakeTestResults(prev => ({ ...prev, [id]: { success: false, error: err instanceof Error ? err.message : "Test failed" } }));
    } finally {
      setIntakeTesting(null);
    }
  }

  async function handleManualUpload() {
    if (!manualArtifactName || !manualArtifactType || !manualVersion) return;
    setManualUploading(true); setManualUploadResult(null);
    try {
      const result = await manualUploadArtifact({ artifactName: manualArtifactName, artifactType: manualArtifactType, version: manualVersion });
      setManualUploadResult({ success: true, message: `Artifact uploaded successfully (ID: ${result.artifactId})` });
      setManualArtifactName(""); setManualVersion("");
      listIntakeEvents({ limit: 20 }).then(setIntakeEvents).catch(() => {});
    } catch (err) {
      setManualUploadResult({ success: false, message: err instanceof Error ? err.message : "Upload failed" });
    } finally {
      setManualUploading(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) return <CanvasPanelHost title={title} noBreadcrumb><div className="loading">Loading...</div></CanvasPanelHost>;
  if (!settings) return <CanvasPanelHost title={title} noBreadcrumb><div className="error-msg">Failed to load settings</div></CanvasPanelHost>;

  const isIdpOrIntakeTab = settingsTab === "identity" || settingsTab === "intake";
  const mcpServers = settings.mcpServers ?? [];

  const tabs: { id: Tab; label: string }[] = [
    { id: "general", label: "General" },
    { id: "llm", label: "LLM" },
    { id: "agent", label: "Agent" },
    { id: "deploy", label: "Deploys" },
    { id: "envoy", label: "Envoy" },
    ...(canManageSettings ? [
      { id: "identity" as Tab, label: "Identity" },
      { id: "intake" as Tab, label: "Intake" },
    ] : []),
    { id: "branding", label: "Branding" },
  ];

  return (
    <CanvasPanelHost title={title} noBreadcrumb>
      {/* Page header */}
      <div style={{ padding: "0 20px", marginBottom: 20 }}>
        <h1 className="v6-page-title">Settings</h1>
        <p className="v6-page-subtitle">Instance configuration and integrations.</p>
      </div>

      {/* Tab bar */}
      <div style={{ padding: "0 20px", marginBottom: 24 }}>
        <div className="segmented-control">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`segmented-control-btn ${settingsTab === t.id ? "segmented-control-btn-active" : ""}`}
              onClick={() => setSettingsTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: "0 20px 120px", display: "flex", flexDirection: "column", gap: 14, maxWidth: 760 }}>

        {/* ════ GENERAL ════ */}
        {settingsTab === "general" && (
          <>
            <div className="card">
              <div className="card-header"><h3>Environments</h3></div>
              <SettingRow label="Environments enabled" description="When disabled, deployments target envoys directly without environment scoping." last>
                <ToggleSwitch on={settings.environmentsEnabled} onChange={() => setSettings({ ...settings, environmentsEnabled: !settings.environmentsEnabled })} />
              </SettingRow>
            </div>

            <div className="card">
              <div className="card-header"><h3>Appearance</h3></div>
              <SettingRow label="Default theme" description="Theme applied to new users. Individual users can override." last>
                <SS value={settings.defaultTheme ?? "system"} onChange={v => setSettings({ ...settings, defaultTheme: v as "dark" | "light" | "system" })} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} width={120} />
              </SettingRow>
            </div>

            {commandInfo && (
              <div className="card">
                <div className="card-header"><h3>Instance</h3></div>
                <SettingRow label="Version"><span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-muted)" }}>{commandInfo.version}</span></SettingRow>
                <SettingRow label="Host"><span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-muted)" }}>{commandInfo.host}:{commandInfo.port}</span></SettingRow>
                <SettingRow label="Started" last><span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-muted)" }}>{new Date(commandInfo.startedAt).toUTCString()}</span></SettingRow>
              </div>
            )}
          </>
        )}

        {/* ════ LLM ════ */}
        {settingsTab === "llm" && (
          <>
            <div className="card">
              <div className="card-header">
                <h3>Primary Provider</h3>
                {settings.llm?.apiKeyConfigured && <Pill text="Connected" success />}
              </div>
              <SettingRow label="Provider">
                <SS
                  value={settings.llm?.provider ?? "claude"}
                  onChange={v => setSettings({ ...settings, llm: { ...(settings.llm ?? { provider: "claude", reasoningModel: "", classificationModel: "", timeoutMs: 30000, rateLimitPerMin: 60, apiKeyConfigured: false }), provider: v as LlmProvider } })}
                  options={[
                    { value: "claude", label: "Anthropic Claude" },
                    { value: "openai", label: "OpenAI" },
                    { value: "gemini", label: "Google Gemini" },
                    { value: "grok", label: "xAI Grok" },
                    { value: "deepseek", label: "DeepSeek" },
                    { value: "ollama", label: "Ollama (local)" },
                    { value: "custom", label: "Custom endpoint" },
                  ]}
                  width={200}
                />
              </SettingRow>
              <SettingRow label="API Key" description="Stored in SYNTH_LLM_API_KEY environment variable. Never persisted to disk.">
                {settings.llm?.apiKeyConfigured
                  ? <><span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-muted)" }}>sk-••••••••••••••••</span><Pill text="Set" success /></>
                  : <Pill text="Not set" muted />
                }
              </SettingRow>
              <SettingRow label="Reasoning model" description="Plan generation, diagnostics, and complex decisions.">
                <SI value={settings.llm?.reasoningModel ?? ""} onChange={v => setSettings({ ...settings, llm: { ...(settings.llm ?? { provider: "claude", reasoningModel: "", classificationModel: "", timeoutMs: 30000, rateLimitPerMin: 60, apiKeyConfigured: false }), reasoningModel: v } })} placeholder="e.g. claude-sonnet-4-5" width={260} />
              </SettingRow>
              <SettingRow label="Classification model" description="Log classification and lightweight pattern matching.">
                <SI value={settings.llm?.classificationModel ?? ""} onChange={v => setSettings({ ...settings, llm: { ...(settings.llm ?? { provider: "claude", reasoningModel: "", classificationModel: "", timeoutMs: 30000, rateLimitPerMin: 60, apiKeyConfigured: false }), classificationModel: v } })} placeholder="e.g. claude-haiku-4-5" width={260} />
              </SettingRow>
              <SettingRow label="Timeout">
                <SI value={String(settings.llm?.timeoutMs ?? 30000)} onChange={v => setSettings({ ...settings, llm: { ...(settings.llm ?? { provider: "claude", reasoningModel: "", classificationModel: "", timeoutMs: 30000, rateLimitPerMin: 60, apiKeyConfigured: false }), timeoutMs: Number(v) } })} type="number" width={90} />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ms</span>
              </SettingRow>
              <SettingRow label="Rate limit" last>
                <SI value={String(settings.llm?.rateLimitPerMin ?? 60)} onChange={v => setSettings({ ...settings, llm: { ...(settings.llm ?? { provider: "claude", reasoningModel: "", classificationModel: "", timeoutMs: 30000, rateLimitPerMin: 60, apiKeyConfigured: false }), rateLimitPerMin: Number(v) } })} type="number" width={70} />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>req/min</span>
              </SettingRow>
            </div>

            <div className="card">
              <div className="card-header">
                <h3>Task Model Overrides</h3>
                <Pill text="Optional" muted />
              </div>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px 0", lineHeight: 1.5 }}>
                Override which model handles specific tasks. Leave blank to use the primary provider models above.
              </p>
              <SettingRow label="Use one model for all tasks" last={useOneModel}>
                <ToggleSwitch on={useOneModel} onChange={() => { if (!useOneModel) { handleClearTaskModels(); } else { setUseOneModel(false); } }} />
              </SettingRow>
              {!useOneModel && (["logClassification", "diagnosticSynthesis", "postmortemGeneration", "queryAnswering"] as TaskModelTask[]).map((task, i, arr) => {
                const meta = TASK_MODEL_META[task];
                const result = verificationResults[task];
                return (
                  <SettingRow key={task} label={meta.label} description={`${meta.tier} · ${meta.tokenBudget}`} last={i === arr.length - 1}>
                    <SI value={getTaskModel(task)} onChange={v => updateTaskModel(task, v)} placeholder="Use default" width={220} />
                    <button className="btn" onClick={() => handleVerifyTaskModel(task)} disabled={!getTaskModel(task) || verifyingTask === task} style={{ padding: "4px 10px", fontSize: 11 }}>
                      {verifyingTask === task ? "…" : "Test"}
                    </button>
                    {result && (
                      <span className={`status-badge status-${result.status === "verified" ? "succeeded" : result.status === "marginal" ? "pending" : "failed"}`} title={result.explanation}>
                        {result.status}
                      </span>
                    )}
                  </SettingRow>
                );
              })}
            </div>
          </>
        )}

        {/* ════ AGENT ════ */}
        {settingsTab === "agent" && (
          <>
            <div className="card">
              <div className="card-header"><h3>Conflict Resolution</h3></div>
              <SettingRow label="Variable conflict policy" description="Strict: halt on any cross-environment variable conflict. Permissive: proceed and log a warning in the Debrief." last>
                <SS value={settings.agent.conflictPolicy} onChange={v => setSettings({ ...settings, agent: { ...settings.agent, conflictPolicy: v as ConflictPolicy } })} options={[{ value: "strict", label: "Strict" }, { value: "permissive", label: "Permissive" }]} width={140} />
              </SettingRow>
            </div>

            <div className="card">
              <div className="card-header"><h3>Verification</h3></div>
              <SettingRow label="Default verification strategy" description="How Synth verifies deployments after execution." last>
                <SS value={settings.agent.defaultVerificationStrategy} onChange={v => setSettings({ ...settings, agent: { ...settings.agent, defaultVerificationStrategy: v as "basic" | "full" | "none" } })} options={[{ value: "full", label: "Full" }, { value: "basic", label: "Basic" }, { value: "none", label: "None" }]} width={110} />
              </SettingRow>
            </div>

            <div className="card">
              <div className="card-header"><h3>Privacy</h3></div>
              <SettingRow label="LLM entity exposure" description="'names' sends real envoy and partition names to the LLM. 'none' uses anonymized references." last>
                <SS value={settings.agent.llmEntityExposure ?? "names"} onChange={v => setSettings({ ...settings, agent: { ...settings.agent, llmEntityExposure: v as "names" | "none" } })} options={[{ value: "names", label: "Names" }, { value: "none", label: "None" }]} width={110} />
              </SettingRow>
            </div>

            <div className="card">
              <div className="card-header"><h3>External MCP Servers</h3></div>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 8px 0", lineHeight: 1.5 }}>
                Connect to external MCP servers for pre-deployment intelligence. Unreachable servers are skipped gracefully.
              </p>
              {mcpServers.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {mcpServers.map((server, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{server.name}</div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{server.url}</div>
                        {server.description && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{server.description}</div>}
                      </div>
                      <button className="btn" onClick={() => handleRemoveMcpServer(i)} style={{ padding: "4px 10px", fontSize: 11 }}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <SI value={mcpNewName} onChange={setMcpNewName} placeholder="Server name (e.g. datadog-monitor)" width={320} />
                <SI value={mcpNewUrl} onChange={setMcpNewUrl} placeholder="http://localhost:4000/mcp" width={320} />
                <SI value={mcpNewDescription} onChange={setMcpNewDescription} placeholder="Description (optional)" mono={false} width={320} />
                <div>
                  <button className="btn" onClick={handleAddMcpServer} disabled={!mcpNewName || !mcpNewUrl}>+ Add Server</button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ════ DEPLOYS ════ */}
        {settingsTab === "deploy" && (
          <>
            <div className="card">
              <div className="card-header"><h3>Health Checks</h3></div>
              <SettingRow label="Enabled" description="Run health verification after each deployment step.">
                <ToggleSwitch on={settings.deploymentDefaults.defaultHealthCheckEnabled} onChange={() => setSettings({ ...settings, deploymentDefaults: { ...settings.deploymentDefaults, defaultHealthCheckEnabled: !settings.deploymentDefaults.defaultHealthCheckEnabled } })} />
              </SettingRow>
              <SettingRow label="Retries" description="Retry attempts before marking a health check as failed." last>
                <SI value={String(settings.deploymentDefaults.defaultHealthCheckRetries)} onChange={v => setSettings({ ...settings, deploymentDefaults: { ...settings.deploymentDefaults, defaultHealthCheckRetries: Number(v) } })} type="number" width={70} />
              </SettingRow>
            </div>

            <div className="card">
              <div className="card-header"><h3>Timeouts</h3></div>
              <SettingRow label="Step timeout" description="Maximum execution time for a single deployment step." last>
                <SI value={String(settings.deploymentDefaults.defaultTimeoutMs)} onChange={v => setSettings({ ...settings, deploymentDefaults: { ...settings.deploymentDefaults, defaultTimeoutMs: Number(v) } })} type="number" width={90} />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ms</span>
              </SettingRow>
            </div>

            <div className="card">
              <div className="card-header"><h3>Verification</h3></div>
              <SettingRow label="Post-deploy verification" description="Full runs all checks. Basic checks health only. None skips." last>
                <SS value={settings.deploymentDefaults.defaultVerificationStrategy} onChange={v => setSettings({ ...settings, deploymentDefaults: { ...settings.deploymentDefaults, defaultVerificationStrategy: v as "basic" | "full" | "none" } })} options={[{ value: "full", label: "Full" }, { value: "basic", label: "Basic" }, { value: "none", label: "None" }]} width={110} />
              </SettingRow>
            </div>
          </>
        )}

        {/* ════ ENVOY ════ */}
        {settingsTab === "envoy" && (
          <>
            <div className="card">
              <div className="card-header"><h3>Server Endpoint</h3></div>
              <SettingRow label="URL" description="The URL envoys use to reach this Synth instance.">
                <SI value={settings.envoy.url} onChange={v => setSettings({ ...settings, envoy: { ...settings.envoy, url: v } })} placeholder="https://synth.internal:3000" width={280} />
              </SettingRow>
              <SettingRow label="Connection timeout" description="How long to wait for an envoy health probe response." last>
                <SI value={String(settings.envoy.timeoutMs)} onChange={v => setSettings({ ...settings, envoy: { ...settings.envoy, timeoutMs: Number(v) } })} type="number" width={90} />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ms</span>
              </SettingRow>
            </div>

            <SubLabel>Registered Envoys</SubLabel>
            <div className="card">
              {envoys.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 0" }}>No envoys registered.</div>
              ) : (
                envoys.map((e, i) => (
                  <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: i < envoys.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: e.health === "OK" ? "var(--accent)" : e.health === "Degraded" ? "var(--signal-warning, orange)" : "var(--text-muted)" }} />
                    <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)", flex: 1, color: "var(--text)" }}>{e.hostname ?? e.id}</span>
                    <span className={`status-badge status-${e.health === "OK" ? "succeeded" : e.health === "Degraded" ? "pending" : "failed"}`} style={{ fontSize: 11 }}>{e.health}</span>
                    {e.lastSeen && <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", minWidth: 60, textAlign: "right" }}>{e.lastSeen}</span>}
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* ════ IDENTITY ════ */}
        {settingsTab === "identity" && canManageSettings && (
          <>
            <div className="card">
              <div className="card-header">
                <h3>Identity Providers</h3>
                {idpProviders.length > 0 && <Pill text={`${idpProviders.filter(p => p.enabled).length} active`} success />}
              </div>
              {idpProviders.map(provider => {
                const testResult = idpTestResults[provider.id];
                return (
                  <div key={provider.id} style={{ padding: "14px 16px", borderRadius: 8, background: "var(--surface-alt)", border: "1px solid var(--border)", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: provider.enabled ? "var(--accent)" : "var(--text-muted)" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{provider.name}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                          {provider.type.toUpperCase()} — {provider.type === "saml" ? (provider.config.entryPoint as string) || "No entry point" : provider.type === "ldap" ? (provider.config.url as string) || "No LDAP URL" : (provider.config.issuerUrl as string) || "No issuer URL"}
                        </div>
                      </div>
                      <ToggleSwitch on={provider.enabled} onChange={() => handleToggleIdpProvider(provider.id, !provider.enabled)} />
                      <button className="btn" onClick={() => handleTestIdpProvider(provider.id)} disabled={idpTesting === provider.id} style={{ padding: "4px 10px", fontSize: 11 }}>{idpTesting === provider.id ? "…" : "Test"}</button>
                      {provider.type === "saml" && <a href={`/api/auth/saml/${provider.id}/metadata`} target="_blank" rel="noopener noreferrer" className="btn" style={{ padding: "4px 10px", fontSize: 11, textDecoration: "none" }}>SP Metadata</a>}
                      <button className="btn" onClick={() => handleLoadMappings(provider.id)} style={{ padding: "4px 10px", fontSize: 11 }}>{idpMappingProviderId === provider.id ? "Hide Mappings" : "Mappings"}</button>
                      <button className="btn" onClick={() => handleDeleteIdpProvider(provider.id)} style={{ padding: "4px 10px", fontSize: 11 }}>Remove</button>
                    </div>
                    {testResult && (
                      <div style={{ marginTop: 8 }}>
                        <span className={`status-badge status-${testResult.success ? "succeeded" : "failed"}`}>{testResult.success ? "Connection successful" : `Failed: ${testResult.error}`}</span>
                      </div>
                    )}
                    {provider.type === "ldap" && (
                      <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <SI value={ldapTestUsername[provider.id] ?? ""} onChange={v => setLdapTestUsername(prev => ({ ...prev, [provider.id]: v }))} placeholder="Test username (e.g. jdoe)" width={200} />
                        <button className="btn" onClick={() => handleTestLdapUser(provider.id)} disabled={!ldapTestUsername[provider.id] || ldapTestingUser === provider.id} style={{ padding: "4px 10px", fontSize: 11 }}>{ldapTestingUser === provider.id ? "…" : "Test User"}</button>
                        {ldapTestUserResults[provider.id] && (
                          <span className={`status-badge status-${ldapTestUserResults[provider.id].found ? "succeeded" : "failed"}`}>
                            {ldapTestUserResults[provider.id].found ? `Found: ${ldapTestUserResults[provider.id].displayName ?? "unknown"} (${ldapTestUserResults[provider.id].email ?? "no email"})` : `Not found: ${ldapTestUserResults[provider.id].error}`}
                          </span>
                        )}
                      </div>
                    )}
                    {idpMappingProviderId === provider.id && (
                      <div style={{ marginTop: 12, paddingLeft: 16, borderLeft: "2px solid var(--border)" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 8 }}>Role Mappings</div>
                        {(idpMappings[provider.id] ?? []).length > 0 && (
                          <div style={{ borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)", marginBottom: 8 }}>
                            <div style={{ display: "flex", padding: "7px 12px", background: "var(--surface-alt)", borderBottom: "1px solid var(--border)" }}>
                              <span style={{ flex: 1, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1 }}>IdP Group</span>
                              <span style={{ flex: 1, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1 }}>Synth Role</span>
                              <span style={{ width: 60 }} />
                            </div>
                            {(idpMappings[provider.id] ?? []).map(mapping => (
                              <div key={mapping.id} style={{ display: "flex", alignItems: "center", padding: "9px 12px", borderBottom: "1px solid var(--border)" }}>
                                <span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)" }}>{mapping.idpGroup}</span>
                                <span style={{ flex: 1, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 500 }}>{mapping.synthRole}</span>
                                <button className="btn" onClick={() => handleDeleteRoleMapping(provider.id, mapping.id)} style={{ padding: "2px 8px", fontSize: 11 }}>✕</button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <SI value={idpMappingNewGroup} onChange={setIdpMappingNewGroup} placeholder="IdP Group" width={180} />
                          <SI value={idpMappingNewRole} onChange={setIdpMappingNewRole} placeholder="Synth Role" width={140} />
                          <button className="btn btn-primary" onClick={() => handleAddRoleMapping(provider.id)} disabled={!idpMappingNewGroup || !idpMappingNewRole} style={{ padding: "6px 12px", fontSize: 11 }}>+ Add</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {idpShowForm ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px", background: "var(--surface-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <SS value={idpNewType} onChange={v => setIdpNewType(v as "oidc" | "saml" | "ldap")} options={[{ value: "oidc", label: "OIDC (OpenID Connect)" }, { value: "saml", label: "SAML 2.0" }, { value: "ldap", label: "LDAP / Active Directory" }]} width={220} />
                    <SI value={idpNewName} onChange={setIdpNewName} placeholder="Provider name (e.g. Okta, Azure AD)" width={240} />
                  </div>
                  {idpNewType === "oidc" && (
                    <>
                      <SI value={idpNewIssuerUrl} onChange={setIdpNewIssuerUrl} placeholder="Issuer URL (https://login.example.com)" width={400} />
                      <div style={{ display: "flex", gap: 8 }}>
                        <SI value={idpNewClientId} onChange={setIdpNewClientId} placeholder="Client ID" width={200} />
                        <SI value={idpNewClientSecret} onChange={setIdpNewClientSecret} placeholder="Client Secret" type="password" width={200} />
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <SI value={idpNewScopes} onChange={setIdpNewScopes} placeholder="Scopes (openid profile email)" width={240} />
                        <SI value={idpNewGroupsClaim} onChange={setIdpNewGroupsClaim} placeholder="Groups claim (groups)" width={160} />
                      </div>
                    </>
                  )}
                  {idpNewType === "saml" && (
                    <>
                      <SI value={idpNewEntryPoint} onChange={setIdpNewEntryPoint} placeholder="Entry Point URL (https://idp.example.com/sso/saml)" width={400} />
                      <SI value={idpNewSamlIssuer} onChange={setIdpNewSamlIssuer} placeholder="Issuer / Entity ID" width={400} />
                      <textarea value={idpNewSamlCert} onChange={e => setIdpNewSamlCert(e.target.value)} placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"} rows={5} style={{ ...INPUT_STYLE, width: "100%", resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 12 }} />
                      <div style={{ display: "flex", gap: 8 }}>
                        <SS value={idpNewSignatureAlgorithm} onChange={v => setIdpNewSignatureAlgorithm(v as "sha256" | "sha512")} options={[{ value: "sha256", label: "SHA-256" }, { value: "sha512", label: "SHA-512" }]} width={130} />
                        <SI value={idpNewGroupsAttribute} onChange={setIdpNewGroupsAttribute} placeholder="Groups attribute (memberOf)" width={200} />
                      </div>
                    </>
                  )}
                  {idpNewType === "ldap" && (
                    <>
                      <SI value={idpNewLdapUrl} onChange={setIdpNewLdapUrl} placeholder="ldaps://dc.corp.example.com:636" width={400} />
                      <SI value={idpNewLdapBindDn} onChange={setIdpNewLdapBindDn} placeholder="Bind DN (cn=svc-synth,ou=ServiceAccounts,dc=corp,dc=example,dc=com)" width={400} />
                      <SI value={idpNewLdapBindCredential} onChange={setIdpNewLdapBindCredential} placeholder="Bind Credential" type="password" width={300} />
                      <SI value={idpNewLdapSearchBase} onChange={setIdpNewLdapSearchBase} placeholder="Search Base (ou=Users,dc=corp,dc=example,dc=com)" width={400} />
                      <SI value={idpNewLdapSearchFilter} onChange={setIdpNewLdapSearchFilter} placeholder="Search Filter" width={400} />
                      <SI value={idpNewLdapGroupSearchBase} onChange={setIdpNewLdapGroupSearchBase} placeholder="Group Search Base (ou=Groups,...)" width={400} />
                      <SI value={idpNewLdapGroupSearchFilter} onChange={setIdpNewLdapGroupSearchFilter} placeholder="Group Search Filter" width={400} />
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <ToggleSwitch on={idpNewLdapUseTls} onChange={() => setIdpNewLdapUseTls(v => !v)} />
                        <span style={{ fontSize: 13 }}>Use TLS</span>
                        <SI value={idpNewLdapTlsCaPath} onChange={setIdpNewLdapTlsCaPath} placeholder="TLS CA path (optional)" width={260} />
                      </div>
                    </>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button className="btn btn-primary" onClick={handleAddIdpProvider} disabled={!idpNewName || (idpNewType === "oidc" ? (!idpNewIssuerUrl || !idpNewClientId || !idpNewClientSecret) : idpNewType === "saml" ? (!idpNewEntryPoint || !idpNewSamlIssuer || !idpNewSamlCert) : (!idpNewLdapUrl || !idpNewLdapBindDn || !idpNewLdapBindCredential || !idpNewLdapSearchBase || !idpNewLdapGroupSearchBase))}>Add Provider</button>
                    <button className="btn" onClick={() => setIdpShowForm(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="btn" onClick={() => setIdpShowForm(true)} style={{ marginTop: 4 }}>+ Add Provider</button>
              )}
            </div>
          </>
        )}

        {/* ════ INTAKE ════ */}
        {settingsTab === "intake" && canManageSettings && (
          <>
            <div className="card">
              <div className="card-header">
                <h3>Intake Channels</h3>
                {intakeChannels.filter(c => c.enabled).length > 0 && <Pill text={`${intakeChannels.filter(c => c.enabled).length} active`} success />}
              </div>

              {intakeCreatedToken && (
                <div style={{ padding: 12, marginBottom: 12, background: "var(--accent-dim)", border: "1px solid var(--accent-border)", borderRadius: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Channel Auth Token (shown once)</div>
                  <code style={{ display: "block", padding: "6px 10px", background: "var(--bg)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 12, wordBreak: "break-all" }}>{intakeCreatedToken}</code>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>Use as query parameter <code>?token=…</code> or header <code>X-Intake-Token</code>.</div>
                  <button className="btn" onClick={() => setIntakeCreatedToken(null)} style={{ marginTop: 8, padding: "4px 10px", fontSize: 11 }}>Dismiss</button>
                </div>
              )}

              {intakeChannels.map(channel => {
                const testResult = intakeTestResults[channel.id];
                const webhookUrl = channel.type === "webhook" ? `${window.location.origin}/api/intake/webhook/${channel.id}` : null;
                return (
                  <div key={channel.id} style={{ padding: "14px 16px", borderRadius: 8, background: "var(--surface-alt)", border: "1px solid var(--border)", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: channel.enabled ? "var(--accent)" : "var(--text-muted)" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{channel.name}</span>
                          <Pill text={channel.type} muted />
                        </div>
                        {webhookUrl && <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2, wordBreak: "break-all" }}>{webhookUrl}</div>}
                        {channel.type === "registry" && <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{(channel.config.type as string || "").toUpperCase()} — {channel.config.url as string || ""}</div>}
                      </div>
                      <ToggleSwitch on={channel.enabled} onChange={() => handleToggleIntakeChannel(channel.id, !channel.enabled)} />
                      {channel.type === "registry" && <button className="btn" onClick={() => handleTestIntakeChannel(channel.id)} disabled={intakeTesting === channel.id} style={{ padding: "4px 10px", fontSize: 11 }}>{intakeTesting === channel.id ? "…" : "Test"}</button>}
                      <button className="btn" onClick={() => handleDeleteIntakeChannel(channel.id)} style={{ padding: "4px 10px", fontSize: 11 }}>Remove</button>
                    </div>
                    {testResult && (
                      <div style={{ marginTop: 8 }}>
                        <span className={`status-badge status-${testResult.success ? "succeeded" : "failed"}`}>{testResult.success ? "Connection successful" : `Failed: ${testResult.error}`}</span>
                      </div>
                    )}
                  </div>
                );
              })}

              {intakeShowForm ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px", background: "var(--surface-alt)", borderRadius: 8, border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <SS value={intakeNewType} onChange={v => setIntakeNewType(v as "webhook" | "registry")} options={[{ value: "webhook", label: "Webhook (CI/CD)" }, { value: "registry", label: "Registry Poll" }]} width={180} />
                    <SI value={intakeNewName} onChange={setIntakeNewName} placeholder="Channel name" width={200} mono={false} />
                  </div>
                  {intakeNewType === "webhook" && (
                    <SS value={intakeNewWebhookSource} onChange={setIntakeNewWebhookSource} options={[{ value: "github-actions", label: "GitHub Actions" }, { value: "azure-devops", label: "Azure DevOps" }, { value: "jenkins", label: "Jenkins" }, { value: "gitlab-ci", label: "GitLab CI" }, { value: "circleci", label: "CircleCI" }, { value: "generic", label: "Generic" }]} width={200} />
                  )}
                  {intakeNewType === "registry" && (
                    <>
                      <SS value={intakeNewRegistryType} onChange={v => setIntakeNewRegistryType(v as "docker" | "npm" | "nuget")} options={[{ value: "docker", label: "Docker Registry" }, { value: "npm", label: "npm Registry" }, { value: "nuget", label: "NuGet Feed" }]} width={200} />
                      <SI value={intakeNewRegistryUrl} onChange={setIntakeNewRegistryUrl} placeholder="Registry URL" width={360} />
                      <div style={{ display: "flex", gap: 8 }}>
                        <SI value={intakeNewRegistryUsername} onChange={setIntakeNewRegistryUsername} placeholder="Username (optional)" width={180} mono={false} />
                        <SI value={intakeNewRegistryPassword} onChange={setIntakeNewRegistryPassword} placeholder="Password (optional)" type="password" width={180} />
                      </div>
                      <SI value={intakeNewTrackedItems} onChange={setIntakeNewTrackedItems} placeholder={intakeNewRegistryType === "docker" ? "myapp, myorg/api-service" : "@myorg/package, another-pkg"} width={400} mono={false} />
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <SI value={intakeNewPollInterval} onChange={setIntakeNewPollInterval} placeholder="300000" type="number" width={110} />
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ms poll interval</span>
                      </div>
                    </>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button className="btn btn-primary" onClick={handleAddIntakeChannel} disabled={!intakeNewName || (intakeNewType === "registry" && !intakeNewRegistryUrl)}>Add Channel</button>
                    <button className="btn" onClick={() => setIntakeShowForm(false)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="btn" onClick={() => setIntakeShowForm(true)} style={{ marginTop: 4 }}>+ Add Channel</button>
              )}
            </div>

            {/* Manual Upload */}
            <div className="card">
              <div className="card-header"><h3>Manual Upload</h3></div>
              <SettingRow label="Artifact name">
                <SI value={manualArtifactName} onChange={setManualArtifactName} placeholder="e.g. my-api-service" width={220} mono={false} />
              </SettingRow>
              <SettingRow label="Type">
                <SS value={manualArtifactType} onChange={setManualArtifactType} options={[{ value: "docker", label: "Docker" }, { value: "npm", label: "npm" }, { value: "nuget", label: "NuGet" }, { value: "helm", label: "Helm" }, { value: "generic", label: "Generic" }]} width={130} />
              </SettingRow>
              <SettingRow label="Version" last>
                <SI value={manualVersion} onChange={setManualVersion} placeholder="e.g. 1.2.3" width={140} />
              </SettingRow>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
                <button className="btn btn-primary" onClick={handleManualUpload} disabled={!manualArtifactName || !manualVersion || manualUploading}>{manualUploading ? "Uploading…" : "Upload Artifact"}</button>
                {manualUploadResult && <span className={`status-badge status-${manualUploadResult.success ? "succeeded" : "failed"}`}>{manualUploadResult.message}</span>}
              </div>
            </div>

            {/* Recent Events */}
            <SubLabel>Recent Events</SubLabel>
            <div className="card">
              {intakeEvents.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "8px 0" }}>No intake events yet.</div>
              ) : (
                intakeEvents.map((event, i) => {
                  const statusClass = event.status === "completed" ? "succeeded" : event.status === "processing" ? "running" : event.status === "failed" ? "failed" : "pending";
                  const artifactName = (event.payload?.artifactName as string) ?? "Unknown artifact";
                  return (
                    <div key={event.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: i < intakeEvents.length - 1 ? "1px solid var(--border)" : "none" }}>
                      <div style={{ flex: 1 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{artifactName}</span>
                        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginLeft: 8 }}>{(event.payload?.version as string) ?? ""}</span>
                      </div>
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{event.channelId}</span>
                      <span className={`status-badge status-${statusClass}`}>{event.status}</span>
                      {event.createdAt && <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", minWidth: 60, textAlign: "right" }}>{new Date(event.createdAt).toLocaleTimeString()}</span>}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* ════ BRANDING ════ */}
        {settingsTab === "branding" && (
          <>
            <div className="card">
              <div className="card-header">
                <h3>Co-Branding</h3>
                <Pill text="Optional" muted />
              </div>
              <SettingRow label="Operator name" description="Your organization name. Shown on the login page and footer.">
                <SI value={settings.coBranding?.operatorName ?? ""} onChange={v => setSettings({ ...settings, coBranding: { ...(settings.coBranding ?? { operatorName: "", logoUrl: "" }), operatorName: v } })} placeholder="Acme Corp" width={220} mono={false} />
              </SettingRow>
              <SettingRow label="Logo URL" description="Displayed alongside the Synth mark in the header.">
                <SI value={settings.coBranding?.logoUrl ?? ""} onChange={v => setSettings({ ...settings, coBranding: { ...(settings.coBranding ?? { operatorName: "", logoUrl: "" }), logoUrl: v } })} placeholder="https://cdn.example.com/logo.svg" width={260} />
              </SettingRow>
              <SettingRow label="Accent color" description="Override the default accent. CSS hex color." last>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {settings.coBranding?.accentColor && <div style={{ width: 26, height: 26, borderRadius: 5, background: settings.coBranding.accentColor, border: "1px solid var(--border)", flexShrink: 0 }} />}
                  <SI value={settings.coBranding?.accentColor ?? ""} onChange={v => setSettings({ ...settings, coBranding: { ...(settings.coBranding ?? { operatorName: "", logoUrl: "" }), accentColor: v || undefined } })} placeholder="#2d5bf0" width={110} />
                </div>
              </SettingRow>
            </div>

            {settings.coBranding?.operatorName && (
              <>
                <SubLabel>Preview</SubLabel>
                <div className="card">
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
                    <span style={{ fontSize: 18, fontWeight: 600, color: "var(--text)" }}>Synth</span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>×</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{settings.coBranding.operatorName}</span>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>This is how the co-branded header will appear on the login page and navigation.</p>
                </div>
              </>
            )}
          </>
        )}

      </div>

      {/* ── Save bar ─────────────────────────────────────────────────────────────── */}
      <div style={{
        position: "sticky", bottom: 0, zIndex: 10,
        margin: "0 20px 20px",
        padding: "14px 20px",
        borderRadius: 10,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {isIdpOrIntakeTab ? "Identity and intake changes apply immediately." : "Changes are not saved until you click Save."}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {savedAt && <span style={{ fontSize: 12, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>Saved at {savedAt}</span>}
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || isIdpOrIntakeTab}
            style={{ opacity: isIdpOrIntakeTab ? 0.4 : 1 }}
          >
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </CanvasPanelHost>
  );
}
