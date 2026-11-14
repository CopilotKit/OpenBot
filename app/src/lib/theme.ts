export const THEME_STORAGE_KEY = "openbot-theme";

/** The system's own setting, as the browser reports it. */
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

/** What a person chose: the system's light or dark, or one of their own. */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES = [
  "system",
  "light",
  "dark",
] as const satisfies ReadonlyArray<ThemePreference>;

/**
 * The saved choice. Nothing saved is the system's. A saved "light" or "dark" is that person's own,
 * including one saved by a release from before OpenBot followed the system.
 */
export function parseStoredTheme(value: string | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

/** Whether the app is dark: the person's own choice, or the system's when they follow it. */
export function resolveDarkTheme(
  preference: ThemePreference,
  systemDark: boolean,
) {
  return preference === "system" ? systemDark : preference === "dark";
}

type ThemeEffects = {
  setStoredValue: (key: string, value: string) => void;
  removeStoredValue: (key: string) => void;
  toggleRootClass: (name: string, force: boolean) => void;
  setRootColorScheme: (scheme: "dark" | "light") => void;
};

export function applyTheme(
  preference: ThemePreference,
  systemDark: boolean,
  effects: ThemeEffects,
) {
  const dark = resolveDarkTheme(preference, systemDark);
  // Following the system saves nothing, which is what `index.html` reads before the first paint.
  if (preference === "system") effects.removeStoredValue(THEME_STORAGE_KEY);
  else effects.setStoredValue(THEME_STORAGE_KEY, preference);
  effects.toggleRootClass("dark", dark);
  // `index.html` sets this inline before paint, and an inline style outranks the palette.
  effects.setRootColorScheme(dark ? "dark" : "light");
}
