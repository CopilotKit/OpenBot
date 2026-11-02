/**
 * How a person's browser is launched: which browser, with which switches, and with which of the
 * person's own native messaging hookups.
 *
 * A PERSON'S BROWSER IS NOT A BOT'S. A Bot's browser is a test browser on purpose: Playwright's
 * defaults make it deterministic, and nothing the person installs belongs in it. A person's browser
 * is their everyday browser (OpenBot Desktop opens their installed Chrome, or Edge, in a dedicated
 * OpenBot profile), and the same defaults would quietly take most of that away: no extensions, so
 * no password manager; no sync, so no Google sign-in; a mock keychain, so no saved passwords; no
 * component updates, so no streaming video. So a person's native browser is not launched by
 * Playwright at all (see `native-browser.ts`): it starts with exactly the switches below, and none
 * of Playwright's defaults, each of which is decided below. A Bot's launch is untouched.
 *
 * The hosted person's browser is the computer's bundled Chromium, shown through the live screen.
 * It keeps a Bot's launch except for what the Recorder needs: extensions on, and only the Recorder.
 * A Bot's own browser takes the Recorder the same way where this computer has it (`recorderLaunchOptions`).
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
import { RECORDER_NATIVE_HOST } from "../../shared/recorder-extension";
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
 * The commands each browser's Linux packages put on the PATH, in the order they are tried: the
 * stable channel's own name first, then the one every channel's package links.
 */
export const LINUX_LAUNCHERS: Record<InstalledBrowser, readonly string[]> = {
  chrome: ["google-chrome-stable", "google-chrome"],
  msedge: ["microsoft-edge-stable", "microsoft-edge"],
};

/**
 * Where each browser installs, in the order it is looked for. Never an executable from a request.
 *
 * macOS and Windows: Playwright's own stable-channel locations, which are where the browsers'
 * installers put them.
 *
 * Linux: where Google's and Microsoft's own packages install them on every distribution (their .deb
 * and .rpm put the browser in `/opt` and link a launcher into `/usr/bin`, and the AUR builds follow
 * them), then the launcher on the PATH, for a distribution that keeps the browser somewhere of its
 * own (NixOS keeps it in the Nix store, behind a wrapper on the PATH). A launcher is the browser's
 * own script, which hands every argument and the DevTools pipe on to the browser it starts. A
 * native window is started from this path itself rather than through Playwright's channel (see
 * `native-browser.ts`), so a browser found this way is one that opens.
 *
 * Never a Flatpak or a Snap. The Flatpak builds of Chrome and Edge are community wrappers that run
 * the browser in a sandbox with no access to the folders it would need here (its profile, and the
 * Recorder in the deployment), and their exported launchers (`com.google.Chrome`) are not on the
 * list above. Neither browser is published as a Snap; the Snap Store's browser is Chromium. OpenBot
 * Desktop says so to the person when that is all a machine has.
 * https://github.com/flathub/com.google.Chrome
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
  if (platform === "linux") {
    const packaged =
      browser === "chrome"
        ? "/opt/google/chrome/chrome"
        : "/opt/microsoft/msedge/msedge";
    // Absolute folders only: an empty or relative PATH entry means the folder this process runs in.
    const folders = (env.PATH ?? "")
      .split(":")
      .filter((folder) => posix.isAbsolute(folder));
    return [
      ...new Set([
        packaged,
        ...folders.flatMap((folder) =>
          LINUX_LAUNCHERS[browser].map((name) => posix.join(folder, name)),
        ),
      ]),
    ];
  }
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

/** Whether an executable is there to run (on Windows, there at all), without running it. */
export async function runnable(
  path: string,
  platform: string,
): Promise<boolean> {
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
  return (await installedBrowserAt(env, platform))?.browser ?? null;
}

/** The same, with the executable that is installed, which a person's native browser is started from. */
export async function installedBrowserAt(
  env: Environment,
  platform: string = process.platform,
): Promise<{ browser: InstalledBrowser; executable: string } | null> {
  for (const browser of INSTALLED_BROWSERS) {
    for (const candidate of browserExecutableCandidates(
      browser,
      env,
      platform,
    )) {
      if (await runnable(candidate, platform))
        return { browser, executable: candidate };
    }
  }
  return null;
}

export const NO_INSTALLED_BROWSER = `Neither ${NAMES.chrome} nor ${NAMES.msedge} was found in its standard installation location. Install one of them (not as a Flatpak or a Snap) to open a browser here.`;

/**
 * Playwright's own Chromium switches (playwright-core 1.62.1, `chromiumSwitches.ts`, plus what its
 * launcher adds) that a person's native browser does not get, each with the reason. It is started
 * without Playwright, so none of them is on its command line; `person-browser.test.ts` reads that
 * command line from the browser itself and checks. The `--disable-features` value is spelled out
 * exactly as Playwright builds it, which the hosted browser's and Bots' tests read it against.
 *
 * What it keeps of Playwright's, and why, is `personNativeLaunch`.
 */
export const PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = [
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

/**
 * The command line a person's native browser starts with, all of it, and the environment it starts in.
 *
 * What it keeps of Playwright's own launch, and why:
 *   - `--remote-debugging-pipe` and `--user-data-dir`: how OpenBot holds the browser and keeps the
 *     dedicated profile separate from the person's own. A pipe, not a port: only this process can
 *     reach the browser.
 *   - `--no-first-run`: the first-run flow can hold the first window behind a modal, and the launch
 *     waits on that window. The person signs in to Chrome from its profile menu instead.
 *   - `--no-default-browser-check`: the OpenBot window does not ask to become the default browser.
 *     The person's default browser stays the one they chose.
 *   - `--enable-features=CDPScreenshotNewSurface`: how frames are captured for the live screen.
 *   - `--edge-skip-compat-layer-relaunch`: Edge on Windows can relaunch itself and drop the pipe.
 *
 * No page to open: the browser opens what the person's own startup setting says, the new tab page or
 * the tabs they had last time. `headless` only for the tests, which never open a window.
 */
export function personNativeLaunch(
  input: { dir: string; headless: boolean; display: PersonDisplay },
  platform: string = process.platform,
): { args: string[]; env?: Record<string, string> } {
  const env = personBrowserEnv("native", input.display, process.env, platform);
  return {
    args: [
      "--remote-debugging-pipe",
      `--user-data-dir=${input.dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-features=CDPScreenshotNewSurface",
      "--edge-skip-compat-layer-relaunch",
      /*
       * `navigator.webdriver` false, at the source, as for a Bot. A browser on a DevTools pipe turns on
       * Blink's AutomationControlled feature by itself (Chromium's `runtime_features.cc` maps
       * `--remote-debugging-pipe` to it, as it does `--enable-automation` and `--headless`), and only
       * this switch, read after that, turns it off again. Without it Google refuses sign-in ("This
       * browser or app may not be secure"), and with `navigator.webdriver` patched to false by a
       * script instead, it still does: both measured on Google Chrome 156 against accounts.google.com.
       *
       * It costs a warning bar in the first window: Chrome lists `--disable-blink-features` among the
       * switches it warns of ("unsupported command-line flag", `bad_flags_prompt.cc`), and hides that
       * warning only under `--enable-automation` (which turns `navigator.webdriver` on again and shows
       * a bar of its own), under `--test-type` (which changes Chrome's behaviour in a dozen other
       * places), or by enterprise policy. No other switch here is one it warns of.
       * https://chromium.googlesource.com/chromium/src/+/main/content/child/runtime_features.cc
       * https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/startup/bad_flags_prompt.cc
       */
      "--disable-blink-features=AutomationControlled",
      // What lets `Extensions.loadUnpacked` install the Recorder. Branded Chrome ignores
      // `--load-extension` since Chrome 137, and only OpenBot holds this browser's DevTools pipe.
      "--enable-unsafe-extension-debugging",
      ...(input.headless ? ["--headless"] : []),
    ],
    ...(env ? { env } : {}),
  };
}

/** A browser Playwright launches with the Recorder in it: what it needs beyond a Bot's launch here. */
export type RecorderLaunchInput = {
  /** The built Recorder, loaded by flag. */
  recorderDir: string;
  headless: boolean;
  /** Chromium's own process sandbox. */
  sandbox: boolean;
  /** The switches a Bot's browser launches with on this computer, which a browser with the Recorder keeps. */
  botArgs: readonly string[];
};

export type RecorderLaunchOptions = {
  args: string[];
  ignoreDefaultArgs: string[];
  chromiumSandbox: boolean;
  headless: boolean;
  viewport: { width: number; height: number };
};

/**
 * A Bot's launch, with the Recorder let in: the hosted person's browser's, and a Bot's own on a computer that has the
 * Recorder (`shared/bot-browser.ts`), where it waits, disconnected, for a person holding the wheel to press Record.
 *
 * It keeps Playwright's focus emulation, which a native window drops (`native-browser.ts`): nobody sits at this
 * browser, so every tab of it says it is in front, and OpenBot itself decides which one is, from its own tab strip,
 * and shows that one on the live screen. Bots' browsers keep it for the reason Playwright has it: a Bot acts in tabs
 * that are not in front, and each must behave as if it were.
 */
export function recorderLaunchOptions(
  input: RecorderLaunchInput,
  viewport: { width: number; height: number },
): RecorderLaunchOptions {
  return {
    args: [
      ...input.botArgs,
      // Only the Recorder: a browser launched here takes no other extension.
      `--disable-extensions-except=${input.recorderDir}`,
      `--load-extension=${input.recorderDir}`,
      // So the Recorder can be loaded again over DevTools when this profile's worker runs an earlier
      // build of it (see `keepRecorderCurrent` in `recorder-in-browser.ts`). Only OpenBot holds the pipe.
      "--enable-unsafe-extension-debugging",
      /*
       * No "started debugging this browser" bar when the Recorder attaches `chrome.debugger` to
       * record a tab. The bar takes its height from the window, so while it showed, the live screen
       * lost the bottom 143 pixels of the page (frames went from 800 to 657 high at Record, and 713
       * after Stop) though the page's own viewport stayed 800. Measured on bundled Chromium with the
       * built Recorder recording, and gone with this switch.
       *
       * The switch does nothing else: Chromium reads it in one place, `debugger_api.cc`, to skip
       * that warning, which it also skips for an extension installed by policy. The warning is
       * there to tell a person that an extension is reading their tabs; here the only extension
       * there can be is the Recorder (`--disable-extensions-except`), and the person pressed Record
       * in OpenBot, which says it is recording. A native window keeps the bar: the person installs
       * their own extensions there, and it is the one signal that one of them attached.
       * https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc
       */
      "--silent-debugger-extension-api",
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

/**
 * Take the Recorder out of the profile's pinned extensions before it is loaded, so it is pinned once.
 *
 * WHY. Chrome pins a newly installed extension to the toolbar ("pin new extensions by default",
 * `ToolbarActionsModel`), and the Recorder is newly installed at every launch: an extension loaded
 * over DevTools or by `--load-extension` does not outlive the browser, so each load is a first
 * install. Each launch therefore added it to `extensions.pinned_extensions` once more, while the
 * entries from earlier launches stayed: three after three launches in the end-to-end run, and
 * measured growing by one per launch on Chrome 156. With the Recorder taken out first, the launch
 * leaves the one entry its install adds; left in once, the launch still ended with two. Chrome does
 * not guard this preference against edits (it is not among its tracked preferences), and nothing
 * else in the file is touched. A profile with no preferences yet, or ones Chrome never finished
 * writing, is left alone.
 * https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/toolbar/toolbar_actions_model.cc
 * https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/prefs/chrome_pref_service_factory.cc
 */
export async function forgetRecorderPins(
  profileDir: string,
  recorderId: string,
): Promise<void> {
  const file = join(profileDir, "Default", "Preferences");
  let preferences: unknown;
  try {
    preferences = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return;
  }
  if (!preferences || typeof preferences !== "object") return;
  const extensions = (preferences as { extensions?: unknown }).extensions;
  if (!extensions || typeof extensions !== "object") return;
  const pinned = (extensions as { pinned_extensions?: unknown })
    .pinned_extensions;
  if (!Array.isArray(pinned) || !pinned.includes(recorderId)) return;
  (extensions as { pinned_extensions: unknown[] }).pinned_extensions =
    pinned.filter((id) => id !== recorderId);
  await writeFile(file, JSON.stringify(preferences));
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
 *
 * Except OpenBot Desktop's own Recorder host. Its only job is to hand a newly installed Recorder a
 * connect code, and in this browser the launcher connects the Recorder itself: copied, the host would
 * be asked first, and `connect` would wait behind it.
 */
export async function copyNativeMessagingHosts(
  from: string,
  to: string,
): Promise<string[]> {
  const manifests = new Map<string, string>();
  const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name === `${RECORDER_NATIVE_HOST}.json`) continue;
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
