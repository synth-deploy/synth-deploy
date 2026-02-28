import { NavLink } from "react-router";
import { useMode } from "../context/ModeContext.js";
import { useSettings } from "../context/SettingsContext.js";
import ModeToggle from "./ModeToggle.js";

export default function Sidebar() {
  const { mode } = useMode();
  const { settings } = useSettings();
  const isAgent = mode === "agent";
  const environmentsEnabled = settings?.environmentsEnabled ?? true;

  return (
    <aside className={`sidebar ${isAgent ? "sidebar-agent" : ""}`}>
      <div className="sidebar-logo">
        <h1>DeployStack</h1>
      </div>

      <div className="mode-toggle-container">
        <ModeToggle />
      </div>

      <nav className="sidebar-nav">
        <NavLink to="/" end className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9632;</span>
          Dashboard
        </NavLink>
        <NavLink to="/projects" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9654;</span>
          Projects
        </NavLink>
        <NavLink to="/partitions" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9670;</span>
          Partitions
        </NavLink>
        {environmentsEnabled && (
          <NavLink to="/environments" className={({ isActive }) => isActive ? "active" : ""}>
            <span className="nav-icon">&#9679;</span>
            Environments
          </NavLink>
        )}
        <NavLink to="/orders" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9776;</span>
          Orders
        </NavLink>
        <NavLink to="/deploy" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9650;</span>
          New Deployment
        </NavLink>
        <NavLink to="/debrief" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9733;</span>
          Debrief
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9881;</span>
          Settings
        </NavLink>
      </nav>
      <div className="sidebar-footer">
        <div className="text-muted">v0.1.0</div>
      </div>
    </aside>
  );
}
