import { Outlet, useNavigate, useLocation } from "react-router";
import Sidebar from "./components/Sidebar.js";
import AgentBanner from "./components/AgentBanner.js";
import DiaryPanel from "./components/DiaryPanel.js";
import IntentBar from "./components/IntentBar.js";
import { ModeProvider, useMode } from "./context/ModeContext.js";
import { SettingsProvider } from "./context/SettingsContext.js";

function AppLayout() {
  const { mode } = useMode();
  const navigate = useNavigate();
  const location = useLocation();
  const isAgent = mode === "agent";

  // NewDeployment has its own IntentBar — hide the global one there
  const onDeployPage = location.pathname === "/deploy";
  const showGlobalIntentBar = isAgent && !onDeployPage;

  function handleGlobalIntent(intent: string) {
    navigate(`/deploy?intent=${encodeURIComponent(intent)}`);
    return Promise.resolve();
  }

  return (
    <div className={`layout ${isAgent ? "agent-active" : ""}`}>
      <Sidebar />
      <main className="content">
        <AgentBanner />
        <div className="content-with-diary">
          <div className="content-main">
            <Outlet />
          </div>
          <DiaryPanel />
        </div>
      </main>
      {showGlobalIntentBar && (
        <div className="global-intent-bar">
          <IntentBar
            onSubmitIntent={handleGlobalIntent}
            onIntentResolved={() => {}}
            disabled={false}
            processing={false}
          />
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ModeProvider>
      <SettingsProvider>
        <AppLayout />
      </SettingsProvider>
    </ModeProvider>
  );
}
