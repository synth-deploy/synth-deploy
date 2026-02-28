import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router";
import App from "./App.js";
import Dashboard from "./pages/Dashboard.js";
import Projects from "./pages/Projects.js";
import ProjectDetail from "./pages/ProjectDetail.js";
import Partitions from "./pages/Partitions.js";
import PartitionDetail from "./pages/PartitionDetail.js";
import Environments from "./pages/Environments.js";
import EnvironmentDetail from "./pages/EnvironmentDetail.js";
import DeploymentDetail from "./pages/DeploymentDetail.js";
import Orders from "./pages/Orders.js";
import OrderDetail from "./pages/OrderDetail.js";
import NewDeployment from "./pages/NewDeployment.js";
import Debrief from "./pages/Debrief.js";
import Settings from "./pages/Settings.js";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Dashboard />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="partitions" element={<Partitions />} />
          <Route path="partitions/:id" element={<PartitionDetail />} />
          <Route path="environments" element={<Environments />} />
          <Route path="environments/:id" element={<EnvironmentDetail />} />
          <Route path="deployments/:id" element={<DeploymentDetail />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/:id" element={<OrderDetail />} />
          <Route path="deploy" element={<NewDeployment />} />
          <Route path="debrief" element={<Debrief />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
