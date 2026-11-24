import { scheme } from "./scheme";

/**
 * The app's colours, from OpenBot's scheme (src/scheme.ts, written from tokens/src/scheme.ts). Apart
 * from ui.tsx so the words and colours of a status are testable without React Native. Light only,
 * as the screens are drawn today. This file goes as the screens move to Uniwind
 * (docs/app-guidelines.md).
 */
export const colors = {
  // The one colour outside the scheme, kept until the screens move: a tappable word.
  link: "#2563eb",
  error: scheme.light.destructive,
  muted: scheme.light["muted-foreground"],
  border: scheme.light.border,
  success: scheme.light.success,
  warning: scheme.light.warning,
};
