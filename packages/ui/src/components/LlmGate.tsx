import { useState, useEffect, type ReactNode } from "react";
import { getLlmHealth } from "../api.js";
import type { LlmHealthStatus } from "../api.js";

interface LlmGateProps {
  children: ReactNode;
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

  // Not configured -- full gate, no way past
  if (status && !status.configured) {
    return (
      <div className="llm-gate-container">
        <div className="llm-gate-card">
          <div className="llm-gate-logo">Synth</div>
          <div className="llm-gate-title">LLM Connection Required</div>
          <div className="llm-gate-message">
            Synth requires an LLM connection to function. The intelligence
            is the product -- without it, there is no deployment reasoning,
            no risk assessment, and no plan generation.
          </div>
          <div className="llm-gate-setup">
            <div className="llm-gate-setup-title">Setup</div>
            <div className="llm-gate-setup-step">
              <span className="llm-gate-step-number">1</span>
              <span>
                Set <code>DEPLOYSTACK_LLM_API_KEY</code> to your Anthropic API key
              </span>
            </div>
            <div className="llm-gate-setup-step">
              <span className="llm-gate-step-number">2</span>
              <span>
                Optionally set <code>DEPLOYSTACK_LLM_PROVIDER</code> (default: <code>anthropic</code>).
                Supported: <code>anthropic</code>, <code>bedrock</code>, <code>vertex</code>, <code>openai-compatible</code>
              </span>
            </div>
            <div className="llm-gate-setup-step">
              <span className="llm-gate-step-number">3</span>
              <span>Restart the Synth server</span>
            </div>
          </div>
          <button
            className="llm-gate-retry"
            onClick={() => {
              setLoading(true);
              getLlmHealth()
                .then((result) => { setStatus(result); setError(null); })
                .catch((err) => setError(err instanceof Error ? err.message : "Failed to check LLM status"))
                .finally(() => setLoading(false));
            }}
          >
            Re-check Connection
          </button>
        </div>
      </div>
    );
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
