import AgentCanvas from "./components/AgentCanvas.js";
import LlmGate from "./components/LlmGate.js";
import { SettingsProvider } from "./context/SettingsContext.js";
import { CanvasProvider } from "./context/CanvasContext.js";
import { AuthProvider, useAuth } from "./context/AuthContext.js";
import Login from "./pages/Login.js";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, needsSetup, loading, error, login, register, logout } = useAuth();

  if (loading) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-header">
            <h1 className="login-title">DeployStack</h1>
            <p className="login-subtitle">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Login
        onLogin={login}
        onRegister={register}
        needsSetup={needsSetup}
        error={error}
      />
    );
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <SettingsProvider>
          <LlmGate>
            <CanvasProvider>
              <div className="v2-layout">
                <AgentCanvas />
              </div>
            </CanvasProvider>
          </LlmGate>
        </SettingsProvider>
      </AuthGate>
    </AuthProvider>
  );
}
