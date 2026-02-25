import { NavLink } from "react-router";

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <h1>DeployStack</h1>
        <span>Traditional Mode</span>
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
        <NavLink to="/tenants" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9670;</span>
          Tenants
        </NavLink>
        <NavLink to="/deploy" className={({ isActive }) => isActive ? "active" : ""}>
          <span className="nav-icon">&#9650;</span>
          New Deployment
        </NavLink>
      </nav>
      <div className="sidebar-footer">
        <div className="text-muted">v0.1.0</div>
      </div>
    </aside>
  );
}
