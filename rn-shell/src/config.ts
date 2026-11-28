import Constants from "expo-constants";
import { Platform } from "react-native";
import type { TestHooks } from "./testHooks";

/**
 * The app's fixed settings. A store build talks to https://my.open.bot and nothing else: the test
 * hooks (src/testHooks.ts) are only compiled in when the bundle is built with
 * EXPO_PUBLIC_OPENBOT_TEST_BUILD=1 (babel-preset-expo inlines the value, and Metro drops the dead
 * branch and the module with it; CI greps the store bundle for the hooks' names to prove it).
 */
export const RELEASE_BASE_URL = "https://my.open.bot";

export const TEST_BUILD = process.env.EXPO_PUBLIC_OPENBOT_TEST_BUILD === "1";

export const NO_HOOKS: TestHooks = {
  baseUrl: null,
  reset: false,
  sessionCookie: null,
  plainSessionCookie: null,
  staleSession: false,
  handoffAuto: false,
  forceOffline: false,
  forceOfflineSeconds: 0,
  delayFirstLoadMs: 0,
  probeUrl: null,
  diagnostics: false,
  testName: null,
  forceDark: false,
  softwareLayer: false,
};

function loadHooks(): TestHooks {
  if (process.env.EXPO_PUBLIC_OPENBOT_TEST_BUILD === "1") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (
      require("./testHooks") as typeof import("./testHooks")
    ).readTestHooks();
  }
  return NO_HOOKS;
}

export const hooks: TestHooks = loadHooks();

function normalizedOrigin(url: string): string {
  return url.replace(/\/+$/, "");
}

export const BASE_URL = normalizedOrigin(hooks.baseUrl ?? RELEASE_BASE_URL);
export const BASE_HOST = BASE_URL.replace(/^https?:\/\//, "").replace(
  /[:/].*$/,
  "",
);
export const PLATFORM: "ios" | "android" =
  Platform.OS === "ios" ? "ios" : "android";
export const VERSION: string = Constants.expoConfig?.version ?? "0.1.0";
export const USER_AGENT_MARK = `${PLATFORM === "ios" ? "OpenBotShell-iOS" : "OpenBotShell-Android"}/${VERSION}`;
