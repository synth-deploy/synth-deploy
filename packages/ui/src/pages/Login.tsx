import { useState, useEffect, useRef } from "react";
import { listEnabledAuthProviders, ldapLogin, setAuthToken } from "../api.js";
import type { IdpProviderPublic } from "../types.js";
import SynthMark from "../components/SynthMark.js";
import ThemeToggle from "../components/ThemeToggle.js";

interface LoginProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (email: string, name: string, password: string) => Promise<void>;
  needsSetup: boolean;
  error: string | null;
}

function LoginParticles() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    let w = window.innerWidth, h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr; ctx.scale(dpr, dpr);
    const pts = Array.from({ length: 30 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.2, vy: (Math.random() - 0.5) * 0.12,
      r: Math.random() * 1.2 + 0.4,
    }));
    let id: number;
    const draw = () => {
      const style = getComputedStyle(document.documentElement);
      const accentRaw = style.getPropertyValue("--accent").trim() || "#2d5bf0";
      const rgb = hexToRgb(accentRaw);
      ctx.clearRect(0, 0, w, h);
      pts.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0) p.x = w; if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h; if (p.y > h) p.y = 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},0.06)`; ctx.fill();
      });
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 150) {
            ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y);
            ctx.strokeStyle = `rgba(${rgb},${0.025 * (1 - d / 150)})`;
            ctx.lineWidth = 0.5; ctx.stroke();
          }
        }
      }
      id = requestAnimationFrame(draw);
    };
    draw();
    const rs = () => {
      w = window.innerWidth; h = window.innerHeight;
      c.width = w * dpr; c.height = h * dpr; ctx.scale(dpr, dpr);
    };
    window.addEventListener("resize", rs);
    return () => { cancelAnimationFrame(id); window.removeEventListener("resize", rs); };
  }, []);
  return <canvas ref={ref} className="login-particles" />;
}

function hexToRgb(hex: string): string {
  if (hex.startsWith("rgb")) {
    const m = hex.match(/\d+/g);
    return m ? `${m[0]},${m[1]},${m[2]}` : "45,91,240";
  }
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return isNaN(r) ? "45,91,240" : `${r},${g},${b}`;
}

export default function Login({ onLogin, onRegister, needsSetup, error }: LoginProps) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">(needsSetup ? "register" : "login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [ssoProviders, setSsoProviders] = useState<IdpProviderPublic[]>([]);
  const [mounted, setMounted] = useState(false);

  // LDAP inline login state
  const [ldapProviderId, setLdapProviderId] = useState<string | null>(null);
  const [ldapUsername, setLdapUsername] = useState("");
  const [ldapPassword, setLdapPassword] = useState("");
  const [ldapLoading, setLdapLoading] = useState(false);
  const [ldapError, setLdapError] = useState<string | null>(null);

  useEffect(() => { setTimeout(() => setMounted(true), 50); }, []);

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

  function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotSent(true);
    setTimeout(() => { setForgotSent(false); setMode("login"); }, 3000);
  }

  function handleSsoLogin(provider: IdpProviderPublic) {
    if (provider.type === "ldap") {
      setLdapProviderId(provider.id);
      setLdapUsername(""); setLdapPassword(""); setLdapError(null);
      return;
    }
    window.location.href = `/api/auth/${provider.type}/${provider.id}/authorize`;
  }

  async function handleLdapSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ldapProviderId) return;
    setLdapLoading(true); setLdapError(null);
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

  const ldapProvider = ldapProviderId ? ssoProviders.find((p) => p.id === ldapProviderId) : null;

  const title = ldapProvider
    ? `Sign in with ${ldapProvider.name}`
    : mode === "login" ? "Sign in"
    : mode === "register" ? (needsSetup ? "Create admin account" : "Create account")
    : "Reset password";

  const subtitle = ldapProvider
    ? `Enter your ${ldapProvider.name} credentials`
    : mode === "login" ? "Welcome back. Enter your credentials to continue."
    : mode === "register" ? (needsSetup ? "Set up your admin account to get started with Synth." : "Set up your account to get started with Synth.")
    : "Enter your email and we'll send a reset link.";

  return (
    <div className="login-page">
      <LoginParticles />
      <div className="login-theme-toggle">
        <ThemeToggle />
      </div>

      <div className={`login-content${mounted ? " login-content-mounted" : ""}`}>
        {/* Logo */}
        <div className="login-logo">
          <SynthMark size={64} />
          <span className="login-wordmark">Synth</span>
        </div>

        {/* Card */}
        <div className="login-card">
          <div className="login-header">
            <h1 className="login-title">{title}</h1>
            <p className="login-subtitle">{subtitle}</p>
          </div>

          {error && <div className="login-alert login-alert-error">{error}</div>}
          {forgotSent && <div className="login-alert login-alert-success">Reset link sent. Check your email.</div>}

          {/* LDAP inline login */}
          {ldapProvider && (
            <>
              {ldapError && <div className="login-alert login-alert-error">{ldapError}</div>}
              <form onSubmit={handleLdapSubmit} className="login-form">
                <div className="login-field">
                  <label htmlFor="ldap-username">Username</label>
                  <input id="ldap-username" type="text" value={ldapUsername}
                    onChange={(e) => setLdapUsername(e.target.value)}
                    placeholder="Username" required autoFocus autoComplete="username" />
                </div>
                <div className="login-field">
                  <label htmlFor="ldap-password">Password</label>
                  <input id="ldap-password" type="password" value={ldapPassword}
                    onChange={(e) => setLdapPassword(e.target.value)}
                    placeholder="Password" required autoComplete="current-password" />
                </div>
                <button type="submit" className="login-button" disabled={ldapLoading}>
                  {ldapLoading ? "…" : "Sign In"}
                </button>
              </form>
              <div className="login-toggle">
                <button type="button" className="login-link" onClick={() => setLdapProviderId(null)}>
                  ← Back to login options
                </button>
              </div>
            </>
          )}

          {/* Forgot password form */}
          {!ldapProvider && mode === "forgot" && (
            <form onSubmit={handleForgot} className="login-form">
              <div className="login-field">
                <label htmlFor="forgot-email">Email</label>
                <input id="forgot-email" type="email" value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com" required autoFocus autoComplete="email" />
              </div>
              <button type="submit" className="login-button" disabled={loading || forgotSent}>
                {forgotSent ? "Sent!" : "Send Reset Link"}
              </button>
            </form>
          )}

          {/* SSO Providers */}
          {!ldapProvider && mode === "login" && !needsSetup && ssoProviders.length > 0 && (
            <div className="login-sso">
              {ssoProviders.map((provider) => (
                <button key={provider.id} type="button" className="login-sso-button"
                  onClick={() => handleSsoLogin(provider)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                    <polyline points="10 17 15 12 10 7" />
                    <line x1="15" y1="12" x2="3" y2="12" />
                  </svg>
                  Sign in with {provider.name}
                </button>
              ))}
            </div>
          )}

          {/* Main credential form */}
          {!ldapProvider && mode !== "forgot" && (
            <>
              {!needsSetup && mode === "login" && ssoProviders.length > 0 && (
                <div className="login-divider">
                  <div className="login-divider-line" />
                  <span>or</span>
                  <div className="login-divider-line" />
                </div>
              )}

              <form onSubmit={handleSubmit} className="login-form">
                {mode === "register" && (
                  <div className="login-field">
                    <label htmlFor="name">Name</label>
                    <input id="name" type="text" value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your full name" required autoComplete="name" />
                  </div>
                )}

                <div className="login-field">
                  <label htmlFor="email">Email</label>
                  <input id="email" type="email" value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com" required autoFocus autoComplete="email" />
                </div>

                <div className="login-field">
                  <div className="login-field-header">
                    <label htmlFor="password">Password</label>
                    {mode === "login" && (
                      <button type="button" className="login-forgot-link"
                        onClick={() => setMode("forgot")}>
                        Forgot?
                      </button>
                    )}
                  </div>
                  <div className="login-pw-wrap">
                    <input id="password" type={showPw ? "text" : "password"} value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••" required
                      minLength={mode === "register" ? 8 : 1}
                      autoComplete={mode === "register" ? "new-password" : "current-password"} />
                    <button type="button" className="login-pw-toggle" onClick={() => setShowPw(p => !p)}>
                      {showPw ? "hide" : "show"}
                    </button>
                  </div>
                </div>

                <button type="submit" className="login-button" disabled={loading}>
                  {loading ? "…" : mode === "register" ? "Create Account" : "Sign In"}
                </button>
              </form>
            </>
          )}
        </div>

        {/* Mode switcher */}
        {!ldapProvider && mode !== "forgot" && !needsSetup && (
          <div className="login-toggle">
            {mode === "login"
              ? <span>No account? <button type="button" className="login-link" onClick={() => setMode("register")}>Create one</button></span>
              : <span>Already have an account? <button type="button" className="login-link" onClick={() => setMode("login")}>Sign in</button></span>
            }
          </div>
        )}
        {!ldapProvider && mode === "forgot" && (
          <div className="login-toggle">
            <button type="button" className="login-link" onClick={() => { setMode("login"); setForgotSent(false); }}>
              ← Back to sign in
            </button>
          </div>
        )}

        <div className="login-footer">synthdeploy.com</div>
      </div>
    </div>
  );
}
