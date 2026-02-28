import { useMode } from "../context/ModeContext.js";

export default function AgentBanner() {
  const { mode } = useMode();
  const isAgent = mode === "agent";

  return (
    <div className={`agent-banner ${isAgent ? "agent-banner-visible" : ""}`}>
      <div className="agent-banner-inner">
        <span className="agent-banner-dot" />
        <span className="agent-banner-text">
          AGENT MODE ACTIVE
        </span>
      </div>
    </div>
  );
}
