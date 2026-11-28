import type { ITheme } from "@xterm/xterm";

/**
 * A dark terminal in both of the app's themes: a shade deeper than the app's own dark ground, so it
 * reads as a terminal in the dark theme too, with the app's periwinkle ring as the cursor. Its sixteen
 * colours are tuned for that ground.
 */
export const TERMINAL_THEME: ITheme = {
  background: "#060b12",
  foreground: "#eff1f3",
  cursor: "#8d97ff",
  cursorAccent: "#060b12",
  selectionBackground: "#8d97ff4d",
  selectionInactiveBackground: "#8d97ff26",
  black: "#131920",
  red: "#ff8a8f",
  green: "#5fe3bb",
  yellow: "#f5d27a",
  blue: "#8d97ff",
  magenta: "#d4a5ff",
  cyan: "#7fd8f0",
  white: "#c6cbd1",
  brightBlack: "#666e78",
  brightRed: "#ffadb1",
  brightGreen: "#8ff0d0",
  brightYellow: "#ffe2a0",
  brightBlue: "#b3baff",
  brightMagenta: "#e5c4ff",
  brightCyan: "#a8e6f6",
  brightWhite: "#eff1f3",
};

/** The terminal's ground, for the frame around it. */
export const TERMINAL_BACKGROUND = TERMINAL_THEME.background as string;

/** The terminal's own text colours, for what is drawn around it without xterm.js: the chat's command blocks. */
export const TERMINAL_TEXT = {
  foreground: TERMINAL_THEME.foreground as string,
  muted: "#9fa6af",
  prompt: TERMINAL_THEME.brightBlue as string,
} as const;
