import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { setAuthToken, authLogin, authRegister, authRefresh, authMe, authStatus } from "../api.js";

interface UserPublic {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

type Permission = string;

interface AuthContextType {
  user: UserPublic | null;
  permissions: Permission[];
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
  needsSetup: boolean;
  loading: boolean;
  error: string | null;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  permissions: [],
  token: null,
  login: async () => {},
  register: async () => {},
  logout: async () => {},
  isAuthenticated: false,
  needsSetup: false,
  loading: true,
  error: null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [refreshToken, setRefreshTokenState] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check initial auth state
  useEffect(() => {
    async function checkAuth() {
      try {
        // Check if system needs first-user setup
        const status = await authStatus();
        if (status.needsSetup) {
          setNeedsSetup(true);
          setLoading(false);
          return;
        }

        // Try to restore session from stored refresh token
        const storedRefresh = sessionStorage.getItem("deploystack_refresh_token");
        if (storedRefresh) {
          try {
            const result = await authRefresh(storedRefresh);
            setToken(result.token);
            setRefreshTokenState(result.refreshToken);
            setAuthToken(result.token);
            sessionStorage.setItem("deploystack_refresh_token", result.refreshToken);

            // Fetch user info
            const me = await authMe();
            setUser(me.user);
            setPermissions(me.permissions);
          } catch {
            // Refresh failed — need to log in again
            sessionStorage.removeItem("deploystack_refresh_token");
          }
        }
      } catch {
        // Status endpoint failed — server might be down
      }
      setLoading(false);
    }
    checkAuth();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const result = await authLogin(email, password);
      setToken(result.token);
      setRefreshTokenState(result.refreshToken);
      setAuthToken(result.token);
      setUser(result.user);
      setPermissions(result.permissions);
      sessionStorage.setItem("deploystack_refresh_token", result.refreshToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Login failed";
      setError(message);
      throw err;
    }
  }, []);

  const register = useCallback(async (email: string, name: string, password: string) => {
    setError(null);
    try {
      const result = await authRegister(email, name, password);
      setToken(result.token);
      setRefreshTokenState(result.refreshToken);
      setAuthToken(result.token);
      setUser(result.user);
      setPermissions(result.permissions);
      setNeedsSetup(false);
      sessionStorage.setItem("deploystack_refresh_token", result.refreshToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Registration failed";
      setError(message);
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      // Call server logout
      const BASE = "";
      await fetch(`${BASE}/api/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      // Ignore logout errors
    }
    setToken(null);
    setRefreshTokenState(null);
    setUser(null);
    setPermissions([]);
    setAuthToken(null);
    sessionStorage.removeItem("deploystack_refresh_token");
  }, [token]);

  return (
    <AuthContext.Provider
      value={{
        user,
        permissions,
        token,
        login,
        register,
        logout,
        isAuthenticated: !!token && !!user,
        needsSetup,
        loading,
        error,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  return useContext(AuthContext);
}
