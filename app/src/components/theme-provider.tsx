import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  applyTheme,
  parseStoredTheme,
  resolveDarkTheme,
  SYSTEM_DARK_QUERY,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

type ThemeContextValue = {
  /** What the person chose: the system's light or dark, or one of their own. */
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  /** Whether the app is dark right now. */
  dark: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** The system's light or dark, live: the browser says when it changes. */
function subscribeToSystemDark(changed: () => void) {
  const query = window.matchMedia(SYSTEM_DARK_QUERY);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}

function systemIsDark() {
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState(() =>
    parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY)),
  );
  const systemDark = useSyncExternalStore(subscribeToSystemDark, systemIsDark);

  useEffect(() => {
    applyTheme(theme, systemDark, {
      setStoredValue: (key, value) => window.localStorage.setItem(key, value),
      removeStoredValue: (key) => window.localStorage.removeItem(key),
      toggleRootClass: (name, force) =>
        document.documentElement.classList.toggle(name, force),
      setRootColorScheme: (scheme) => {
        document.documentElement.style.colorScheme = scheme;
      },
    });
  }, [theme, systemDark]);

  return (
    <ThemeContext.Provider
      value={{ theme, setTheme, dark: resolveDarkTheme(theme, systemDark) }}
    >
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
