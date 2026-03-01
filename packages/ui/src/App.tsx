import AgentCanvas from "./components/AgentCanvas.js";
import { SettingsProvider } from "./context/SettingsContext.js";
import { CanvasProvider } from "./context/CanvasContext.js";

export default function App() {
  return (
    <SettingsProvider>
      <CanvasProvider>
        <div className="v2-layout">
          <AgentCanvas />
        </div>
      </CanvasProvider>
    </SettingsProvider>
  );
}
