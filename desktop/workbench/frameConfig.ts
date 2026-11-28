import type { Answer } from "../src/fakeNative/control";

export type Os = "mac" | "windows";

export type EnvValues = Partial<
  Record<
    | "VITE_OPENBOT_CLOUD_ENABLED"
    | "VITE_OPENBOT_CLOUD_URL"
    | "VITE_OPENBOT_CLOUD_WEB_URL"
    | "VITE_OPENBOT_SUPPORT_URL",
    string
  >
>;

/** What one preview frame starts with. Answers never use "script": a URL cannot carry a function. */
export type FrameConfig = {
  hash: string;
  search: string;
  os: Os;
  env: EnvValues;
  answers: Record<string, Answer>;
  /** Undefined follows the system. */
  theme?: "light" | "dark";
};

export const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

export const WINDOWS_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

/**
 * A normal Windows computer: no blocker, no restart owed, and no machine plan, because a WSL
 * machine is never resized (`machine_size::plan` answers nothing for it).
 */
export const WINDOWS_ANSWERS: Record<string, Answer> = {
  windows_blocker: { mode: "value", value: null },
  windows_restart_pending: { mode: "value", value: false },
  podman_machine_plan: { mode: "value", value: null },
};

export function frameUrl(config: FrameConfig): string {
  return `/workbench/frame.html${config.search}${config.hash}`;
}

declare global {
  var __workbenchEnv: EnvValues | undefined;
  interface Window {
    __workbenchFrame?: FrameConfig;
  }
}

const EMPTY: FrameConfig = {
  hash: "",
  search: "",
  os: "mac",
  env: {},
  answers: {},
};

export function readFrameConfig(): FrameConfig {
  if (typeof window === "undefined") return { ...EMPTY, env: {}, answers: {} };
  try {
    const found = window.parent?.__workbenchFrame;
    if (window.parent !== window && found) return found;
  } catch {
    // A parent from another origin cannot be read.
  }
  return { ...EMPTY, env: {}, answers: {} };
}
