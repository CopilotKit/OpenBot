/**
 * How a person's browser is launched: which browser, with which switches, and with which of the
 * person's own native messaging hookups.
 *
 * A PERSON'S BROWSER IS NOT A BOT'S. A Bot's browser is a test browser on purpose: Playwright's
 * defaults make it deterministic, and nothing the person installs belongs in it. A person's browser
 * is their everyday browser (OpenBot Desktop opens their installed Chrome, or Edge, in a dedicated
 * OpenBot profile), and the same defaults would quietly take most of that away: no extensions, so
 * no password manager; no sync, so no Google sign-in; a mock keychain, so no saved passwords; no
 * component updates, so no streaming video. So a person's native browser drops every Playwright
 * default OpenBot's control does not need, each one decided below, and a Bot's launch is untouched.
 *
 * The hosted person's browser is the computer's bundled Chromium, shown through the live screen.
 * It keeps a Bot's launch except for what the Recorder needs: extensions on, and only the Recorder.
 *
 * Free of Playwright, so the decisions can be tested without launching anything.
 */
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type {
  BrowserProduct,
  BrowserWindow,
} from "../../shared/openbot-browser";
import type { BrowserRuntime } from "./browser-runtime";

type Environment = Record<string, string | undefined>;

/** An installed, branded browser OpenBot can open a person's window in, in the order it is preferred. */
export type InstalledBrowser = Extract<BrowserProduct, "chrome" | "msedge">;
export const INSTALLED_BROWSERS: readonly InstalledBrowser[] = [
  "chrome",
  "msedge",
];

const NAMES: Record<InstalledBrowser, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
};

/** Where the person's browser shows: a native window on Desktop, the live screen when hosted. */
export function personWindow(runtime: BrowserRuntime): BrowserWindow {
  return runtime.backend === "local-chrome" ? "native" : "screen";
}

/**
 * Where each browser installs, matching Playwright's own stable-channel lookup, so the browser this
 * finds is the one `channel` then launches. Never an executable from a request.
 */
export function browserExecutableCandidates(
  browser: InstalledBrowser,
  env: Environment,
  platform: string = process.platform,
): string[] {
  if (platform === "darwin")
    return browser === "chrome"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  if (platform === "linux")
    return browser === "chrome"
      ? ["/opt/google/chrome/chrome"]
      : ["/opt/microsoft/msedge/msedge"];
  if (platform === "win32") {
    const suffix =
      browser === "chrome"
        ? ["Google", "Chrome", "Application", "chrome.exe"]
        : ["Microsoft", "Edge", "Application", "msedge.exe"];
    return [
      env.LOCALAPPDATA,
      env.PROGRAMFILES,
      env["PROGRAMFILES(X86)"],
      ...(env.HOMEDRIVE
        ? [
            win32.join(env.HOMEDRIVE, "Program Files"),
            win32.join(env.HOMEDRIVE, "Program Files (x86)"),
          ]
        : []),
    ]
      .filter((prefix): prefix is string => Boolean(prefix))
      .map((prefix) => win32.join(prefix, ...suffix));
  }
  throw new Error(`A person's browser is not supported on ${platform}.`);
}

async function runnable(path: string, platform: string): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}

/**
 * Google Chrome when it is installed, otherwise Microsoft Edge, otherwise nothing.
 *
 * Chrome first because it is what most people already use and sign in to; Edge because it ships
 * with Windows, so a Windows machine without Chrome still has a browser Google and Microsoft keep
 * patched. Never a bundled Chromium on the desktop: it does not update itself and cannot use Google
 * sign-in or sync.
 */
export async function installedBrowser(
  env: Environment,
  platform: string = process.platform,
): Promise<InstalledBrowser | null> {
  for (const browser of INSTALLED_BROWSERS) {
    for (const candidate of browserExecutableCandidates(
      browser,
      env,
      platform,
    )) {
      if (await runnable(candidate, platform)) return browser;
    }
  }
  return null;
}

export const NO_INSTALLED_BROWSER = `Neither ${NAMES.chrome} nor ${NAMES.msedge} was found in its standard installation location. Install one of them to open a browser here.`;

/**
 * Playwright's own Chromium switches (playwright-core 1.62.1, `chromiumSwitches.ts`, plus what its
 * launcher adds) that a person's native browser does not get, each with the reason.
 *
 * `ignoreDefaultArgs` drops a switch only on an exact match, so the `--disable-features` value is
 * spelled out exactly as Playwright builds it. A Playwright upgrade that changes it shows up in
 * `person-browser.test.ts`, which reads the launched browser's own command line, rather than as a
 * switch that silently came back.
 *
 * What stays, and why it stays:
 *   - `--remote-debugging-pipe` and `--user-data-dir`: how OpenBot holds the browser and keeps the
 *     dedicated profile separate from the person's own.
 *   - `--no-first-run`: the first-run flow can hold the first window behind a modal, and the launch
 *     waits on that window. The person signs in to Chrome from its profile menu instead.
 *   - `--no-default-browser-check`: the OpenBot window does not ask to become the default browser.
 *     The person's default browser stays the one they chose.
 *   - `--enable-features=CDPScreenshotNewSurface`: how frames are captured for the live screen.
 *   - `--edge-skip-compat-layer-relaunch`: Edge on Windows can relaunch itself and drop the pipe.
 */
const PLAYWRIGHT_DISABLED_FEATURES = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "BoundaryEventDispatchTracksNodeRemoval",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "Translate",
  "AutoDeElevate",
  "OptimizationHints",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
];

export const PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET: readonly string[] = [
  // Playwright's own `navigator.webdriver` and "controlled by automated software" banner, dropped
  // for Bots too.
  "--enable-automation",
  // The person's own extensions (1Password, Bitwarden, LastPass), and the Recorder itself, which
  // `Extensions.loadUnpacked` installs silently and absent while this is on the command line.
  "--disable-extensions",
  // Chrome sync and Google sign-in: bookmarks, passwords and extensions arrive through it.
  "--disable-sync",
  // The OS credential store: the macOS Keychain, libsecret or KWallet on Linux. Without them saved
  // passwords and the cookie encryption key live in a fixed, readable fallback.
  "--use-mock-keychain",
  "--password-store=basic",
  // Safe Browsing list updates, extension updates and sync all ride on background networking.
  "--disable-background-networking",
  // Component updates bring Widevine (streaming video), certificate revocation lists and Safe
  // Browsing data. Component extensions and default apps are Chrome as it ships.
  "--disable-component-update",
  "--disable-component-extensions-with-background-pages",
  "--disable-default-apps",
  // Safe Browsing's phishing check, the popup blocker, the hang monitor, the resubmit-form prompt,
  // IPC flood protection and the DevTools paste warning all protect the person.
  "--disable-client-side-phishing-detection",
  "--disable-popup-blocking",
  "--disable-hang-monitor",
  "--disable-prompt-on-repost",
  "--disable-ipc-flooding-protection",
  "--unsafely-disable-devtools-self-xss-warnings",
  // Including HTTPS upgrades and third-party storage partitioning, which are security and privacy,
  // and Translate, Cast and Lens, which are features.
  `--disable-features=${PLAYWRIGHT_DISABLED_FEATURES.join(",")}`,
  // Test determinism a person pays for in battery and speed: background tabs throttle, the back
  // and forward cache makes Back instant, input waits for the page it is meant for.
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-back-forward-cache",
  "--allow-pre-commit-input",
  // The display's own colour profile, not forced sRGB.
  "--force-color-profile=srgb",
  // Crash reports and usage statistics follow the person's own choice in Chrome's settings.
  "--disable-breakpad",
  "--metrics-recording-only",
  // Edge keeps itself patched on macOS.
  "--disable-edgeupdater",
  "--disable-updater-scheduler",
  // Chrome as it ships: its search engine choice where the law requires it, its own services, its
  // PDF output, its infobars (this one only affects Chrome for Testing).
  "--disable-search-engine-choice-screen",
  "--no-service-autorun",
  "--export-tagged-pdf",
  "--disable-infobars",
  "--disable-field-trial-config",
  // A desktop has a GPU path and real shared memory. Software WebGL is off in an everyday Chrome.
  "--enable-unsafe-swiftshader",
  "--disable-dev-shm-usage",
  // The page Playwright opens at launch. Without it the browser opens what the person's own startup
  // setting says: the new tab page, or the tabs they had last time.
  "about:blank",
];

/** The display a person's desktop session had before this process started its own. */
export type PersonDisplay = { DISPLAY?: string; WAYLAND_DISPLAY?: string };

/**
 * The environment a person's native browser starts in on Linux: the person's own display.
 *
 * A headed computer on Linux starts its own Xvfb and points `DISPLAY` at it, which is right for
 * every browser nobody sits in front of: a hosted computer's, and a Bot's on OpenBot Desktop. A
 * person's native window opened there would be drawn on a screen nobody can see. So it gets back
 * the display the person's session had (their X display, or their Wayland one with no X display at
 * all), and everything else keeps the virtual one. Elsewhere, and for the hosted browser shown on the
 * live screen, nothing changes: undefined means the process environment as it is.
 */
export function personBrowserEnv(
  window: BrowserWindow,
  own: PersonDisplay,
  current: Environment,
  platform: string = process.platform,
): Record<string, string> | undefined {
  if (window !== "native" || platform !== "linux") return undefined;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(current))
    if (value !== undefined) env[name] = value;
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  if (own.DISPLAY) env.DISPLAY = own.DISPLAY;
  if (own.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = own.WAYLAND_DISPLAY;
  return env;
}

export type PersonLaunchInput = {
  window: BrowserWindow;
  /** The built Recorder. The hosted browser loads it by flag; a native one through DevTools. */
  recorderDir: string;
  headless: boolean;
  /** Chromium's own process sandbox. Always on for a native browser, as for a Bot's local Chrome. */
  sandbox: boolean;
  /** The switches a Bot's browser launches with on this computer, which the hosted browser keeps. */
  botArgs: readonly string[];
  /** See `personBrowserEnv`. */
  display: PersonDisplay;
};

export type PersonLaunchOptions = {
  args: string[];
  ignoreDefaultArgs: string[];
  chromiumSandbox: boolean;
  headless: boolean;
  /** Null for a native window: pages take the window's size, as in any browser. */
  viewport: null | { width: number; height: number };
  colorScheme?: null;
  reducedMotion?: null;
  forcedColors?: null;
  contrast?: null;
  /** The browser's environment, when it differs from this process's. See `personBrowserEnv`. */
  env?: Record<string, string>;
};

export function personLaunchOptions(
  input: PersonLaunchInput,
  viewport: { width: number; height: number },
  platform: string = process.platform,
): PersonLaunchOptions {
  if (input.window === "native") {
    const env = personBrowserEnv(
      "native",
      input.display,
      process.env,
      platform,
    );
    return {
      ...(env ? { env } : {}),
      args: [
        // As for a Bot: the flag rather than a script patch, so `navigator.webdriver` is false at
        // the source and Google sign-in works.
        "--disable-blink-features=AutomationControlled",
        // What lets `Extensions.loadUnpacked` install the Recorder. Branded Chrome ignores
        // `--load-extension` since Chrome 137, and only OpenBot holds this browser's DevTools pipe.
        "--enable-unsafe-extension-debugging",
      ],
      ignoreDefaultArgs: [...PLAYWRIGHT_DEFAULTS_A_PERSON_DOES_NOT_GET],
      chromiumSandbox: true,
      headless: input.headless,
      viewport: null,
      // Playwright emulates a light colour scheme by default; null leaves the person's own.
      colorScheme: null,
      reducedMotion: null,
      forcedColors: null,
      contrast: null,
    };
  }
  return {
    args: [
      ...input.botArgs,
      // Only the Recorder: the hosted browser takes no other extension.
      `--disable-extensions-except=${input.recorderDir}`,
      `--load-extension=${input.recorderDir}`,
    ],
    ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
    chromiumSandbox: input.sandbox,
    headless: input.headless,
    viewport,
  };
}

/**
 * Where the person's own browser keeps the native messaging hosts their apps installed.
 *
 * User-level manifests live in the `NativeMessagingHosts` folder of the browser's user data
 * directory on macOS and Linux, so a browser started on OpenBot's dedicated profile looks in that
 * profile's folder instead and finds none of them: 1Password's extension cannot reach the
 * 1Password app, and Touch ID unlock is gone. Windows registers hosts in the registry, which every
 * profile reads, so there is nothing to copy there. System-wide hosts (`/Library/...`, `/etc/...`)
 * are read by every profile already.
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
 * https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging
 */
export function defaultNativeMessagingHosts(
  browser: InstalledBrowser,
  env: Environment,
  platform: string = process.platform,
  home: string = homedir(),
): string | null {
  if (platform === "darwin")
    return posix.join(
      home,
      "Library",
      "Application Support",
      browser === "chrome" ? "Google/Chrome" : "Microsoft Edge",
      "NativeMessagingHosts",
    );
  if (platform === "linux")
    return posix.join(
      env.XDG_CONFIG_HOME?.trim() || posix.join(home, ".config"),
      browser === "chrome" ? "google-chrome" : "microsoft-edge",
      "NativeMessagingHosts",
    );
  return null;
}

/** A host manifest is a few hundred bytes; anything far larger is not one. */
const MAX_HOST_MANIFEST_BYTES = 64 * 1024;

/**
 * Make the OpenBot profile's `NativeMessagingHosts` folder hold exactly the person's installed host
 * manifests, at every launch, so an app installed or removed since last time is picked up.
 *
 * Manifests only: regular `.json` files of a manifest's size, read and written rather than linked, so
 * nothing else from the person's profile is ever copied or reachable from the OpenBot one. A folder
 * that is not there (no app installed a host) leaves the OpenBot one empty.
 */
export async function copyNativeMessagingHosts(
  from: string,
  to: string,
): Promise<string[]> {
  const manifests = new Map<string, string>();
  const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const source = join(from, entry.name);
    // `stat` follows a link, because an installer may link its manifest in, and judges what it
    // points at: a regular file of a manifest's size, and nothing else.
    const file = await stat(source).catch(() => null);
    if (!file?.isFile() || file.size > MAX_HOST_MANIFEST_BYTES) continue;
    const text = await readFile(source, "utf8").catch(() => null);
    if (text === null) continue;
    manifests.set(entry.name, text);
  }
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const existing of await readdir(to).catch(() => [])) {
    if (existing.endsWith(".json") && !manifests.has(existing))
      await rm(join(to, existing), { force: true });
  }
  for (const [name, text] of manifests)
    await writeFile(join(to, name), text, { mode: 0o600 });
  return [...manifests.keys()].sort();
}
