export type BrowserMode = "headless" | "headed";

/** Choose the browser process an operator asked for, preserving the existing default. */
export function browserModeFromEnv(raw: string | undefined): BrowserMode {
  const mode = raw?.trim() || "headless";
  if (mode === "headless" || mode === "headed") return mode;
  throw new Error(
    `COMPUTER_BROWSER_MODE must be headless or headed, not ${JSON.stringify(mode)}.`,
  );
}
