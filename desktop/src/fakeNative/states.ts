/*
 * The fake native side's answers for each state of the desktop window, by the page's hash and
 * search: the browser test's scripted `@tauri-apps/api/core`, typed. `#start` is a relaunch whose
 * Start updates OpenBot; otherwise it is a first run. The page's `__fake.download` is what the
 * download poll answers, and setup progress goes out through the control's `emit` as the native
 * side sends it.
 */
import type { Problem } from "../Problem";
import { type FallbackAnswer, nativeControl } from "./control";

/** The page address a state is at. */
export type Where = { hash: string; search: string };

/** Every state the fake can show, with a short title. */
export const STATE_NAMES: readonly {
  hash: string;
  search: string;
  title: string;
}[] = [
  { hash: "", search: "", title: "First run" },
  { hash: "", search: "?offer", title: "First run, update offered" },
  { hash: "", search: "?internal", title: "First run, internal build" },
  { hash: "#start", search: "", title: "Relaunch with an update" },
  { hash: "#update-short", search: "", title: "OpenBot update: no room" },
  { hash: "#backend-short", search: "", title: "Services update: no room" },
  { hash: "#signin", search: "", title: "Sign in" },
  { hash: "#licence", search: "", title: "Licence" },
  {
    hash: "#licence-installing",
    search: "",
    title: "Licence while installing",
  },
  { hash: "#licence-slow", search: "", title: "Licence, slow sign-in check" },
  { hash: "#pause-podman", search: "", title: "Pause your Podman" },
  { hash: "#connect-fails", search: "", title: "Connect fails" },
  {
    hash: "#connect-app-too-old",
    search: "",
    title: "Connected: app too old",
  },
  {
    hash: "#connect-app-too-old",
    search: "?offer",
    title: "Connected: app too old, update offered",
  },
  {
    hash: "#connect-app-too-old",
    search: "?internal",
    title: "Connected: app too old, internal build",
  },
  {
    hash: "#connect-app-too-old-security",
    search: "",
    title: "Connected: app too old for security",
  },
  {
    hash: "#connect-session-ended",
    search: "",
    title: "Connected: sign-in ended",
  },
  { hash: "#local-app-too-old", search: "", title: "Local: app too old" },
  {
    hash: "#local-app-too-old",
    search: "?internal",
    title: "Local: app too old, internal build",
  },
  {
    hash: "#local-app-too-old-security",
    search: "",
    title: "Local: app too old for security",
  },
  {
    hash: "#local-launcher-ahead",
    search: "",
    title: "Local: launcher too new",
  },
  {
    hash: "#local-launcher-ahead",
    search: "?offer",
    title: "Local: launcher too new, update offered",
  },
  {
    hash: "#local-app-too-old-running",
    search: "",
    title: "Local running: app too old",
  },
  {
    hash: "#local-app-too-old-running",
    search: "?offer",
    title: "Local running: app too old, update offered",
  },
  {
    hash: "#local-running-fails",
    search: "",
    title: "Local running: show fails",
  },
  { hash: "#move-choice", search: "", title: "Move: choice" },
  { hash: "#move-confirm", search: "", title: "Move: confirm" },
  {
    hash: "#move-confirm-loading",
    search: "",
    title: "Move: confirm, loading",
  },
  { hash: "#move-confirm-many", search: "", title: "Move: confirm, many apps" },
  { hash: "#move-signin", search: "", title: "Move: sign in" },
  { hash: "#move-midway", search: "", title: "Move: midway" },
  { hash: "#move-failed", search: "", title: "Move: failed" },
  {
    hash: "#move-stopped",
    search: "",
    title: "Move: OpenBot Cloud stopped the import",
  },
  { hash: "#move-done", search: "", title: "Move: done" },
  {
    hash: "#move-done-held",
    search: "",
    title: "Move: done, disk space still held",
  },
  { hash: "#move-done-left", search: "", title: "Move: done, some left" },
  { hash: "#move-done-ai", search: "", title: "Move: done, AI still needed" },
  { hash: "#move-first", search: "", title: "Move: asked before an update" },
  { hash: "#status", search: "", title: "Status: running" },
  { hash: "#status", search: "?stopped", title: "Status: stopped" },
  { hash: "#status", search: "?updating", title: "Status: updating" },
  { hash: "#status", search: "?started", title: "Status: started later" },
];

type States = {
  answer: FallbackAnswer;
  finishSetUp: () => void;
  finishInstall: () => void;
  finishUpdate: () => void;
};

type MoveApp = {
  appId: string;
  appName: string;
  accountLabel?: string;
  botNames?: string[];
};

const MOVE_APPS: MoveApp[] = [
  {
    appId: "gmail",
    appName: "Gmail",
    accountLabel: "sam@example.com",
    botNames: ["Inbox helper", "Standup"],
  },
  { appId: "slack", appName: "Slack", accountLabel: "Northwind" },
  { appId: "google-drive", appName: "Google Drive" },
];

const MORE_APPS: MoveApp[] = [
  ...MOVE_APPS,
  { appId: "notion", appName: "Notion" },
  { appId: "github", appName: "GitHub", accountLabel: "sam-codes" },
  { appId: "linear", appName: "Linear" },
  {
    appId: "google-calendar",
    appName: "Google Calendar",
    accountLabel: "sam@example.com",
  },
  { appId: "hubspot", appName: "HubSpot" },
];

// This app too old for its OpenBot, as the shell says it: connected to an OpenBot (such as OpenBot
// Cloud) that needs a newer app; one whose sign-in ended, as it always was; and the OpenBot on
// this computer needing a newer app once Start has it running.
const CONNECTED_PROBLEMS: Record<string, Problem> = {
  "#connect-app-too-old": {
    said: "The OpenBot at openbot.example.com needs a newer version of this app. Update OpenBot, then connect again.",
    kind: "app-too-old",
  },
  "#connect-app-too-old-security": {
    said: "This version of OpenBot has a security problem. Update to keep using it.",
    kind: "app-too-old-security",
  },
  "#connect-session-ended": {
    said: "Your sign-in to openbot.example.com has ended. Sign in again to keep going.",
    kind: "session-ended",
  },
};

function createStates(where: Where): States {
  const emit = (name: string, payload: unknown) =>
    nativeControl().emit(name, payload);
  // A relaunch whose update this computer has no room for: OpenBot's own (Windows, C: at 7.4 GB),
  // or the back end's, which the window runs first (a Mac at 8.2 GB).
  const updateShort = where.hash === "#update-short";
  const backEndShort = where.hash === "#backend-short";
  const connectedProblem = Object.hasOwn(CONNECTED_PROBLEMS, where.hash)
    ? CONNECTED_PROBLEMS[where.hash]
    : undefined;
  // The same, for a minimum raised because of a security problem.
  const localSecurity = where.hash === "#local-app-too-old-security";
  const localTooOld = where.hash === "#local-app-too-old" || localSecurity;
  // Start finding the release on this computer needs a newer launcher contract than this app
  // speaks.
  const launcherAhead = where.hash === "#local-launcher-ahead";
  // A launch that finds this computer's OpenBot already running, and that it needs a newer app.
  const runningTooOld = where.hash === "#local-app-too-old-running";
  // The same launch, where showing it fails as it could before: the slot the card above lands in.
  const runningFails = where.hash === "#local-running-fails";
  // The update feed has a newer version, so the offer at the top shows too.
  const offered = where.search === "?offer";
  // A build that never updates itself (internal, candidate, or without the updater).
  const internal = where.search === "?internal";
  // The move to OpenBot Cloud, offered over an OpenBot (Self-Contained) found running:
  // `#move-choice` after an update, and the rest from Settings, at the screen each names (see
  // `moveAnswer`).
  const move = where.hash.startsWith("#move-") ? where.hash.slice(6) : null;
  // `#move-first`: a relaunch after the update, OpenBot stopped and due an update of its own, with
  // the move due. The window asks before anything starts; the update runs until
  // `__fake.finishUpdate()`.
  const moveFirst = move === "first";
  let finishUpdate: (value: unknown) => void = () => {};
  const updated = new Promise((resolve) => {
    finishUpdate = resolve;
  });
  // Found running by the launch is a relaunch too: an installation set up and started before.
  const relaunch =
    where.hash === "#start" ||
    updateShort ||
    backEndShort ||
    localTooOld ||
    runningTooOld ||
    launcherAhead ||
    Boolean(move);
  const MOVE_PREVIEW = {
    counts: [
      { kind: "bots", count: 3 },
      { kind: "skills", count: 9 },
      { kind: "conversations", count: 37 },
      { kind: "messages", count: 2814 },
      { kind: "memories", count: 52 },
      { kind: "routines", count: 3 },
      { kind: "goals", count: 1 },
      { kind: "check-ins", count: 2 },
      { kind: "files", count: 64 },
      { kind: "settings", count: 1 },
    ],
    apps: move === "confirm-many" ? MORE_APPS : MOVE_APPS,
    footprintBytes: 20_200_000_000,
    modelKeysAvailable: true,
  };
  function moveAnswer(command: string): unknown {
    if (command === "move_offer")
      return {
        due: true,
        fromSettings: move !== "choice" && !moveFirst,
        footprintBytes: 20_200_000_000,
      };
    if (command === "move_preview")
      return move === "confirm-loading" ? new Promise(() => {}) : MOVE_PREVIEW;
    if (command !== "move_to_cloud") return undefined;
    const progress = (stage: string, state: string, share?: number) =>
      emit("move:progress", { stage, state, progress: share });
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
      throw {
        said: "\"Field Researcher\" has new messages on your computer, and was also carried on in OpenBot Cloud. OpenBot won't overwrite what was said in OpenBot Cloud, so the new messages can't move.",
        detail: null,
        kind: "move-stopped",
      } satisfies Problem;
    }
    progress("upload", "running", 0.42);
    if (move === "midway") return new Promise(() => {});
    if (move === "failed")
      throw {
        said: "OpenBot couldn't send everything to OpenBot Cloud. Check your internet connection and try again.",
        kind: "move-failed",
      } satisfies Problem;
    // As most real failures are: with the technical details for the log.
    if (move === "failed-detail")
      throw {
        said: "OpenBot couldn't send everything to OpenBot Cloud. Check your internet connection and try again.",
        detail:
          "part 3 of 7: the connection was reset while sending (tried 3 times over 41s); the last try answered 502 bad-gateway with no body",
        kind: "move-failed",
      } satisfies Problem;
    // `#move-done-held`: as on a Mac, the disk shows 4.5 of the 20.2 GB removed free so far.
    // `#move-done-ai`: OpenBot Cloud still needs the person's AI, so the result leads with it.
    return {
      connectAi: move === "done-ai",
      removedBytes: 20_200_000_000,
      diskGainedBytes: move === "done-held" ? 4_500_000_000 : 20_100_000_000,
      apps: MOVE_APPS,
      notes:
        move === "done" || move === "done-held"
          ? [
              "Research runs on an ordinary computer here, because OpenBot Cloud has no isolated computers.",
            ]
          : [],
      leftBehind:
        move === "done-left"
          ? [
              "Some of OpenBot's software is still on this computer. Restart your computer to finish removing it.",
            ]
          : [],
    };
  }
  const signingIn = where.hash === "#signin";
  const installing = where.hash === "#licence-installing";
  const pausing = where.hash === "#pause-podman";
  // Signed in already, the CLI taking two seconds to say so, as on Windows G.
  const slowCheck = where.hash === "#licence-slow";
  // A first install whose connect step stops partway, as on a Mac on 1.1.0-rc.1.
  const connectFails = where.hash === "#connect-fails";
  const licence = where.hash === "#licence" || installing || slowCheck;
  let finishInstall: (value: null) => void = () => {};
  const installed = new Promise<null>((resolve) => {
    finishInstall = resolve;
  });
  const stack = {
    id: "local-abc123",
    installedRelease: "0.16.0-rc.10",
    step: "ready",
    urls: {
      api: "http://127.0.0.1:64770",
      dashboard: "http://127.0.0.1:64771",
      gateway: "ws://127.0.0.1:64772",
    },
    hasFailedStep: false,
    updateInProgress: false,
    unfinishedUpdate: null,
    observed: null,
  };
  const status = (readiness: string, licence: string) => ({
    outcome: "completed",
    stack,
    reason: null,
    readiness,
    licence,
    licenceExpiresAt: null,
    checksPassed: false,
  });
  let finishSetUp: (value: ReturnType<typeof status>) => void = () => {};
  const setUp = new Promise<ReturnType<typeof status>>((resolve) => {
    finishSetUp = resolve;
  });
  const none = { openai: false, anthropic: false };

  const answer: FallbackAnswer = (command, args) => {
    const fake = globalThis.__fake;
    if (connectedProblem && command === "connection")
      return {
        mode: "connected",
        address: "https://openbot.example.com",
        signedIn: true,
      };
    if (connectedProblem && command === "show_connected")
      throw connectedProblem;
    if (
      (runningTooOld || runningFails || (move && !moveFirst)) &&
      command === "already_running"
    )
      return true;
    if (move) {
      const moved = moveAnswer(command);
      if (moved !== undefined) return moved;
    }
    if (runningFails && command === "show_openbot")
      throw {
        said: "Part of OpenBot needs recovery. Try starting OpenBot once more.",
      } satisfies Problem;
    if (localSecurity && command === "show_openbot")
      throw {
        said: "This version of OpenBot has a security problem. Update to keep using it.",
        detail:
          "the deployment's minimumClients.desktop is 1.2.0, raised for a security problem (securityMinimumClients); this app is desktop/1.1.0 and speaks v2",
        kind: "app-too-old-security",
      } satisfies Problem;
    if ((localTooOld || runningTooOld) && command === "show_openbot")
      throw {
        said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
        detail:
          "the deployment's minimumClients.desktop is 1.2.0; this app is desktop/1.1.0 and speaks v2",
        kind: "app-too-old",
      } satisfies Problem;
    if (
      (connectedProblem || localTooOld || runningTooOld || launcherAhead) &&
      command === "app_update_offer"
    )
      return {
        version: offered ? "1.2.0" : null,
        current: "1.1.0",
        installing: null,
        updatesItself: !internal,
        ready: null,
      };
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
              saved: {
                modelApiKeys: { openai: true, anthropic: false },
                modelSessions: none,
                model: "open-ai-api-key",
              },
              launch: { harness: { id: "langgraph" } },
              localEval: {
                stack: "local-abc123",
                ownership: "created",
                phase: "installed",
                connected: true,
              },
            }
          : { values: {}, saved: { modelApiKeys: none, modelSessions: none } };
      case "upgrade_due":
        return relaunch && !localTooOld && !runningTooOld && !launcherAhead
          ? { from: "1.0.0", to: "1.0.1" }
          : null;
      case "upgrade_and_start":
        if (updateShort)
          throw {
            said: "There isn't room on this computer for the update, so nothing changed.",
            shortfall: {
              podman: true,
              cpu: false,
              memory: false,
              disk: true,
              diskGb: "7.4",
              wsl: true,
              drive: "C:",
              freeOnDrive: true,
              updating: true,
              neededGb: "13",
            },
          };
        if (moveFirst) {
          emit("setup:progress", {
            step: "release",
            ok: true,
            running: true,
            detail:
              "Updating OpenBot. Your Bots, sign-ins and data stay as they are.",
          });
          return updated;
        }
        return new Promise(() => {});
      case "providers":
        // As provider::catalogue lists them.
        return [
          {
            id: "openai",
            name: "OpenAI",
            summary: "Sign in with ChatGPT Plus, Pro, Team or Enterprise.",
            logins: ["plan", "api-key"],
            mark: "openai",
            caution: null,
          },
          {
            id: "anthropic",
            name: "Anthropic",
            summary: "Sign in with a Claude Pro, Max, Team or Enterprise plan.",
            logins: ["plan", "api-key"],
            mark: "anthropic",
            caution: null,
          },
          {
            id: "google",
            name: "Google Gemini",
            summary:
              "Use a Google AI Studio key or sign in for Gemini API access.",
            logins: ["endpoint", "oauth"],
            mark: "google-color",
            caution: null,
          },
          {
            id: "xai",
            name: "xAI",
            summary: "Use an xAI API key or sign in to your xAI account.",
            logins: ["endpoint", "oauth"],
            mark: "xai",
            caution: null,
          },
          {
            id: "unbiased",
            name: "Unbiased AI",
            summary:
              "Sign in with Unbiased AI to use Pareto, or use an API key.",
            logins: ["oauth", "endpoint"],
            mark: "unbiased",
            caution: null,
          },
          {
            id: "openai-compatible",
            name: "Any OpenAI-compatible endpoint",
            summary:
              "Azure, Bedrock, Mistral, DeepSeek, Ollama, vLLM or your own.",
            logins: ["endpoint"],
            mark: null,
            caution: null,
          },
        ];
      case "prepare_installation":
        if (pausing) {
          // A Mac whose own Podman OpenBot can't use: Install waits for the person's yes.
          emit("setup:progress", {
            step: "pause-podman",
            ok: true,
            running: true,
            asks: true,
            detail:
              "Your Podman is set up in a way OpenBot can't use. OpenBot will use its own, and pause yours while OpenBot is running. Yours starts again when you quit OpenBot.",
          });
          return new Promise(() => {});
        }
        emit("setup:progress", {
          step: "engine",
          ok: true,
          running: false,
          detail: "The software OpenBot runs on is ready.",
        });
        return installing
          ? installed
          : new Promise((resolve) => setTimeout(() => resolve(null), 50));
      case "sign_in_to_copilotkit":
        if (slowCheck)
          return new Promise((resolve) =>
            setTimeout(() => resolve({ signedIn: true }), 1500),
          );
        return signingIn ? new Promise(() => {}) : { signedIn: true };
      case "copilotkit_sign_in_page":
        return signingIn
          ? {
              url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
              userCode: "WXYZ-2345",
            }
          : null;
      case "allow_pause_podman":
        return true;
      case "local_eval_terms":
        if (pausing) return { status: "engine-not-ready" };
        return {
          status: "required",
          accepted: !licence,
          version: "developer-edition-2026-10-01-web",
          url: "https://copilotkit.ai/legal/developer-edition",
          organizationName: "Acme",
        };
      case "set_up_local_eval":
        return setUp;
      case "local_eval_download":
        return fake?.download;
      case "connect_local_eval":
        return connectFails
          ? {
              outcome: "failed",
              stack: null,
              reason: "local-command-failed",
              conflicted: false,
            }
          : { outcome: "completed", stack, reason: null, conflicted: false };
      case "run_local_eval":
        if (backEndShort && args?.action === "update")
          return {
            outcome: "blocked",
            stack: null,
            reason: "resources-short",
            readiness: "unknown",
            licence: "unknown",
            licenceExpiresAt: null,
            checksPassed: false,
            shortfall: {
              podman: true,
              cpu: false,
              memory: false,
              disk: true,
              diskGb: "8.2",
              freeOnDrive: true,
              mac: true,
              updating: true,
              neededGb: "13",
            },
          };
        if (backEndShort)
          return { ...status("ready", "valid"), updateTo: "0.16.0-rc.13" };
        // The Status window's services, stopped until the main window's Start brings them up.
        if (where.search === "?started" && !fake?.up)
          return status("stopped", "valid");
        return status("ready", "valid");
      // OpenBot's own start, the step's last row: it stays there for the test to look at.
      // Running, when the window is about to find it needs a newer app. Refused, when the release
      // laid out needs a newer launcher contract than this app speaks.
      case "start_stack":
        if (launcherAhead)
          throw {
            said: "The OpenBot on this computer needs a newer version of this app. Update OpenBot to keep going.",
            detail:
              "OpenBot v1.3.0 needs launcherApi 2; this app is v1.1.1 and speaks launcherApi 1",
            kind: "app-too-old",
          } satisfies Problem;
        return localTooOld ? null : new Promise(() => {});
      // The Status window (`#status`): everything running, or, at `?stopped#status`, all of it
      // stopped as Stop leaves it, the software OpenBot runs on still running. At
      // `?updating#status`, stopped by an update of OpenBot. At `?started#status`, stopped until
      // `__fake.up`, as when the main window's Start brings everything up.
      case "desktop_status": {
        const stopped =
          where.search === "?stopped" ||
          where.search === "?updating" ||
          (where.search === "?started" && !fake?.up);
        return {
          updating: where.search === "?updating",
          openbotRunning: !stopped,
          openbotHeld: !stopped,
          processes: [],
          containers: stopped
            ? []
            : [
                { name: "openbot-desktop-server-1", memoryBytes: 200000000 },
                { name: "openbot-desktop-worker-1", memoryBytes: 50000000 },
                { name: "openbot-desktop-postgres-1", memoryBytes: 150000000 },
              ],
          intelligenceStack: "local-abc123",
          intelligenceContainers: stopped
            ? []
            : [{ name: "k3d-local-abc123-server-0", memoryBytes: 2400000000 }],
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
  };

  return {
    answer,
    finishSetUp: () => finishSetUp(status("starting", "valid")),
    finishInstall: () => finishInstall(null),
    finishUpdate: () =>
      finishUpdate({ from: "1.1.3", to: "1.2.0", moved: true }),
  };
}

/** The fake native side's answer to each command, for the state at `where`. */
export function stateAnswer(where: Where): FallbackAnswer {
  return createStates(where).answer;
}

/**
 * Makes the page's state, by its own hash and search, the control's fallback answer.
 * `__fake.finishSetUp` ends the rest of OpenBot setting up behind the AI step, and
 * `__fake.finishInstall` ends the install at `#licence-installing`. `__fake.download` is what the
 * download poll answers, `__fake.up` brings the Status window's services up at
 * `?started#status`, and `__fake.finishUpdate` ends the update at `#move-first`.
 */
export function installStates(): void {
  const states = createStates({
    hash: location.hash,
    search: location.search,
  });
  nativeControl().setFallback(states.answer);
  globalThis.__fake ??= { listeners: {}, download: null };
  const fake = globalThis.__fake;
  fake.finishSetUp = states.finishSetUp;
  fake.finishInstall = states.finishInstall;
  fake.finishUpdate = states.finishUpdate;
  fake.download ??= null;
}
