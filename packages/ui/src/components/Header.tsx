import { useCanvas } from "../context/CanvasContext.js";
import { listEnvoys } from "../api.js";
import type { EnvoyRegistryEntry } from "../api.js";
import { useQuery } from "../hooks/useQuery.js";
import SynthMark from "./SynthMark.js";
import ThemeToggle from "./ThemeToggle.js";

const TABS = [
  { id: "operation-authoring", label: "Deploy", panelTitle: "Deploy" },
  { id: "artifact-catalog", label: "Artifacts", panelTitle: "Artifact Catalog" },
  { id: "topology", label: "Topology", panelTitle: "Topology" },
  { id: "debrief", label: "Debriefs", panelTitle: "Debriefs" },
] as const;

export default function Header() {
  const { currentPanel, resetToOverview, pushPanel } = useCanvas();
  const { data: envoys } = useQuery<EnvoyRegistryEntry[]>("list:envoys", () => listEnvoys().catch(() => [] as EnvoyRegistryEntry[]));
  const envoyList = envoys ?? [];
  const healthyCount = envoyList.filter((e) => e.health === "OK").length;
  const totalCount = envoyList.length;

  const activeTab = TABS.find((t) => t.id === currentPanel.type)?.id ?? null;

  const navTo = (panelType: string, title: string) => {
    resetToOverview();
    pushPanel({ type: panelType, title, params: {} });
  };

  return (
    <header className="synth-header">
      <div className="synth-header-left">
        <div
          className={`synth-header-logo ${currentPanel.type === "overview" ? "synth-header-logo-active" : ""}`}
          onClick={resetToOverview}
        >
          <SynthMark size={20} active />
          <span className="synth-header-wordmark">Synth</span>
        </div>
        <div className="synth-header-divider" />
        <nav className="synth-header-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`synth-header-tab ${activeTab === t.id ? "synth-header-tab-active" : ""}`}
              onClick={() => navTo(t.id, t.panelTitle)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="synth-header-right">
        <button
          className="synth-header-health-pill"
          onClick={() => navTo("topology", "Topology")}
          title="Envoy fleet health"
        >
          <span className={`health-pip ${healthyCount === totalCount ? "health-pip-healthy" : "health-pip-degraded"}`} />
          <span className="health-pill-text">{totalCount > 0 ? `${healthyCount}/${totalCount} envoys healthy` : "No envoys"}</span>
        </button>
        <ThemeToggle />
        <button
          className="synth-header-icon-btn"
          onClick={() => {
            resetToOverview();
            pushPanel({ type: "settings", title: "Settings", params: {} });
          }}
          title="Settings"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <button
          className="synth-header-user-btn"
          title="User settings"
          onClick={() => {
            resetToOverview();
            pushPanel({ type: "user-settings", title: "User Settings", params: {} });
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M4 21c0-4.42 3.58-8 8-8s8 3.58 8 8M12 13a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </header>
  );
}
