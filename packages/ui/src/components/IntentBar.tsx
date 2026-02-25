import { useState, useRef, useEffect } from "react";
import type { IntentResult } from "../api.js";

interface IntentBarProps {
  onIntentResolved: (result: IntentResult) => void;
  onSubmitIntent: (intent: string) => Promise<void>;
  disabled?: boolean;
  processing?: boolean;
}

export default function IntentBar({ onIntentResolved, onSubmitIntent, disabled, processing }: IntentBarProps) {
  const [intent, setIntent] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!disabled && inputRef.current) {
      inputRef.current.focus();
    }
  }, [disabled]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!intent.trim() || disabled || processing) return;
    await onSubmitIntent(intent.trim());
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <form className="intent-bar" onSubmit={handleSubmit}>
      <div className="intent-bar-inner">
        <span className="intent-bar-icon">&gt;</span>
        <input
          ref={inputRef}
          className="intent-bar-input"
          type="text"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Describe what you want to deploy, e.g. "Deploy web-app v2.0.0 to production for Acme Corp"'
          disabled={disabled || processing}
        />
        <button
          type="submit"
          className="intent-bar-submit"
          disabled={!intent.trim() || disabled || processing}
        >
          {processing ? "..." : "Go"}
        </button>
      </div>
    </form>
  );
}
