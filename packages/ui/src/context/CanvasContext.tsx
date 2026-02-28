import { createContext, useContext, useReducer, type ReactNode } from "react";

export interface CanvasPanel {
  id: string;
  type: string;
  title: string;
  params: Record<string, string>;
}

interface CanvasState {
  panels: CanvasPanel[];
}

type CanvasAction =
  | { type: "PUSH"; panel: Omit<CanvasPanel, "id"> }
  | { type: "POP" }
  | { type: "REPLACE"; panel: Omit<CanvasPanel, "id"> }
  | { type: "RESET" };

function canvasReducer(state: CanvasState, action: CanvasAction): CanvasState {
  switch (action.type) {
    case "PUSH":
      return {
        panels: [...state.panels, { ...action.panel, id: crypto.randomUUID() }],
      };
    case "POP":
      // Never pop the overview (index 0)
      if (state.panels.length <= 1) return state;
      return { panels: state.panels.slice(0, -1) };
    case "REPLACE":
      // Replace the topmost panel (keep overview if it's the only one)
      if (state.panels.length <= 1) {
        return { panels: [{ ...action.panel, id: crypto.randomUUID() }] };
      }
      return {
        panels: [...state.panels.slice(0, -1), { ...action.panel, id: crypto.randomUUID() }],
      };
    case "RESET":
      return { panels: [OVERVIEW_PANEL] };
    default:
      return state;
  }
}

const OVERVIEW_PANEL: CanvasPanel = {
  id: "overview",
  type: "overview",
  title: "Operational Overview",
  params: {},
};

interface CanvasContextValue {
  panels: CanvasPanel[];
  currentPanel: CanvasPanel;
  pushPanel: (panel: Omit<CanvasPanel, "id">) => void;
  popPanel: () => void;
  replacePanel: (panel: Omit<CanvasPanel, "id">) => void;
  resetToOverview: () => void;
  depth: number;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

export function CanvasProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(canvasReducer, {
    panels: [OVERVIEW_PANEL],
  });

  const value: CanvasContextValue = {
    panels: state.panels,
    currentPanel: state.panels[state.panels.length - 1],
    pushPanel: (panel) => dispatch({ type: "PUSH", panel }),
    popPanel: () => dispatch({ type: "POP" }),
    replacePanel: (panel) => dispatch({ type: "REPLACE", panel }),
    resetToOverview: () => dispatch({ type: "RESET" }),
    depth: state.panels.length,
  };

  return (
    <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>
  );
}

export function useCanvas(): CanvasContextValue {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error("useCanvas must be used within CanvasProvider");
  return ctx;
}
