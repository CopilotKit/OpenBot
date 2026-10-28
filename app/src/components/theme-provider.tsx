import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  applyTheme,
  LEGACY_THEME_STORAGE_KEY,
  parseThemePreference,
  type ResolvedTheme,
  resolveTheme,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

type ThemeContextValue = {
  /** What the person chose: follow the system, or always light or dark. */
  preference: ThemePreference;
  /** What is drawn right now. */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Storage throws in some privacy modes; a theme is not worth taking the app down for. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function systemDarkNow(): boolean {
  return window.matchMedia?.(SYSTEM_DARK_QUERY).matches ?? false;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    parseThemePreference(
      readStored(THEME_STORAGE_KEY),
      readStored(LEGACY_THEME_STORAGE_KEY),
    ),
  );
  const [systemDark, setSystemDark] = useState(systemDarkNow);

  // The system's setting, live: it changes at sunset without anybody reloading.
  useEffect(() => {
    const query = window.matchMedia?.(SYSTEM_DARK_QUERY);
    if (!query) return;
    const follow = () => setSystemDark(query.matches);
    follow();
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);

  const resolved = resolveTheme(preference, systemDark);
  useEffect(() => {
    applyTheme(resolved, {
      toggleRootClass: (name, force) =>
        document.documentElement.classList.toggle(name, force),
      setRootColorScheme: (scheme) => {
        document.documentElement.style.colorScheme = scheme;
      },
    });
  }, [resolved]);

  // Written only when the person chooses, so following the system stays the default until they do.
  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The choice holds for this visit; it just isn't remembered.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return value;
}
