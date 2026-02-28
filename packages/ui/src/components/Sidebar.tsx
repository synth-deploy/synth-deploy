import { NavLink } from "react-router";
import { useMode } from "../context/ModeContext.js";

export default function Sidebar() {
  const { mode, toggleMode } = useMode();
  const isAgent = mode === "agent";

  return (
    <aside className={`sidebar ${isAgent ? "sidebar-agent" : ""}`}>
      <div className="sidebar-logo">
        <h1>DeployStack</h1>
        <span>{isAgent ? "Agent Mode" : "Traditional Mode"}</span>
      </div>

      <div className="mode-toggle-container">
        <button
          className={`mode-toggle ${isAgent ? "mode-toggle-active" : ""}`}
          onClick={toggleMode}
          aria-label={`Switch to ${isAgent ? "traditional" : "agent"} mode`}
        >
          <span className="mode-toggle-track">
            <span className="mode-toggle-thumb" />
          </span>
          <span className="mode-toggle-label">
            {isAgent ? "Agent" : "Traditional"}
          </span>
        </button>
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
        <NavLink to="/environments" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9679;</span>
          Environments
        </NavLink>
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
