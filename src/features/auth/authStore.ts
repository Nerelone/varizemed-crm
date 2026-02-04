import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { useToast } from "../../shared/ui/Toast";
import { fetchProfile, saveProfile } from "./authApi";

export type AuthState = {
  username: string;
  displayName: string;
  usePrefix: boolean;
  isLoaded: boolean;
};

type AuthContextValue = AuthState & {
  loadProfile: () => Promise<void>;
  saveProfile: (displayName: string, usePrefix: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const DISPLAY_NAME_KEY = "crm_display_name";
const USE_PREFIX_KEY = "crm_use_prefix";

export function AuthProvider({ children }: { children: ReactNode }) {
  const { push } = useToast();
  const [state, setState] = useState<AuthState>(() => ({
    username: "",
    displayName: localStorage.getItem(DISPLAY_NAME_KEY) || "",
    usePrefix: localStorage.getItem(USE_PREFIX_KEY) === "true",
    isLoaded: false
  }));

  const loadProfile = useCallback(async () => {
    try {
      const profile = await fetchProfile();
      const displayName = profile.display_name || "";
      const usePrefix = profile.use_prefix || false;

      localStorage.setItem(DISPLAY_NAME_KEY, displayName);
      localStorage.setItem(USE_PREFIX_KEY, String(usePrefix));

      setState({
        username: profile.username || "",
        displayName,
        usePrefix,
        isLoaded: true
      });
    } catch (error) {
      console.error("Erro ao carregar perfil:", error);
      push("Erro ao carregar perfil do usuário");
      setState((prev) => ({ ...prev, isLoaded: true }));
    }
  }, [push]);

  const persistProfile = useCallback(async (displayName: string, usePrefix: boolean) => {
    if (!displayName.trim()) {
      push("Nome de exibição é obrigatório");
      return;
    }

    try {
      await saveProfile({ display_name: displayName.trim(), use_prefix: usePrefix });
      localStorage.setItem(DISPLAY_NAME_KEY, displayName.trim());
      localStorage.setItem(USE_PREFIX_KEY, String(usePrefix));

      setState((prev) => ({
        ...prev,
        displayName: displayName.trim(),
        usePrefix
      }));
      push("Configurações salvas!");
    } catch (error) {
      console.error("Erro ao salvar perfil:", error);
      push(`Erro ao salvar: ${(error as Error)?.message || "Erro desconhecido"}`);
    }
  }, [push]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const value = useMemo<AuthContextValue>(() => ({
    ...state,
    loadProfile,
    saveProfile: persistProfile
  }), [state, loadProfile, persistProfile]);

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
