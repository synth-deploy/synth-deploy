import { Outlet } from "react-router";
import Sidebar from "./components/Sidebar.js";
import AgentCanvas from "./components/AgentCanvas.js";
import ModeToggle from "./components/ModeToggle.js";
import { ModeProvider, useMode } from "./context/ModeContext.js";
import { SettingsProvider } from "./context/SettingsContext.js";
import { CanvasProvider } from "./context/CanvasContext.js";

function AppLayout() {
  const { mode } = useMode();
  const isAgent = mode === "agent";

  // --- Agent mode: full-screen canvas (no sidebar, no routing) ---
  if (isAgent) {
    return (
      <CanvasProvider>
        <div className="layout agent-active">
          <AgentCanvas />
        </div>
      </CanvasProvider>
    );
  }

  // --- Traditional mode: sidebar + page routing ---
  return (
    <div className="layout">
      <Sidebar />
      <main className="content">
        <div className="content-mode-toggle">
          <ModeToggle />
        </div>
        <div className="content-with-diary">
          <div className="content-main">
            <Outlet />
          </div>
        </div>
      </main>
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
