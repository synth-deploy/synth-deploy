import { useState, useRef, useEffect, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { queryAgent } from "../api.js";
import type { CanvasQueryResult } from "../api.js";
import { detectStructuredContent } from "../utils/detectStructuredContent.js";
import EntityTag from "./EntityTag.js";
import type { EntityType } from "./EntityTag.js";

interface Message {
  id: string;
  speaker: "you" | "envoy" | "nav";
  time: string;
  text: string;
  entities?: Array<{ type: EntityType; label: string }>;
}

interface SynthChannelProps {
  scope?: string;
  mode?: "strip" | "panel";
  onQuerySubmit?: () => void;
  onAgentResult?: (result: CanvasQueryResult) => void;
  onStructuredContent?: (text: string, title?: string) => void;
  onDismiss?: () => void;
  style?: CSSProperties;
}

export default function SynthChannel({
  scope,
  mode = "strip",
  onQuerySubmit,
  onAgentResult,
  onStructuredContent,
  onDismiss,
  style,
}: SynthChannelProps) {
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef(crypto.randomUUID());

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, typing]);

  const handleSubmit = async () => {
    if (!inputValue.trim()) return;
    const text = inputValue.trim();

    setMessages((prev) => [
      ...prev,
      {
        id: `msg-${Date.now()}`,
        speaker: "you",
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
        text,
      },
    ]);
    setInputValue("");
    onQuerySubmit?.();
    setTyping(true);

    try {
      const result = await queryAgent(text, conversationIdRef.current);
      setTyping(false);

      if (result.action === "answer") {
        const content = result.content ?? result.title ?? "Done.";
        const isStructured = detectStructuredContent(content);
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-r`,
            // When structured content goes to the right panel, show a dim nav-style ack
            // instead of repeating the full table in the chat history
            speaker: isStructured ? "nav" : "envoy",
            time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
            text: isStructured ? (result.title ?? "Structured data") : content,
          },
        ]);
        if (isStructured) {
          onStructuredContent?.(content, result.title);
        }
      } else {
        // Navigation/data/create — show a dim nav ack, then navigate
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-nav`,
            speaker: "nav",
            time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
            text: result.title ?? result.view ?? "Navigating.",
          },
        ]);
        onAgentResult?.(result);
      }
    } catch {
      setTyping(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}-err`,
          speaker: "envoy",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
          text: scope
            ? `Looking into that for ${scope}.`
            : "Let me look into that for you.",
          entities: scope ? [{ type: "Partition" as EntityType, label: scope }] : [],
        },
      ]);
    }
  };

  const prefix = scope ? `ASK \u203A ${scope} \u203A` : "ASK \u203A";

  if (mode === "panel") {
    return (
      <div className="synth-channel-panel-mode" style={style}>
        <div className="synth-channel-panel-mode-header">
          <span className="synth-channel-panel-mode-label">
            {scope ? `ASK \u203A ${scope}` : "ASK"}
          </span>
          {scope && <EntityTag type="Partition" label={scope} />}
          {onDismiss && (
            <button className="synth-channel-panel-dismiss" onClick={onDismiss} title="Close">
              &times;
            </button>
          )}
        </div>

        <div ref={scrollRef} className="synth-channel-panel-mode-messages">
          {messages.length === 0 && !typing && (
            <div className="synth-channel-panel-mode-empty">
              {scope
                ? `Ask about ${scope}`
                : "Ask anything about your systems, deployments, or fleet."}
            </div>
          )}
          {messages.map((msg, i) => {
            if (msg.speaker === "nav") {
              return (
                <div
                  key={msg.id}
                  className="synth-channel-nav-ack"
                  style={{ animation: i === messages.length - 1 ? "fadeSlideIn 0.25s ease" : "none" }}
                >
                  <span className="synth-channel-nav-arrow">&#8594;</span>
                  <span className="synth-channel-nav-text">{msg.text}</span>
                </div>
              );
            }

            const isYou = msg.speaker === "you";
            return (
              <div
                key={msg.id}
                className={`synth-channel-msg ${isYou ? "synth-channel-msg-you" : "synth-channel-msg-command"}`}
                style={{ animation: i === messages.length - 1 ? "fadeSlideIn 0.3s ease" : "none" }}
              >
                <div className="synth-channel-msg-header">
                  <span className={`synth-channel-speaker ${isYou ? "speaker-you" : "speaker-command"}`}>
                    {isYou ? "YOU" : "ENVOY"}
                  </span>
                  <span className="synth-channel-time">{msg.time}</span>
                  {msg.entities && msg.entities.map((e, j) => (
                    <EntityTag key={j} type={e.type} label={e.label} />
                  ))}
                </div>
                <div className="synth-channel-msg-text">
                  {isYou ? (
                    msg.text
                  ) : (
                    <div className="synth-channel-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {typing && (
            <div className="synth-channel-msg synth-channel-msg-command">
              <div className="synth-channel-msg-header">
                <span className="synth-channel-speaker speaker-command">ENVOY</span>
                <div className="synth-channel-typing-dots">
                  <div className="typing-dot" style={{ animationDelay: "0s" }} />
                  <div className="typing-dot" style={{ animationDelay: "0.15s" }} />
                  <div className="typing-dot" style={{ animationDelay: "0.3s" }} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="synth-channel-panel-mode-input">
          <input
            className="synth-channel-input synth-channel-panel-mode-input-field"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleSubmit(); }
            }}
            placeholder={scope ? `Ask about ${scope}...` : "What do you want to know?"}
            autoFocus
          />
          <button
            className="synth-channel-submit-btn"
            onClick={handleSubmit}
            disabled={!inputValue.trim()}
            style={{
              background: inputValue.trim() ? "var(--accent-dim)" : "transparent",
              borderColor: inputValue.trim() ? "var(--accent-border)" : "var(--border)",
              color: inputValue.trim() ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            &#8629;
          </button>
        </div>
      </div>
    );
  }

  // Strip mode (default): minimal bottom bar
  return (
    <div className="synth-channel">
      <div className="synth-channel-bar">
        <div className="synth-channel-input-wrapper">
          <span className="synth-channel-prefix">{prefix}</span>
          <input
            className="synth-channel-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleSubmit(); }
            }}
            placeholder={scope ? `Ask about ${scope}...` : "What do you want to know?"}
          />
          <button
            className="synth-channel-submit-btn"
            onClick={handleSubmit}
            disabled={!inputValue.trim()}
            style={{
              background: inputValue.trim() ? "var(--accent-dim)" : "transparent",
              borderColor: inputValue.trim() ? "var(--accent-border)" : "var(--border)",
              color: inputValue.trim() ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            &#8629;
          </button>
        </div>
        {messages.length === 0 && (
          <div className="synth-channel-hint">
            {scope
              ? `Scoped to ${scope} \u2014 ask questions to investigate`
              : "Ask questions to investigate \u00B7 Navigate by describing what you need \u00B7 Your context becomes part of the Debrief"}
          </div>
        )}
      </div>
    </div>
  );
}
