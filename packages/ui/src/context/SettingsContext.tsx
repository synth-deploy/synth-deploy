import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { getSettings, updateSettings } from "../api.js";
import type { AppSettings } from "../types.js";

interface SettingsContextValue {
  settings: AppSettings | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: null,
  loading: true,
  refresh: async () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await getSettings();
      setSettings(s);
    } catch {
      // Settings fetch failed — defaults will be used via ?? fallbacks
    }
  }, []);

  useEffect(() => {
    refresh().then(() => setLoading(false));
  }, [refresh]);

  return (
    <SettingsContext.Provider value={{ settings, loading, refresh }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
