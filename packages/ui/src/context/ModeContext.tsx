import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type DeployMode = "traditional" | "agent";

interface ModeContextValue {
  mode: DeployMode;
  toggleMode: () => void;
  setMode: (mode: DeployMode) => void;
}

const ModeContext = createContext<ModeContextValue>({
  mode: "traditional",
  toggleMode: () => {},
  setMode: () => {},
});

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DeployMode>(() => {
    try {
      const stored = localStorage.getItem("deploystack-mode");
      if (stored === "agent" || stored === "traditional") return stored;
    } catch {
      // localStorage not available
    }
    return "traditional";
  });

  const setMode = useCallback((next: DeployMode) => {
    setModeState(next);
    try {
      localStorage.setItem("deploystack-mode", next);
    } catch {
      // localStorage not available
    }
  }, []);

  const toggleMode = useCallback(() => {
    setMode(mode === "traditional" ? "agent" : "traditional");
  }, [mode, setMode]);

  return (
    <ModeContext.Provider value={{ mode, toggleMode, setMode }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode() {
  return useContext(ModeContext);
}
