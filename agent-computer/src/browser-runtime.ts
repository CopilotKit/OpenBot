import { browserModeFromEnv, type BrowserMode } from "./browser-mode";

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
  const mode = browserModeFromEnv(
    env.COMPUTER_BROWSER_MODE?.trim() || (local ? "headed" : "headless"),
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
