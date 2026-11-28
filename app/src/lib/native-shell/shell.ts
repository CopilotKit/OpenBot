/**
 * OpenBot inside its phone app: the web app loaded in a native shell (a WKWebView on iOS, a
 * WebView on Android) that draws its own tab bar (Conversations, Home, Bots) and its own sign-in
 * screen around the page. In the shell the page draws no sidebar and no sign-in of its own, and
 * tells the shell where it is (`bridge.ts`).
 *
 * How the page knows, in this order:
 *
 * 1. `window.__OPENBOT_NATIVE_SHELL__`, which the shell injects before the page's first script:
 *    `{ platform: "ios" | "android", version, bridge: 1 }`.
 * 2. The user agent, which the shell ends with `OpenBotShell-iOS/0.1` (or `OpenBotShell-Android/…`).
 * 3. For testing, `?native-shell=ios`, remembered for the tab in sessionStorage, so a desktop browser
 *    or Playwright can open the shell's layout. The platform it reports is "test". Only in a
 *    development build or on a development host (`developmentHost`): elsewhere a link carrying it
 *    would leave a person with the shell's layout and no shell, signed out with no way to sign in or
 *    signed in with no navigation, until the tab closed. `?native-shell=off` forgets it anywhere, so
 *    a tab that kept it from before can be freed.
 *
 * index.html's inline script runs the same detection before the first paint and marks
 * `<html data-native-shell="…">` for the styles, and widens the viewport to the whole web view
 * (`viewport-fit=cover`) only there. `app/tests/native-shell.test.ts` holds the two to one answer.
 */

/** Which shell: its own platform, or "test" for the query-parameter override. */
export type NativeShellPlatform = "ios" | "android" | "test";

export type NativeShell = { platform: NativeShellPlatform };

/** What the shell injects at document start. */
export type InjectedNativeShell = {
  platform: "ios" | "android";
  version: string;
  bridge: 1;
};

declare global {
  interface Window {
    __OPENBOT_NATIVE_SHELL__?: InjectedNativeShell;
  }
}

/** The query parameter that turns the shell's layout on for a tab (`ios`), or off (`off`). */
export const NATIVE_SHELL_PARAM = "native-shell";
/** Where the tab remembers it. */
export const NATIVE_SHELL_STORAGE_KEY = "openbot-native-shell";
/** The mark on `<html>`, as `dataset.nativeShell`, read by the styles as `[data-native-shell]`. */
export const NATIVE_SHELL_ATTRIBUTE = "data-native-shell";

/** The user agent's mark: `OpenBotShell-iOS/0.1`. */
const USER_AGENT_MARK = /OpenBotShell-(\w+)/;

/**
 * Where the testing override counts: a machine's own addresses and the names kept for development
 * (`.localhost`, `.test`), where the phone apps' UI tests, the workbench and the screenshot scripts
 * open the app. index.html asks the same.
 */
export function developmentHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".test")
  );
}

/** What detection reads, so a test can hand it anything. */
export type NativeShellEnvironment = {
  injected: unknown;
  userAgent: string;
  search: string;
  /** The page's host name: the testing override counts only on a development host. */
  hostname: string;
  /** A development build, where the override counts on any host. */
  dev?: boolean;
  /** The tab's sessionStorage, or null where it can't be read. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
};

/**
 * Applies `?native-shell=` to the tab's memory: `ios` (or `android`, `test`) remembers it, `off`
 * forgets it. Then answers which shell this page is in, or null in a plain browser.
 */
export function detectNativeShell(
  environment: NativeShellEnvironment,
): NativeShell | null {
  const { injected, userAgent, search, storage } = environment;
  const overridable =
    environment.dev === true || developmentHost(environment.hostname);
  const param = new URLSearchParams(search).get(NATIVE_SHELL_PARAM);
  // "off" is honoured anywhere; turning the override on only where it may count.
  const asked = param === "off" || overridable ? param : null;
  try {
    if (asked === "off") storage?.removeItem(NATIVE_SHELL_STORAGE_KEY);
    else if (asked === "ios" || asked === "android" || asked === "test")
      storage?.setItem(NATIVE_SHELL_STORAGE_KEY, "test");
  } catch {
    // Storage refused: the override lasts for this page only.
  }
  if (
    typeof injected === "object" &&
    injected !== null &&
    "platform" in injected &&
    (injected.platform === "ios" || injected.platform === "android")
  )
    return { platform: injected.platform };
  const mark = USER_AGENT_MARK.exec(userAgent);
  if (mark)
    return {
      platform: mark[1].toLowerCase() === "android" ? "android" : "ios",
    };
  if (asked === "ios" || asked === "android" || asked === "test")
    return { platform: "test" };
  if (asked === "off" || !overridable) return null;
  try {
    return storage?.getItem(NATIVE_SHELL_STORAGE_KEY) === "test"
      ? { platform: "test" }
      : null;
  } catch {
    return null;
  }
}

function pageStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** This page's environment. */
function pageEnvironment(): NativeShellEnvironment {
  return {
    injected: window.__OPENBOT_NATIVE_SHELL__,
    userAgent: navigator.userAgent,
    search: window.location.search,
    hostname: window.location.hostname,
    // A boolean under Vite, a string where another build (the Recorder) types the env.
    dev: String(import.meta.env.DEV) === "true",
    storage: pageStorage(),
  };
}

let detected: NativeShell | null | undefined;

/**
 * The native shell this page is in, or null in a browser, OpenBot Desktop included. Worked out once,
 * on the first call, and the same answer after: a page does not move into or out of a shell.
 */
export function nativeShell(): NativeShell | null {
  if (detected === undefined) {
    detected =
      typeof window === "undefined"
        ? null
        : detectNativeShell(pageEnvironment());
  }
  return detected;
}

/** For tests: forget the answer, so the next call works it out again. */
export function forgetNativeShellForTests(): void {
  detected = undefined;
}

/**
 * Marks `<html>` for the styles, as index.html's inline script already did before the first paint.
 * Again here for a page whose script could not run it; idempotent.
 */
export function markNativeShell(root: HTMLElement = document.documentElement) {
  const shell = nativeShell();
  if (shell) root.dataset.nativeShell = shell.platform;
}
