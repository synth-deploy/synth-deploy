import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

interface ThemeContextValue {
  theme: ResolvedTheme;
  preference: ThemePreference;
  setTheme: (pref: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem("synth-theme");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
  });

  const theme = resolveTheme(preference);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("synth-theme", preference);
  }, [theme, preference]);

  // Re-resolve when system preference changes
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => document.documentElement.setAttribute("data-theme", resolveTheme("system"));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  const setTheme = (pref: ThemePreference) => setPreference(pref);
  const toggle = () => setPreference((p) => (resolveTheme(p) === "light" ? "dark" : "light"));

  return (
    <ThemeContext.Provider value={{ theme, preference, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
