import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router";
import App from "./App.js";
import Dashboard from "./pages/Dashboard.js";
import Projects from "./pages/Projects.js";
import ProjectDetail from "./pages/ProjectDetail.js";
import Tenants from "./pages/Tenants.js";
import TenantDetail from "./pages/TenantDetail.js";
import DeploymentDetail from "./pages/DeploymentDetail.js";
import NewDeployment from "./pages/NewDeployment.js";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Dashboard />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="tenants" element={<Tenants />} />
          <Route path="tenants/:id" element={<TenantDetail />} />
          <Route path="deployments/:id" element={<DeploymentDetail />} />
          <Route path="deploy" element={<NewDeployment />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
