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
    const text = intent.trim();
    setIntent("");
    await onSubmitIntent(text);
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
          placeholder="Issue intent... e.g. deploy Acme to staging"
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
