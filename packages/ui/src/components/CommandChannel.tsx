import { useState, useRef, useEffect } from "react";
import { queryAgent } from "../api.js";
import type { CanvasQueryResult } from "../api.js";
import EntityTag from "./EntityTag.js";
import type { EntityType } from "./EntityTag.js";

interface Message {
  id: string;
  speaker: "you" | "command";
  time: string;
  text: string;
  entities?: Array<{ type: EntityType; label: string }>;
}

interface CommandChannelProps {
  scope?: string;
  onAgentResult?: (result: CanvasQueryResult) => void;
}

export default function CommandChannel({ scope, onAgentResult }: CommandChannelProps) {
  const [expanded, setExpanded] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef(crypto.randomUUID());

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, expanded]);

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
    if (!expanded) setExpanded(true);
    setTyping(true);

    try {
      const result = await queryAgent(text, conversationIdRef.current);

      setTyping(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}-r`,
          speaker: "command",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
          text: result.title ?? "Understood. Navigating.",
          entities: [],
        },
      ]);

      if (onAgentResult) {
        onAgentResult(result);
      }
    } catch {
      setTyping(false);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}-err`,
          speaker: "command",
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
          text: scope
            ? `Looking into that for ${scope}. I can see the full deployment history and current status for this Partition.`
            : "Let me look into that for you.",
          entities: scope ? [{ type: "Partition" as EntityType, label: scope }] : [],
        },
      ]);
    }
  };

  const prefix = scope ? `ASK \u203A ${scope} \u203A` : "ASK \u203A";

  return (
    <div className="command-channel">
      {/* Expanded conversation panel */}
      <div
        className="command-channel-panel"
        style={{
          maxHeight: expanded ? "40vh" : 0,
          opacity: expanded ? 1 : 0,
        }}
      >
        {expanded && (
          <div className="command-channel-panel-header">
            <span className="command-channel-scope-label">
              {scope ? "Investigating" : "Querying"}
            </span>
            {scope ? (
              <EntityTag type="Partition" label={scope} />
            ) : (
              <EntityTag type="Command" label="DeployStack" />
            )}
            <button
              className="command-channel-collapse-btn"
              onClick={() => setExpanded(false)}
            >
              Collapse
            </button>
          </div>
        )}
        <div ref={scrollRef} className="command-channel-messages">
          {messages.map((msg, i) => {
            const isYou = msg.speaker === "you";
            return (
              <div
                key={msg.id}
                className={`command-channel-msg ${isYou ? "command-channel-msg-you" : "command-channel-msg-command"}`}
                style={{
                  animation: i === messages.length - 1 ? "fadeSlideIn 0.3s ease" : "none",
                }}
              >
                <div className="command-channel-msg-header">
                  <span className={`command-channel-speaker ${isYou ? "speaker-you" : "speaker-command"}`}>
                    {isYou ? "YOU" : "ENVOY"}
                  </span>
                  <span className="command-channel-time">{msg.time}</span>
                  {msg.entities && (
                    <div className="command-channel-entities">
                      {msg.entities.map((e, j) => (
                        <EntityTag key={j} type={e.type} label={e.label} />
                      ))}
                    </div>
                  )}
                </div>
                <div className="command-channel-msg-text">{msg.text}</div>
              </div>
            );
          })}
          {typing && (
            <div className="command-channel-msg command-channel-msg-command">
              <div className="command-channel-msg-header">
                <span className="command-channel-speaker speaker-command">ENVOY</span>
                <div className="command-channel-typing-dots">
                  <div className="typing-dot" style={{ animationDelay: "0s" }} />
                  <div className="typing-dot" style={{ animationDelay: "0.15s" }} />
                  <div className="typing-dot" style={{ animationDelay: "0.3s" }} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Input bar */}
      <div className="command-channel-bar">
        <div className="command-channel-input-wrapper">
          <span className="command-channel-prefix">{prefix}</span>
          <input
            className="command-channel-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSubmit();
              }
            }}
            onFocus={() => {
              if (messages.length > 0 && !expanded) setExpanded(true);
            }}
            placeholder={scope ? `Ask about ${scope}...` : "What do you want to know?"}
          />
          {messages.length > 0 && (
            <button
              className="command-channel-toggle-btn"
              onClick={() => setExpanded(!expanded)}
            >
              <span
                style={{
                  transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.3s ease",
                  display: "inline-block",
                }}
              >
                &uarr;
              </span>
              {!expanded && <span>{messages.length}</span>}
            </button>
          )}
          <button
            className="command-channel-submit-btn"
            onClick={handleSubmit}
            disabled={!inputValue.trim()}
            style={{
              background: inputValue.trim()
                ? "rgba(99,225,190,0.12)"
                : "rgba(107,114,128,0.06)",
              borderColor: inputValue.trim()
                ? "rgba(99,225,190,0.25)"
                : "rgba(107,114,128,0.1)",
              color: inputValue.trim() ? "#63e1be" : "#374151",
            }}
          >
            &#8629;
          </button>
        </div>
        {!expanded && messages.length === 0 && (
          <div className="command-channel-hint">
            {scope
              ? `Scoped to ${scope} \u2014 ask questions to investigate`
              : "Ask questions to investigate \u00B7 Navigate by describing what you need \u00B7 Your context becomes part of the Debrief"}
          </div>
        )}
      </div>
    </div>
  );
}
