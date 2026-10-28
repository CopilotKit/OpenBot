import { type BrowserMode, browserModeFromEnv } from "./browser-mode";

export type BrowserRuntime = {
  backend: "managed" | "local-chrome";
  channel: "chromium" | "chrome";
  mode: BrowserMode;
  useVirtualDisplay: boolean;
  hostname?: "127.0.0.1";
  allowExec: boolean;
};

/** The same launch decision is used by profiles and the computer HTTP process. */
export function browserRuntimeFromEnv(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): BrowserRuntime {
  const backend = env.COMPUTER_BROWSER_BACKEND?.trim() || "managed";
  if (backend !== "managed" && backend !== "local-chrome") {
    throw new Error(
      "COMPUTER_BROWSER_BACKEND must be managed or local-chrome.",
    );
  }
  const local = backend === "local-chrome";
  /*
   * Headed wherever a hosted computer runs, which is Linux: a container, a Kubernetes pod, the
   * desktop app's Podman machine. Headless Chromium is the browser bot checks are best at spotting
   * (it says `HeadlessChrome`, renders without a GPU path a person's browser has, and is missing what
   * a windowed browser has), and Cloudflare in front of ChatGPT, Canva and the like challenges it on
   * sight. The window goes to the in-container X server (`virtual-display.ts`), so nothing appears
   * anywhere and the live screen is unchanged. A developer running this directly on a Mac or Windows
   * keeps headless, where a headed default would open windows on their desktop.
   * `COMPUTER_BROWSER_MODE=headless` still chooses headless anywhere.
   */
  const mode = browserModeFromEnv(
    env.COMPUTER_BROWSER_MODE?.trim() ||
      (local || platform === "linux" ? "headed" : "headless"),
  );
  if (local && mode !== "headed") {
    throw new Error(
      "COMPUTER_BROWSER_BACKEND=local-chrome requires COMPUTER_BROWSER_MODE=headed.",
    );
  }
  return {
    backend,
    channel: local ? "chrome" : "chromium",
    mode,
    useVirtualDisplay: platform === "linux" && mode === "headed",
    ...(local ? { hostname: "127.0.0.1" as const } : {}),
    allowExec: !local,
  };
}
