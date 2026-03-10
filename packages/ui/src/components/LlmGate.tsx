import { useState, useEffect, type ReactNode } from "react";
import { getLlmHealth, updateSettings } from "../api.js";
import type { LlmHealthStatus } from "../api.js";

interface LlmGateProps {
  children: ReactNode;
}

function LlmGateSetup({ onConfigured }: { onConfigured: (status: LlmHealthStatus) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateSettings({ llm: { apiKey: apiKey.trim() } } as never);
      const result = await getLlmHealth();
      if (result.configured) {
        onConfigured(result);
      } else {
        setSaveError("Key saved but LLM health check still failing — verify the key is valid.");
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save API key");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="llm-gate-container">
      <div className="llm-gate-card">
        <div className="llm-gate-logo">Synth</div>
        <div className="llm-gate-title">LLM Connection Required</div>
        <div className="llm-gate-message">
          Synth requires an LLM connection to function. The intelligence
          is the product — without it, there is no deployment reasoning,
          no risk assessment, and no plan generation.
        </div>
        <form className="llm-gate-setup" onSubmit={handleSubmit}>
          <div className="llm-gate-setup-title">Connect your LLM</div>
          <div className="llm-gate-setup-step">
            <span className="llm-gate-step-number">1</span>
            <span>Enter your API key below. Anthropic Claude is the default provider.</span>
          </div>
          <div className="llm-gate-setup-step">
            <span className="llm-gate-step-number">2</span>
            <span>
              To use a different provider (<code>openai-compatible</code>, <code>bedrock</code>, <code>vertex</code>),
              set <code>SYNTH_LLM_PROVIDER</code> in your environment and restart.
            </span>
          </div>
          <input
            className="llm-gate-key-input"
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {saveError && <div className="llm-gate-save-error">{saveError}</div>}
          <button className="llm-gate-retry" type="submit" disabled={saving || !apiKey.trim()}>
            {saving ? "Connecting…" : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LlmGate({ children }: LlmGateProps) {
  const [status, setStatus] = useState<LlmHealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const result = await getLlmHealth();
        if (!cancelled) {
          setStatus(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to check LLM status");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    check();
    return () => { cancelled = true; };
  }, []);

  // Still loading -- show nothing to avoid flash
  if (loading) {
    return (
      <div className="llm-gate-loading">
        <div className="llm-gate-loading-spinner" />
      </div>
    );
  }

  // Network error reaching the server itself
  if (error) {
    return (
      <div className="llm-gate-container">
        <div className="llm-gate-card">
          <div className="llm-gate-logo">Synth</div>
          <div className="llm-gate-title">Unable to reach server</div>
          <div className="llm-gate-message">
            Could not connect to the Synth server to verify LLM status.
          </div>
          <div className="llm-gate-detail">{error}</div>
          <button
            className="llm-gate-retry"
            onClick={() => {
              setLoading(true);
              setError(null);
              getLlmHealth()
                .then((result) => { setStatus(result); setError(null); })
                .catch((err) => setError(err instanceof Error ? err.message : "Failed to check LLM status"))
                .finally(() => setLoading(false));
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Not configured -- full gate with inline key entry
  if (status && !status.configured) {
    return <LlmGateSetup onConfigured={(result) => setStatus(result)} />;
  }

  // Configured but unhealthy -- warning banner, children still render
  if (status && status.configured && !status.healthy) {
    return (
      <>
        <div className="llm-gate-warning-banner">
          <span className="llm-gate-warning-dot" />
          <span className="llm-gate-warning-text">
            LLM provider ({status.provider ?? "unknown"}) is configured but not responding.
            Some intelligent features may be temporarily unavailable.
          </span>
        </div>
        {children}
      </>
    );
  }

  // All good -- render children
  return <>{children}</>;
}
