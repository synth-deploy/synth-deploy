import { useState, useEffect } from "react";
import { listEnabledAuthProviders } from "../api.js";
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

  function handleSsoLogin(providerId: string) {
    // Redirect to the OIDC authorization endpoint
    window.location.href = `/api/auth/oidc/${providerId}/authorize`;
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <h1 className="login-title">DeployStack</h1>
          <p className="login-subtitle">
            {needsSetup
              ? "Create your admin account to get started"
              : mode === "login"
                ? "Sign in to continue"
                : "Register a new account"}
          </p>
        </div>

        {error && <div className="login-error">{error}</div>}

        {/* SSO Providers */}
        {!needsSetup && mode === "login" && ssoProviders.length > 0 && (
          <div className="login-sso" style={{ marginBottom: 16 }}>
            {ssoProviders.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className="login-button login-sso-button"
                onClick={() => handleSsoLogin(provider.id)}
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

        {!needsSetup && (
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
