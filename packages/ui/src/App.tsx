import AgentCanvas from "./components/AgentCanvas.js";
import LlmGate from "./components/LlmGate.js";
import { SettingsProvider } from "./context/SettingsContext.js";
import { CanvasProvider } from "./context/CanvasContext.js";

export default function App() {
  return (
    <SettingsProvider>
      <LlmGate>
        <CanvasProvider>
          <div className="v2-layout">
            <AgentCanvas />
          </div>
        </CanvasProvider>
      </LlmGate>
    </SettingsProvider>
  );
}
