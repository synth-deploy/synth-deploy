import { Outlet } from "react-router";
import Sidebar from "./components/Sidebar.js";
import { ModeProvider } from "./context/ModeContext.js";
import { SettingsProvider } from "./context/SettingsContext.js";

export default function App() {
  return (
    <ModeProvider>
      <SettingsProvider>
        <div className="layout">
          <Sidebar />
          <main className="content">
            <Outlet />
          </main>
        </div>
      </SettingsProvider>
    </ModeProvider>
  );
}
