import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "../../context/AuthContext.js";
import CanvasPanelHost from "./CanvasPanelHost.js";
import {
  authUpdateMe,
  authChangePassword,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  regenerateApiKey,
} from "../../api.js";
import type { ApiKeyPublic, SessionPublic } from "../../api.js";

function parseUA(ua: string | null | undefined): string {
  if (!ua) return "Browser session";
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera\//.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  else if (/synth-cli/i.test(ua)) browser = "Synth CLI";
  else if (/curl\//.test(ua)) browser = "curl";

  let os = "";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/iPhone|iPad/.test(ua)) os = "iOS";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Linux/.test(ua)) os = "Linux";

  return os ? `${browser} · ${os}` : browser;
}

interface Props {
  title: string;
}

// ─── Shared sub-components ─────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5,
      color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 10, marginTop: 28,
    }}>
      {children}
    </div>
  );
}

interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  last?: boolean;
}

function SettingRow({ label, description, children, last }: SettingRowProps) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24,
      padding: "14px 0", borderBottom: last ? "none" : "1px solid var(--border)",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{label}</div>
        {description && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.45 }}>{description}</div>
        )}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>{children}</div>
    </div>
  );
}

interface ToggleSwitchProps {
  on: boolean;
  onChange: (val: boolean) => void;
}

function ToggleSwitch({ on, onChange }: ToggleSwitchProps) {
  return (
    <div
      onClick={() => onChange(!on)}
      style={{
        width: 38, height: 22, borderRadius: 11, border: "1px solid var(--border)",
        background: on ? "var(--accent-dim)" : "var(--surface-alt)",
        cursor: "pointer", position: "relative", transition: "all 0.2s",
        flexShrink: 0,
      }}
    >
      <div style={{
        width: 16, height: 16, borderRadius: "50%",
        background: on ? "var(--accent)" : "var(--text-muted)",
        position: "absolute", top: 2, left: on ? 19 : 2, transition: "left 0.2s",
      }} />
    </div>
  );
}

interface PillProps {
  text: string;
  color?: string;
}

function Pill({ text, color }: PillProps) {
  const c = color ?? "var(--accent)";
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
      fontFamily: "var(--font-mono)", textTransform: "uppercase",
      color: c,
      background: `color-mix(in srgb, ${c} 10%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 28%, transparent)`,
    }}>
      {text}
    </span>
  );
}

interface CardProps {
  title?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}

function Card({ title, badge, children }: CardProps) {
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 10, padding: "20px 22px", marginBottom: 14, transition: "background 0.3s",
    }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: 0 }}>{title}</h3>
          {badge}
        </div>
      )}
      {children}
    </div>
  );
}

interface SelectInputProps {
  value: string;
  options: string[];
  width?: number;
  onChange: (val: string) => void;
}

function SelectInput({ value, options, width, onChange }: SelectInputProps) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width: width ?? 160, padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)",
        background: "var(--surface-alt)", color: "var(--text)", fontSize: 13,
        fontFamily: "var(--font-mono)", boxSizing: "border-box", transition: "all 0.3s", appearance: "auto",
      }}
    >
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

// ─── Preferences state ─────────────────────────────────────────────────────

interface UserPrefs {
  theme: "dark" | "light" | "system";
  compactTables: boolean;
  showAssessment: boolean;
  showSignals: boolean;
  recentDeploymentsCount: string;
  contextualSuggestions: boolean;
  autoExpandResponses: boolean;
  defaultDeployScope: "environment" | "envoy" | "partition";
  autoGreenlight: boolean;
  defaultTimelineView: "summary" | "full" | "collapsed";
  includeLlmReasoning: boolean;
}

interface UserNotifications {
  criticalSignals: boolean;
  warningSignals: boolean;
  infoSignals: boolean;
  deployStarted: boolean;
  deployCompleted: boolean;
  planApproval: boolean;
  rollbackExecuted: boolean;
  inApp: boolean;
  email: boolean;
}

const DEFAULT_PREFS: UserPrefs = {
  theme: "system",
  compactTables: false,
  showAssessment: true,
  showSignals: true,
  recentDeploymentsCount: "5",
  contextualSuggestions: true,
  autoExpandResponses: false,
  defaultDeployScope: "environment",
  autoGreenlight: false,
  defaultTimelineView: "summary",
  includeLlmReasoning: true,
};

const DEFAULT_NOTIFICATIONS: UserNotifications = {
  criticalSignals: true,
  warningSignals: true,
  infoSignals: false,
  deployStarted: true,
  deployCompleted: true,
  planApproval: true,
  rollbackExecuted: true,
  inApp: true,
  email: false,
};

function loadPrefs(): UserPrefs {
  try {
    const raw = localStorage.getItem("synth_user_prefs");
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PREFS };
}

function loadNotifications(): UserNotifications {
  try {
    const raw = localStorage.getItem("synth_user_notifications");
    if (raw) return { ...DEFAULT_NOTIFICATIONS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_NOTIFICATIONS };
}

function savePrefs(prefs: UserPrefs): void {
  try { localStorage.setItem("synth_user_prefs", JSON.stringify(prefs)); } catch { /* ignore */ }
}

function saveNotifications(notif: UserNotifications): void {
  try { localStorage.setItem("synth_user_notifications", JSON.stringify(notif)); } catch { /* ignore */ }
}

// ─── Relative time helper ──────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const PERM_DESCRIPTIONS: Record<string, string> = {
  "deployment.create": "Create and execute deployments",
  "deployment.approve": "Approve deployment plans",
  "deployment.reject": "Reject deployment plans",
  "deployment.view": "View deployments and plans",
  "artifact.read": "View artifact catalog",
  "artifact.write": "Create and annotate artifacts",
  "topology.read": "View topology",
  "topology.write": "Manage envoys, environments, partitions",
  "debrief.read": "View debriefs and postmortems",
  "settings.manage": "Modify instance settings",
  "users.manage": "Manage users and roles",
  "deploy:write": "Create and execute deployments",
  "deploy:read": "View deployments and plans",
  "artifact:write": "Create and annotate artifacts",
  "artifact:read": "View artifact catalog",
  "topology:write": "Manage envoys, environments, partitions",
  "topology:read": "View topology",
  "debrief:read": "View debriefs and postmortems",
  "settings:write": "Modify instance settings",
  "users:write": "Manage users and roles",
};

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─── Main component ─────────────────────────────────────────────────────────

export default function UserSettingsPanel({ title }: Props) {
  const { user, permissions, logout } = useAuth();

  const [tab, setTab] = useState<"profile" | "preferences" | "notifications" | "sessions" | "apikeys">("profile");
  const [prefs, setPrefs] = useState<UserPrefs>(() => loadPrefs());
  const [notif, setNotif] = useState<UserNotifications>(() => loadNotifications());

  // Profile state
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Password state
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const isLocal = !user?.authSource || user.authSource === "local";

  // Sessions state
  const [sessions, setSessions] = useState<SessionPublic[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKeyPublic[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyPerms, setNewKeyPerms] = useState<string[]>([]);
  const [createdFullKey, setCreatedFullKey] = useState<string | null>(null);
  const [regeneratedKey, setRegeneratedKey] = useState<{ id: string; fullKey: string } | null>(null);

  const updatePrefs = useCallback((updates: Partial<UserPrefs>) => {
    setPrefs(prev => {
      const next = { ...prev, ...updates };
      savePrefs(next);
      return next;
    });
  }, []);

  const updateNotif = useCallback((updates: Partial<UserNotifications>) => {
    setNotif(prev => {
      const next = { ...prev, ...updates };
      saveNotifications(next);
      return next;
    });
  }, []);

  // Load sessions when tab is active
  useEffect(() => {
    if (tab !== "sessions") return;
    setSessionsLoading(true);
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setSessionsLoading(false));
  }, [tab]);

  // Load API keys when tab is active
  useEffect(() => {
    if (tab !== "apikeys") return;
    setApiKeysLoading(true);
    listApiKeys()
      .then(setApiKeys)
      .catch(() => setApiKeys([]))
      .finally(() => setApiKeysLoading(false));
  }, [tab]);

  async function handleSaveProfile() {
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      await authUpdateMe({ name: name.trim(), email: email.trim() });
      setProfileMsg({ ok: true, text: "Profile saved." });
      setTimeout(() => setProfileMsg(null), 2500);
    } catch (err) {
      setProfileMsg({ ok: false, text: err instanceof Error ? err.message : "Failed to save profile" });
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleChangePassword() {
    if (newPw !== confirmPw) {
      setPwMsg({ ok: false, text: "New passwords do not match." });
      return;
    }
    if (newPw.length < 8) {
      setPwMsg({ ok: false, text: "New password must be at least 8 characters." });
      return;
    }
    setPwSaving(true);
    setPwMsg(null);
    try {
      await authChangePassword({ currentPassword: currentPw, newPassword: newPw });
      setPwMsg({ ok: true, text: "Password changed." });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      setTimeout(() => setPwMsg(null), 2500);
    } catch (err) {
      setPwMsg({ ok: false, text: err instanceof Error ? err.message : "Failed to change password" });
    } finally {
      setPwSaving(false);
    }
  }

  async function handleRevokeSession(id: string) {
    try {
      await revokeSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch { /* ignore */ }
  }

  async function handleRevokeOtherSessions() {
    try {
      await revokeOtherSessions();
      setSessions(prev => prev.filter(s => s.current));
    } catch { /* ignore */ }
  }

  async function handleCreateKey() {
    if (!newKeyName.trim()) return;
    try {
      const result = await createApiKey({ name: newKeyName.trim(), permissions: newKeyPerms });
      setApiKeys(prev => [...prev, result.key]);
      setCreatedFullKey(result.fullKey);
      setNewKeyName("");
      setNewKeyPerms([]);
      setShowCreateKey(false);
    } catch { /* ignore */ }
  }

  async function handleRevokeKey(id: string) {
    try {
      await revokeApiKey(id);
      setApiKeys(prev => prev.filter(k => k.id !== id));
    } catch { /* ignore */ }
  }

  async function handleRegenerateKey(id: string) {
    try {
      const result = await regenerateApiKey(id);
      setApiKeys(prev => prev.map(k => k.id === id ? result.key : k));
      setRegeneratedKey({ id, fullKey: result.fullKey });
    } catch { /* ignore */ }
  }

  // Profile photo state
  const [photo, setPhoto] = useState<string | null>(() => localStorage.getItem("synth_user_photo"));
  const [photoHovered, setPhotoHovered] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setPhoto(dataUrl);
      localStorage.setItem("synth_user_photo", dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  const isAdmin = permissions.includes("settings.manage") || permissions.includes("users.manage");
  const roleLabel = isAdmin ? "Admin" : "Member";
  const initials = user ? deriveInitials(user.name) : "??";

  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: "profile", label: "Profile" },
    { id: "preferences", label: "Preferences" },
    { id: "notifications", label: "Notifications" },
    { id: "sessions", label: "Sessions" },
    { id: "apikeys", label: "API Keys" },
  ];

  const DANGER = "var(--status-failed)";
  const DANGER_SOFT = "var(--status-failed-bg)";
  const DANGER_BORDER = "color-mix(in srgb, var(--status-failed) 28%, transparent)";
  const SUCCESS = "var(--status-succeeded)";

  return (
    <CanvasPanelHost title={title} noBreadcrumb>
      <div style={{ maxWidth: 780, margin: "0 auto", padding: "28px 24px 80px" }}>

        {/* Avatar + name header */}
        <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 24 }}>
          <div
            onClick={() => photoInputRef.current?.click()}
            onMouseEnter={() => setPhotoHovered(true)}
            onMouseLeave={() => setPhotoHovered(false)}
            style={{
              width: 56, height: 56, borderRadius: 12,
              background: "var(--accent-dim)", border: "2px solid var(--accent-border)",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              cursor: "pointer", position: "relative", overflow: "hidden",
            }}
          >
            {photo ? (
              <img src={photo} alt="Profile" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 10 }} />
            ) : (
              <span style={{ fontSize: 22, fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
                {initials}
              </span>
            )}
            {photoHovered && (
              <div style={{
                position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)",
                display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 10,
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
              </div>
            )}
          </div>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            onChange={handlePhotoChange}
            style={{ display: "none" }}
          />
          <div style={{ flex: 1 }}>
            <h1 style={{ fontSize: 24, fontWeight: 500, color: "var(--text)", margin: "0 0 2px 0", fontFamily: "var(--font-display)" }}>
              {user?.name ?? "—"}
            </h1>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{user?.email ?? "—"}</span>
              <Pill text={roleLabel} color="var(--accent)" />
            </div>
          </div>
          <button
            onClick={logout}
            style={{
              padding: "7px 16px", borderRadius: 6, flexShrink: 0,
              border: `1px solid ${DANGER_BORDER}`,
              background: DANGER_SOFT, color: DANGER,
              fontSize: 12, fontWeight: 600, fontFamily: "var(--font-mono)", cursor: "pointer",
            }}
          >
            Sign Out
          </button>
        </div>

        {/* Segmented control */}
        <div style={{
          display: "flex", gap: 4, padding: "3px", borderRadius: 7,
          background: "var(--surface-alt)", border: "1px solid var(--border)",
          width: "fit-content", marginBottom: 22,
        }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: "6px 14px", borderRadius: 5, border: "none", cursor: "pointer",
                background: tab === t.id ? "var(--surface)" : "transparent",
                color: tab === t.id ? "var(--text)" : "var(--text-muted)",
                fontSize: 12, fontWeight: tab === t.id ? 600 : 400,
                fontFamily: "var(--font-mono)", transition: "all 0.15s",
                boxShadow: tab === t.id ? "0 1px 3px var(--border)" : "none",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ════════ PROFILE ════════ */}
        {tab === "profile" && (
          <>
            <Card title="Personal Information">
              <SettingRow label="Full name">
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  style={{
                    width: 240, padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)",
                    background: "var(--surface-alt)", color: "var(--text)", fontSize: 13,
                    fontFamily: "var(--font)", boxSizing: "border-box",
                  }}
                />
              </SettingRow>
              <SettingRow label="Email" description="Used for login and notifications.">
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  style={{
                    width: 240, padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)",
                    background: "var(--surface-alt)", color: "var(--text)", fontSize: 13,
                    fontFamily: "var(--font-mono)", boxSizing: "border-box",
                  }}
                />
              </SettingRow>
              <SettingRow label="Role" description="Assigned by your identity provider or an admin.">
                <Pill text={roleLabel} color="var(--accent)" />
              </SettingRow>
              <SettingRow label="Member since" last>
                <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                  {user?.createdAt ? new Date(user.createdAt).toISOString().slice(0, 10) : "—"}
                </span>
              </SettingRow>
              {profileMsg && (
                <div style={{ fontSize: 12, marginTop: 8, color: profileMsg.ok ? SUCCESS : DANGER }}>
                  {profileMsg.text}
                </div>
              )}
              <div style={{ marginTop: 14 }}>
                <button
                  onClick={handleSaveProfile}
                  disabled={profileSaving}
                  style={{
                    padding: "7px 16px", borderRadius: 5, border: "1px solid var(--accent-border)",
                    background: "transparent", color: "var(--accent)", fontSize: 12,
                    fontFamily: "var(--font-mono)", fontWeight: 600, cursor: profileSaving ? "default" : "pointer",
                    opacity: profileSaving ? 0.6 : 1,
                  }}
                >
                  {profileSaving ? "Saving…" : "Save Profile"}
                </button>
              </div>
            </Card>

            {isLocal && (
              <Card title="Password">
                <SettingRow label="Current password" description="Leave blank to keep unchanged.">
                  <input
                    type="password"
                    value={currentPw}
                    onChange={e => setCurrentPw(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    style={{
                      width: 200, padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)",
                      background: "var(--surface-alt)", color: "var(--text)", fontSize: 13,
                      fontFamily: "var(--font)", boxSizing: "border-box",
                    }}
                  />
                </SettingRow>
                <SettingRow label="New password">
                  <input
                    type="password"
                    value={newPw}
                    onChange={e => setNewPw(e.target.value)}
                    placeholder="New password"
                    autoComplete="new-password"
                    style={{
                      width: 200, padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)",
                      background: "var(--surface-alt)", color: "var(--text)", fontSize: 13,
                      fontFamily: "var(--font)", boxSizing: "border-box",
                    }}
                  />
                </SettingRow>
                <SettingRow label="Confirm new password" last>
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    placeholder="Confirm"
                    autoComplete="new-password"
                    style={{
                      width: 200, padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)",
                      background: "var(--surface-alt)", color: "var(--text)", fontSize: 13,
                      fontFamily: "var(--font)", boxSizing: "border-box",
                    }}
                  />
                </SettingRow>
                {pwMsg && (
                  <div style={{ fontSize: 12, marginTop: 8, color: pwMsg.ok ? SUCCESS : DANGER }}>
                    {pwMsg.text}
                  </div>
                )}
                <div style={{ marginTop: 14 }}>
                  <button
                    onClick={handleChangePassword}
                    disabled={pwSaving || !currentPw || !newPw || !confirmPw}
                    style={{
                      padding: "7px 16px", borderRadius: 5, border: "1px solid var(--accent-border)",
                      background: "transparent", color: "var(--accent)", fontSize: 12,
                      fontFamily: "var(--font-mono)", fontWeight: 600,
                      cursor: (pwSaving || !currentPw || !newPw || !confirmPw) ? "default" : "pointer",
                      opacity: (pwSaving || !currentPw || !newPw || !confirmPw) ? 0.5 : 1,
                    }}
                  >
                    {pwSaving ? "Saving…" : "Change Password"}
                  </button>
                </div>
              </Card>
            )}

            <Card title="Authentication">
              <SettingRow label="Login method" description="How you authenticate with this Synth instance.">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Pill text={user?.authSource ?? "local"} color="var(--text-secondary)" />
                </div>
              </SettingRow>
              <SettingRow label="Last login" last>
                <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                  {user?.updatedAt ? relativeTime(user.updatedAt) : "—"}
                </span>
              </SettingRow>
            </Card>
          </>
        )}

        {/* ════════ PREFERENCES ════════ */}
        {tab === "preferences" && (
          <>
            <Card title="Appearance">
              <SettingRow label="Theme" description="Override the instance default.">
                <SelectInput
                  value={prefs.theme}
                  options={["dark", "light", "system"]}
                  width={120}
                  onChange={v => updatePrefs({ theme: v as UserPrefs["theme"] })}
                />
              </SettingRow>
              <SettingRow label="Compact tables" description="Reduce row height in deployment and debrief tables." last>
                <ToggleSwitch on={prefs.compactTables} onChange={v => updatePrefs({ compactTables: v })} />
              </SettingRow>
            </Card>

            <Card title="Home Page">
              <SettingRow label="Show Synth Assessment" description="The editorial assessment card on the home page.">
                <ToggleSwitch on={prefs.showAssessment} onChange={v => updatePrefs({ showAssessment: v })} />
              </SettingRow>
              <SettingRow label="Show signals" description="Active signals section below the assessment.">
                <ToggleSwitch on={prefs.showSignals} onChange={v => updatePrefs({ showSignals: v })} />
              </SettingRow>
              <SettingRow label="Recent deployments count" description="How many recent deployments to show on home." last>
                <SelectInput
                  value={prefs.recentDeploymentsCount}
                  options={["3", "5", "10", "20"]}
                  width={80}
                  onChange={v => updatePrefs({ recentDeploymentsCount: v })}
                />
              </SettingRow>
            </Card>

            <Card title="Ask Bar">
              <SettingRow label="Show contextual suggestions" description="Pre-populated questions based on the current page.">
                <ToggleSwitch on={prefs.contextualSuggestions} onChange={v => updatePrefs({ contextualSuggestions: v })} />
              </SettingRow>
              <SettingRow label="Auto-expand responses" description="Automatically expand the ask bar when Synth responds." last>
                <ToggleSwitch on={prefs.autoExpandResponses} onChange={v => updatePrefs({ autoExpandResponses: v })} />
              </SettingRow>
            </Card>

            <Card title="Deployments">
              <SettingRow label="Default deploy scope" description="Which scope tab is selected by default on the deploy page.">
                <SelectInput
                  value={prefs.defaultDeployScope}
                  options={["environment", "envoy", "partition"]}
                  width={140}
                  onChange={v => updatePrefs({ defaultDeployScope: v as UserPrefs["defaultDeployScope"] })}
                />
              </SettingRow>
              <SettingRow label="Auto-greenlight" description="Skip plan review for deployments to non-production environments. Not recommended." last>
                <ToggleSwitch on={prefs.autoGreenlight} onChange={v => updatePrefs({ autoGreenlight: v })} />
              </SettingRow>
            </Card>

            <Card title="Debriefs">
              <SettingRow label="Default timeline view" description="Show full timeline or summary by default.">
                <SelectInput
                  value={prefs.defaultTimelineView}
                  options={["summary", "full", "collapsed"]}
                  width={120}
                  onChange={v => updatePrefs({ defaultTimelineView: v as UserPrefs["defaultTimelineView"] })}
                />
              </SettingRow>
              <SettingRow label="Include LLM reasoning" description="Show raw LLM reasoning in debrief entries." last>
                <ToggleSwitch on={prefs.includeLlmReasoning} onChange={v => updatePrefs({ includeLlmReasoning: v })} />
              </SettingRow>
            </Card>
          </>
        )}

        {/* ════════ NOTIFICATIONS ════════ */}
        {tab === "notifications" && (
          <>
            <Card title="Signal Notifications">
              <SettingRow label="Critical signals" description="Immediate notification for critical severity signals.">
                <ToggleSwitch on={notif.criticalSignals} onChange={v => updateNotif({ criticalSignals: v })} />
              </SettingRow>
              <SettingRow label="Warning signals" description="Notification for warning severity signals.">
                <ToggleSwitch on={notif.warningSignals} onChange={v => updateNotif({ warningSignals: v })} />
              </SettingRow>
              <SettingRow label="Info signals" description="Notification for informational signals." last>
                <ToggleSwitch on={notif.infoSignals} onChange={v => updateNotif({ infoSignals: v })} />
              </SettingRow>
            </Card>

            <Card title="Deployment Notifications">
              <SettingRow label="Deploy started" description="When a deployment you initiated begins execution.">
                <ToggleSwitch on={notif.deployStarted} onChange={v => updateNotif({ deployStarted: v })} />
              </SettingRow>
              <SettingRow label="Deploy completed" description="When a deployment finishes (success or failure).">
                <ToggleSwitch on={notif.deployCompleted} onChange={v => updateNotif({ deployCompleted: v })} />
              </SettingRow>
              <SettingRow label="Plan awaiting approval" description="When a deployment plan needs your review.">
                <ToggleSwitch on={notif.planApproval} onChange={v => updateNotif({ planApproval: v })} />
              </SettingRow>
              <SettingRow label="Rollback executed" description="When an automatic rollback occurs." last>
                <ToggleSwitch on={notif.rollbackExecuted} onChange={v => updateNotif({ rollbackExecuted: v })} />
              </SettingRow>
            </Card>

            <Card title="Delivery">
              <SettingRow label="In-app" description="Browser notifications when Synth is open.">
                <ToggleSwitch on={notif.inApp} onChange={v => updateNotif({ inApp: v })} />
              </SettingRow>
              <SettingRow label="Email" description="Send notifications to your registered email.">
                <ToggleSwitch on={notif.email} onChange={v => updateNotif({ email: v })} />
              </SettingRow>
              <SettingRow label="Email address" last>
                <span style={{
                  width: 220, padding: "7px 12px", borderRadius: 6, border: "1px solid var(--border)",
                  background: "var(--surface-alt)", color: "var(--text-muted)", fontSize: 13,
                  fontFamily: "var(--font-mono)", opacity: 0.6, display: "inline-block",
                }}>
                  {user?.email ?? "—"}
                </span>
              </SettingRow>
            </Card>
          </>
        )}

        {/* ════════ SESSIONS ════════ */}
        {tab === "sessions" && (
          <>
            <Card
              title="Active Sessions"
              badge={<Pill text={`${sessions.length} active`} color={SUCCESS} />}
            >
              {sessionsLoading ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>Loading…</div>
              ) : sessions.length === 0 ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>No active sessions found.</div>
              ) : sessions.map((s, i, arr) => (
                <div
                  key={s.id}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                    padding: "13px 0",
                    borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                    <div style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: s.current ? SUCCESS : "var(--text-muted)",
                      flexShrink: 0,
                    }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                          {parseUA(s.userAgent)}
                        </span>
                        {s.current && <Pill text="Current" color={SUCCESS} />}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3, fontFamily: "var(--font-mono)" }}>
                        {s.ipAddress && <span>{s.ipAddress} · </span>}
                        Signed in {relativeTime(s.createdAt)} · expires {new Date(s.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {s.current ? "Now" : relativeTime(s.createdAt)}
                    </span>
                    {!s.current && (
                      <button
                        onClick={() => handleRevokeSession(s.id)}
                        style={{
                          padding: "4px 10px", borderRadius: 4,
                          border: `1px solid ${DANGER_BORDER}`,
                          background: DANGER_SOFT, color: DANGER,
                          fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600, cursor: "pointer",
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </Card>

            <SectionLabel>Session History</SectionLabel>
            <Card>
              <div style={{ borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", padding: "7px 14px", background: "var(--surface-alt)", borderBottom: "1px solid var(--border)", gap: 12 }}>
                  <span style={{ flex: 1, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1 }}>Session</span>
                  <span style={{ width: 140, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1 }}>Started</span>
                  <span style={{ width: 70, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1, textAlign: "right" }}>Duration</span>
                </div>
                <div style={{ padding: "14px", fontSize: 12, color: "var(--text-muted)" }}>
                  Session history is not retained.
                </div>
              </div>
            </Card>

            <div style={{ marginTop: 12 }}>
              <button
                onClick={handleRevokeOtherSessions}
                style={{
                  padding: "8px 16px", borderRadius: 6,
                  border: `1px solid ${DANGER_BORDER}`,
                  background: DANGER_SOFT, color: DANGER,
                  fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 600, cursor: "pointer",
                }}
              >
                Revoke All Other Sessions
              </button>
            </div>
          </>
        )}

        {/* ════════ API KEYS ════════ */}
        {tab === "apikeys" && (
          <>
            <Card
              title="Personal API Keys"
              badge={<Pill text={`${apiKeys.length} active`} color={SUCCESS} />}
            >
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 14px 0", lineHeight: 1.5 }}>
                API keys authenticate CLI tools and scripts against this Synth instance. Keys inherit your role permissions.
              </p>

              {/* Revealed key banners */}
              {createdFullKey && (
                <div style={{
                  padding: "12px 14px", borderRadius: 8, marginBottom: 12,
                  background: "var(--accent-dim)", border: "1px solid var(--accent-border)",
                }}>
                  <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 6, fontWeight: 600 }}>
                    New key created — copy it now. It will not be shown again.
                  </div>
                  <code style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", wordBreak: "break-all" }}>
                    {createdFullKey}
                  </code>
                  <button
                    onClick={() => setCreatedFullKey(null)}
                    style={{ marginLeft: 12, fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
              {regeneratedKey && (
                <div style={{
                  padding: "12px 14px", borderRadius: 8, marginBottom: 12,
                  background: "var(--accent-dim)", border: "1px solid var(--accent-border)",
                }}>
                  <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 6, fontWeight: 600 }}>
                    Key regenerated — copy it now. It will not be shown again.
                  </div>
                  <code style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", wordBreak: "break-all" }}>
                    {regeneratedKey.fullKey}
                  </code>
                  <button
                    onClick={() => setRegeneratedKey(null)}
                    style={{ marginLeft: 12, fontSize: 11, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {apiKeysLoading ? (
                <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>Loading…</div>
              ) : apiKeys.map(k => (
                <div
                  key={k.id}
                  style={{
                    padding: "14px 16px", borderRadius: 8,
                    background: "var(--surface-alt)", border: "1px solid var(--border)", marginBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{k.name}</span>
                      <Pill text="Active" color={SUCCESS} />
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => handleRegenerateKey(k.id)}
                        style={{
                          padding: "4px 10px", borderRadius: 4, border: "1px solid var(--border)",
                          background: "transparent", color: "var(--text-secondary)", fontSize: 11,
                          fontFamily: "var(--font-mono)", cursor: "pointer",
                        }}
                      >
                        Regenerate
                      </button>
                      <button
                        onClick={() => handleRevokeKey(k.id)}
                        style={{
                          padding: "4px 10px", borderRadius: 4,
                          border: `1px solid ${DANGER_BORDER}`,
                          background: DANGER_SOFT, color: DANGER,
                          fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600, cursor: "pointer",
                        }}
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--text-muted)" }}>
                    <span>Created: {new Date(k.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                    <span>Last used: {k.lastUsedAt ? relativeTime(k.lastUsedAt) : "Never"}</span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      synth_{k.keyPrefix}•••••••{k.keySuffix}
                    </span>
                  </div>
                  {k.permissions.length > 0 && (
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                      Permissions:{" "}
                      {k.permissions.map((p, i) => (
                        <span key={p}>
                          {i > 0 && <span style={{ margin: "0 4px" }}>·</span>}
                          <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>{p}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {/* Create key form */}
              {showCreateKey ? (
                <div style={{
                  padding: "14px 16px", borderRadius: 8,
                  border: "1px solid var(--accent-border)", background: "var(--accent-dim)", marginTop: 8,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>
                    Create API Key
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", display: "block", marginBottom: 4 }}>
                      KEY NAME
                    </label>
                    <input
                      type="text"
                      value={newKeyName}
                      onChange={e => setNewKeyName(e.target.value)}
                      placeholder="e.g. deploy-cli"
                      style={{
                        width: "100%", maxWidth: 280, padding: "7px 12px", borderRadius: 6,
                        border: "1px solid var(--border)", background: "var(--surface)",
                        color: "var(--text)", fontSize: 13, fontFamily: "var(--font)", boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", display: "block", marginBottom: 6 }}>
                      PERMISSIONS
                    </label>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {permissions.map(p => (
                        <label key={p} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={newKeyPerms.includes(p)}
                            onChange={e => setNewKeyPerms(prev =>
                              e.target.checked ? [...prev, p] : prev.filter(x => x !== p)
                            )}
                          />
                          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--accent)" }}>{p}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={handleCreateKey}
                      disabled={!newKeyName.trim()}
                      style={{
                        padding: "6px 14px", borderRadius: 5, border: "1px solid var(--accent-border)",
                        background: "var(--accent)", color: "#fff", fontSize: 12,
                        fontFamily: "var(--font-mono)", fontWeight: 600,
                        cursor: newKeyName.trim() ? "pointer" : "default",
                        opacity: newKeyName.trim() ? 1 : 0.5,
                      }}
                    >
                      Create Key
                    </button>
                    <button
                      onClick={() => { setShowCreateKey(false); setNewKeyName(""); setNewKeyPerms([]); }}
                      style={{
                        padding: "6px 14px", borderRadius: 5, border: "1px solid var(--border)",
                        background: "transparent", color: "var(--text-muted)", fontSize: 12,
                        fontFamily: "var(--font-mono)", cursor: "pointer",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowCreateKey(true)}
                  style={{
                    padding: "6px 14px", borderRadius: 5,
                    border: "1px solid var(--accent-border)", background: "transparent",
                    color: "var(--accent)", fontSize: 11,
                    fontFamily: "var(--font-mono)", fontWeight: 600, cursor: "pointer", marginTop: 4,
                  }}
                >
                  + Create API Key
                </button>
              )}
            </Card>

            <Card title="Key Permissions">
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px 0", lineHeight: 1.5 }}>
                API keys can be scoped to specific permission sets. Available permissions depend on your role.
              </p>
              <div style={{ borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                <div style={{ display: "flex", padding: "8px 14px", background: "var(--surface-alt)", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ flex: 1, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1 }}>Permission</span>
                  <span style={{ width: 80, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1, textAlign: "center" }}>Your Role</span>
                </div>
                {permissions.map((p, i) => (
                  <div
                    key={p}
                    style={{
                      display: "flex", alignItems: "center", padding: "9px 14px",
                      borderBottom: i < permissions.length - 1 ? "1px solid var(--border)" : "none",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", fontWeight: 500 }}>{p}</span>
                      {PERM_DESCRIPTIONS[p] && (
                        <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 10 }}>{PERM_DESCRIPTIONS[p]}</span>
                      )}
                    </div>
                    <div style={{ width: 80, display: "flex", justifyContent: "center" }}>
                      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: SUCCESS, strokeWidth: 2, display: "block", flexShrink: 0 }}>
                        <polyline points="2,7 5,10 11,3"/>
                      </svg>
                    </div>
                  </div>
                ))}
                {permissions.length === 0 && (
                  <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--text-muted)" }}>
                    No permissions assigned.
                  </div>
                )}
              </div>
            </Card>
          </>
        )}


      </div>
    </CanvasPanelHost>
  );
}
