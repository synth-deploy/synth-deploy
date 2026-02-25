import { Outlet } from "react-router";
import Sidebar from "./components/Sidebar.js";

export default function App() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
