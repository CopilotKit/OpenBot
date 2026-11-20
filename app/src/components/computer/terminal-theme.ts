import type { ITheme } from "@xterm/xterm";

/**
 * A dark terminal in both of the app's themes: a shade deeper than the app's own dark ground, so it
 * reads as a terminal in the dark theme too, with the app's periwinkle ring as the cursor. Its sixteen
 * colours are tuned for that ground.
 */
export const TERMINAL_THEME: ITheme = {
  background: "#0b0a10",
  foreground: "#f0f0f4",
  cursor: "#8d97ff",
  cursorAccent: "#0b0a10",
  selectionBackground: "#8d97ff4d",
  selectionInactiveBackground: "#8d97ff26",
  black: "#1a1624",
  red: "#ff8a8f",
  green: "#5fe3bb",
  yellow: "#f5d27a",
  blue: "#8d97ff",
  magenta: "#d4a5ff",
  cyan: "#7fd8f0",
  white: "#c9c9d4",
  brightBlack: "#6e6a7d",
  brightRed: "#ffadb1",
  brightGreen: "#8ff0d0",
  brightYellow: "#ffe2a0",
  brightBlue: "#b3baff",
  brightMagenta: "#e5c4ff",
  brightCyan: "#a8e6f6",
  brightWhite: "#f0f0f4",
};

/** The terminal's ground, for the frame around it. */
export const TERMINAL_BACKGROUND = TERMINAL_THEME.background as string;

/** The terminal's own text colours, for what is drawn around it without xterm.js: the chat's command blocks. */
export const TERMINAL_TEXT = {
  foreground: TERMINAL_THEME.foreground as string,
  muted: "#a6a3b4",
  prompt: TERMINAL_THEME.brightBlue as string,
} as const;
