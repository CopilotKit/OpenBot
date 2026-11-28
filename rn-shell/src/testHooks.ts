/**
 * TEST BUILDS ONLY. Read from the launch arguments (iOS: `-openbot.base_url http://…`; Android: the
 * launch intent's extras, as Maestro's `launchApp: arguments:` or `adb shell am start --es` set them).
 * src/config.ts requires this file only when the bundle was built with
 * EXPO_PUBLIC_OPENBOT_TEST_BUILD=1, so a store build has none of these names in it.
 */
import ShellNative from "../modules/shell-native/src";

export type TestHooks = {
  /** `openbot.base_url`: the server (a mock stack, the probe). */
  baseUrl: string | null;
  /** `openbot.reset=1`: the web view's whole data store is cleared at launch. */
  reset: boolean;
  /** `openbot.test_session_cookie=V`: `__Secure-better-auth.session_token` (https) before the first load. */
  sessionCookie: string | null;
  /** `openbot.plain_session_cookie=V`: `better-auth.session_token` (the http mock's name). */
  plainSessionCookie: string | null;
  /** `openbot.stale_session=1`: `better-auth.session_token=stale`, a session the server does not know. */
  staleSession: boolean;
  /** `openbot.handoff_auto=1`: `&auto=1` on the hand-off (the mock follows its link by itself). */
  handoffAuto: boolean;
  /** `openbot.force_offline=1` / `openbot.force_offline_seconds=N`. */
  forceOffline: boolean;
  forceOfflineSeconds: number;
  /** `openbot.delay_first_load_ms=N`: the first page load starts late (to see the skeleton). */
  delayFirstLoadMs: number;
  /** `openbot.probe_url=URL`: loads URL at launch with the enter header (the header probe). */
  probeUrl: string | null;
  /** `openbot.diagnostics=1`: log lines prefixed OPENBOT_DIAG (redacted as always). */
  diagnostics: boolean;
  /** `openbot.test_name`: names the run in the log. */
  testName: string | null;
  /** `openbot.force_dark=1`. */
  forceDark: boolean;
  /** `openbot.software_layer=1`: Android draws the web view in software (recordings only: the
   * emulator's GPU ghosts some pages, as it did for the native shell). */
  softwareLayer: boolean;
};

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function httpUrl(value: string | undefined): string | null {
  return value && /^https?:\/\/[^\s]+$/i.test(value) ? value : null;
}

export function readTestHooks(): TestHooks {
  let args: Record<string, string> = {};
  try {
    args = ShellNative.launchArguments();
  } catch {
    args = {};
  }
  return {
    baseUrl: httpUrl(args["openbot.base_url"]),
    reset: flag(args["openbot.reset"]),
    sessionCookie: args["openbot.test_session_cookie"] || null,
    plainSessionCookie: args["openbot.plain_session_cookie"] || null,
    staleSession: flag(args["openbot.stale_session"]),
    handoffAuto: flag(args["openbot.handoff_auto"]),
    forceOffline: flag(args["openbot.force_offline"]),
    forceOfflineSeconds:
      Number(args["openbot.force_offline_seconds"] ?? 0) || 0,
    delayFirstLoadMs: Number(args["openbot.delay_first_load_ms"] ?? 0) || 0,
    probeUrl: httpUrl(args["openbot.probe_url"]),
    diagnostics: true,
    testName: args["openbot.test_name"] ?? null,
    forceDark: flag(args["openbot.force_dark"]),
    softwareLayer: flag(args["openbot.software_layer"]),
  };
}
