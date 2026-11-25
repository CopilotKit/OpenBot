import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { BOOKING_CALENDAR_ORIGIN } from "../../shared/openbot-for-business";

/**
 * The AI step's form holds still while the install behind it comes and goes.
 *
 * Seen on Windows: on "Connect your AI", the back end's download card appeared above the endpoint
 * form while the person typed in it, and went when the download ended. Base URL and Model jumped
 * about 100px each time, a click meant for a field landed on "Advanced compatible endpoint options",
 * and the window grew taller and moved to fit. The install's row now has one slot under the form,
 * its height held (`BehindSlot`).
 *
 * The real window (`main.tsx` and `styles.css`), bundled as the app is, in a real Chromium, because
 * where a field lands is the browser's layout to decide. Only the native side is scripted, as it
 * answers on a first run: install done, the account passed, the rest of OpenBot setting up behind
 * the step, its download arriving and ending.
 *
 *   OPENBOT_APP_BROWSER=1 bun test src/setupLayout.browser.test.ts
 */
const asked = process.env.OPENBOT_APP_BROWSER === "1";

/*
 * Playwright comes from the root install, which the real-browser CI job has. The desktop's own
 * jobs install only the desktop's dependencies and typecheck this file, so it names the module
 * by a variable and types only the part of it used here.
 */
const PLAYWRIGHT: string = "playwright-core";
type Box = { x: number; y: number; width: number; height: number } | null;
type Locator = {
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  waitFor(options?: { state?: "hidden" | "visible" }): Promise<void>;
  boundingBox(): Promise<Box>;
  textContent(): Promise<string | null>;
  count(): Promise<number>;
};
type Route = {
  request(): { url(): string };
  fulfill(response: {
    status?: number;
    contentType?: string;
    headers?: Record<string, string>;
    body: string;
  }): Promise<void>;
};
type Page = {
  addInitScript(script: string): Promise<void>;
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  getByRole(role: string, options?: { name: string; exact?: boolean }): Locator;
  locator(selector: string, options?: { hasText?: string }): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByLabel(text: string, options: { exact: boolean }): Locator;
  evaluate<T, A = undefined>(run: (arg: A) => T, arg?: A): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  mouse: {
    click(x: number, y: number): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  close(): Promise<void>;
};
type Browser = {
  newPage(options: {
    viewport: { width: number; height: number };
    colorScheme?: "light" | "dark";
  }): Promise<Page>;
  close(): Promise<void>;
};
type Chromium = {
  launch(options: {
    channel: string;
    ignoreDefaultArgs?: string[];
  }): Promise<Browser>;
};

/**
 * `@tauri-apps/api/core`, scripted. The page's `__fake.download` is what the download poll answers,
 * and `__fake.emit` sends setup progress as the native side does. `#start` is a relaunch whose
 * Start updates OpenBot; otherwise it is a first run.
 */
const FAKE_CORE = `
const fake = (globalThis.__fake ??= { listeners: {}, download: null });
const emit = (name, payload) => {
  for (const listener of fake.listeners[name] ?? []) listener({ payload });
};
fake.emit = emit;
// A relaunch whose update this computer has no room for: OpenBot's own (Windows, C: at 7.4 GB), or
// the back end's, which the window runs first (a Mac at 8.2 GB).
const updateShort = location.hash === "#update-short";
const backEndShort = location.hash === "#backend-short";
// This app too old for its OpenBot, as the shell says it: connected to an OpenBot (such as OpenBot
// Cloud) that needs a newer app; one whose sign-in ended, as it always was; and the OpenBot on
// this computer needing a newer app once Start has it running.
const CONNECTED_PROBLEMS = {
  "#connect-app-too-old": { said: "The OpenBot at openbot.example.com needs a newer version of this app. Update OpenBot, then connect again.", kind: "app-too-old" },
  "#connect-app-too-old-security": { said: "This version of OpenBot has a security problem. Update to keep using it.", kind: "app-too-old-security" },
  "#connect-session-ended": { said: "Your sign-in to openbot.example.com has ended. Sign in again to keep going.", kind: "session-ended" },
};
const connectedProblem = CONNECTED_PROBLEMS[location.hash];
// The same, for a minimum raised because of a security problem.
const localSecurity = location.hash === "#local-app-too-old-security";
const localTooOld = location.hash === "#local-app-too-old" || localSecurity;
// Start finding the release on this computer needs a newer launcher contract than this app speaks.
const launcherAhead = location.hash === "#local-launcher-ahead";
// A launch that finds this computer's OpenBot already running, and that it needs a newer app.
const runningTooOld = location.hash === "#local-app-too-old-running";
// The same launch, where showing it fails as it could before: the slot the card above lands in.
const runningFails = location.hash === "#local-running-fails";
// The update feed has a newer version, so the offer at the top shows too.
const offered = location.search === "?offer";
// A build that never updates itself (internal, candidate, or without the updater).
const internal = location.search === "?internal";
// The move to OpenBot Cloud, offered over an OpenBot (Self-Contained) found running: \`#move-choice\`
// after an update, and the rest from Settings, at the screen each names (see \`moveAnswer\`).
const move = location.hash.startsWith("#move-") ? location.hash.slice(6) : null;
// \`#move-first\`: a relaunch after the update, OpenBot stopped and due an update of its own, with the
// move due. The window asks before anything starts; the update runs until \`__fake.finishUpdate()\`.
const moveFirst = move === "first";
let finishUpdate;
const updated = new Promise((resolve) => (finishUpdate = resolve));
fake.finishUpdate = () => finishUpdate({ from: "1.1.3", to: "1.2.0", moved: true });
// A relaunch whose image list something outside OpenBot deleted: Start refuses it as an unfinished
// install, as start_stack does, and the window installs before it starts again. Offline here, so
// that install fails and the window says so.
const imageListGone = location.hash === "#image-list-gone";
// Found running by the launch is a relaunch too: an installation set up and started before.
const relaunch = location.hash === "#start" || updateShort || backEndShort || localTooOld || runningTooOld || launcherAhead || imageListGone || Boolean(move);
const MOVE_APPS = [
  { appId: "gmail", appName: "Gmail", accountLabel: "sam@example.com", botNames: ["Inbox helper", "Standup"] },
  { appId: "slack", appName: "Slack", accountLabel: "Northwind" },
  { appId: "google-drive", appName: "Google Drive" },
];
const MORE_APPS = [
  ...MOVE_APPS,
  { appId: "notion", appName: "Notion" },
  { appId: "github", appName: "GitHub", accountLabel: "sam-codes" },
  { appId: "linear", appName: "Linear" },
  { appId: "google-calendar", appName: "Google Calendar", accountLabel: "sam@example.com" },
  { appId: "hubspot", appName: "HubSpot" },
];
// \`#move-confirm-carried\`, \`#move-done-carried\`, \`#move-done-ai-carried\`: apps connected with a key
// come across connected, the rest are signed in to again, and on the result one Cloud couldn't connect.
const carriedMove = Boolean(move && move.endsWith("-carried"));
const SIGN_IN_APPS = [
  { appId: "gmail", appName: "Gmail", accountLabel: "sam@example.com", botNames: ["Inbox helper", "Standup"] },
  { appId: "slack", appName: "Slack", accountLabel: "Northwind" },
];
const KEY_APPS = [
  { appId: "fireflies", appName: "Fireflies", botNames: ["Standup"] },
  { appId: "posthog", appName: "PostHog", botNames: ["Metrics"] },
];
const TEAM_WIKI = { appId: "team-wiki", appName: "Team wiki", botNames: ["Research"] };
const NOT_ALLOWED = "Your organization doesn't allow Team wiki yet. Ask an admin to approve it, then connect it here.";
const MOVE_PREVIEW = {
  counts: [
    { kind: "bots", count: 3 }, { kind: "skills", count: 9 }, { kind: "conversations", count: 37 },
    { kind: "messages", count: 2814 }, { kind: "memories", count: 52 }, { kind: "routines", count: 3 },
    { kind: "goals", count: 1 }, { kind: "check-ins", count: 2 }, { kind: "files", count: 64 },
    { kind: "settings", count: 1 },
  ],
  apps: move === "confirm-many" ? MORE_APPS : carriedMove ? SIGN_IN_APPS : MOVE_APPS,
  ...(carriedMove ? { carried: [...KEY_APPS, TEAM_WIKI] } : {}),
  // \`#move-first\` is measured again once its update has added the new release's files.
  footprintBytes: moveFirst ? 26_600_000_000 : 20_200_000_000,
  modelKeysAvailable: true,
};
const MOVE_DESTINATIONS = [
  { id: "org_northwind", name: "Northwind Traders", personal: false, canMoveIn: true },
  { id: "org_mine", name: "Sam's organization", personal: true, canMoveIn: true },
  { id: "org_lab", name: "Research Lab", personal: false, canMoveIn: false },
];
function moveAnswer(command) {
  if (command === "move_offer")
    return { due: true, fromSettings: move !== "choice" && !moveFirst, footprintBytes: moveFirst ? 23_100_000_000 : 20_200_000_000 };
  if (command === "move_preview")
    return move === "confirm-loading" ? new Promise(() => {}) : MOVE_PREVIEW;
  // \`#move-where\`: in three organizations on OpenBot Cloud, one of which doesn't let them use Bots,
  // so the window asks where the Bots go. \`#move-not-allowed\`: in one, which refuses the move.
  if (command === "move_destinations") {
    if (move === "where") return MOVE_DESTINATIONS;
    if (move === "not-allowed") return [{ ...MOVE_DESTINATIONS[1], canMoveIn: true }];
    return undefined;
  }
  if (command !== "move_to_cloud") return undefined;
  const progress = (stage, state, share) => emit("move:progress", { stage, state, progress: share });
  if (move === "not-allowed") {
    progress("sign-in", "done");
    throw { said: "An admin of Northwind Traders hasn't let you use Bots there. Ask them to let you, or choose another organization.", detail: null, kind: "move-not-allowed" };
  }
  if (move === "signin") {
    progress("sign-in", "running");
    return new Promise(() => {});
  }
  progress("sign-in", "done");
  progress("export", "done");
  // OpenBot Cloud stopped the import and said why: a conversation it won't overwrite.
  if (move === "stopped") {
    progress("upload", "done");
    progress("import", "running");
    throw { said: "\\"Field Researcher\\" has new messages on your computer, and was also carried on in OpenBot Cloud. OpenBot won't overwrite what was said in OpenBot Cloud, so the new messages can't move.", detail: null, kind: "move-stopped" };
  }
  progress("upload", "running", 0.42);
  if (move === "midway") return new Promise(() => {});
  if (move === "failed")
    throw { said: "OpenBot couldn't send your Bots to OpenBot Cloud. Check your internet connection, then try again.", kind: "move-failed" };
  // As most real failures are: with the technical details for the log.
  if (move === "failed-detail")
    throw {
      said: "OpenBot couldn't send your Bots to OpenBot Cloud. Check your internet connection, then try again.",
      detail: "part 3 of 7: the connection was reset while sending (tried 3 times over 41s); the last try answered 502 bad-gateway with no body",
      kind: "move-failed",
    };
  // \`#move-done-held\`: as on a Mac, the disk shows 4.5 of the 20.2 GB removed free so far.
  // \`#move-done-ai\`: OpenBot Cloud still needs the person's AI, so the result leads with it.
  return {
    connectAi: move === "done-ai" || move === "done-ai-carried",
    removedBytes: 20_200_000_000,
    diskGainedBytes: move === "done-held" ? 4_500_000_000 : 20_100_000_000,
    apps: carriedMove ? [...SIGN_IN_APPS, { ...TEAM_WIKI, reason: NOT_ALLOWED }] : MOVE_APPS,
    ...(carriedMove ? { carried: KEY_APPS } : {}),
    notes: move === "done" || move === "done-held" ? ["Research runs on an ordinary computer here, because OpenBot Cloud has no isolated computers."] : [],
    leftBehind: move === "done-left" ? ["Some of OpenBot's software is still on this computer. Restart your computer to finish removing it."] : [],
    account: { email: "sam.longname-for-wrapping@example.com", organization: "Sam's organization" },
  };
}
const signingIn = location.hash === "#signin";
const installing = location.hash === "#licence-installing";
const pausing = location.hash === "#pause-podman";
// Signed in already, the CLI taking two seconds to say so, as on Windows G.
const slowCheck = location.hash === "#licence-slow";
// A first install whose connect step stops partway, as on a Mac on 1.1.0-rc.1.
const connectFails = location.hash === "#connect-fails";
const licence = location.hash === "#licence" || installing || slowCheck;
let finishInstall;
const installed = new Promise((resolve) => (finishInstall = resolve));
let finishSetUp;
const setUp = new Promise((resolve) => (finishSetUp = resolve));
const stack = {
  id: "local-abc123",
  installedRelease: "0.16.0-rc.10",
  step: "ready",
  urls: { api: "http://127.0.0.1:64770", dashboard: "http://127.0.0.1:64771", gateway: "ws://127.0.0.1:64772" },
  hasFailedStep: false,
  updateInProgress: false,
  unfinishedUpdate: null,
  observed: null,
};
const status = (readiness, licence) => ({
  outcome: "completed", stack, reason: null, readiness, licence, licenceExpiresAt: null, checksPassed: false,
});
fake.finishSetUp = () => finishSetUp(status("starting", "valid"));
fake.finishInstall = () => finishInstall(null);
const none = { openai: false, anthropic: false };
export function convertFileSrc(path) { return path; }
fake.calls = [];
// The pages opened in the person's browser, by address.
fake.opened = [];
export async function invoke(command, args) {
  fake.calls.push(command);
  // \`?throws\`: the update offer is handed an answer it can't draw, this app's version as an
  // object, so a screen fails to draw as any might.
  if (location.search === "?throws" && command === "app_update_offer")
    return { version: "1.3.0", current: { broken: true }, installing: null, updatesItself: true, ready: null };
  if (command === "plugin:opener|open_url") fake.opened.push(args.url);
  if (connectedProblem && command === "connection")
    return { mode: "connected", address: "https://openbot.example.com", signedIn: true };
  if (connectedProblem && command === "show_connected") throw connectedProblem;
  if ((runningTooOld || runningFails || (move && !moveFirst)) && command === "already_running") return true;
  if (move) {
    const answer = moveAnswer(command);
    if (answer !== undefined) return answer;
  }
  if (runningFails && command === "show_openbot")
    throw { said: "Part of OpenBot needs recovery. Try starting OpenBot once more." };
  if (localSecurity && command === "show_openbot")
    throw {
      said: "This version of OpenBot has a security problem. Update to keep using it.",
      detail: "the deployment's minimumClients.desktop is 1.2.0, raised for a security problem (securityMinimumClients); this app is desktop/1.1.0 and speaks v2",
      kind: "app-too-old-security",
    };
  if ((localTooOld || runningTooOld) && command === "show_openbot")
    throw {
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      detail: "the deployment's minimumClients.desktop is 1.2.0; this app is desktop/1.1.0 and speaks v2",
      kind: "app-too-old",
    };
  if ((connectedProblem || localTooOld || runningTooOld || launcherAhead) && command === "app_update_offer")
    return { version: offered ? "1.2.0" : null, current: "1.1.0", installing: null, updatesItself: !internal, ready: null };
  switch (command) {
    case "windows_restart_pending":
    case "take_ai_connection_change":
    case "already_running":
      return false;
    case "default_root":
      return "/Users/you/OpenBot";
    case "already_configured":
      return relaunch
        ? {
            values: {},
            saved: { modelApiKeys: { openai: true, anthropic: false }, modelSessions: none, model: "open-ai-api-key" },
            launch: { harness: { id: "langgraph" } },
            localEval: { stack: "local-abc123", ownership: "created", phase: "installed", connected: true },
          }
        : { values: {}, saved: { modelApiKeys: none, modelSessions: none } };
    case "upgrade_due":
      return relaunch && !localTooOld && !runningTooOld && !launcherAhead && !imageListGone ? { from: "1.0.0", to: "1.0.1" } : null;
    case "upgrade_and_start":
      if (updateShort)
        throw {
          said: "There isn't room on this computer for the update, so nothing changed.",
          shortfall: { podman: true, cpu: false, memory: false, disk: true, diskGb: "7.4", wsl: true, drive: "C:", freeOnDrive: true, updating: true, neededGb: "13" },
        };
      if (moveFirst) {
        emit("setup:progress", { step: "release", ok: true, running: true, detail: "Updating OpenBot. Your Bots, sign-ins and data stay as they are." });
        return updated;
      }
      return new Promise(() => {});
    case "providers":
      // As provider::catalogue lists them.
      return [
        { id: "openai", name: "OpenAI", summary: "Sign in with ChatGPT Plus, Pro, Team or Enterprise.", logins: ["plan", "api-key"], mark: "openai", caution: null },
        { id: "anthropic", name: "Anthropic", summary: "Sign in with a Claude Pro, Max, Team or Enterprise plan.", logins: ["plan", "api-key"], mark: "anthropic", caution: null },
        { id: "google", name: "Google Gemini", summary: "Use a Google AI Studio key or sign in for Gemini API access.", logins: ["endpoint", "oauth"], mark: "google-color", caution: null },
        { id: "xai", name: "xAI", summary: "Use an xAI API key or sign in to your xAI account.", logins: ["endpoint", "oauth"], mark: "xai", caution: null },
        { id: "unbiased", name: "Unbiased AI", summary: "Sign in with Unbiased AI to use Pareto, or use an API key.", logins: ["oauth", "endpoint"], mark: "unbiased", caution: null },
        { id: "trustedrouter", name: "TrustedRouter", summary: "Use a TrustedRouter API key for models from many providers.", logins: ["endpoint"], mark: "trustedrouter", caution: null },
        { id: "openai-compatible", name: "Any OpenAI-compatible endpoint", summary: "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.", logins: ["endpoint"], mark: null, caution: null },
      ];
    case "prepare_installation":
      if (pausing) {
        // A Mac whose own Podman OpenBot can't use: Install waits for the person's yes.
        emit("setup:progress", { step: "pause-podman", ok: true, running: true, asks: true, detail: "Your Podman is set up in a way OpenBot can't use. OpenBot will use its own, and pause yours while OpenBot is running. Yours starts again when you quit OpenBot." });
        return new Promise(() => {});
      }
      emit("setup:progress", { step: "engine", ok: true, running: false, detail: "The software OpenBot runs on is ready." });
      // Offline, so the install Start asked for cannot download the list again.
      if (imageListGone) {
        emit("setup:progress", { step: "deployment", ok: false, running: false, detail: "could not fetch the image list for v1.1.2: error sending request" });
        throw {
          said: "OpenBot could not download what it needs to run. Check the internet connection and try again.",
          detail: "could not fetch the image list for v1.1.2: error sending request",
        };
      }
      return installing ? installed : new Promise((resolve) => setTimeout(() => resolve(null), 50));
    case "sign_in_to_copilotkit":
      if (slowCheck) return new Promise((resolve) => setTimeout(() => resolve({ signedIn: true }), 1500));
      return signingIn ? new Promise(() => {}) : { signedIn: true };
    case "copilotkit_sign_in_page":
      return signingIn
        ? { url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345", userCode: "WXYZ-2345" }
        : null;
    case "allow_pause_podman":
      return true;
    case "local_eval_terms":
      if (pausing) return { status: "engine-not-ready" };
      return { status: "required", accepted: !licence, version: "developer-edition-2026-10-01-web", url: "https://copilotkit.ai/legal/developer-edition", organizationName: "Acme" };
    case "set_up_local_eval":
      return setUp;
    case "local_eval_download":
      return fake.download;
    case "connect_local_eval":
      return connectFails
        ? { outcome: "failed", stack: null, reason: "local-command-failed", conflicted: false }
        : { outcome: "completed", stack, reason: null, conflicted: false };
    case "run_local_eval":
      if (backEndShort && args.action === "update")
        return {
          outcome: "blocked", stack: null, reason: "resources-short", readiness: "unknown", licence: "unknown", licenceExpiresAt: null, checksPassed: false,
          shortfall: { podman: true, cpu: false, memory: false, disk: true, diskGb: "8.2", freeOnDrive: true, mac: true, updating: true, neededGb: "13" },
        };
      if (backEndShort) return { ...status("ready", "valid"), updateTo: "0.16.0-rc.13" };
      // The Status window's services, stopped until the main window's Start brings them up.
      if (location.search === "?started" && !fake.up) return status("stopped", "valid");
      return status("ready", "valid");
    // OpenBot's own start, the step's last row: it stays there for the test to look at. Running,
    // when the window is about to find it needs a newer app. Refused, when the release laid out
    // needs a newer launcher contract than this app speaks.
    case "start_stack":
      if (imageListGone)
        throw {
          said: "Finish installing OpenBot's local software before signing in or starting. Return to Install and try again.",
          detail: "The image list /Users/you/OpenBot/container-images.json is missing. Install downloads it again.",
          connection: "installation",
        };
      if (launcherAhead)
        throw {
          said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
          detail: "OpenBot v1.3.0 needs launcherApi 2; this app is v1.1.1 and speaks launcherApi 1",
          kind: "app-too-old",
        };
      return localTooOld ? null : new Promise(() => {});
    // The Status window (\`#status\`): everything running, or, at \`?stopped#status\`, all of it
    // stopped as Stop leaves it, the software OpenBot runs on still running. At
    // \`?updating#status\`, stopped by an update of OpenBot. At \`?started#status\`, stopped until
    // \`__fake.up\`, as when the main window's Start brings everything up.
    case "desktop_status": {
      const stopped =
        location.search === "?stopped" ||
        location.search === "?updating" ||
        (location.search === "?started" && !fake.up);
      return {
        updating: location.search === "?updating",
        openbotRunning: !stopped,
        openbotHeld: !stopped,
        processes: [],
        containers: stopped ? [] : [
          { name: "openbot-desktop-server-1", memoryBytes: 200000000 },
          { name: "openbot-desktop-worker-1", memoryBytes: 50000000 },
          { name: "openbot-desktop-postgres-1", memoryBytes: 150000000 },
        ],
        intelligenceStack: "local-abc123",
        intelligenceContainers: stopped ? [] : [{ name: "k3d-local-abc123-server-0", memoryBytes: 2400000000 }],
        engine: "docker",
        root: "/Users/you/OpenBot",
        appPort: stopped ? null : 3010,
        version: "1.1.0",
        build: "internal",
        logFolder: "/Users/you/Library/Logs/ai.copilotkit.openbot.desktop",
      };
    }
    // Usage data as a first run finds it: shared until the person says otherwise.
    case "plugin:openbot-desktop|usage_data":
      return { shared: true, offByEnvironment: false };
    case "plugin:openbot-desktop|set_usage_data":
      return { shared: false, offByEnvironment: false };
    default:
      return null;
  }
}
`;

/** `@tauri-apps/api/event`, scripted: `FAKE_CORE` emits through the same listeners. */
const FAKE_EVENT = `
const fake = (globalThis.__fake ??= { listeners: {}, download: null });
export async function listen(name, listener) {
  (fake.listeners[name] ??= new Set()).add(listener);
  return () => fake.listeners[name].delete(listener);
}
`;

type Window = { script: string; style: string };

/**
 * `marks.ts` as Vite builds it: each vendored mark in `shared/marks` inlined as a data URI, by the
 * file's name.
 */
function vendoredMarks(): string {
  const folder = new URL("../../shared/marks/", import.meta.url);
  const marks = Object.fromEntries(
    readdirSync(folder)
      .filter((file) => file.endsWith(".svg"))
      .map((file) => [
        file.replace(/\.svg$/, ""),
        `data:image/svg+xml;base64,${readFileSync(new URL(file, folder)).toString("base64")}`,
      ]),
  );
  return `const byId = new Map(Object.entries(${JSON.stringify(marks)}));
export function markFor(id) { return (id && byId.get(id)) ?? null; }`;
}

/**
 * The window as the app builds it, with the native side scripted. `env` is Vite's build-time
 * values; none set is a build without a whitelabel support page or OpenBot Cloud.
 */
async function buildWindow(env: Record<string, string> = {}): Promise<Window> {
  const built = await Bun.build({
    entrypoints: [new URL("./main.tsx", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env": JSON.stringify(env),
    },
    plugins: [
      {
        name: "scripted-native-side",
        setup(build) {
          build.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({
            path: "event",
            namespace: "scripted",
          }));
          build.onResolve({ filter: /^@tauri-apps\/api\// }, () => ({
            path: "core",
            namespace: "scripted",
          }));
          /*
           * Brand marks come from Vite's glob import, which this build has not got. The same files
           * are inlined here instead, so the window draws every mark the app draws. Left out, the
           * clouds OpenBot for Business runs on showed as four empty tiles.
           */
          build.onResolve({ filter: /^\.\/marks$/ }, () => ({
            path: "marks",
            namespace: "scripted",
          }));
          build.onLoad({ filter: /.*/, namespace: "scripted" }, (args) => ({
            contents:
              args.path === "event"
                ? FAKE_EVENT
                : args.path === "marks"
                  ? vendoredMarks()
                  : FAKE_CORE,
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "build failed");
  const script = await built.outputs
    .find((out) => out.kind === "entry-point")
    ?.text();
  const style = await built.outputs
    .find((out) => out.path.endsWith(".css"))
    ?.text();
  if (!script) throw new Error("the build has no entry point");
  return { script, style: style ?? "" };
}

/** Served as the shell serves the window: its page, its script and its stylesheet. */
async function open(
  page: Page,
  hash = "",
  served: Window = built,
  headers: Record<string, string> = {},
) {
  await page.route("https://openbot.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/main.js")
      return route.fulfill({
        contentType: "text/javascript",
        body: served.script,
      });
    if (path === "/main.css")
      return route.fulfill({ contentType: "text/css", body: served.style });
    if (path === "/")
      return route.fulfill({
        contentType: "text/html",
        headers,
        body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/main.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      });
    return route.fulfill({ status: 404, body: "" });
  });
  // A secure origin, as the shell's own is: the window's calls are named with `crypto.randomUUID`.
  await page.goto(`https://openbot.test/${hash}`);
}

let browser: Browser;
let built: Window;
/** The same window from a build that turns OpenBot Cloud on. */
let cloudBuilt: Window;
let chromium: Chromium;

beforeAll(async () => {
  if (!asked) return;
  built = await buildWindow();
  cloudBuilt = await buildWindow({ VITE_OPENBOT_CLOUD_ENABLED: "true" });
  const playwright = (await import(PLAYWRIGHT)) as {
    chromium: Chromium;
    webkit: { launch(): Promise<Browser> };
  };
  ({ chromium } = playwright);
  // The CI job installs full Chromium without the headless shell. `OPENBOT_APP_ENGINE=webkit` is
  // for a look in the engine the Mac window draws with, on a machine that has it installed.
  browser =
    process.env.OPENBOT_APP_ENGINE === "webkit"
      ? await playwright.webkit.launch()
      : await chromium.launch({ channel: "chromium" });
});

afterAll(async () => {
  await browser?.close();
});

/** Where the form's first field is, and how tall the page is: what the window is sized to. */
async function measure(page: Page) {
  const field = await page
    .getByLabel("Base URL", { exact: true })
    .boundingBox();
  const advanced = await page
    .getByText("Advanced compatible endpoint options")
    .boundingBox();
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  return { field: field?.y, advanced: advanced?.y, height };
}

/*
 * Seen on Windows F: the window opened at 1016x839, grew to 853 when the sign-in card appeared,
 * then jumped 54 px up and to 992 tall on "Connect your AI". The window keeps its size and place
 * now: the page is never taller than it, the window is never asked to grow, and a step taller than
 * the room it has scrolls inside its card.
 */
/**
 * The longest lines the background row is given, as the native side says them, and whether each
 * sends the person to another window. Kept in step with `docker_desktop_update.rs`,
 * `docker_desktop.rs`, `install.rs` and `engine.rs`.
 */
const LONGEST_ROW_LINES: [string, boolean][] = [
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. Windows will ask for your approval.",
    true,
  ],
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. Your Mac will ask for your password.",
    true,
  ],
  [
    "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. About 25 minutes left.",
    false,
  ],
  [
    "The Podman on this computer is too old for OpenBot, so OpenBot is updating it. Your Mac will ask for your password.",
    true,
  ],
  [
    "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.",
    true,
  ],
  [
    "Docker Desktop hasn't started yet. It may be waiting for you in its own window. Accept its terms or sign in there, and OpenBot carries on by itself.",
    true,
  ],
  [
    "Preparing this computer to run OpenBot. If a window asks to install a Windows feature OpenBot needs, allow it. Windows then asks for your approval and a restart.",
    true,
  ],
];

describe.skipIf(!asked)("the window through a first run", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the page never outgrows the window and a tall step scrolls in its card`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        const fits = () =>
          page.evaluate(() => ({
            page: document.documentElement.scrollHeight,
            window: window.innerHeight,
            asked: (
              globalThis as unknown as { __fake: { calls: string[] } }
            ).__fake.calls.filter((call) => call === "fit_setup_window").length,
          }));
        const check = async () => {
          const now = await fits();
          expect(now.page).toBeLessThanOrEqual(now.window);
          expect(now.asked).toBe(0);
        };
        await check();
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.waitForTimeout(600);
        await check();
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        await page.waitForTimeout(600);
        await check();
        // Taller than the room it has at the smaller size: its card scrolls, the page does not.
        const card = await page.evaluate(() => {
          const sheet = document.querySelector("main > .sheet") as HTMLElement;
          return { scroll: sheet.scrollHeight, client: sheet.clientHeight };
        });
        if (height < 600) expect(card.scroll).toBeGreaterThan(card.client);
        expect(card.client).toBeLessThanOrEqual(height);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * Seen on Windows F (a 1016x839 window): "Connect your AI" was taller than the window and scrolled
 * in its card, and the "Installing OpenBot in the background" row sat below the fold at y 822-839,
 * seen only by scrolling. It is pinned to the bottom of the card's visible area now, and Continue
 * still scrolls into view above it.
 */
/*
 * Seen on Windows F (a 1016x839 window): "Connect your AI" was taller than the window and scrolled
 * in its card. First the "Installing OpenBot in the background" row sat below the fold; then, with
 * only that row pinned, Continue sat under it with a grey sliver showing until the person
 * scrolled. A step's foot is pinned now: its action and the background row, both in view, with the
 * step scrolling above them.
 */
describe.skipIf(!asked)("a setup step's foot", () => {
  for (const [width, height] of [
    [1016, 839],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, its action and the background row are in view and uncovered on Account, Licence and AI`, async () => {
      const inView = async (_page: Page, box: Box, what: string) => {
        expect({ what, found: box !== null }).toEqual({ what, found: true });
        expect({ what, top: (box?.y ?? -1) >= 0 }).toEqual({ what, top: true });
        expect({
          what,
          bottom: (box?.y ?? 0) + (box?.height ?? 0) <= height,
        }).toEqual({ what, bottom: true });
      };
      const background = async (page: Page) =>
        inView(
          page,
          await page
            .getByRole("listitem", {
              name: "Installing OpenBot in the background",
            })
            .boundingBox(),
          "the background row",
        );
      /** The button is in view, and what is at its middle is the button: nothing covers it. */
      const pressable = async (page: Page, name: string) => {
        const button = page.getByRole("button", { name, exact: true });
        await inView(page, await button.boundingBox(), name);
        const covered = await page.evaluate((label) => {
          const found = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === label,
          );
          if (!found) return "missing";
          const box = found.getBoundingClientRect();
          const top = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return top && (top === found || found.contains(top))
            ? null
            : (top?.textContent ?? "nothing").slice(0, 60);
        }, name);
        expect({ name, coveredBy: covered }).toEqual({ name, coveredBy: null });
      };
      const account = await browser.newPage({ viewport: { width, height } });
      try {
        await open(account, "#signin");
        await account
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await account
          .getByRole("heading", { name: "Get your free license key" })
          .waitFor();
        await account.waitForTimeout(600);
        await background(account);
      } finally {
        await account.close();
      }
      const licence = await browser.newPage({ viewport: { width, height } });
      try {
        await open(licence, "#licence");
        await licence
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await licence
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
        await licence.waitForTimeout(600);
        await pressable(licence, "Accept");
        await background(licence);
      } finally {
        await licence.close();
      }
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.waitForTimeout(600);
        // Before a choice, and after it, with its form open and the step scrolling above.
        await pressable(page, "Continue");
        await background(page);
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        await page.waitForTimeout(600);
        await pressable(page, "Continue");
        await background(page);
      } finally {
        await page.close();
      }
    }, 40_000);
  }
});

/*
 * Seen on Windows F: on "Connect your AI", Continue moved up 14 px and back down with no input. It
 * shares the pinned foot with the background row, which was 118 px as a plain line and 132 px with
 * a download's bar and bytes. The row has one height now, so the action above it never moves.
 */
describe.skipIf(!asked)(
  "the foot holds still as the background row changes",
  () => {
    for (const [width, height] of [
      [1016, 839],
      [720, 560],
    ] as const) {
      test(`at ${width}x${height}, Accept and Continue never move through every state of the row`, async () => {
        const top = async (page: Page, name: string) =>
          (await page.getByRole("button", { name, exact: true }).boundingBox())
            ?.y;
        const emit = (page: Page, payload: Record<string, unknown>) =>
          page.evaluate(
            (sent) =>
              (
                globalThis as unknown as {
                  __fake: { emit: (name: string, payload: unknown) => void };
                }
              ).__fake.emit("setup:progress", sent),
            payload,
          );
        /*
         * Minutes into the install, as on F ("Step 3 of 4 · 3m 26s elapsed"): the wider badge is
         * what pushed the row's name onto a second line there, and the row from 118 px to 132.
         */
        const minutesIn = (page: Page) =>
          page.evaluate(() => {
            const real = Date.now;
            Date.now = () => real() + 10 * 60 * 1000;
            // Wider type than this browser sets: on Windows F the row's name or its line took a
            // second line, and the row grew 14 px. A little letter spacing does the same here.
            const wider = document.createElement("style");
            wider.textContent = ".behind-slot { letter-spacing: 0.12em; }";
            document.head.append(wider);
          });
        const licence = await browser.newPage({ viewport: { width, height } });
        try {
          await open(licence, "#licence-installing");
          await licence
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await licence
            .getByRole("heading", { name: "Accept the license agreement" })
            .waitFor();
          await minutesIn(licence);
          await licence.waitForTimeout(1200);
          const seen: (number | undefined)[] = [];
          // The longest lines that reach this row, each read whole: an engine update with its
          // prompt (on Windows G they were cut at "...so OpenBo…"), and Docker Desktop's own window
          // ("...when Docker is…"). Each in full, and the step's button where it was.
          for (const [detail, elsewhere] of LONGEST_ROW_LINES) {
            await emit(licence, {
              step: "engine",
              ok: true,
              running: true,
              elsewhere,
              detail,
            });
            const row = licence.locator(".behind-slot .step .detail", {
              hasText: detail,
            });
            await row.waitFor();
            expect({
              detail,
              cut: await licence.evaluate(() => {
                const shown = document.querySelector(
                  ".behind-slot .step .detail",
                ) as HTMLElement;
                return shown.scrollHeight > shown.clientHeight + 1;
              }),
            }).toEqual({ detail, cut: false });
            seen.push(await top(licence, "Accept"));
          }
          // A plain line.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Checking what OpenBot needs to download.",
          });
          await licence
            .getByText("Checking what OpenBot needs to download.")
            .waitFor();
          seen.push(await top(licence, "Accept"));
          // Downloading, with its bar and bytes.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Downloading OpenBot.",
            downloads: {
              done: 1,
              total: 5,
              bytes: 300_000_000,
              size: 1_100_000_000,
              bytesPerSecond: 9_000_000,
            },
          });
          await licence
            .getByText("300.0 MB of 1.1 GB", { exact: false })
            .waitFor();
          seen.push(await top(licence, "Accept"));
          // Unpacking.
          await emit(licence, {
            step: "images",
            ok: true,
            running: true,
            detail: "Downloading OpenBot.",
            downloads: {
              done: 3,
              total: 5,
              bytes: 1_100_000_000,
              size: 1_100_000_000,
            },
          });
          await licence.getByText(/Unpacking OpenBot/).waitFor();
          seen.push(await top(licence, "Accept"));
          // Installed, and the rest waiting for the person.
          await licence.evaluate(() =>
            (
              globalThis as unknown as { __fake: { finishInstall: () => void } }
            ).__fake.finishInstall(),
          );
          await licence.getByText(/Waiting for you/).waitFor();
          seen.push(await top(licence, "Accept"));
          expect(seen.every((y) => y !== undefined && y === seen[0])).toBe(
            true,
          );
        } finally {
          await licence.close();
        }

        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await open(page);
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Connect your AI" })
            .waitFor();
          await minutesIn(page);
          await page.waitForTimeout(1200);
          const seen: (number | undefined)[] = [];
          // A plain line: setting up, with nothing downloading.
          await page.getByText(/Setting up OpenBot on this computer/).waitFor();
          seen.push(await top(page, "Continue"));
          // Downloading the rest, with its bar and bytes.
          await page.evaluate(() => {
            (
              globalThis as unknown as { __fake: { download: unknown } }
            ).__fake.download = { done: 400_000_000, total: 1_600_000_000 };
          });
          await page.getByText("400.0 MB of 1.6 GB").waitFor();
          seen.push(await top(page, "Continue"));
          // Installed.
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { finishSetUp: () => void } }
            ).__fake.finishSetUp(),
          );
          await page.getByText("OpenBot is installed").waitFor();
          seen.push(await top(page, "Continue"));
          expect(seen.every((y) => y !== undefined && y === seen[0])).toBe(
            true,
          );
        } finally {
          await page.close();
        }
      }, 40_000);
    }
  },
);

/*
 * Seen on the Account step while the person signs in: its Cancel sits above the foot, the foot's
 * own actions row is empty, and the background row sat flush against Cancel with no gap at all. The
 * row sits the card's one gap (24px) under the step's button on every step, Cancel included.
 */
describe.skipIf(!asked)("the background row under the step's button", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, is one card gap below Cancel, Accept and Continue`, async () => {
      /** The gap from the button's bottom to the background row's top, the card scrolled to its end. */
      const gap = async (page: Page, name: string) => {
        await page.waitForTimeout(600);
        return page.evaluate((label) => {
          const sheet = document.querySelector("main > .sheet") as HTMLElement;
          sheet.scrollTop = sheet.scrollHeight;
          const button = [...document.querySelectorAll("button")].find(
            (found) => found.textContent?.trim() === label,
          );
          const row = document.querySelector(".behind-slot > .steps");
          if (!button || !row) return null;
          return Math.round(
            row.getBoundingClientRect().top -
              button.getBoundingClientRect().bottom,
          );
        }, name);
      };
      const scenes: Array<[string, string, string]> = [
        ["#signin", "Get your free license key", "Cancel"],
        ["#licence", "Accept the license agreement", "Accept"],
        ["", "Connect your AI", "Continue"],
      ];
      for (const [hash, heading, button] of scenes) {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await open(page, hash);
          await page
            .getByRole("button", { name: "Install", exact: true })
            .click();
          await page.getByRole("heading", { name: heading }).waitFor();
          expect({ button, gap: await gap(page, button) }).toEqual({
            button,
            gap: 24,
          });
        } finally {
          await page.close();
        }
      }
    }, 40_000);
  }
});

/*
 * Seen on Windows F: on the first screen the download line shrank about 40px when the download
 * finished ("Downloading OpenBot." with its bar and bytes, then a line saying it was downloaded),
 * and the text under it moved up. The line holds its tallest height in every state, and before it
 * says anything, so the card's bottom edge stays where it is.
 */
describe.skipIf(!asked)("the first screen at the window's default size", () => {
  // The window opens at 1000x800 (tauri.conf.json); a title bar takes some of that. Seen on
  // Windows: once the first screen listed where OpenBot runs and what this computer needs, the card
  // showed a scrollbar for a few pixels at that size. Everything on it has to show without one.
  for (const theme of ["light", "dark"] as const) {
    test(`at 1000x760 (${theme}), everything on it shows without the card scrolling, OpenBot for Business's two ways stacked`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 760 },
        colorScheme: theme,
      });
      const shots = process.env.OPENBOT_APP_SHOTS;
      try {
        await open(page);
        await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
        await page.waitForTimeout(400);
        // A build without OpenBot Cloud (VITE_OPENBOT_CLOUD_ENABLED unset) offers no Cloud row.
        expect(await page.getByText("OpenBot Cloud").count()).toBe(0);
        if (shots)
          await page.screenshot({ path: `${shots}/welcome-off-${theme}.png` });
        const shape = await page.evaluate(() => {
          const card = document.querySelector("main > .sheet") as HTMLElement;
          const group = document.querySelector(".tile-group") as HTMLElement;
          const [cloud, own] = [
            ...document.querySelectorAll(".tile-option"),
          ].map((option) => option.getBoundingClientRect());
          const marks = [...document.querySelectorAll(".cloud-mark")].map(
            (mark) => mark.getBoundingClientRect(),
          );
          const box = group.getBoundingClientRect();
          return {
            overflow: card.scrollHeight - card.clientHeight,
            // One above the other, the same width, inside the Business card.
            stacked:
              !!cloud &&
              !!own &&
              own.top >= cloud.bottom &&
              cloud.width === own.width &&
              own.right <= box.right &&
              own.bottom <= box.bottom,
            // The four clouds' marks on Self-Hosted's own line, inside its row.
            marks:
              marks.length === 4 &&
              !!own &&
              marks.every(
                (mark) =>
                  mark.top >= own.top &&
                  mark.bottom <= own.bottom &&
                  mark.right <= own.right &&
                  mark.top === marks[0]?.top,
              ),
            // Each choice's name and line on one line.
            oneLine: [...document.querySelectorAll(".tile-option-text")].every(
              (text) => text.getBoundingClientRect().height <= 21,
            ),
          };
        });
        const { overflow, ...laid } = shape;
        expect(overflow).toBeLessThanOrEqual(0);
        expect(laid).toEqual({ stacked: true, marks: true, oneLine: true });
        // And connecting to a company's own OpenBot, by the link under the rows: the address and Connect.
        await page.getByRole("button", { name: "Connect to it" }).click();
        await page
          .getByLabel("Your company's OpenBot address", { exact: true })
          .waitFor();
        await page.waitForTimeout(400);
        expect(
          await page.evaluate(() => {
            const card = document.querySelector("main > .sheet") as HTMLElement;
            return card.scrollHeight - card.clientHeight;
          }),
        ).toBeLessThanOrEqual(0);
        expect(
          await page.getByRole("button", { name: "Connect" }).count(),
        ).toBe(1);
      } finally {
        await page.close();
      }
    });

    /*
     * A build with OpenBot Cloud on: OpenBot Cloud and OpenBot for Business as the two rows, Cloud
     * picked with its sign-in under them, and OpenBot (Self-Contained) a line at the card's foot.
     * All of it fits, and so does Self-Contained opened, with Install, and the address.
     */
    test(`at 1000x760 (${theme}), a build with OpenBot Cloud on opens on Cloud's sign-in, Self-Contained a line at the foot, without the card scrolling`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 760 },
        colorScheme: theme,
      });
      const shots = process.env.OPENBOT_APP_SHOTS;
      try {
        await routeCalendar(page);
        await open(page, "", cloudBuilt);
        await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
        await page
          .getByRole("button", { name: "Sign in to OpenBot Cloud" })
          .waitFor();
        // Measured in the window's own face: a line set in the fallback, before Inter has loaded,
        // can wrap where Inter's doesn't.
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await page.waitForTimeout(400);
        const shape = await page.evaluate(() => {
          const card = document.querySelector("main > .sheet") as HTMLElement;
          const rows = [
            ...document.querySelectorAll("fieldset.picker.hosting > .tile"),
          ].map((row) => row.getBoundingClientRect());
          const foot = document.querySelector(
            ".this-computer-foot",
          ) as HTMLElement | null;
          const footBox = foot?.getBoundingClientRect();
          const signIn = [...document.querySelectorAll("button")]
            .find((button) => button.textContent === "Sign in to OpenBot Cloud")
            ?.getBoundingClientRect();
          const size = (element: Element | null | undefined) =>
            element
              ? Number.parseFloat(getComputedStyle(element).fontSize)
              : Number.NaN;
          const business = document.querySelector(
            ".tile.with-marks",
          ) as HTMLElement;
          const box = business.getBoundingClientRect();
          const words = business
            .querySelector(".tile-summary")
            ?.getBoundingClientRect();
          const marks = [...business.querySelectorAll(".cloud-mark")].map(
            (mark) => mark.getBoundingClientRect(),
          );
          return {
            overflow: card.scrollHeight - card.clientHeight,
            // Each cloud's own mark, drawn: an empty tile is a mark that didn't load.
            drawn: [
              ...business.querySelectorAll<HTMLImageElement>(".cloud-mark img"),
            ].map((image) => [
              image.dataset.mark,
              image.complete && image.naturalWidth > 0,
            ]),
            // Two rows, one above the other, the same width.
            rows:
              rows.length === 2 &&
              rows.every(
                (row, at) =>
                  row.width === rows[0]?.width &&
                  (at === 0 || row.top >= (rows[at - 1]?.bottom ?? 0)),
              ),
            // Self-Contained at the foot: the card's last element, below Cloud's sign-in, one line
            // in smaller type than the rows' names, inside the card.
            foot:
              !!foot &&
              !!footBox &&
              !!signIn &&
              foot.parentElement?.lastElementChild === foot &&
              footBox.top >= signIn.bottom &&
              footBox.bottom <= card.getBoundingClientRect().bottom &&
              size(foot.querySelector(".this-computer-aside")) <
                size(
                  document.querySelector("fieldset.picker.hosting .tile-name"),
                ) &&
              (foot
                .querySelector(".this-computer-aside")
                ?.getBoundingClientRect().height ?? 99) <= 21,
            // The four clouds' marks inside OpenBot for Business's row, on one line, past its words.
            marks:
              marks.length === 4 &&
              !!words &&
              marks.every(
                (mark) =>
                  mark.top >= box.top &&
                  mark.bottom <= box.bottom &&
                  mark.right <= box.right &&
                  mark.left >= words.right &&
                  mark.top === marks[0]?.top,
              ),
            // Each row's name and line on one line.
            oneLine: [
              ...document.querySelectorAll(
                "fieldset.picker.hosting .tile-name, fieldset.picker.hosting .tile-summary",
              ),
            ].every((text) => text.getBoundingClientRect().height <= 22),
          };
        });
        const { overflow, ...laid } = shape;
        expect(overflow).toBeLessThanOrEqual(0);
        expect(laid).toEqual({
          drawn: [
            ["aws", true],
            ["azure", true],
            ["google-cloud", true],
            ["kubernetes", true],
          ],
          rows: true,
          foot: true,
          marks: true,
          oneLine: true,
        });
        if (shots) {
          await page.screenshot({ path: `${shots}/welcome-on-${theme}.png` });
        }
        /*
         * OpenBot for Business picked: what it adds, then Book a demo and its calendar, taller than
         * the window. The card scrolls, never the page, and scrolled to its end the calendar is
         * whole inside the card, nothing cut at either edge.
         */
        await page.getByText("Your own cloud or on-prem. Book a demo.").click();
        await page
          .locator(
            '.booking-calendar[data-ready] iframe[title="Booking calendar"]',
          )
          .waitFor();
        await page.waitForTimeout(200);
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-business-${theme}.png`,
          });
        // Book a demo is in view as soon as Business is picked, and takes the card to the calendar.
        const button = page.getByRole("button", {
          name: "Book a demo",
          exact: true,
        });
        const at = await button.boundingBox();
        expect((at?.y ?? 760) + (at?.height ?? 0)).toBeLessThanOrEqual(760);
        await button.click();
        await page.waitForTimeout(800);
        const jumped = await page.evaluate(() => {
          const view = (
            document.querySelector("main > .sheet") as HTMLElement
          ).getBoundingClientRect();
          const heading = document
            .querySelector("#book-a-demo-title")
            ?.getBoundingClientRect();
          const frame = document
            .querySelector('iframe[title="Booking calendar"]')
            ?.getBoundingClientRect();
          return {
            heading:
              !!heading &&
              heading.top >= view.top &&
              heading.top <= view.top + 40,
            calendar: !!frame && frame.top < view.bottom - 300,
            focused: document.activeElement?.id === "book-a-demo-title",
          };
        });
        expect(jumped).toEqual({
          heading: true,
          calendar: true,
          focused: true,
        });
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-business-booker-${theme}.png`,
          });
        const booker = await page.evaluate(() => {
          const card = document.querySelector("main > .sheet") as HTMLElement;
          const view = card.getBoundingClientRect();
          const element = document.querySelector(
            'iframe[title="Booking calendar"]',
          ) as HTMLElement;
          // The calendar fits the card's visible area whole, scrolled to it.
          element.scrollIntoView({ block: "center" });
          const frame = element.getBoundingClientRect();
          const heading = document
            .querySelector("#book-a-demo-title")
            ?.getBoundingClientRect();
          const calendar =
            frame.height >= 320 &&
            frame.top >= view.top &&
            frame.bottom <= view.bottom;
          // At the card's end, Self-Contained's line is last and in view, below the calendar.
          card.scrollTop = card.scrollHeight;
          const foot = document
            .querySelector(".this-computer-foot")
            ?.getBoundingClientRect();
          const below = element.getBoundingClientRect();
          return {
            page: document.documentElement.scrollHeight <= window.innerHeight,
            cardScrolls: card.scrollHeight > card.clientHeight + 1,
            sideways: card.scrollWidth - card.clientWidth <= 0,
            calendar,
            // Its heading sits above it.
            heading: !!heading && heading.bottom <= frame.top,
            foot:
              !!foot &&
              foot.top >= below.bottom &&
              foot.top >= view.top &&
              foot.bottom <= view.bottom,
          };
        });
        expect(booker).toEqual({
          page: true,
          cardScrolls: true,
          sideways: true,
          calendar: true,
          heading: true,
          foot: true,
        });
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-business-end-${theme}.png`,
          });
        // Self-Contained opened at the foot: what this computer needs and Install, still without a
        // scrollbar.
        await page
          .getByRole("button", { name: "Use OpenBot (Self-Contained)" })
          .click();
        await page
          .getByRole("button", { name: "Install", exact: true })
          .waitFor();
        await page.waitForTimeout(200);
        expect(
          await page.evaluate(() => {
            const card = document.querySelector("main > .sheet") as HTMLElement;
            return card.scrollHeight - card.clientHeight;
          }),
        ).toBeLessThanOrEqual(0);
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-self-contained-${theme}.png`,
          });
        // Connect to it: the address and Connect, still without a scrollbar.
        await page.getByRole("button", { name: "Connect to it" }).click();
        await page
          .getByLabel("Your company's OpenBot address", { exact: true })
          .waitFor();
        // The pointer off the card, as a person's is once they type: nothing shows hovered.
        await page.mouse.move(2, 2);
        await page.waitForTimeout(200);
        expect(
          await page.evaluate(() => {
            const card = document.querySelector("main > .sheet") as HTMLElement;
            return {
              overflow: card.scrollHeight - card.clientHeight <= 0,
              // Nothing looks picked: no row, and no shaded Self-Contained.
              chosen: document.querySelectorAll(".chosen").length,
            };
          }),
        ).toEqual({ overflow: true, chosen: 0 });
        if (shots)
          await page.screenshot({
            path: `${shots}/welcome-on-connect-${theme}.png`,
          });
      } finally {
        await page.close();
      }
    });
  }

  /*
   * OpenBot for Business books a call: either of its two ways to run, picked, shows the app's
   * OpenBot for Business view, what it adds and the booking calendar, where it used to show an
   * address field. Taller than the window, it scrolls in the card as any tall step does; the page
   * never does, nothing runs off the card's side, and the calendar takes the height Calendly reports.
   */
  test("at 1000x760, OpenBot for Business shows its booker in the card, which scrolls, and no address field", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 760 },
    });
    try {
      await routeCalendar(page);
      await open(page);
      await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
      await page.getByText("Your own cloud or on-prem.").click();
      await page.locator(".tile-option.chosen").waitFor();
      await page.getByText("We run it for you.").click();
      await page
        .locator(
          '.booking-calendar[data-ready] iframe[title="Booking calendar"]',
        )
        .waitFor();
      expect(
        await page
          .getByLabel("Your company's OpenBot address", { exact: true })
          .count(),
      ).toBe(0);
      expect(
        await page
          .getByRole("button", { name: "Connect", exact: true })
          .count(),
      ).toBe(0);
      expect(
        await page.getByText("A full audit trail, with export").count(),
      ).toBe(1);
      const shape = await page.evaluate(() => {
        const card = document.querySelector("main > .sheet") as HTMLElement;
        const frame = document.querySelector(
          'iframe[title="Booking calendar"]',
        ) as HTMLElement;
        const wider = [...card.querySelectorAll("*")].filter(
          (element) =>
            element.getBoundingClientRect().right >
            card.getBoundingClientRect().right + 0.5,
        );
        return {
          page: document.documentElement.scrollHeight,
          cardScrolls: card.scrollHeight > card.clientHeight + 1,
          sideways: card.scrollWidth - card.clientWidth,
          wider: wider.map((element) => element.className),
          frame: frame.getBoundingClientRect().height,
        };
      });
      expect(shape.page).toBeLessThanOrEqual(760);
      expect(shape.cardScrolls).toBe(true);
      expect(shape.sideways).toBeLessThanOrEqual(0);
      expect(shape.wider).toEqual([]);
      expect(shape.frame).toBe(660);
      // The way to connect is still under the rows, and leads to the address.
      await page.getByRole("button", { name: "Connect to it" }).click();
      await page
        .getByLabel("Your company's OpenBot address", { exact: true })
        .waitFor();
      expect(
        await page.locator('iframe[title="Booking calendar"]').count(),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });
});

/**
 * Calendly, as far as the window can tell: a page in the calendar's frame that says its height, as
 * Calendly's inline embed does once it is drawn. The real one is on the web, which a test never is.
 */
async function routeCalendar(page: Page) {
  await page.route("https://calendly.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body style="margin:0;height:660px;background:#fff;font:14px sans-serif;color:#555;display:grid;place-items:center">Booking calendar (stand-in for Calendly)<script>
        parent.postMessage({ event: "calendly.page_height", payload: { height: "660px" } }, "*");
      </script></body>`,
    }),
  );
}

describe.skipIf(!asked)("the first screen while its downloads run", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the card holds its height under the download line`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
        await page.waitForTimeout(400);
        // The card's bottom edge: nothing under the line moves, and the card does not shrink.
        const usage = async () => {
          const box = await page.locator("main > .sheet").boundingBox();
          return Math.round(box ? box.y + box.height : -1);
        };
        const say = async (payload: Record<string, unknown>) => {
          await page.evaluate((sent) => {
            (
              globalThis as unknown as {
                __fake: { emit: (name: string, payload: unknown) => void };
              }
            ).__fake.emit("setup:downloads", sent);
          }, payload);
          await page.waitForTimeout(300);
        };
        const GB = 1_000_000_000;
        const seen: Array<[string, number]> = [["nothing yet", await usage()]];
        for (const [state, payload] of [
          ["starting", { state: "downloading", bytes: 0 }],
          [
            "downloading",
            {
              state: "downloading",
              bytes: 0.15 * GB,
              size: 0.31 * GB,
              bytesPerSecond: 9_000_000,
            },
          ],
          ["done", { state: "done", bytes: 0.31 * GB, size: 0.31 * GB }],
          ["failed", { state: "failed", bytes: 0.2 * GB, size: 0.31 * GB }],
          [
            "short of disk",
            { state: "short", bytes: 0, free: 14.6 * GB, needed: 44.3 * GB },
          ],
        ] as const) {
          await say(payload);
          seen.push([state, await usage()]);
        }
        const first = seen[0]?.[1];
        expect(first).toBeGreaterThan(0);
        expect(seen.map(([state, y]) => [state, y - (first ?? 0)])).toEqual(
          seen.map(([state]) => [state, 0]),
        );
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

describe.skipIf(!asked)("the AI step while OpenBot installs behind it", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the form does not move and the page does not grow as the download comes and goes`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page);
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
        await page.getByText("Any OpenAI-compatible endpoint").click();
        await page.getByLabel("Base URL", { exact: true }).waitFor();
        // The entrance animation settles before anything is measured.
        await page.waitForTimeout(600);
        const before = await measure(page);
        expect(before.field).toBeGreaterThan(0);

        // The rest of OpenBot starts downloading, while the person types in the form.
        await page.evaluate(() => {
          (
            globalThis as unknown as { __fake: { download: unknown } }
          ).__fake.download = { done: 400_000_000, total: 1_600_000_000 };
        });
        await page.getByText("400.0 MB of 1.6 GB").waitFor();
        expect(await measure(page)).toEqual(before);

        // The download ends.
        await page.evaluate(() => {
          (
            globalThis as unknown as { __fake: { download: unknown } }
          ).__fake.download = null;
        });
        await page.getByText("400.0 MB of 1.6 GB").waitFor({ state: "hidden" });
        expect(await measure(page)).toEqual(before);

        // Everything is installed, and the row says so.
        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishSetUp: () => void } }
          ).__fake.finishSetUp(),
        );
        await page.getByText("OpenBot is installed").waitFor();
        expect(await measure(page)).toEqual(before);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/** Where the step's heading and its first row are: what a person is reading. */
async function anchors(page: Page) {
  const heading = await page
    // Only the Start that updates OpenBot (`#start`) asks.
    .getByRole("heading", { name: "Updating OpenBot" })
    .boundingBox();
  const first = await page
    .getByRole("listitem", { name: "Setting up OpenBot" })
    .boundingBox();
  return { heading: heading?.y, first: first?.y };
}

/*
 * Seen on Windows: Start's card re-centred as rows came and went while OpenBot updated, so the
 * heading and the rows jumped up 31px when the update's row appeared, up 20px when its download
 * bar did, and down 20px when the bar went. The card is held from the top now, and the update is
 * the Start journey's: its download's measure sits on the journey's time line, so neither the
 * heading nor the rows move as it comes and goes.
 */
describe.skipIf(!asked)("the Start screen while OpenBot updates", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, nothing on screen moves as the update and its download come and go`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page, "#start");
        await page.getByRole("listitem", { name: "Opening OpenBot" }).waitFor();
        await page.waitForTimeout(600);
        const before = await anchors(page);
        expect(before.heading).toBeGreaterThan(0);
        const said = page.locator(".journey-said");
        const time = page.locator(".journey-time");

        const emit = (payload: Record<string, unknown>) =>
          page.evaluate(
            (sent) =>
              (
                globalThis as unknown as {
                  __fake: { emit: (name: string, payload: unknown) => void };
                }
              ).__fake.emit("setup:progress", sent),
            payload,
          );
        // The update begins: the journey says so.
        await emit({
          step: "release",
          ok: true,
          running: true,
          detail: "Downloading the update.",
        });
        await page
          .locator(".journey-said", { hasText: "Downloading the update" })
          .waitFor();
        expect(await anchors(page)).toEqual(before);
        const lines = await time.boundingBox();
        // Its download, measured on the journey's time line, and one bar on the screen.
        await emit({
          step: "images",
          ok: true,
          running: true,
          detail: "Downloading local software.",
          downloads: {
            done: 1,
            total: 5,
            bytes: 100_000_000,
            size: 944_200_000,
          },
        });
        await page
          .getByText("100.0 MB of 944.2 MB", { exact: false })
          .waitFor();
        expect(await anchors(page)).toEqual(before);
        expect((await time.boundingBox())?.height).toBe(lines?.height);
        expect(await page.getByRole("progressbar").count()).toBe(1);
        // The download ends, and its measure goes.
        await emit({
          step: "images",
          ok: true,
          running: false,
          detail: "Local software is downloaded (5/5).",
        });
        await page
          .getByText("100.0 MB of 944.2 MB", { exact: false })
          .waitFor({ state: "hidden" });
        expect(await anchors(page)).toEqual(before);
        // Its download done, the update is on to installing what it downloaded.
        expect(await said.textContent()).toBe("Installing the update");
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * David's decision for 1.0.2: on a Mac whose own Podman OpenBot can't use, the account step says
 * OpenBot needs its own and offers to pause theirs, with one button. The card, its button and the
 * background row are all in the window at the setup window's sizes, without the page growing.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each size for a look.
 */
describe.skipIf(!asked)("the offer to pause the person's Podman", () => {
  for (const [width, height] of [
    [1016, 839],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, the offer and its button are in the window`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await open(page, "#pause-podman");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Setting up this computer" })
          .waitFor();
        const card = page.getByRole("region", {
          name: "OpenBot needs its own Podman",
        });
        await card.waitFor();
        await page.waitForTimeout(400);
        const button = page.getByRole("button", { name: "Pause my Podman" });
        const box = await button.boundingBox();
        const behind = page.getByRole("listitem", {
          name: "Installing OpenBot in the background",
        });
        const foot = await page.locator(".step-footer").boundingBox();
        expect(box).not.toBeNull();
        expect(foot).not.toBeNull();
        if (box && foot) {
          // In the window, and not under the step's pinned foot: seen at 720x560, cut in half.
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(foot.y);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        expect(await behind.textContent()).toContain(
          "Waiting for you to pause your Podman.",
        );
        expect(
          await page.evaluate(() => ({
            page: document.documentElement.scrollHeight,
            window: window.innerHeight,
          })),
        ).toEqual({ page: height, window: height });
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/pause-podman-${width}x${height}.png`,
          });
        await button.click();
        expect(
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { calls: string[] } }
            ).__fake.calls.filter((call) => call === "allow_pause_podman"),
          ),
        ).toEqual(["allow_pause_podman"]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/** Goes from the first screen to "Connect your AI", as a first run does. */
async function toTheAiStep(page: Page, hash = "") {
  await open(page, hash);
  await page.getByRole("button", { name: "Install", exact: true }).click();
  await page.getByRole("heading", { name: "Connect your AI" }).waitFor();
  // The entrance animation settles before anything is measured.
  await page.waitForTimeout(600);
}

const PROVIDERS = [
  "OpenAI",
  "Anthropic",
  "Google Gemini",
  "xAI",
  "Unbiased AI",
  "TrustedRouter",
  "Any OpenAI-compatible endpoint",
];

/*
 * Seen on Windows G (the default 1000x800 window): on "Connect your AI" the last providers sat under
 * the step's pinned foot, Continue and the background row, with a sliver of one tile's edge
 * showing, and nothing said the list went on. The list has no scroll of its own: the card is the
 * one scroll area, the list plainly goes on under the foot, and each provider scrolls into view.
 */
describe.skipIf(!asked)("Connect your AI with every provider", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, one scroll area, the list plainly goes on under the foot, and every provider scrolls into view`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await toTheAiStep(page);
        const look = () =>
          page.evaluate(() => {
            const sheet = document.querySelector(
              "main > .sheet",
            ) as HTMLElement;
            const foot = sheet.querySelector(".step-footer") as HTMLElement;
            const top = sheet.getBoundingClientRect().top;
            const footTop = foot.getBoundingClientRect().top;
            const scrolling = [...document.querySelectorAll("*")]
              .filter((element) => {
                const { overflowY } = getComputedStyle(element);
                return (
                  /auto|scroll/.test(overflowY) &&
                  element.scrollHeight > element.clientHeight + 1
                );
              })
              .map((element) => element.className);
            const fade = getComputedStyle(foot, "::before");
            const tiles = [
              ...sheet.querySelectorAll("fieldset.providers .tile"),
            ].map((tile) => {
              const box = tile.getBoundingClientRect();
              const at = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
              return {
                name: tile.querySelector(".tile-name")?.textContent ?? "",
                // Whole, above the foot, and nothing over it.
                shown:
                  box.top >= top - 1 &&
                  box.bottom <= footTop + 1 &&
                  Boolean(at && tile.contains(at)),
              };
            });
            return {
              scrolling,
              goesOn:
                fade.content !== "none" && Number.parseFloat(fade.height) > 0,
              tiles,
            };
          });
        const first = await look();
        expect(first.scrolling).toEqual(["sheet"]);
        expect(first.tiles.map((tile) => tile.name)).toEqual(PROVIDERS);
        // Some are under the foot at this size, and the screen says the list goes on.
        expect(first.tiles.some((tile) => !tile.shown)).toBe(true);
        expect(first.goesOn).toBe(true);
        // A wheel over the list scrolls the card, and brings every provider into view.
        const seen = new Set(
          first.tiles.filter((tile) => tile.shown).map((tile) => tile.name),
        );
        await page.mouse.move(width / 2, height / 3);
        let now = first;
        for (let turn = 0; turn < 12 && now.goesOn; turn += 1) {
          await page.mouse.wheel(0, 90);
          await page.waitForTimeout(150);
          now = await look();
          for (const tile of now.tiles) if (tile.shown) seen.add(tile.name);
          expect(now.scrolling).toEqual(["sheet"]);
        }
        expect([...seen].sort()).toEqual([...PROVIDERS].sort());
        // At the end of the card nothing is under the foot, and the screen no longer says so.
        expect(now.goesOn).toBe(false);
        expect(now.tiles[now.tiles.length - 1]?.shown).toBe(true);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

/*
 * Seen on Windows G: the background row read "Installing OpenBot in the backgr..." beside its
 * "Step 3 of 4 · 4m 18s elapsed" badge. Its name is whole now, the badge on a line of its own, and
 * the row still fits the height its slot holds in every state.
 */
describe.skipIf(!asked)(
  "the background row's name beside minutes of install",
  () => {
    for (const [width, height] of [
      [1016, 839],
      [1000, 800],
      [720, 560],
    ] as const) {
      test(`at ${width}x${height}, is read whole in Windows-wide type, and the row fits its slot`, async () => {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await toTheAiStep(page);
          await page.evaluate(() => {
            const real = Date.now;
            Date.now = () => real() + 258_000;
            // Wider type than this browser sets, as the foot's own test does: Windows' is.
            const wider = document.createElement("style");
            wider.textContent = ".behind-slot { letter-spacing: 0.12em; }";
            document.head.append(wider);
          });
          const read = () =>
            page.evaluate(() => {
              const name = document.querySelector(
                ".behind-slot .step-label",
              ) as HTMLElement;
              const row = document
                .querySelector(".behind-slot > .steps")
                ?.getBoundingClientRect();
              const slot = document
                .querySelector(".behind-slot")
                ?.getBoundingClientRect();
              return {
                name: name.textContent,
                cut: name.scrollWidth > name.clientWidth,
                badge:
                  document.querySelector(".behind-slot .step-status")
                    ?.textContent ?? "",
                fits: (row?.bottom ?? 1e9) <= (slot?.bottom ?? 0) + 0.5,
              };
            });
          // Setting up, then downloading the rest with its bar and bytes, then installed.
          await page.getByText(/Setting up OpenBot on this computer/).waitFor();
          await page.waitForTimeout(1100);
          const plain = await read();
          expect(plain).toEqual({
            name: "Installing OpenBot in the background",
            cut: false,
            badge: expect.stringMatching(/^Step 3 of 4 · 4m \d+s elapsed$/),
            fits: true,
          });
          await page.evaluate(() => {
            (
              globalThis as unknown as { __fake: { download: unknown } }
            ).__fake.download = { done: 481_800_000, total: 605_200_000 };
          });
          await page.getByText("481.8 MB of 605.2 MB").waitFor();
          expect(await read()).toEqual({ ...plain, badge: expect.any(String) });
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  },
);

/*
 * Seen on Windows G: the background row moved about 15 px sideways when a provider was chosen, as
 * the card stopped scrolling and its scrollbar went. With the scrollbars Windows draws, which
 * take room, the row is where it was either way.
 */
describe.skipIf(!asked)(
  "with scrollbars that take room, as Windows draws them",
  () => {
    test("at 1000x800, the background row holds still as the card's scrollbar comes and goes", async () => {
      const drawn = await chromium.launch({
        channel: "chromium",
        ignoreDefaultArgs: ["--hide-scrollbars"],
      });
      try {
        const page = await drawn.newPage({
          viewport: { width: 1000, height: 800 },
        });
        await toTheAiStep(page);
        const where = () =>
          page.evaluate(() => {
            const sheet = document.querySelector(
              "main > .sheet",
            ) as HTMLElement;
            const row = document
              .querySelector(".behind-slot > .steps")
              ?.getBoundingClientRect();
            const tile = document
              .querySelector("fieldset.providers .tile")
              ?.getBoundingClientRect();
            return {
              scrolls: sheet.scrollHeight > sheet.clientHeight + 1,
              scrollbar: sheet.offsetWidth - sheet.clientWidth > 2,
              row: row && { left: row.left, width: row.width },
              tile: tile && { left: tile.left, width: tile.width },
            };
          });
        const listing = await where();
        expect(listing.scrolls).toBe(true);
        expect(listing.scrollbar).toBe(true);
        // A provider chosen, the step fits, and the card has no scrollbar to draw.
        await page.getByText("Anthropic", { exact: true }).click();
        await page
          .getByRole("button", { name: "Choose a different provider" })
          .waitFor();
        await page.waitForTimeout(400);
        const chosen = await where();
        expect(chosen.scrolls).toBe(false);
        expect(chosen.row).toEqual(listing.row);
        expect(chosen.tile).toEqual(listing.tile);
      } finally {
        await drawn.close();
      }
    }, 30_000);
  },
);

/*
 * Seen on Windows K: on "Finishing setup" the usage data checkbox sat under the step's rows, and the
 * rows come one at a time. It was on screen and could be clicked from the step's first moment, and
 * then moved down 49 px three times in about three seconds as the second, third and fourth rows
 * arrived, 147 px in all. A click aimed at it landed on nothing, and the box stayed ticked. The
 * choice sits above the rows now, under the step's own words, and holds its place for the whole step.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of the step's first and last moments at each size.
 */
describe.skipIf(!asked)("Finishing setup's usage data choice", () => {
  for (const [width, height] of [
    [1000, 800],
    [720, 560],
  ] as const) {
    test(`at ${width}x${height}, holds its place from the step's first row to its last, and unticks where it was`, async () => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await toTheAiStep(page);
        await page.getByText("Anthropic", { exact: true }).click();
        await page
          .getByRole("tab", { name: "Use an API key", exact: true })
          .click();
        await page
          .getByLabel("Anthropic API key", { exact: true })
          .fill("a-key-for-this-test");
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page.getByRole("heading", { name: "Finishing setup" }).waitFor();
        const box = page.getByRole("checkbox");
        await box.waitFor();
        // The entrance animation settles before anything is measured.
        await page.waitForTimeout(600);
        /** Where the checkbox is in the window, and whether a click at its middle reaches it. */
        const where = async () => {
          const at = await box.boundingBox();
          const reached = await page.evaluate(() => {
            const found = document.querySelector(
              '.usage-choice input[type="checkbox"]',
            ) as HTMLInputElement;
            const rect = found.getBoundingClientRect();
            return (
              document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              ) === found
            );
          });
          return { x: at?.x, y: at?.y, reached };
        };
        const rows = () => page.locator(".steps > .step").count();
        const shots = process.env.OPENBOT_APP_SHOTS;
        const keep = async (moment: string) => {
          if (shots)
            await page.screenshot({
              path: `${shots}/finishing-setup-${moment}-${width}x${height}.png`,
            });
        };

        // The step's first moment: one row, setting up, and the choice already there to click.
        await page
          .getByRole("listitem", { name: "Setting up OpenBot" })
          .waitFor();
        const first = await where();
        expect(await rows()).toBe(1);
        expect(first.y).toBeGreaterThan(0);
        expect(first.reached).toBe(true);
        await keep("first-row");

        // Setting up ends, and the rest of the rows arrive one after another.
        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishSetUp: () => void } }
          ).__fake.finishSetUp(),
        );
        await page.getByRole("listitem", { name: "Opening OpenBot" }).waitFor();
        await page.waitForTimeout(600);
        expect(await rows()).toBe(4);
        await keep("last-row");
        expect(await where()).toEqual(first);

        // A click where the box was at the step's first moment unticks it.
        await page.mouse.click((first.x ?? 0) + 6, (first.y ?? 0) + 6);
        await page.waitForTimeout(200);
        expect(
          await page.evaluate(() =>
            (
              globalThis as unknown as { __fake: { calls: string[] } }
            ).__fake.calls.filter(
              (call) => call === "plugin:openbot-desktop|set_usage_data",
            ),
          ),
        ).toEqual(["plugin:openbot-desktop|set_usage_data"]);
      } finally {
        await page.close();
      }
    }, 40_000);
  }
});

/*
 * Seen on a Mac's first install: on Finishing setup, "Connecting OpenBot" stopped with "Setup
 * stopped partway through with an error. Retry. If it stops again, copy the logs below.", and the
 * card had nothing below it but Retry. The logs it names are in the card now, and in view.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of the stopped card.
 */
describe.skipIf(!asked)("Finishing setup when a step stops", () => {
  test("offers the logs its sentence names, in view", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toTheAiStep(page, "#connect-fails");
      await page.getByText("Anthropic", { exact: true }).click();
      await page
        .getByRole("tab", { name: "Use an API key", exact: true })
        .click();
      await page
        .getByLabel("Anthropic API key", { exact: true })
        .fill("a-key-for-this-test");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("heading", { name: "Finishing setup" }).waitFor();
      await page.evaluate(() =>
        (
          globalThis as unknown as { __fake: { finishSetUp: () => void } }
        ).__fake.finishSetUp(),
      );
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      await page.waitForTimeout(600);
      const shots = process.env.OPENBOT_APP_SHOTS;
      if (shots)
        await page.screenshot({
          path: `${shots}/finishing-setup-stopped-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
        });
      const connect = await page
        .getByRole("listitem", { name: "Connecting OpenBot" })
        .textContent();
      expect(connect).toContain("copy the logs below");
      const copy = page.getByRole("button", { name: "Copy logs", exact: true });
      expect(await copy.count()).toBe(1);
      expect(
        await page
          .getByRole("button", { name: "Save to a file", exact: true })
          .count(),
      ).toBe(1);
      // In the window as it opens, under the row that names it: nothing to scroll to.
      const [row, button] = await Promise.all([
        page
          .getByRole("listitem", { name: "Connecting OpenBot" })
          .boundingBox(),
        copy.boundingBox(),
      ]);
      expect(button).not.toBeNull();
      expect(button?.y ?? 0).toBeGreaterThan(row?.y ?? 0);
      expect((button?.y ?? 0) + (button?.height ?? 0)).toBeLessThanOrEqual(800);
    } finally {
      await page.close();
    }
  }, 40_000);
});

/*
 * An update this computer has no room for. On Windows the sentence with the figures sat at the foot
 * of the window, in a "That didn't finish" box under "OpenBot is stopped / ready to reopen", a row
 * that said "OpenBot did not start." and a second copy of the logs. What it needs is the heading and
 * the sentence under it, with Retry beside it, in the window as it opens; the row that stopped says
 * why; the logs are offered once. For OpenBot's own update, and for the back end's, which the window
 * runs first. `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each, light and dark.
 */
describe.skipIf(!asked)("an update this computer has no room for", () => {
  const cases = [
    {
      hash: "#update-short",
      said: "This computer has 7.4 GB of free space on drive C:, and OpenBot needs about 13 GB to update. Free up some space, then Retry.",
    },
    {
      hash: "#backend-short",
      said: "This Mac has 8.2 GB of free space, and OpenBot needs about 13 GB to update. Free up some space, then Retry.",
    },
  ];
  for (const { hash, said } of cases)
    for (const colorScheme of ["light", "dark"] as const)
      test(`says what it needs first, with Retry beside it (${hash.slice(1)}, ${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 800 },
          colorScheme,
        });
        try {
          await open(page, hash);
          // Stopped, whatever it is headed.
          await page
            .getByRole("button", { name: "Retry", exact: true })
            .waitFor();
          await page.waitForTimeout(600);
          const shots = process.env.OPENBOT_APP_SHOTS;
          if (shots)
            await page.screenshot({
              path: `${shots}/no-room-${hash.slice(1)}-${colorScheme}-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
            });
          const seen = await page.evaluate(() => {
            const box = (element: Element | null | undefined) => {
              const rect = element?.getBoundingClientRect();
              return rect ? { top: rect.top, bottom: rect.bottom } : null;
            };
            const lede = document.querySelector("main .lede");
            const retry = [...document.querySelectorAll("main button")].filter(
              (button) => button.textContent === "Retry",
            );
            const failed = [...document.querySelectorAll("main li")].filter(
              (row) => row.textContent?.includes("Failed"),
            );
            const named = (label: string) =>
              [...document.querySelectorAll("main button")].filter(
                (button) => button.textContent === label,
              ).length;
            const ledeBox = box(lede);
            const retryBox = box(retry[0]);
            const rowsBox = box(document.querySelector("main li"));
            const text = document.querySelector("main")?.textContent ?? "";
            return {
              heading: document.querySelector("main h1")?.textContent,
              lede: lede?.textContent,
              retries: retry.length,
              // Retry under the sentence and above the rows, in the window as it opens.
              retryUnderSentence: (retryBox?.top ?? 0) > (ledeBox?.bottom ?? 0),
              retryAboveRows: (retryBox?.bottom ?? 0) < (rowsBox?.top ?? 0),
              retryInView: (retryBox?.bottom ?? 900) <= 800,
              failedRows: failed.length,
              failedRowSaysWhy: failed.some((row) =>
                row.textContent?.includes("Not enough free space to update."),
              ),
              saysDidNotStart: text.includes("did not start"),
              saysDidNotFinish: text.includes("That didn’t finish"),
              saysReadyToReopen: text.includes("ready to reopen"),
              copyLogs: named("Copy logs"),
              saveToAFile: named("Save to a file"),
            };
          });
          expect(seen).toEqual({
            heading: "OpenBot needs more free space to update",
            lede: said,
            retries: 1,
            retryUnderSentence: true,
            retryAboveRows: true,
            retryInView: true,
            failedRows: 1,
            failedRowSaysWhy: true,
            saysDidNotStart: false,
            saysDidNotFinish: false,
            saysReadyToReopen: false,
            copyLogs: 1,
            saveToAFile: 1,
          });
        } finally {
          await page.close();
        }
      }, 40_000);
});

/*
 * An image list something outside OpenBot deleted. Start used to say "This version of OpenBot does
 * not include the Bot you picked. Go back and choose another, or update OpenBot.", and every Retry
 * failed the same way. Start says it is an unfinished install now, so the window runs Install by
 * itself (which downloads only the list again) before it starts. Offline here, so that install
 * fails: the window is on Installing OpenBot with the download row failed and Retry installation,
 * and says nothing about the Bot. `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot, light and dark.
 */
describe.skipIf(!asked)("a Start whose image list is gone", () => {
  for (const colorScheme of ["light", "dark"] as const)
    test(`installs again by itself, and offline says the download failed, not the Bot (${colorScheme})`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
        colorScheme,
      });
      try {
        await open(page, "#image-list-gone");
        await page
          .getByRole("button", { name: "Retry installation", exact: true })
          .waitFor();
        await page.waitForTimeout(600);
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/image-list-gone-${colorScheme}-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
          });
        const seen = await page.evaluate(() => {
          const calls = (
            globalThis as unknown as { __fake: { calls: string[] } }
          ).__fake.calls;
          const text = document.querySelector("main")?.textContent ?? "";
          const failed = [...document.querySelectorAll("main li")].filter(
            (row) => row.textContent?.includes("Failed"),
          );
          return {
            heading: document.querySelector("main h1")?.textContent,
            failedRows: failed.length,
            failedDownload: failed.some((row) =>
              row.textContent?.includes("Downloading OpenBot"),
            ),
            blamesTheBot: text.includes("does not include"),
            saysDidNotStart: text.includes("did not start"),
            starts: calls.filter((call) => call === "start_stack").length,
            installs: calls.filter((call) => call === "prepare_installation")
              .length,
          };
        });
        expect(seen).toEqual({
          heading: "Installing OpenBot",
          failedRows: 1,
          failedDownload: true,
          blamesTheBot: false,
          saysDidNotStart: false,
          starts: 1,
          installs: 1,
        });
      } finally {
        await page.close();
      }
    }, 40_000);
});

/** Opens a relaunch whose Start updates OpenBot, at its last step, OpenBot opening. */
async function toStart(page: Page) {
  await open(page, "#start");
  await page.getByRole("listitem", { name: "Opening OpenBot" }).waitFor();
  await page.waitForTimeout(600);
}

const emitProgress = (page: Page, payload: Record<string, unknown>) =>
  page.evaluate(
    (sent) =>
      (
        globalThis as unknown as {
          __fake: { emit: (name: string, payload: unknown) => void };
        }
      ).__fake.emit("setup:progress", sent),
    payload,
  );

describe.skipIf(!asked)("the Start screen's words and card", () => {
  /*
   * Seen on Windows G: "Starting OpenBot" said "This usually takes a minute or two" over a card
   * that said "About 3 minutes left", and the start took four. The card's time comes from how long
   * each part takes; the heading gives none of its own.
   */
  test("the time is said once, by the card", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      const said = await page.evaluate(() => ({
        heading: document.querySelector("main h1")?.textContent,
        lede: document.querySelector("main .lede")?.textContent ?? "",
        card: document.querySelector(".journey-time")?.textContent ?? "",
      }));
      // This Start updates OpenBot, and its heading says so.
      expect(said.heading).toBe("Updating OpenBot (Self-Contained)");
      expect(said.lede).toBe("OpenBot is getting ready and opens by itself.");
      expect(said.lede).not.toMatch(/minute|second|hour/i);
      expect(said.card).toMatch(/left/);
    } finally {
      await page.close();
    }
  }, 30_000);

  /*
   * Seen on Windows G: the card grew a line and shrank again as what it said changed, and moved the
   * rows under it. Held at one fixed 130 px instead, its usual one-line form had an empty band under
   * the bar. It is as tall as what it says, in its own padding, and what changes is said in place:
   * "Taking longer than usual, still working" takes the time line's place and adds no line.
   * Docker Desktop's three-line hand-off holds its own height while it shows.
   */
  test("the card fits what it says, and nothing moves as its time line changes", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      const measure = () =>
        page.evaluate(() => {
          const card = document
            .querySelector(".journey")
            ?.getBoundingClientRect();
          const words = document
            .querySelector(".journey-said")
            ?.getBoundingClientRect();
          const bar = document
            .querySelector(".journey progress")
            ?.getBoundingClientRect();
          const time = document.querySelector(".journey-time") as HTMLElement;
          return {
            card: card?.height ?? 0,
            row: document
              .querySelector('[aria-label="Setting up OpenBot"]')
              ?.getBoundingClientRect().top,
            // The padding above what it says, and under the bar.
            above: (words?.top ?? 0) - (card?.top ?? 0),
            below: (card?.bottom ?? 0) - (bar?.bottom ?? 0),
            time: time.textContent ?? "",
            said: document.querySelector(".journey-said")?.textContent ?? "",
            cut: time.scrollWidth > time.clientWidth,
          };
        });
      const emit = (downloads: Record<string, number>) =>
        emitProgress(page, {
          step: "images",
          ok: true,
          running: true,
          detail: "Downloading local software.",
          downloads,
        });
      // OpenBot updating itself, its download under way, as on Windows G.
      await emitProgress(page, {
        step: "release",
        ok: true,
        running: true,
        detail: "Downloading the update.",
      });
      await emit({
        done: 1,
        total: 5,
        bytes: 190_900_000,
        size: 944_400_000,
        bytesPerSecond: 12_000_000,
      });
      await page.getByText(/190\.9 MB of 944\.4 MB/).waitFor();
      await page.waitForTimeout(600);
      const usual = await measure();
      expect(Math.abs(usual.below - usual.above)).toBeLessThanOrEqual(2);
      // The bytes are said with the download they count; the time line is the bar's, the whole
      // Start's (Windows K: "304.0 MB of 317.0 MB" read as the measure of a bar a third full).
      expect(usual.time).toMatch(/left · \d+s so far$/);
      expect(usual.time).not.toContain("MB");
      expect(usual.said).toBe("Downloading the update · 190.9 MB of 944.4 MB");
      expect(usual.cut).toBe(false);
      // Every byte in, its last part unpacking, and fifteen minutes on: taking longer than usual.
      await emit({
        done: 4,
        total: 5,
        bytes: 944_400_000,
        size: 944_400_000,
        bytesPerSecond: 0,
      });
      await page.waitForTimeout(1500);
      await page.evaluate(() => {
        const real = Date.now;
        Date.now = () => real() + 900_000;
      });
      await page.getByText(/Taking longer than usual/).waitFor();
      const slow = await measure();
      expect(slow.time).toBe("Taking longer than usual, still working");
      expect(slow.said).toBe(
        "Unpacking the update (5 of 5) · 944.4 MB downloaded",
      );
      expect(slow.cut).toBe(false);
      expect({ card: slow.card, row: slow.row }).toEqual({
        card: usual.card,
        row: usual.row,
      });
    } finally {
      await page.close();
    }
  }, 30_000);

  test("Docker Desktop's hand-off holds its three lines while it shows, whatever it says", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      const card = async () =>
        (await page.locator(".journey").boundingBox())?.height ?? 0;
      const usual = await card();
      const handOff = async (detail: string) => {
        await emitProgress(page, {
          step: "engine",
          ok: true,
          running: true,
          elsewhere: true,
          detail,
        });
        await page
          .locator(".journey-said", { hasText: detail.slice(0, 30) })
          .waitFor();
        return card();
      };
      const starting = await handOff(
        "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.",
      );
      const waiting = await handOff(
        "Docker Desktop hasn't started yet. It may be waiting for you. Accept its terms there.",
      );
      expect(starting).toBe(usual + 44);
      expect(waiting).toBe(starting);
    } finally {
      await page.close();
    }
  }, 30_000);

  /*
   * Seen on Windows G: Cancel went at step 4 and the card shrank. Cancel stops the setup's own
   * steps; the last, OpenBot starting or updating, can't be stopped partway. Its place says so, in
   * a button's height.
   */
  test("at its last step, the place of Cancel says why it can't be cancelled", async () => {
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await toStart(page);
      expect(await page.getByRole("button", { name: "Cancel" }).count()).toBe(
        0,
      );
      const note = page.locator(".cannot-cancel");
      // This Start updates OpenBot (`upgrade_due` answers a move), so it is said as the update.
      expect(await note.textContent()).toBe(
        "You can't cancel this last step. Stopping it partway could leave the update half done.",
      );
      expect((await note.boundingBox())?.height).toBe(40);
      // OpenBot updating itself, as on Windows G.
      await emitProgress(page, {
        step: "release",
        ok: true,
        running: true,
        detail: "Downloading the update.",
      });
      await page
        .locator(".cannot-cancel", { hasText: "the update half done" })
        .waitFor();
      expect((await note.boundingBox())?.height).toBe(40);
    } finally {
      await page.close();
    }
  }, 30_000);
});

/*
 * A dogfooding report: the screen OpenBot Desktop shows while it updates OpenBot is a strange one
 * for an app, and said nothing of why. It is headed as the self-contained OpenBot's update now, and
 * under its progress says that everything runs on this computer, then offers OpenBot for Business
 * with a link to book a demo. That adds no click and no scroll: at the window's default size (1000x800
 * less a title bar), in light and dark, the card shows whole, the progress first, the note under it.
 * Docker Desktop's three-line hand-off makes the journey 44px taller, which scrolled the card by
 * 12px: while it shows, the note keeps its heading and the pitch and leaves out the sentence between.
 * Run with `OPENBOT_APP_ENGINE=webkit` too, the engine the Mac window draws with.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each, taken before anything is asserted.
 */
const DOCKER_STARTING =
  "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.";

/** The update screen as a person sees it: its words, and where the progress and the note sit. */
function updateScreen(page: Page) {
  return page.evaluate(() => {
    const sheet = document.querySelector("main > .sheet") as HTMLElement;
    const note = document.querySelector(
      "main > .sheet > .self-contained",
    ) as HTMLElement | null;
    const journey = document.querySelector(".journey");
    const why = note?.querySelector(".self-contained-why") as HTMLElement;
    const box = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect ? { top: rect.top, bottom: rect.bottom } : null;
    };
    return {
      heading: document.querySelector("main h1")?.textContent,
      // What shows, as a person reads it.
      note: note?.innerText ?? null,
      // Whether the sentence that says why shows.
      said: Boolean(why && why.offsetHeight > 0),
      noteBox: box(note),
      sheetBox: box(sheet),
      journey: box(journey),
      journeyHeight: journey?.getBoundingClientRect().height ?? 0,
      rows: box(document.querySelector('[aria-label="Opening OpenBot"]')),
      scrolls: sheet.scrollHeight - sheet.clientHeight,
      page: document.documentElement.scrollHeight,
      window: window.innerHeight,
      cut: note ? note.scrollWidth > note.clientWidth : null,
      buttons: note?.querySelectorAll("button").length ?? null,
      link: note?.querySelector("a")?.getAttribute("href") ?? null,
    };
  });
}

/** The progress first, the note under it, all of the card in the window, nothing scrolled. */
function expectWholeUnderProgress(
  seen: Awaited<ReturnType<typeof updateScreen>>,
) {
  const { journey, rows, noteBox, sheetBox } = seen;
  expect(journey && rows && noteBox && sheetBox).toBeTruthy();
  if (journey && rows && noteBox && sheetBox) {
    expect(noteBox.top).toBeGreaterThan(journey.bottom);
    expect(noteBox.top).toBeGreaterThan(rows.bottom);
    expect(noteBox.bottom).toBeLessThanOrEqual(sheetBox.bottom);
    expect(sheetBox.bottom).toBeLessThanOrEqual(seen.window);
  }
  expect(seen.scrolls).toBeLessThanOrEqual(0);
  expect(seen.page).toBeLessThanOrEqual(seen.window);
  expect(seen.cut).toBe(false);
}

describe.skipIf(!asked)(
  "the Start screen that updates OpenBot says why",
  () => {
    for (const scheme of ["light", "dark"] as const) {
      test(`in ${scheme}, at 1000x760, it says it runs on this computer under the progress, whole and without a scroll`, async () => {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 760 },
          colorScheme: scheme,
        });
        try {
          await toStart(page);
          // OpenBot updating itself, its download under way, as in the report.
          await emitProgress(page, {
            step: "release",
            ok: true,
            running: true,
            detail: "Downloading the update.",
          });
          await page
            .locator(".journey-said", { hasText: "Downloading the update" })
            .waitFor();
          await page.waitForTimeout(400);
          const shots = process.env.OPENBOT_APP_SHOTS;
          if (shots)
            await page.screenshot({
              path: `${shots}/update-screen-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}-${scheme}.png`,
            });

          const seen = await updateScreen(page);
          expect(seen.heading).toBe("Updating OpenBot (Self-Contained)");
          expect(seen.note).toContain("Everything runs on this computer");
          expect(seen.note).toContain("This OpenBot is self-contained.");
          expect(seen.said).toBe(true);
          expect(seen.note).toContain("OpenBot for Business");
          expect(seen.note).not.toMatch(/—/);
          // Nothing to click to go on: its one link opens a page, and the update carries on.
          expect(seen.buttons).toBe(0);
          expect(seen.link).toBe("https://open.bot/business");
          expectWholeUnderProgress(seen);

          // Docker Desktop's hand-off, its three lines, while the update waits on Docker: the
          // journey grows 44px. The note says less while it shows, and the card still doesn't scroll.
          await emitProgress(page, {
            step: "engine",
            ok: true,
            running: true,
            elsewhere: true,
            detail: DOCKER_STARTING,
          });
          await page.locator(".journey.handing-off").waitFor();
          await page.waitForTimeout(400);
          if (shots)
            await page.screenshot({
              path: `${shots}/update-screen-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}-${scheme}-docker.png`,
            });
          const handingOff = await updateScreen(page);
          expect(handingOff.journeyHeight).toBe(seen.journeyHeight + 44);
          expect(handingOff.heading).toBe("Updating OpenBot (Self-Contained)");
          expect(handingOff.note).toContain("Everything runs on this computer");
          expect(handingOff.said).toBe(false);
          expect(handingOff.note).toContain("OpenBot for Business");
          expect(handingOff.link).toBe("https://open.bot/business");
          expectWholeUnderProgress(handingOff);

          // Docker answers and the hand-off goes: the note says all of it again.
          await emitProgress(page, {
            step: "engine",
            ok: true,
            running: false,
            detail: "Docker is answering.",
          });
          await page
            .locator(".journey.handing-off")
            .waitFor({ state: "hidden" });
          expect((await updateScreen(page)).said).toBe(true);

          // Book a demo opens OpenBot for Business's page in the person's browser.
          await page.getByRole("link", { name: "Book a demo" }).click();
          await page.waitForTimeout(200);
          expect(
            await page.evaluate(
              () =>
                (globalThis as unknown as { __fake: { opened: string[] } })
                  .__fake.opened,
            ),
          ).toEqual(["https://open.bot/business"]);
          // Still the update, on the same screen.
          expect(
            await page.evaluate(
              () => document.querySelector("main h1")?.textContent,
            ),
          ).toBe("Updating OpenBot (Self-Contained)");
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  },
);

describe.skipIf(!asked)(
  "the account step for a person already signed in",
  () => {
    /*
     * Seen on Windows G: for two seconds before the license agreement, a signed-in person saw the
     * signed-out pitch ("It requires a free license key", "does NOT send traffic data") over
     * "Checking your OpenBot account". The step says only that it is checking, until it knows.
     */
    test("while the sign-in is checked, the screen says so and nothing about signing in", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
      });
      try {
        await open(page, "#licence-slow");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Your OpenBot account" })
          .waitFor();
        const text = await page.evaluate(
          () =>
            (document.querySelector("main > .sheet") as HTMLElement).innerText,
        );
        expect(text).toContain("Checking your OpenBot account");
        expect(text).not.toMatch(
          /license key|traffic data|Self-contained|sign in/i,
        );
        await page
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
      } finally {
        await page.close();
      }
    }, 30_000);

    /*
     * Seen on Windows G: signed in already, the license screen's background row still said "The rest
     * of the install starts after you sign in and accept the license agreement".
     */
    test("the background row waits on the agreement only", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
      });
      try {
        await open(page, "#licence");
        await page
          .getByRole("button", { name: "Install", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "Accept the license agreement" })
          .waitFor();
        const row = page.getByRole("listitem", {
          name: "Installing OpenBot in the background",
        });
        await page.getByText(/The rest of the install starts/).waitFor();
        const said = (await row.textContent()) ?? "";
        expect(said).toContain(
          "The rest of the install starts after you accept the license agreement.",
        );
        expect(said).not.toMatch(/sign in/i);
      } finally {
        await page.close();
      }
    }, 30_000);
  },
);

/*
 * When this app is too old for its OpenBot (`client_version.rs`), the window says the shell's
 * sentence and offers its one way on, Update and restart, in view and uncovered, without outgrowing
 * the window. Beside them problems the screen always had, a sign-in that ended and a found-running
 * OpenBot that fails to show, for comparison. With `OPENBOT_SHOTS_DIR` set, each is
 * saved there in light and dark, at the window's default size.
 */
describe.skipIf(!asked)("an OpenBot this app is too old for", () => {
  const shots = process.env.OPENBOT_SHOTS_DIR;
  const states: {
    name: string;
    at: string;
    said: string;
    way: { role: "button" | "link"; name: string };
    /** The window's heading, where the state's screen is OpenBot on this computer running. */
    heading?: string;
  }[] = [
    {
      name: "connected-app-too-old",
      at: "#connect-app-too-old",
      said: "needs a newer version of this app. Update OpenBot, then connect again.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "connected-app-too-old-with-offer",
      at: "?offer#connect-app-too-old",
      said: "needs a newer version of this app. Update OpenBot, then connect again.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "connected-app-too-old-security",
      at: "#connect-app-too-old-security",
      said: "This version of OpenBot has a security problem. Update to keep using it.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "local-app-too-old-security",
      at: "#local-app-too-old-security",
      said: "This version of OpenBot has a security problem. Update to keep using it.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "local-app-too-old",
      at: "#local-app-too-old",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      way: { role: "button", name: "Update and restart" },
      heading: "Update OpenBot",
    },
    // Found running by a launch that did not start it: the same screen as when Start finds it.
    {
      // Start refused: the release on this computer needs a newer launcher contract (launcherApi).
      name: "local-launcher-ahead",
      at: "#local-launcher-ahead",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "local-launcher-ahead-with-offer",
      at: "?offer#local-launcher-ahead",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      way: { role: "button", name: "Update and restart" },
    },
    {
      name: "local-app-too-old-found-running",
      at: "?offer#local-app-too-old-running",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
      way: { role: "button", name: "Update and restart" },
      heading: "Update OpenBot",
    },
    {
      name: "existing-found-running-fails",
      at: "#local-running-fails",
      said: "Part of OpenBot needs recovery. Try starting OpenBot once more.",
      way: { role: "button", name: "Install" },
    },
    {
      name: "existing-session-ended",
      at: "#connect-session-ended",
      said: "Your sign-in to openbot.example.com has ended.",
      way: { role: "button", name: "Sign in again" },
    },
  ];
  for (const state of states) {
    for (const [width, height] of [
      [1000, 800],
      [720, 560],
    ] as const) {
      test(`${state.name} at ${width}x${height}: the sentence and its way on are in view`, async () => {
        for (const colorScheme of ["light", "dark"] as const) {
          const page = await browser.newPage({
            viewport: { width, height },
            colorScheme,
          });
          try {
            await open(page, state.at);
            await page.getByText(state.said, { exact: false }).waitFor();
            // The card's entrance, and the update offer's first answer, settled.
            await page.waitForTimeout(1200);
            // The card's own way on: the last of its name, under the offer at the top when there is one.
            const way = await page.evaluate(({ role, name }) => {
              const found = [
                ...document.querySelectorAll(role === "link" ? "a" : "button"),
              ].filter((element) => element.textContent?.trim() === name);
              const element = found.at(-1);
              if (!element) return null;
              // A step taller than the window scrolls inside its card: there, it is reached so.
              element.scrollIntoView({ block: "nearest" });
              const box = element.getBoundingClientRect();
              const top = document.elementFromPoint(
                box.left + box.width / 2,
                box.top + box.height / 2,
              );
              return {
                y: box.top,
                bottom: box.bottom,
                covered: !(top && (top === element || element.contains(top))),
                enabled: !(element as HTMLButtonElement).disabled,
              };
            }, state.way);
            expect({ state: state.name, found: way !== null }).toEqual({
              state: state.name,
              found: true,
            });
            expect(way?.y ?? -1).toBeGreaterThanOrEqual(0);
            expect(way?.bottom ?? height + 1).toBeLessThanOrEqual(height);
            expect({ state: state.name, covered: way?.covered }).toEqual({
              state: state.name,
              covered: false,
            });
            expect(way?.enabled).toBe(true);
            // Running, so never "OpenBot is stopped" with a Start: Show OpenBot and Stop OpenBot.
            if (state.heading) {
              const screen = await page.evaluate(() => ({
                heading: document.querySelector("h1")?.textContent?.trim(),
                buttons: [...document.querySelectorAll("button")].map(
                  (button) => button.textContent?.trim(),
                ),
              }));
              expect(screen.heading).toBe(state.heading);
              expect(screen.buttons).not.toContain("Start OpenBot");
              expect(screen.buttons).toContain("Show OpenBot");
              expect(screen.buttons).toContain("Stop OpenBot");
            }
            // One Update and restart: the offer at the top stands back while the card says why.
            if (state.way.name === "Update and restart")
              expect(
                await page.evaluate(
                  () =>
                    [...document.querySelectorAll("button")].filter(
                      (button) =>
                        button.textContent?.trim() === "Update and restart",
                    ).length,
                ),
              ).toBe(1);
            const fits = await page.evaluate(() => ({
              page: document.documentElement.scrollHeight,
              window: window.innerHeight,
              wide: document.documentElement.scrollWidth,
              across: window.innerWidth,
            }));
            expect(fits.page).toBeLessThanOrEqual(fits.window);
            expect(fits.wide).toBeLessThanOrEqual(fits.across);
            if (shots && width === 1000)
              await page.screenshot({
                path: `${shots}/${state.name}-${colorScheme}.png`,
              });
          } finally {
            await page.close();
          }
        }
      }, 30_000);
    }
  }

  /*
   * On a build that never updates itself, the line that says so is part of the notice, in the
   * notice's type, on the connect screen as on the screen for the OpenBot on this computer. Seen on
   * a Mac: on the connect screen it sat under the notice in body type.
   */
  for (const state of [
    {
      name: "connected-app-too-old-internal",
      at: "?internal#connect-app-too-old",
      said: "needs a newer version of this app. Update OpenBot, then connect again.",
    },
    {
      name: "local-app-too-old-internal",
      at: "?internal#local-app-too-old",
      said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
    },
  ]) {
    test(`${state.name}: "doesn't update itself" is in the notice, in the notice's type`, async () => {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 800 },
          colorScheme,
        });
        try {
          await open(page, state.at);
          await page.getByText(state.said, { exact: false }).waitFor();
          // The update's own line (Updates, folded under the buttons, says it too).
          await page
            .locator('p[role="status"]', { hasText: "doesn't update itself" })
            .waitFor();
          await page.waitForTimeout(1200);
          const placed = await page.evaluate((said) => {
            const notice = [...document.querySelectorAll(".local-alert")].find(
              (element) => element.textContent?.includes(said),
            );
            const sentence = [...(notice?.querySelectorAll("p") ?? [])].find(
              (element) => element.textContent?.includes(said),
            );
            const line = [
              ...document.querySelectorAll('p[role="status"]'),
            ].find((element) =>
              element.textContent?.includes("doesn't update itself"),
            );
            const size = (element: Element | undefined) =>
              element ? getComputedStyle(element).fontSize : null;
            return {
              inside: Boolean(notice && line && notice.contains(line)),
              line: size(line),
              notice: size(sentence),
              updates: [...document.querySelectorAll("button")].filter(
                (button) => button.textContent?.trim() === "Update and restart",
              ).length,
            };
          }, state.said);
          expect(placed.notice).not.toBeNull();
          expect(placed).toEqual({
            inside: true,
            line: placed.notice,
            notice: placed.notice,
            updates: 0,
          });
          if (shots)
            await page.screenshot({
              path: `${shots}/${state.name}-${colorScheme}.png`,
            });
        } finally {
          await page.close();
        }
      }
    }, 30_000);
  }
});

/*
 * After Stop, the Status window's App row said Stopped and offered nothing, while the services row
 * under it offered Start. The App row offers Start now, laid out as the services row's: the same
 * button, as far under its heading, at the same left edge. In the window's own size, light and dark.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of the window, stopped and running.
 */
describe.skipIf(!asked)("the Status window after Stop", () => {
  for (const colorScheme of ["light", "dark"] as const)
    test(`the App row offers Start as the services row does (${colorScheme})`, async () => {
      const shots = process.env.OPENBOT_APP_SHOTS;
      const engine = process.env.OPENBOT_APP_ENGINE ?? "chromium";
      for (const state of ["running", "stopped"] as const) {
        const page = await browser.newPage({
          viewport: { width: 640, height: 720 },
          colorScheme,
        });
        try {
          await open(page, state === "stopped" ? "?stopped#status" : "#status");
          await page.getByRole("region", { name: "App" }).waitFor();
          await page.waitForTimeout(400);
          if (shots)
            await page.screenshot({
              path: `${shots}/status-${state}-${colorScheme}-${engine}.png`,
            });
          if (state === "running") continue;
          const seen = await page.evaluate(() => {
            const part = (name: string) => {
              const section = document.querySelector(
                `section[aria-label="${name}"]`,
              );
              const head = section?.querySelector(".status-head");
              const buttons = [...(section?.querySelectorAll("button") ?? [])];
              const button = buttons[0]?.getBoundingClientRect();
              const top = head?.getBoundingClientRect();
              // Whole pixels: Chromium on Linux lays a 40 px button out at 39.99998.
              const px = (value: number | undefined) =>
                value === undefined ? null : Math.round(value);
              return {
                said: buttons.map((one) => one.textContent),
                left: px(button?.left),
                width: px(button?.width),
                height: px(button?.height),
                underHead:
                  button && top ? Math.round(button.top - top.bottom) : null,
                className: buttons[0]?.className,
              };
            };
            return { app: part("App"), services: part("OpenBot's services") };
          });
          expect(seen.app.said).toEqual(["Start"]);
          expect(seen.services.said).toEqual(["Start"]);
          expect(seen.app.className).toBe(seen.services.className);
          expect(seen.app.left).toBe(seen.services.left);
          expect(seen.app.width).toBe(seen.services.width);
          expect(seen.app.height).toBe(seen.services.height);
          expect(seen.app.underHead).toBe(seen.services.underHead);
        } finally {
          await page.close();
        }
      }
    }, 30_000);
});

/*
 * Two states the Mac and Windows pass found. Opened while OpenBot updated itself, the App row said
 * Stopped and offered Start: it says Updating now, with nothing to press. And after the App row's
 * Start brought everything up in the main window, the services row still said Stopped, with Start,
 * until Refresh: told the Start finished (`status:refresh`), it reads its readiness again. Each
 * screenshot is taken before anything is asserted, so a run against the earlier window keeps its
 * look too. `OPENBOT_APP_SHOTS=<folder>` keeps them, light and dark.
 */
describe.skipIf(!asked)(
  "the Status window through an update and a start",
  () => {
    const shots = process.env.OPENBOT_APP_SHOTS;
    const engine = process.env.OPENBOT_APP_ENGINE ?? "chromium";
    const shoot = (page: Page, name: string, colorScheme: string) =>
      shots
        ? page.screenshot({
            path: `${shots}/status-${name}-${colorScheme}-${engine}.png`,
          })
        : null;
    const appRow = (page: Page) =>
      page.evaluate(() => {
        const section = document.querySelector('section[aria-label="App"]');
        return {
          state: section?.querySelector(".status-state")?.textContent ?? null,
          buttons: [...(section?.querySelectorAll("button") ?? [])].map(
            (button) => button.textContent,
          ),
        };
      });
    const servicesRow = (page: Page) =>
      page.evaluate(() => {
        const section = document.querySelector(
          `section[aria-label="OpenBot's services"]`,
        );
        return {
          state: section?.querySelector(".status-state")?.textContent ?? null,
          buttons: [...(section?.querySelectorAll("button") ?? [])].map(
            (button) => button.textContent,
          ),
        };
      });

    for (const colorScheme of ["light", "dark"] as const) {
      test(`while OpenBot updates, the App row says Updating and nothing offers Start (${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 640, height: 720 },
          colorScheme,
        });
        try {
          await open(page, "?updating#status");
          await page.getByRole("region", { name: "App" }).waitFor();
          await page.waitForTimeout(400);
          await shoot(page, "updating", colorScheme);
          expect(await appRow(page)).toEqual({
            state: "Updating",
            buttons: [],
          });
          // Nor the services row: the update starts what it needs.
          expect(await servicesRow(page)).toEqual({
            state: "Stopped",
            buttons: [],
          });
        } finally {
          await page.close();
        }
      }, 30_000);

      test(`once a start finishes, the services row follows without Refresh (${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 640, height: 720 },
          colorScheme,
        });
        try {
          await open(page, "?started#status");
          await page.getByRole("region", { name: "App" }).waitFor();
          await page.waitForTimeout(400);
          // The main window's Start brings everything up; the window's own reading sees the parts.
          await page.evaluate(() => {
            (globalThis as unknown as { __fake: { up: boolean } }).__fake.up =
              true;
          });
          await page
            .locator('section[aria-label="App"] .status-state', {
              hasText: "Running",
            })
            .waitFor();
          await page.waitForTimeout(400);
          // Told the Start finished, as the native side tells it.
          await page.evaluate(() =>
            (
              globalThis as unknown as {
                __fake: { emit: (name: string, payload: unknown) => void };
              }
            ).__fake.emit("status:refresh", null),
          );
          await page.waitForTimeout(1500);
          await shoot(page, "started", colorScheme);
          expect((await appRow(page)).buttons).toEqual(["Restart", "Stop"]);
          expect(await servicesRow(page)).toEqual({
            state: "Ready · 2.4 GB",
            buttons: ["Restart", "Stop"],
          });
        } finally {
          await page.close();
        }
      }, 40_000);
    }
  },
);

/*
 * The move to OpenBot Cloud, each of its screens in the first screen's card, at the window's
 * default size (1000x800, tauri.conf.json), that less a title bar (1000x760), and its smallest
 * (720x560). The page never scrolls, and every one of a screen's buttons is whole in the window and
 * in the card's view, not under anything, as the screen opens. At 1000x760 every common case fits
 * with nothing scrolled inside the card; what is taller scrolls inside the card above its buttons.
 *
 * Seen on 1.2.0-rc.2: a move that failed showed its technical details, the screen ran past the
 * card's foot, and Try again and Keep OpenBot on this computer were out of view. The person quit
 * and reopened OpenBot to get past it. `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each,
 * light and dark, taken before anything is asserted.
 */
describe.skipIf(!asked)(
  "the move to OpenBot Cloud at the window's size",
  () => {
    const shots = process.env.OPENBOT_APP_SHOTS;
    const engine = process.env.OPENBOT_APP_ENGINE ?? "chromium";
    const SIZES = [
      [1000, 760],
      [1000, 800],
      [720, 560],
    ] as const;
    const SCREENS: {
      hash: string;
      /** The test's and the screenshot's name, when one hash shows two ways. */
      name?: string;
      heading: string;
      /** Pressed on the confirm screen, once what moves has loaded. */
      move?: boolean;
      /** Technical details opened, as the person would. */
      openDetail?: boolean;
      /** Scrolls inside the card at 1000x760. */
      scrolls?: boolean;
      /** Nothing to press: sending, past signing in, has no Cancel. */
      noButtons?: boolean;
    }[] = [
      { hash: "#move-choice", heading: "Move to OpenBot Cloud?" },
      { hash: "#move-confirm", heading: "Move to OpenBot Cloud" },
      { hash: "#move-confirm-loading", heading: "Move to OpenBot Cloud" },
      {
        hash: "#move-confirm-many",
        heading: "Move to OpenBot Cloud",
        scrolls: true,
      },
      { hash: "#move-signin", heading: "Moving to OpenBot Cloud", move: true },
      {
        hash: "#move-midway",
        heading: "Moving to OpenBot Cloud",
        move: true,
        noButtons: true,
      },
      { hash: "#move-failed", heading: "The move didn't finish", move: true },
      // In more than one organization on OpenBot Cloud: where the Bots go, one of them held.
      {
        hash: "#move-where",
        heading: "Where should your Bots go?",
        move: true,
      },
      {
        hash: "#move-not-allowed",
        heading: "Your Bots can't move there",
        move: true,
      },
      {
        hash: "#move-failed-detail",
        heading: "The move didn't finish",
        move: true,
        scrolls: true,
      },
      {
        hash: "#move-failed-detail",
        name: "move-failed-detail-open",
        heading: "The move didn't finish",
        move: true,
        openDetail: true,
        scrolls: true,
      },
      // OpenBot Cloud's own three-line sentence: a few pixels past the card, the buttons in view.
      {
        hash: "#move-stopped",
        heading: "The move didn't finish",
        move: true,
        scrolls: true,
      },
      { hash: "#move-done", heading: "You're on OpenBot Cloud", move: true },
      {
        hash: "#move-done-held",
        heading: "You're on OpenBot Cloud",
        move: true,
      },
      {
        hash: "#move-done-left",
        heading: "You're on OpenBot Cloud",
        move: true,
      },
      { hash: "#move-done-ai", heading: "You're on OpenBot Cloud", move: true },
      // Apps connected with a key come across connected, apart from those signed in to again: two
      // lists, which scroll inside the card above its buttons, as many apps do.
      {
        hash: "#move-confirm-carried",
        heading: "Move to OpenBot Cloud",
        scrolls: true,
      },
      {
        hash: "#move-done-carried",
        heading: "You're on OpenBot Cloud",
        move: true,
        scrolls: true,
      },
      {
        hash: "#move-done-ai-carried",
        heading: "You're on OpenBot Cloud",
        move: true,
        scrolls: true,
      },
    ];
    /*
     * The move screen's choices: OpenBot Cloud, then OpenBot for Business as the first screen draws
     * it, then OpenBot (Self-Contained), one above the other at one width. Business's four clouds
     * are drawn, on one line, inside its row past its words.
     */
    const MOVE_CHOICE_ROWS = {
      names: [
        "OpenBot Cloud Recommended",
        "OpenBot for Business",
        "OpenBot (Self-Contained)",
      ],
      stacked: true,
      drawn: [
        ["aws", true],
        ["azure", true],
        ["google-cloud", true],
        ["kubernetes", true],
      ],
      marks: true,
    };
    const moveChoiceRows = async (page: Page) => {
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      return page.evaluate(() => {
        const rows = [
          ...document.querySelectorAll("fieldset.picker.hosting > .tile"),
        ];
        const boxes = rows.map((row) => row.getBoundingClientRect());
        const business = document.querySelector(
          "fieldset.picker.hosting > .tile.with-marks",
        );
        const box = business?.getBoundingClientRect();
        const words = business
          ?.querySelector(".tile-summary")
          ?.getBoundingClientRect();
        const marks = [
          ...(business?.querySelectorAll(".cloud-mark") ?? []),
        ].map((mark) => mark.getBoundingClientRect());
        return {
          names: rows.map(
            (row) => row.querySelector(".tile-name")?.textContent ?? "",
          ),
          stacked: boxes.every(
            (row, at) =>
              row.width === boxes[0]?.width &&
              (at === 0 || row.top >= (boxes[at - 1]?.bottom ?? 0)),
          ),
          drawn: [
            ...(business?.querySelectorAll<HTMLImageElement>(
              ".cloud-mark img",
            ) ?? []),
          ].map((image) => [
            image.dataset.mark,
            image.complete && image.naturalWidth > 0,
          ]),
          marks:
            marks.length === 4 &&
            !!box &&
            !!words &&
            marks.every(
              (mark) =>
                mark.top >= box.top &&
                mark.bottom <= box.bottom &&
                mark.right <= box.right &&
                mark.left >= words.right &&
                mark.top === marks[0]?.top,
            ),
        };
      });
    };
    for (const [width, height] of SIZES)
      for (const colorScheme of ["light", "dark"] as const) {
        for (const screen of SCREENS) {
          const name = screen.name ?? screen.hash.slice(1);
          test(`at ${width}x${height}, ${name} fits the window, its buttons in view (${colorScheme})`, async () => {
            const page = await browser.newPage({
              viewport: { width, height },
              colorScheme,
            });
            try {
              await open(page, screen.hash, cloudBuilt);
              if (screen.move) {
                await page.getByRole("list", { name: "What moves" }).waitFor();
                await page
                  .getByRole("button", { name: "Move to OpenBot Cloud" })
                  .click();
              }
              await page
                .getByRole("heading", { name: screen.heading, exact: true })
                .waitFor();
              if (
                screen.hash === "#move-confirm" ||
                screen.hash === "#move-confirm-carried"
              )
                await page.getByRole("list", { name: "What moves" }).waitFor();
              if (screen.openDetail) {
                await page
                  .getByText("Technical details", { exact: true })
                  .click();
                await page.waitForTimeout(100);
                // Opened, they show: whole, in the card's view, clear of its pinned foot.
                const shown = await page.evaluate(() => {
                  const sheet = document.querySelector("main > .sheet");
                  const said = document.querySelector("main details pre");
                  const foot = document.querySelector(
                    "main > .sheet > .step-footer",
                  );
                  const box = said?.getBoundingClientRect();
                  return {
                    top: box?.top ?? 0,
                    bottom: box?.bottom ?? 0,
                    ceiling: sheet?.getBoundingClientRect().top ?? 0,
                    floor: Math.min(
                      foot?.getBoundingClientRect().top ??
                        Number.POSITIVE_INFINITY,
                      sheet?.getBoundingClientRect().bottom ?? 0,
                    ),
                  };
                });
                expect(shown.bottom).toBeGreaterThan(shown.top);
                expect(shown.top).toBeGreaterThanOrEqual(shown.ceiling);
                // Within the pixel the card's scroll snaps to.
                expect(shown.bottom).toBeLessThanOrEqual(shown.floor + 1);
              }
              // The card's entrance over, and the pointer off whatever it pressed.
              await page.mouse.move(0, 0);
              await page.waitForTimeout(600);
              if (shots)
                await page.screenshot({
                  path: `${shots}/${name}-${width}x${height}-${colorScheme}-${engine}.png`,
                });
              // What scrolls inside the card, scrolled to its end for a look, then back.
              if (shots && screen.scrolls) {
                await page.evaluate(() => {
                  const sheet = document.querySelector("main > .sheet");
                  if (sheet) sheet.scrollTop = sheet.scrollHeight;
                });
                await page.waitForTimeout(200);
                await page.screenshot({
                  path: `${shots}/${name}-scrolled-${width}x${height}-${colorScheme}-${engine}.png`,
                });
                await page.evaluate(() => {
                  const sheet = document.querySelector("main > .sheet");
                  if (sheet) sheet.scrollTop = 0;
                });
              }
              const fit = await page.evaluate(() => {
                const sheet = document.querySelector("main > .sheet");
                const card = sheet?.getBoundingClientRect();
                const style = sheet ? getComputedStyle(sheet) : null;
                // The card's view: inside its border, and inside the window.
                const top = Math.max(
                  0,
                  (card?.top ?? 0) +
                    (Number.parseFloat(style?.borderTopWidth ?? "") || 0),
                );
                const bottom = Math.min(
                  window.innerHeight,
                  (card?.bottom ?? 0) -
                    (Number.parseFloat(style?.borderBottomWidth ?? "") || 0),
                );
                // The screen's own buttons, not those in a list inside it.
                const buttons = [
                  ...document.querySelectorAll(
                    "main > .sheet > .row button, main > .sheet > .step-footer button",
                  ),
                ];
                return {
                  cardScrolls: sheet
                    ? sheet.scrollHeight > sheet.clientHeight + 1
                    : true,
                  pageScrolls:
                    document.documentElement.scrollHeight >
                      window.innerHeight ||
                    document.documentElement.scrollWidth > window.innerWidth,
                  buttons: buttons.length,
                  outOfView: buttons
                    .filter((button) => {
                      const box = button.getBoundingClientRect();
                      const hit = document.elementFromPoint(
                        box.left + box.width / 2,
                        box.top + box.height / 2,
                      );
                      return !(
                        box.top >= top &&
                        box.bottom <= bottom &&
                        box.left >= 0 &&
                        box.right <= window.innerWidth &&
                        hit !== null &&
                        button.contains(hit)
                      );
                    })
                    .map((button) => button.textContent),
                };
              });
              if (screen.noButtons) expect(fit.buttons).toBe(0);
              else expect(fit.buttons).toBeGreaterThan(0);
              expect({
                pageScrolls: fit.pageScrolls,
                outOfView: fit.outOfView,
              }).toEqual({ pageScrolls: false, outOfView: [] });
              if (height === 760)
                expect(fit.cardScrolls).toBe(screen.scrolls === true);
              // The result says the figure the move screens said, counted the same way.
              const said = await page.evaluate(
                () => document.querySelector("main")?.textContent ?? "",
              );
              if (screen.hash === "#move-choice") {
                expect(said).toContain(
                  "This removes about 20.2 GB of OpenBot files from this computer.",
                );
                expect(await moveChoiceRows(page)).toEqual(MOVE_CHOICE_ROWS);
              }
              if (screen.hash === "#move-confirm")
                expect(said).toContain(
                  "Removes about 20.2 GB of OpenBot files.",
                );
              if (screen.hash.startsWith("#move-done"))
                expect(said).toContain("20.2 GB of OpenBot files removed");
              // Their own organization first and picked, then the others; one held, saying why.
              if (screen.hash === "#move-where")
                expect(
                  await page.evaluate(() =>
                    [
                      ...document.querySelectorAll<HTMLInputElement>(
                        "fieldset.picker > .tile > .tile-input",
                      ),
                    ].map((input) => [
                      input.closest(".tile")?.querySelector(".tile-name")
                        ?.textContent,
                      input.checked,
                      input.disabled,
                      input.closest(".tile")?.querySelector(".tile-summary")
                        ?.textContent,
                    ]),
                  ),
                ).toEqual([
                  ["Sam's organization", true, false, "Your own organization."],
                  [
                    "Northwind Traders",
                    false,
                    false,
                    "An organization you belong to.",
                  ],
                  [
                    "Research Lab",
                    false,
                    true,
                    "An admin of this organization hasn't let you use Bots here.",
                  ],
                ]);
              if (screen.hash === "#move-not-allowed")
                expect(said).toContain(
                  "Nothing was removed from this computer.",
                );
              expect(said.includes("of that is free space on your disk")).toBe(
                screen.hash === "#move-done-held",
              );
              // Still needing an AI: Connect your AI leads, and no Reconnect skips it.
              if (screen.hash === "#move-done-ai") {
                expect(said).toContain("Connect your AI first");
                expect(said).toContain("Then reconnect your apps");
                const buttons = await page.evaluate(() =>
                  [...document.querySelectorAll("main button")].map(
                    (button) => button.textContent,
                  ),
                );
                expect(buttons).toEqual(["Connect your AI"]);
              }
            } finally {
              await page.close();
            }
          }, 30_000);
        }
      }

    // Keep, pressed where it shows with nothing scrolled first, leaves the move for OpenBot here.
    for (const [width, height] of [
      [1000, 800],
      [720, 560],
    ] as const)
      test(`at ${width}x${height}, Keep on a failed move with its technical details open opens OpenBot here`, async () => {
        const page = await browser.newPage({ viewport: { width, height } });
        try {
          await open(page, "#move-failed-detail", cloudBuilt);
          await page.getByRole("list", { name: "What moves" }).waitFor();
          await page
            .getByRole("button", { name: "Move to OpenBot Cloud" })
            .click();
          await page
            .getByRole("heading", {
              name: "The move didn't finish",
              exact: true,
            })
            .waitFor();
          await page.getByText("Technical details", { exact: true }).click();
          await page.evaluate(() => {
            const sheet = document.querySelector("main > .sheet");
            if (sheet) sheet.scrollTop = 0;
          });
          await page.waitForTimeout(600);
          const keep = await page
            .getByRole("button", { name: "Keep OpenBot on this computer" })
            .boundingBox();
          expect(keep).not.toBeNull();
          if (!keep) return;
          expect(keep.y + keep.height).toBeLessThanOrEqual(height);
          // The mouse, not a locator's click, which would scroll the button into view first.
          await page.mouse.click(
            keep.x + keep.width / 2,
            keep.y + keep.height / 2,
          );
          for (let i = 0; i < 50; i += 1) {
            if ((await calls(page)).includes("show_openbot")) break;
            await page.waitForTimeout(100);
          }
          const made = await calls(page);
          expect(made).toContain("keep_self_contained");
          expect(made).toContain("show_openbot");
          expect(made.indexOf("show_openbot")).toBeGreaterThan(
            made.indexOf("keep_self_contained"),
          );
          await page
            .getByRole("heading", {
              name: "The move didn't finish",
              exact: true,
            })
            .waitFor({ state: "hidden" });
        } finally {
          await page.close();
        }
      }, 30_000);

    /*
     * OpenBot for Business, picked on the move screen: the first screen's booker under the rows,
     * Book a demo in view at once, and nothing that moves or keeps. Taller than the window, it
     * scrolls in the card as it does on the first screen; the page never does, and nothing runs off
     * the card's side. OpenBot Cloud again brings back Continue and its promise, fitting as before.
     */
    for (const [width, height] of [
      [1000, 760],
      [720, 560],
    ] as const)
      for (const colorScheme of ["light", "dark"] as const)
        test(`at ${width}x${height}, OpenBot for Business on the move screen books a demo in the card and moves nothing (${colorScheme})`, async () => {
          const page = await browser.newPage({
            viewport: { width, height },
            colorScheme,
          });
          try {
            await routeCalendar(page);
            await open(page, "#move-choice", cloudBuilt);
            await page
              .getByRole("heading", {
                name: "Move to OpenBot Cloud?",
                exact: true,
              })
              .waitFor();
            await page
              .getByText("Your own cloud or on-prem. Book a demo.")
              .click();
            await page
              .locator(
                '.booking-calendar[data-ready] iframe[title="Booking calendar"]',
              )
              .waitFor();
            await page.mouse.move(0, 0);
            await page.waitForTimeout(600);
            if (shots)
              await page.screenshot({
                path: `${shots}/move-choice-business-${width}x${height}-${colorScheme}-${engine}.png`,
              });
            expect(await moveChoiceRows(page)).toEqual(MOVE_CHOICE_ROWS);
            const shape = await page.evaluate(() => {
              const card = document.querySelector(
                "main > .sheet",
              ) as HTMLElement;
              const view = card.getBoundingClientRect();
              const rows = [
                ...document.querySelectorAll("fieldset.picker.hosting > .tile"),
              ];
              const last = rows[rows.length - 1]?.getBoundingClientRect();
              const booker = document
                .querySelector(".business-booker")
                ?.getBoundingClientRect();
              const book = [...document.querySelectorAll("button")]
                .find((button) => button.textContent === "Book a demo")
                ?.getBoundingClientRect();
              const wider = [...card.querySelectorAll("*")].filter(
                (element) =>
                  element.getBoundingClientRect().right > view.right + 0.5,
              );
              return {
                page:
                  document.documentElement.scrollHeight <= window.innerHeight &&
                  document.documentElement.scrollWidth <= window.innerWidth,
                cardScrolls: card.scrollHeight > card.clientHeight + 1,
                sideways: card.scrollWidth - card.clientWidth <= 0,
                wider: wider.map((element) => element.className),
                chosen: document.querySelector(".tile.chosen .tile-name")
                  ?.textContent,
                underRows: !!booker && !!last && booker.top >= last.bottom,
                // Its first line shows under the rows without a scroll, at every size.
                bookerShows: !!booker && booker.top + 24 <= view.bottom,
                bookInView:
                  !!book && book.top >= view.top && book.bottom <= view.bottom,
                // The screen's own buttons: none moves and none keeps.
                own: [
                  ...document.querySelectorAll(
                    "main > .sheet > .row button, main > .sheet > .step-footer button",
                  ),
                ].map((button) => button.textContent),
                footnote: document.querySelector("main > .sheet > .footnote")
                  ?.textContent,
              };
            });
            const { bookInView, ...laid } = shape;
            expect(laid).toEqual({
              page: true,
              cardScrolls: true,
              sideways: true,
              wider: [],
              chosen: "OpenBot for Business",
              underRows: true,
              bookerShows: true,
              own: [],
              footnote: undefined,
            });
            // At the window's default size Book a demo is in view at once; in the smallest window
            // the card scrolls to it, as it does to anything below the rows.
            if (height === 760) expect(bookInView).toBe(true);
            const scrolled = await page.evaluate(() => {
              const card = document.querySelector(
                "main > .sheet",
              ) as HTMLElement;
              const button = [...document.querySelectorAll("button")].find(
                (each) => each.textContent === "Book a demo",
              );
              button?.scrollIntoView({ block: "nearest" });
              const view = card.getBoundingClientRect();
              const box = button?.getBoundingClientRect();
              return (
                !!box &&
                box.top >= view.top &&
                box.bottom <= Math.min(window.innerHeight, view.bottom)
              );
            });
            expect(scrolled).toBe(true);
            const made = await calls(page);
            expect(made).not.toContain("move_preview");
            expect(made).not.toContain("move_to_cloud");
            expect(made).not.toContain("keep_self_contained");
            // OpenBot Cloud again: Continue and the promise, in view, the calendar gone.
            await page.getByText(/move to your OpenBot Cloud account/).click();
            await page
              .getByRole("button", { name: "Continue", exact: true })
              .waitFor();
            await page.mouse.move(0, 0);
            await page.waitForTimeout(300);
            const back = await page.evaluate(() => {
              const card = document.querySelector(
                "main > .sheet",
              ) as HTMLElement;
              const view = card.getBoundingClientRect();
              const go = [...document.querySelectorAll("button")]
                .find((button) => button.textContent === "Continue")
                ?.getBoundingClientRect();
              return {
                calendar: document.querySelectorAll(
                  'iframe[title="Booking calendar"]',
                ).length,
                continueInView:
                  !!go &&
                  go.top >= Math.max(0, view.top) &&
                  go.bottom <= Math.min(window.innerHeight, view.bottom),
                footnote: document.querySelector("main > .sheet > .footnote")
                  ?.textContent,
              };
            });
            expect(back).toEqual({
              calendar: 0,
              continueInView: true,
              footnote:
                "Nothing is removed from this computer until everything has arrived in OpenBot Cloud and been checked.",
            });
          } finally {
            await page.close();
          }
        }, 30_000);
  },
);

/** The commands that start or update OpenBot or its backend on this computer. */
const STARTS_OR_UPDATES = [
  "wake_engine",
  "run_local_eval",
  "set_up_local_eval",
  "connect_local_eval",
  "upgrade_and_start",
  "start_stack",
];

/** The native commands the window has asked for, in order. */
const calls = (page: Page) =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __fake: { calls: string[] } }).__fake.calls,
  );

/** Every heading the window shows from now on, kept as it shows. */
const watchHeadings = (page: Page) =>
  page.evaluate(() => {
    const seen: string[] = [];
    (globalThis as unknown as { __headings: string[] }).__headings = seen;
    const note = () => {
      const heading = document.querySelector("main h1")?.textContent ?? "";
      if (heading && seen[seen.length - 1] !== heading) seen.push(heading);
    };
    note();
    new MutationObserver(note).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });

const headingsSeen = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as { __headings: string[] }).__headings,
  );

/*
 * A dogfooding report on 1.2.0-rc.1: installed over OpenBot (Self-Contained) on a Mac, the window
 * showed "Updating OpenBot (Self-Contained)" for about three minutes, and only then asked "Move to
 * OpenBot Cloud?". OpenBot Cloud is the default, so the question comes first now, before anything
 * starts or updates. Picking OpenBot Cloud updates and starts OpenBot under the move's own screen,
 * which fills in what moves once it can read it; Keep runs the update as it always has. In
 * Chromium, and with `OPENBOT_APP_ENGINE=webkit` in the engine the Mac window draws with.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each screen.
 */
describe.skipIf(!asked)(
  "the move to OpenBot Cloud, due at a relaunch that would update OpenBot",
  () => {
    const shots = process.env.OPENBOT_APP_SHOTS;
    const engine = process.env.OPENBOT_APP_ENGINE ?? "chromium";
    const shoot = async (page: Page, name: string) => {
      await page.mouse.move(0, 0);
      await page.waitForTimeout(500);
      if (shots)
        await page.screenshot({
          path: `${shots}/move-first-${name}-${engine}.png`,
        });
    };

    test("OpenBot Cloud: asked before any update, then no Self-Contained update screen, and the move completes", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 760 },
      });
      try {
        await open(page, "#move-first", cloudBuilt);
        await page
          .getByRole("heading", { name: "Move to OpenBot Cloud?", exact: true })
          .waitFor();
        await watchHeadings(page);
        await shoot(page, "choice");
        // Nothing started or updated before the question.
        expect(
          (await calls(page)).filter((call) =>
            STARTS_OR_UPDATES.includes(call),
          ),
        ).toEqual([]);

        await page.getByRole("button", { name: "Continue" }).click();
        await page
          .getByText(
            "Getting your Bots ready to move. This can take a few minutes.",
          )
          .waitFor();
        // OpenBot updates behind the move's screen.
        for (let i = 0; i < 50; i += 1) {
          if ((await calls(page)).includes("upgrade_and_start")) break;
          await page.waitForTimeout(100);
        }
        expect(await calls(page)).toContain("upgrade_and_start");
        await shoot(page, "getting-ready");
        expect(
          await page.evaluate(
            () => document.querySelector("main h1")?.textContent,
          ),
        ).toBe("Move to OpenBot Cloud");

        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishUpdate: () => void } }
          ).__fake.finishUpdate(),
        );
        await page.getByRole("list", { name: "What moves" }).waitFor();
        await shoot(page, "confirm");
        await page
          .getByRole("button", { name: "Move to OpenBot Cloud" })
          .click();
        await page
          .getByRole("heading", { name: "You're on OpenBot Cloud" })
          .waitFor();
        await shoot(page, "done");

        const made = await calls(page);
        expect(made).toContain("move_preview");
        expect(made).toContain("move_to_cloud");
        expect(made).not.toContain("show_openbot");
        expect(made).not.toContain("keep_self_contained");
        // What moves was read only once OpenBot was up.
        expect(made.indexOf("move_preview")).toBeGreaterThan(
          made.indexOf("upgrade_and_start"),
        );
        const headings = await headingsSeen(page);
        expect(headings).not.toContain("Updating OpenBot (Self-Contained)");
        expect(headings).not.toContain("Starting OpenBot");
        // Only the move's own screens, from the question to the end.
        expect(
          headings.filter(
            (heading) =>
              ![
                "Move to OpenBot Cloud?",
                "Move to OpenBot Cloud",
                "Moving to OpenBot Cloud",
                "You're on OpenBot Cloud",
              ].includes(heading),
          ),
        ).toEqual([]);
      } finally {
        await page.close();
      }
    }, 40_000);

    /*
     * FOUND IN A MAC UPGRADE CHECK of 1.2: the choice said the move removes about 23.1 GB and the
     * next screen 26.6 GB, measured after the update added the new release's files. The choice says
     * no figure while the update is still to come, and the next screen says the updated one only.
     */
    for (const colorScheme of ["light", "dark"] as const)
      test(`one size for what the move removes, from the updated OpenBot (${colorScheme})`, async () => {
        const page = await browser.newPage({
          viewport: { width: 1000, height: 760 },
          colorScheme,
        });
        const sized = async (name: string) => {
          await page.mouse.move(0, 0);
          await page.waitForTimeout(500);
          if (shots)
            await page.screenshot({
              path: `${shots}/move-first-size-${name}-${colorScheme}-${engine}.png`,
            });
          return page.evaluate(() => document.body.innerText);
        };
        try {
          await open(page, "#move-first", cloudBuilt);
          await page
            .getByRole("heading", {
              name: "Move to OpenBot Cloud?",
              exact: true,
            })
            .waitFor();
          const choice = await sized("choice");
          await page.getByRole("button", { name: "Continue" }).click();
          await page
            .getByText(
              "Getting your Bots ready to move. This can take a few minutes.",
            )
            .waitFor();
          const ready = await sized("getting-ready");
          await page.evaluate(() =>
            (
              globalThis as unknown as {
                __fake: { finishUpdate: () => void };
              }
            ).__fake.finishUpdate(),
          );
          await page.getByRole("list", { name: "What moves" }).waitFor();
          const confirm = await sized("confirm");
          expect(choice).toContain("move to your OpenBot Cloud account.");
          expect(choice).not.toContain("GB");
          expect(ready).not.toContain("GB");
          expect(confirm).toContain("Removes about 26.6 GB of OpenBot files.");
          expect(confirm).not.toContain("23.1 GB");
        } finally {
          await page.close();
        }
      }, 40_000);

    test("Keep: asked before any update, then the update runs as before and OpenBot opens", async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 760 },
      });
      try {
        await open(page, "#move-first", cloudBuilt);
        await page
          .getByRole("heading", { name: "Move to OpenBot Cloud?", exact: true })
          .waitFor();
        expect(
          (await calls(page)).filter((call) =>
            STARTS_OR_UPDATES.includes(call),
          ),
        ).toEqual([]);
        await page
          .getByText("Everything stays on this computer, as it is now.")
          .click();
        await shoot(page, "keep-picked");
        await page
          .getByRole("button", { name: "Keep OpenBot on this computer" })
          .click();
        await page
          .getByRole("heading", { name: "Updating OpenBot (Self-Contained)" })
          .waitFor();
        await shoot(page, "keep-updating");
        const made = await calls(page);
        expect(made.indexOf("keep_self_contained")).toBeGreaterThan(-1);
        expect(made.indexOf("upgrade_and_start")).toBeGreaterThan(
          made.indexOf("keep_self_contained"),
        );

        await page.evaluate(() =>
          (
            globalThis as unknown as { __fake: { finishUpdate: () => void } }
          ).__fake.finishUpdate(),
        );
        for (let i = 0; i < 50; i += 1) {
          if ((await calls(page)).includes("show_openbot")) break;
          await page.waitForTimeout(100);
        }
        const after = await calls(page);
        expect(after).toContain("show_openbot");
        expect(after).not.toContain("move_preview");
      } finally {
        await page.close();
      }
    }, 40_000);
  },
);

/*
 * FOUND ON 1.2.0-rc.3, a Mac, after an update: the setup window stayed a plain ground with nothing
 * on it, across two launches, while its page's code still ran. A screen that failed to draw took
 * every screen with it, leaving only the ground behind them. Now it shows "OpenBot hit a problem"
 * on the setup window's own failure box, with Reload and the logs, readable in light and dark.
 * `OPENBOT_APP_SHOTS=<folder>` keeps a screenshot of each.
 */
describe.skipIf(!asked)("a screen that fails to draw", () => {
  for (const colorScheme of ["light", "dark"] as const)
    test(`shows OpenBot hit a problem, never the bare ground (${colorScheme})`, async () => {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 800 },
        colorScheme,
      });
      try {
        await open(page, "?throws");
        await page
          .getByRole("heading", { name: "OpenBot hit a problem" })
          .waitFor();
        await page.waitForTimeout(300);
        const shots = process.env.OPENBOT_APP_SHOTS;
        if (shots)
          await page.screenshot({
            path: `${shots}/page-problem-${colorScheme}-${process.env.OPENBOT_APP_ENGINE ?? "chromium"}.png`,
          });
        const seen = await page.evaluate(() => {
          const shown = (selector: string) => {
            const element = document.querySelector(selector);
            const rect = element?.getBoundingClientRect();
            const style = element ? getComputedStyle(element) : null;
            return Boolean(
              rect &&
                rect.width > 0 &&
                rect.height > 0 &&
                rect.bottom <= window.innerHeight &&
                style?.visibility !== "hidden" &&
                style?.color !== style?.backgroundColor,
            );
          };
          const buttons = [...document.querySelectorAll("main button")].map(
            (button) => button.textContent,
          );
          return {
            // What a person reads, as the browser lays it out: not the bare ground.
            text: (document.getElementById("root") as HTMLElement).innerText,
            sheet: shown("main .sheet"),
            heading: shown("main h1"),
            box: shown("main .blocker"),
            buttons,
          };
        });
        expect(seen.text).toContain("OpenBot hit a problem");
        expect(seen.text).toContain(
          "This window stopped working. Reload it to carry on.",
        );
        expect(seen.sheet).toBe(true);
        expect(seen.heading).toBe(true);
        expect(seen.box).toBe(true);
        expect(seen.buttons).toEqual(["Reload", "Copy logs", "Save to a file"]);
        // The error reached the shell, for the Desktop log.
        expect(await calls(page)).toContain("page_error");
      } finally {
        await page.close();
      }
    });
});

/**
 * The Content Security Policy the shell serves the bundled window with (`app.security.csp`), as
 * directive name to sources. Tauri adds its own scripts' hashes to `script-src` when it serves the
 * page, so what is written here is the floor the window draws under.
 */
function bundledPolicy(): { text: string; directives: Map<string, string[]> } {
  const config = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  ) as { app: { security: { csp: unknown } } };
  const text = config.app.security.csp;
  if (typeof text !== "string")
    throw new Error(
      `tauri.conf.json serves the window with no Content Security Policy (app.security.csp is ${JSON.stringify(text)})`,
    );
  const directives = new Map<string, string[]>();
  for (const part of text.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return { text, directives };
}

describe("the bundled window's Content Security Policy", () => {
  test("loads only the window's own files, its images, the IPC and the booking calendar", () => {
    const { directives } = bundledPolicy();
    expect(directives.get("default-src")).toEqual(["'self'"]);
    // Nothing inline and nothing evaluated: Tauri adds its own scripts by hash.
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    // The one page the window frames is OpenBot for Business's booking calendar.
    expect(directives.get("frame-src")).toEqual([BOOKING_CALENDAR_ORIGIN]);
    // The window reaches the shell over Tauri's IPC only: `ipc:` on macOS and Linux, and
    // http://ipc.localhost on Windows.
    expect(directives.get("connect-src")).toEqual([
      "'self'",
      "ipc:",
      "http://ipc.localhost",
    ]);
  });
});

/**
 * The window served with that policy, as the shell serves it, collecting every violation the page
 * reports. A screen that needs something the policy refuses shows here as a violation.
 */
describe.skipIf(!asked)("the window under its Content Security Policy", () => {
  const RECORD_VIOLATIONS = `
    globalThis.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      globalThis.__violations.push(event.violatedDirective + " " + event.blockedURI);
    });
  `;
  const violations = (page: Page) =>
    page.evaluate(
      () => (globalThis as { __violations?: string[] }).__violations ?? [],
    );

  test("the first screen and OpenBot for Business's booking calendar draw with nothing refused", async () => {
    const { text } = bundledPolicy();
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await page.addInitScript(RECORD_VIOLATIONS);
      await routeCalendar(page);
      // An app's icon, as the move to OpenBot Cloud shows one from the app directory.
      await page.route("https://icons.openbot.test/**", (route) =>
        route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
        }),
      );
      await open(page, "", built, { "Content-Security-Policy": text });
      await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
      await page.getByText("Your own cloud or on-prem.").click();
      await page.locator(".tile-option.chosen").waitFor();
      await page.getByText("We run it for you.").click();
      await page
        .locator(
          '.booking-calendar[data-ready] iframe[title="Booking calendar"]',
        )
        .waitFor();
      const icon = await page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const image = new Image();
            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = "https://icons.openbot.test/gmail.svg";
          }),
      );
      expect(icon).toBe(true);
      expect(await violations(page)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test("a script put into the page is refused", async () => {
    const { text } = bundledPolicy();
    const page = await browser.newPage({
      viewport: { width: 1000, height: 800 },
    });
    try {
      await page.addInitScript(RECORD_VIOLATIONS);
      await open(page, "", built, { "Content-Security-Policy": text });
      await page.getByRole("heading", { name: "Set up OpenBot" }).waitFor();
      const ran = await page.evaluate(() => {
        const script = document.createElement("script");
        script.textContent = "globalThis.__injected = true;";
        document.head.append(script);
        return (globalThis as { __injected?: boolean }).__injected === true;
      });
      expect(ran).toBe(false);
      await page.waitForTimeout(100);
      expect(await violations(page)).toContain("script-src-elem inline");
    } finally {
      await page.close();
    }
  });
});
