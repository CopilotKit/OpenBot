/*
 * Settings → Computer scenes: what OpenBot runs on this computer, with Check for updates, the same
 * page in a plain browser, and the move to OpenBot Cloud, as OpenBot Desktop shows them.
 *
 * The page (routes/_authed/settings/computer.tsx) draws its This computer part only inside OpenBot
 * Desktop, after `connection` answers: ThisComputerSections for an OpenBot on this computer, and
 * under it ConnectInsteadSection, with the move to OpenBot Cloud first when `connection` says
 * `moveToCloud`. `/settings/this-computer`, the address OpenBot Desktop's Status opens, redirects to
 * `/settings/computer#this-computer`.
 *
 * `status` is asked twice (desktopStatusQueryOptions in lib/desktop/queries.ts): a quick read without
 * memory, and a measured read that repeats every 5 s on the page clock. One answer serves both.
 * Pattern: app/tests/move-to-cloud-settings.test.tsx (`desktopApp()` and the dialog's steps).
 */

import type { Answer } from "../../../desktop/src/fakeNative/control";
import type { AppScene } from "../../../desktop/workbench/appContract";
import type {
  DesktopAppUpdateCheck,
  DesktopStatus,
} from "../../src/lib/desktop/queries";
import { DEFAULT_SESSION } from "../session";

const STATUS_COMMAND = "plugin:openbot-desktop|status";
const CHECK_UPDATE_COMMAND = "plugin:openbot-desktop|check_update";
const CONNECTION_COMMAND = "plugin:openbot-desktop|connection";
const MOVE_TO_CLOUD_COMMAND = "plugin:openbot-desktop|move_to_cloud";

const MB = 1_000_000;

/**
 * What OpenBot Desktop runs on Sam's Mac on Podman, with memory figures for each part. The names are
 * shaped as Docker reports them, so that part-names.ts gives each its plain name ("App and Bots",
 * "Background jobs", "Database", "Conversations and learning", "Setup helper").
 */
function status(workerMemory: number): DesktopStatus {
  return {
    openbotRunning: true,
    openbotHeld: true,
    processes: [],
    containers: [
      { name: "openbot-desktop-server-1", memoryBytes: 412 * MB },
      { name: "openbot-desktop-worker-1", memoryBytes: workerMemory },
      { name: "openbot-desktop-postgres-1", memoryBytes: 180 * MB },
    ],
    intelligenceStack: "local-5a3e9c1d0b7f4e26a8c1d3f5",
    intelligenceContainers: [
      {
        name: "k3d-local-5a3e9c1d0b7f4e26a8c1d3f5-server-0",
        memoryBytes: 2_380 * MB,
      },
      {
        name: "k3d-local-5a3e9c1d0b7f4e26a8c1d3f5-tools",
        memoryBytes: 21 * MB,
      },
    ],
    engine: "podman",
    root: "/Users/sam/OpenBot",
    appPort: 3010,
    version: "1.2.0",
    build: "Built 2026-11-21 from main",
    logFolder: "/Users/sam/Library/Logs/ai.copilotkit.openbot.desktop",
  } satisfies DesktopStatus;
}

function value(answer: unknown): Answer {
  return { mode: "value", value: answer };
}

/** What a check for updates finds: version 1.3.0. */
const UPDATE_FOUND = {
  found: "available",
  version: "1.3.0",
  current: "1.2.0",
} satisfies DesktopAppUpdateCheck;

/*
 * this-computer-sections.tsx: OpenBotSection ("App", with the memory total), IntelligenceSection
 * ("OpenBot's services") and MachineSection ("Details", which ends with VersionRow). VersionRow's
 * "Check for updates" calls `check_update`; with a version found, the row says how ready it is
 * (`checked` → updateOffered) and the button becomes "Update and restart".
 * At 4 the worker uses more memory; the measured read at 5 s shows the new total by the end.
 */
const THIS_COMPUTER_SCENE: AppScene = {
  kind: "app",
  id: "app-settings-this-computer",
  title: "This computer",
  group: "App: Settings",
  start: {
    route: "/settings/this-computer",
    host: "desktop",
    session: DEFAULT_SESSION,
    answers: { [STATUS_COMMAND]: value(status(230 * MB)) },
  },
  run: [
    { at: 3, answer: CHECK_UPDATE_COMMAND, with: value(UPDATE_FOUND) },
    { at: 3, click: "Check for updates" },
    { at: 4, answer: STATUS_COMMAND, with: value(status(290 * MB)) },
    /*
     * The end. OpenBot Desktop keeps what it found, so a later check finds the same version. This
     * step changes no answer; it gives the measured read at 5 s time to show.
     */
    { at: 6, answer: CHECK_UPDATE_COMMAND, with: value(UPDATE_FOUND) },
  ],
};

/*
 * computer.tsx: outside OpenBot Desktop (`desktopShell()` is null) the page leaves the This
 * computer part out: there is nothing there to read. It says "Connect the browsers you teach your
 * Bots in." and shows only the Browsers part (BrowserSections).
 */
const THIS_COMPUTER_BROWSER_SCENE: AppScene = {
  kind: "app",
  id: "app-settings-this-computer-browser",
  title: "This computer in a browser",
  group: "App: Settings",
  start: {
    route: "/settings/this-computer",
    host: "browser",
    session: DEFAULT_SESSION,
  },
};

/*
 * connection-sections.tsx: ConnectInsteadSection draws MoveToCloudRow first ("OpenBot Cloud", with
 * the button "Move to OpenBot Cloud"). Its dialog ("Move to OpenBot Cloud?") says what happens; its
 * "Continue" calls `move_to_cloud` (moveToCloudMutationOptions). OpenBot Desktop then shows setup at
 * the move, so the workbench shows its handback card.
 */
const MOVE_TO_CLOUD_SCENE: AppScene = {
  kind: "app",
  id: "app-settings-move-to-cloud",
  title: "Move to OpenBot Cloud from Settings",
  group: "App: Settings",
  start: {
    route: "/settings/computer",
    host: "desktop",
    session: DEFAULT_SESSION,
    answers: {
      [CONNECTION_COMMAND]: value({
        mode: "local",
        address: null,
        moveToCloud: true,
      }),
    },
  },
  run: [
    { at: 2, click: "Move to OpenBot Cloud" },
    // OpenBot Desktop answers at once, then shows setup at the move.
    { at: 4, answer: MOVE_TO_CLOUD_COMMAND, with: value(null) },
    { at: 4, click: "Continue" },
  ],
};

export const COMPUTER_SCENES: readonly AppScene[] = [
  THIS_COMPUTER_SCENE,
  THIS_COMPUTER_BROWSER_SCENE,
  MOVE_TO_CLOUD_SCENE,
];
