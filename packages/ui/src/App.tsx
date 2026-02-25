import { Outlet } from "react-router";
import Sidebar from "./components/Sidebar.js";
import { ModeProvider } from "./context/ModeContext.js";

export default function App() {
  return (
    <ModeProvider>
      <div className="layout">
        <Sidebar />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </ModeProvider>
  );
}
