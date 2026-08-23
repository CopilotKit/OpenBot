export const THEME_STORAGE_KEY = "openbot-theme";

export function parseStoredDarkTheme(value: string | null) {
  return value === "dark";
}

type ThemeEffects = {
  setStoredValue: (key: string, value: string) => void;
  toggleRootClass: (name: string, force: boolean) => void;
  setRootColorScheme: (scheme: "dark" | "light") => void;
};

export function applyDarkTheme(dark: boolean, effects: ThemeEffects) {
  effects.setStoredValue(THEME_STORAGE_KEY, dark ? "dark" : "light");
  effects.toggleRootClass("dark", dark);
  // `index.html` sets this inline before paint, and an inline style outranks the palette.
  effects.setRootColorScheme(dark ? "dark" : "light");
}
