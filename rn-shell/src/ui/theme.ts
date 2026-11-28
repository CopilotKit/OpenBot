import { useColorScheme } from "react-native";
import { hooks } from "../config";
import { scheme } from "../scheme";

export type Colors = {
  background: string;
  foreground: string;
  mutedForeground: string;
  card: string;
  muted: string;
  border: string;
  primary: string;
  primaryForeground: string;
  dark: boolean;
};

export function colorsFor(dark: boolean): Colors {
  const set = dark ? scheme.dark : scheme.light;
  return {
    background: set.background,
    foreground: set.foreground,
    mutedForeground: set["muted-foreground"],
    card: set.card,
    muted: set.muted,
    border: set.border,
    primary: set.primary,
    primaryForeground: set["primary-foreground"],
    dark,
  };
}

/** The system's light or dark (or dark for good, with a test build's `openbot.force_dark`). */
export function useColors(): Colors {
  const system = useColorScheme();
  return colorsFor(hooks.forceDark || system === "dark");
}
