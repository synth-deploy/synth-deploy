import { useState, useEffect } from "react";
import { listEnabledAuthProviders, ldapLogin, setAuthToken } from "../api.js";
import type { IdpProviderPublic } from "../types.js";

interface LoginProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, name: string, password: string) => Promise<void>;
  needsSetup: boolean;
  error: string | null;
}

export default function Login({ onLogin, onRegister, needsSetup, error }: LoginProps) {
  const [mode, setMode] = useState<"login" | "register">(needsSetup ? "register" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<IdpProviderPublic[]>([]);

  // LDAP inline login state
  const [ldapProviderId, setLdapProviderId] = useState<string | null>(null);
  const [ldapUsername, setLdapUsername] = useState("");
  const [ldapPassword, setLdapPassword] = useState("");
  const [ldapLoading, setLdapLoading] = useState(false);
  const [ldapError, setLdapError] = useState<string | null>(null);

  useEffect(() => {
    if (!needsSetup) {
      listEnabledAuthProviders().then(setSsoProviders).catch(() => {});
    }
  }, [needsSetup]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "register") {
        await onRegister(email, name, password);
      } else {
        await onLogin(email, password);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleSsoLogin(provider: IdpProviderPublic) {
    if (provider.type === "ldap") {
      setLdapProviderId(provider.id);
      setLdapUsername("");
      setLdapPassword("");
      setLdapError(null);
      return;
    }
    // OIDC and SAML both use /api/auth/{type}/{id}/authorize
    window.location.href = `/api/auth/${provider.type}/${provider.id}/authorize`;
  }

  async function handleLdapSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ldapProviderId) return;
    setLdapLoading(true);
    setLdapError(null);
    try {
      const result = await ldapLogin(ldapProviderId, ldapUsername, ldapPassword);
      setAuthToken(result.token);
      window.location.reload();
    } catch (err: unknown) {
      setLdapError(err instanceof Error ? err.message : "LDAP login failed");
    } finally {
      setLdapLoading(false);
    }
  }

  const ldapProvider = ldapProviderId
    ? ssoProviders.find((p) => p.id === ldapProviderId)
    : null;

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1 className="login-title">DeployStack</h1>
          <p className="login-subtitle">
            {needsSetup
              ? "Create your admin account to get started"
              : ldapProvider
                ? `Sign in with ${ldapProvider.name}`
                : mode === "login"
                  ? "Sign in to continue"
                  : "Register a new account"}
          </p>
        </div>

        {error && <div className="login-error">{error}</div>}

        {/* LDAP inline login form */}
        {ldapProvider && (
          <div>
            {ldapError && <div className="login-error">{ldapError}</div>}
            <form onSubmit={handleLdapSubmit} className="login-form">
              <div className="login-field">
                <label htmlFor="ldap-username">Username</label>
                <input
                  id="ldap-username"
                  type="text"
                  value={ldapUsername}
                  onChange={(e) => setLdapUsername(e.target.value)}
                  placeholder="Username"
                  required
                  autoFocus
                  autoComplete="username"
                />
              </div>
              <div className="login-field">
                <label htmlFor="ldap-password">Password</label>
                <input
                  id="ldap-password"
                  type="password"
                  value={ldapPassword}
                  onChange={(e) => setLdapPassword(e.target.value)}
                  placeholder="Password"
                  required
                  autoComplete="current-password"
                />
              </div>
              <button type="submit" className="login-button" disabled={ldapLoading}>
                {ldapLoading ? "Signing in..." : "Sign In"}
              </button>
            </form>
            <div className="login-toggle">
              <button
                type="button"
                className="login-link"
                onClick={() => setLdapProviderId(null)}
              >
                Back to login options
              </button>
            </div>
          </div>
        )}

        {/* SSO Providers */}
        {!ldapProvider && !needsSetup && mode === "login" && ssoProviders.length > 0 && (
          <div className="login-sso" style={{ marginBottom: 16 }}>
            {ssoProviders.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className="login-button login-sso-button"
                onClick={() => handleSsoLogin(provider)}
                style={{
                  marginBottom: 8,
                  background: "var(--bg-secondary, #f1f5f9)",
                  color: "var(--text-primary, #1e293b)",
                  border: "1px solid var(--border-color, #e2e8f0)",
                }}
              >
                Sign in with {provider.name}
              </button>
            ))}
            <div style={{
              textAlign: "center",
              fontSize: "0.85em",
              color: "var(--text-secondary, #64748b)",
              margin: "8px 0",
            }}>
              or sign in with credentials
            </div>
          </div>
        )}

        {!ldapProvider && (
          <form onSubmit={handleSubmit} className="login-form">
            <div className="login-field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoFocus
                autoComplete="email"
              />
            </div>

            {mode === "register" && (
              <div className="login-field">
                <label htmlFor="name">Name</label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  required
                  autoComplete="name"
                />
              </div>
            )}

            <div className="login-field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "register" ? "Min 8 characters" : "Password"}
                required
                minLength={mode === "register" ? 8 : 1}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
              />
            </div>

            <button type="submit" className="login-button" disabled={loading}>
              {loading
                ? "Please wait..."
                : mode === "register"
                  ? "Create Account"
                  : "Sign In"}
            </button>
          </form>
        )}

        {!ldapProvider && !needsSetup && (
          <div className="login-toggle">
            {mode === "login" ? (
              <button type="button" onClick={() => setMode("register")} className="login-link">
                Need an account? Register
              </button>
            ) : (
              <button type="button" onClick={() => setMode("login")} className="login-link">
                Already have an account? Sign in
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
