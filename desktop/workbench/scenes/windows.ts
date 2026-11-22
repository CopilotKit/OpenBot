/*
 * Runs for the windows other than the install, written by hand: the Status window, a relaunch that
 * updates OpenBot, the move to OpenBot Cloud and the Shutting down screen. Each run starts from a
 * state of the fake native side (`src/fakeNative/states.ts`) and changes it over time with answers,
 * events and clicks, in the words and order of the native side:
 *
 * - Status: `desktop_status`, `stop_openbot_from_status` and `start_openbot_from_status`, and the
 *   `status:refresh` event (`status_changed`), in `main.rs`.
 * - Update: `upgrade_and_start_now` and `DesktopSteps` in `main.rs`, and `upgrade::run` and
 *   `upgrade::now_said` in `upgrade.rs`.
 * - Move to Cloud: `desktop_move::move_now` and `move_to_cloud::run`.
 * - Shutting down: `QuitStatus` and `report_quit` in `main.rs`.
 *
 * Stop and Start in the Status window return at once on the native side: Stop runs on a thread of
 * its own (`stop_then_show_setup`), and Start is the main window's Start (`ask_setup_to_start`).
 * So "Stopping OpenBot…" and "Starting OpenBot…" only flash. The window shows the stop and the
 * start in what `desktop_status` reads meanwhile, and reads again on `status:refresh` when each
 * one ends.
 *
 * The Shutting down screen has nothing to press (`ShuttingDown.tsx`): Quit is chosen in the menu
 * bar, outside the window. So its run has no click.
 */
import type { LocalReport } from "../../src/localEvalCli";
import type { Moved, MoveProgress, ReconnectApp } from "../../src/MoveToCloud";
import type { Problem } from "../../src/Problem";
import type { Progress } from "../../src/SetupProgress";
import type { QuitStatus } from "../../src/ShuttingDown";
import type { DesktopStatus } from "../../src/StatusWindow";
import type { RunStep, Scene } from "./types";

/** A `setup:progress` payload: a row, numbered as `emit_progress` numbers it. */
type ProgressEvent = Progress & { seq: number };

/**
 * `already_configured` and `upgrade_due` as `App.tsx` reads them. `App.tsx` does not export its
 * `AlreadyConfigured`, `ReleaseMove` and `ReleaseOutcome`, so these are the same shapes here.
 */
type AlreadyConfigured = {
  values: Record<string, string>;
  saved: {
    modelApiKeys: { openai: boolean; anthropic: boolean };
    modelSessions: { openai: boolean; anthropic: boolean };
    model?: string;
  };
  launch?: { harness: { id: string } | null } | null;
  autoStart?: boolean;
  localEval?: {
    stack: string;
    ownership: "created" | "shared";
    phase: string;
    connected?: boolean;
  };
};
type ReleaseMove = { from: string; to: string };
type ReleaseOutcome = ReleaseMove & { moved: boolean; notice?: Problem | null };

function value(at: number, command: string, answer: unknown): RunStep {
  return { at, answer: command, with: { mode: "value", value: answer } };
}

/** Times from `from` to `to`, `every` seconds apart, `to` included. */
function times(from: number, to: number, every: number): number[] {
  const found: number[] = [];
  for (let t = from; t < to - 1e-9; t += every)
    found.push(Math.round(t * 10) / 10);
  found.push(to);
  return found;
}

/** Every track in one run, in time order (stable), the progress rows numbered as sent. */
function run(...tracks: RunStep[][]): RunStep[] {
  let seq = 0;
  return tracks
    .flat()
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.at - b.step.at || a.index - b.index)
    .map(({ step }) => {
      if (!("emit" in step) || step.emit !== "setup:progress") return step;
      seq += 1;
      return {
        ...step,
        payload: { ...(step.payload as ProgressEvent), seq },
      };
    });
}

// ---------------------------------------------------------------------------------------------
// Status

const STACK = {
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

/** What `local status` answers for the services, by their readiness. */
function services(readiness: LocalReport["readiness"]): LocalReport {
  return {
    outcome: "completed",
    stack: STACK,
    reason: null,
    readiness,
    licence: "valid",
    licenceExpiresAt: null,
    checksPassed: false,
  } satisfies LocalReport;
}

const APP_CONTAINERS = [
  { name: "openbot-desktop-server-1", memoryBytes: 200_000_000 },
  { name: "openbot-desktop-worker-1", memoryBytes: 50_000_000 },
  { name: "openbot-desktop-postgres-1", memoryBytes: 150_000_000 },
];
const SERVICE_CONTAINERS = [
  { name: "k3d-local-abc123-server-0", memoryBytes: 2_400_000_000 },
];

/** `desktop_status`, as `read_desktop_status` reads it, with what runs now. */
function desktopStatus(
  app: "running" | "stopped" | "updating" | "updating-back",
  servicesUp: boolean,
): DesktopStatus {
  const appUp = app === "running" || app === "updating-back";
  return {
    updating: app === "updating" || app === "updating-back",
    openbotRunning: appUp,
    openbotHeld: appUp,
    processes: [],
    containers: appUp ? APP_CONTAINERS : [],
    intelligenceStack: "local-abc123",
    intelligenceContainers: servicesUp ? SERVICE_CONTAINERS : [],
    engine: "docker",
    root: "/Users/you/OpenBot",
    appPort: appUp ? 3010 : null,
    version: "1.1.0",
    build: "internal",
    logFolder: "/Users/you/Library/Logs/ai.copilotkit.openbot.desktop",
  } satisfies DesktopStatus;
}

/** `status_changed`: a start, a stop or an update ended, and the window reads everything again. */
function refreshed(at: number): RunStep {
  return { at, emit: "status:refresh", payload: null };
}

// status-stop-start: Stop at 2 s. OpenBot's own containers go first, then its services
// (`stop_everything`); the window reads the first on Stop's own refresh and the rest on
// `status:refresh` at 7 s. Start at 10 s: the main window brings the services up, then OpenBot, and
// says so at 18 s. The window reads `desktop_status` every 5 s meanwhile.
const STATUS_STOP_START: Scene = {
  id: "status-stop-start",
  title: "Status: stop and start OpenBot",
  group: "Status",
  start: { hash: "#status", search: "" },
  run: run([
    value(1.5, "desktop_status", desktopStatus("stopped", true)),
    { at: 2, click: "Stop" },
    value(7, "desktop_status", desktopStatus("stopped", false)),
    value(7, "run_local_eval", services("stopped")),
    refreshed(7),
    value(9.5, "desktop_status", desktopStatus("stopped", true)),
    value(9.5, "run_local_eval", services("starting")),
    { at: 10, click: "Start" },
    value(18, "desktop_status", desktopStatus("running", true)),
    value(18, "run_local_eval", services("ready")),
    refreshed(18),
  ]),
};

// status-updating: OpenBot starts updating at 3 s, its services left running. The window sees it
// on its next read (5 s); the person presses Refresh at 7 s. OpenBot's new containers are up at
// 22 s, still updating, and the update ends at 28 s (`status_changed` in `upgrade_and_start`).
const STATUS_UPDATING: Scene = {
  id: "status-updating",
  title: "Status: OpenBot updates",
  group: "Status",
  start: { hash: "#status", search: "" },
  run: run([
    value(3, "desktop_status", desktopStatus("updating", true)),
    { at: 7, click: "Refresh" },
    value(22, "desktop_status", desktopStatus("updating-back", true)),
    value(28, "desktop_status", desktopStatus("running", true)),
    refreshed(28),
  ]),
};

// ---------------------------------------------------------------------------------------------
// Update

/** A row as `emit_progress` sends it. Its `seq` is set by `run`, in time order. */
function row(at: number, progress: Progress): RunStep {
  return {
    at,
    emit: "setup:progress",
    payload: { seq: 0, ...progress } satisfies ProgressEvent,
  };
}

/** The release row's line while `now` runs (`upgrade::now_said`). */
function release(at: number, detail: string): RunStep {
  return row(at, { step: "release", ok: true, running: true, detail });
}

const MB = 1_000_000;
/** The new release's five images: 944.2 MB, as on Windows D (`StartJourney.tsx` `RELEASE`). */
const UPDATE_IMAGES = 944_200_000;
const UPDATE_SPEED = 20 * MB;

/** Stopped earlier this session, so a relaunch waits for Start (`already_configured`). */
const STOPPED_RELAUNCH = {
  values: {},
  saved: {
    modelApiKeys: { openai: true, anthropic: false },
    modelSessions: { openai: false, anthropic: false },
    model: "open-ai-api-key",
  },
  launch: { harness: { id: "langgraph" } },
  autoStart: false,
  localEval: {
    stack: "local-abc123",
    ownership: "created",
    phase: "installed",
    connected: true,
  },
} satisfies AlreadyConfigured;

/**
 * The update from `begin`, Start pressed then: each step of `upgrade::run` said on the release row
 * as it begins (`DesktopSteps::now`), at the seconds Windows D took (`StartJourney.tsx` `RELEASE`:
 * stop 2, back up 8, download 21 to 71, install 71, start 73 to 108). The download shows as the
 * images row (`download_missing`, `report_downloads`), as the Start screen's layout test sends it.
 * Then the new release's install and start rows, and the outcome.
 */
function updateRun(begin: number): RunStep[] {
  const due = { from: "1.0.0", to: "1.0.1" } satisfies ReleaseMove;
  const download = begin + 21.5;
  const downloaded =
    Math.round((download + UPDATE_IMAGES / UPDATE_SPEED) * 10) / 10;
  const steps: RunStep[] = [
    release(
      begin + 0.5,
      "Updating OpenBot. Your Bots, sign-ins and data stay as they are.",
    ),
    release(begin + 0.6, "Checking there's room for the update."),
    release(begin + 2, "Stopping OpenBot."),
    release(begin + 8, "Backing up your data."),
    release(begin + 21, "Downloading the update."),
    row(begin + 21.2, {
      step: "images",
      ok: true,
      running: true,
      detail: "Checking what OpenBot needs to download.",
    }),
  ];
  for (const t of times(download, downloaded, 2)) {
    const bytes = Math.min(
      UPDATE_IMAGES,
      Math.round((t - download) * UPDATE_SPEED),
    );
    steps.push(
      row(t, {
        step: "images",
        ok: true,
        running: true,
        detail: "Downloading OpenBot.",
        ...(bytes > 0 ? { downloadBytes: bytes } : {}),
        downloads: {
          done: Math.min(5, Math.floor((5 * bytes) / UPDATE_IMAGES)),
          total: 5,
          bytes,
          size: UPDATE_IMAGES,
          bytesPerSecond: UPDATE_SPEED,
        },
      }),
    );
  }
  steps.push(
    row(downloaded + 0.3, {
      step: "images",
      ok: true,
      detail: "OpenBot is downloaded.",
    }),
    release(begin + 71, "Installing the update."),
    row(begin + 71.1, {
      step: "installation",
      ok: true,
      running: true,
      detail: "Finishing the installation.",
    }),
    row(begin + 72.9, {
      step: "installation",
      ok: true,
      detail: "OpenBot is installed.",
    }),
    release(begin + 73, "Starting OpenBot."),
    row(begin + 73.5, {
      step: "env",
      ok: true,
      detail: "Your settings are saved.",
    }),
    row(begin + 73.5, {
      step: "services",
      ok: true,
      running: true,
      detail: "Starting OpenBot's services.",
    }),
    row(begin + 95, {
      step: "services",
      ok: true,
      detail: "OpenBot's services are running.",
    }),
    row(begin + 95.4, {
      step: "answering",
      ok: true,
      running: true,
      detail: "Waiting for OpenBot to respond.",
    }),
    row(begin + 107, {
      step: "answering",
      ok: true,
      detail: "OpenBot is ready.",
    }),
    row(begin + 108, {
      step: "release",
      ok: true,
      detail: "OpenBot is updated.",
    }),
    {
      at: begin + 108.2,
      settle: "upgrade_and_start",
      value: { ...due, moved: true, notice: null } satisfies ReleaseOutcome,
    },
  );
  return steps;
}

// relaunch-update-progress: a relaunch after a Stop, with an update due (`upgrade_due`). The person
// presses Start OpenBot at 2 s, and OpenBot updates from 1.0.0 to 1.0.1 and opens.
const RELAUNCH_UPDATE: Scene = {
  id: "relaunch-update-progress",
  title: "Relaunch: update OpenBot",
  group: "Update",
  start: {
    hash: "#start",
    search: "",
    answers: {
      already_configured: { mode: "value", value: STOPPED_RELAUNCH },
      upgrade_and_start: { mode: "never" },
    },
  },
  run: run([{ at: 2, click: "Start OpenBot" }], updateRun(2)),
};

// ---------------------------------------------------------------------------------------------
// Move to Cloud

function moved(
  at: number,
  stage: MoveProgress["stage"],
  share?: number,
): RunStep {
  return {
    at,
    emit: "move:progress",
    payload: {
      stage,
      state: "running",
      ...(share === undefined ? {} : { progress: share }),
    } satisfies MoveProgress,
  };
}
function moveDone(at: number, stage: MoveProgress["stage"]): RunStep {
  return {
    at,
    emit: "move:progress",
    payload: { stage, state: "done" } satisfies MoveProgress,
  };
}

const MOVE_APPS: ReconnectApp[] = [
  {
    appId: "gmail",
    appName: "Gmail",
    accountLabel: "sam@example.com",
    botNames: ["Inbox helper", "Standup"],
  },
  { appId: "slack", appName: "Slack", accountLabel: "Northwind" },
  { appId: "google-drive", appName: "Google Drive" },
];

const MOVED = {
  freedBytes: 18_400_000_000,
  apps: MOVE_APPS,
  notes: [],
  leftBehind: [],
} satisfies Moved;

/** `move_to_cloud::run` from the sign-in done at `from`: export, upload in four parts, and on. */
function moveAfterSignIn(from: number): RunStep[] {
  const upload = from + 5;
  return [
    moved(from, "export", 0),
    moved(from + 1.5, "export", 0.35),
    moved(from + 3, "export", 0.8),
    moveDone(from + 5, "export"),
    moved(upload, "upload", 0),
    moved(upload + 3, "upload", 0.25),
    moved(upload + 6, "upload", 0.5),
    moved(upload + 9, "upload", 0.75),
    moved(upload + 12, "upload", 1),
    moveDone(upload + 12, "upload"),
    moved(upload + 12, "import"),
    moveDone(upload + 18, "import"),
    moved(upload + 18, "verify"),
    moveDone(upload + 20, "verify"),
    moved(upload + 20, "remove"),
    moveDone(upload + 32, "remove"),
    { at: upload + 32.2, settle: "move_to_cloud", value: MOVED },
  ];
}

/** From the offer after an update (`#move-choice`): Continue at 2 s, Move at 5 s. */
const MOVE_START: RunStep[] = [
  { at: 2, click: "Continue" },
  { at: 5, click: "Move to OpenBot Cloud" },
  moved(5.1, "sign-in"),
];

// move-to-cloud: the person signs in in the browser for 9 s, then everything moves and is checked,
// and OpenBot is removed from this computer.
const MOVE_TO_CLOUD: Scene = {
  id: "move-to-cloud",
  title: "Move to OpenBot Cloud",
  group: "Move to Cloud",
  start: {
    hash: "#move-choice",
    search: "",
    answers: { move_to_cloud: { mode: "never" } },
  },
  run: run(MOVE_START, [moveDone(14, "sign-in")], moveAfterSignIn(14)),
};

// move-to-cloud-fails: the upload stops halfway (`Failure::Failed` at `Stage::Upload`). Try again at
// 32 s signs in with the session this run kept, at once, and the move finishes.
const UPLOAD_FAILED = {
  said: "OpenBot couldn't send everything to OpenBot Cloud. Check your internet connection and try again.",
  kind: "move-failed",
} satisfies Problem;
const MOVE_TO_CLOUD_FAILS: Scene = {
  id: "move-to-cloud-fails",
  title: "Move to OpenBot Cloud: the upload fails",
  group: "Move to Cloud",
  start: {
    hash: "#move-choice",
    search: "",
    answers: { move_to_cloud: { mode: "never" } },
  },
  run: run(
    MOVE_START,
    [
      moveDone(14, "sign-in"),
      moved(14, "export", 0),
      moved(15.5, "export", 0.35),
      moved(17, "export", 0.8),
      moveDone(19, "export"),
      moved(19, "upload", 0),
      moved(22, "upload", 0.25),
      moved(25, "upload", 0.5),
      { at: 27, fail: "move_to_cloud", problem: UPLOAD_FAILED },
      { at: 31, answer: "move_to_cloud", with: { mode: "never" } },
      { at: 32, click: "Try again" },
      moved(32.1, "sign-in"),
      moveDone(32.3, "sign-in"),
    ],
    moveAfterSignIn(32.3),
  ),
};

// ---------------------------------------------------------------------------------------------
// Shutting down

/** A Quit row as `QuitStatus::record` makes it: fixed words, so no detail. */
function quitRow(step: string, running: boolean): Progress {
  return {
    step,
    ok: true,
    detail: "",
    running,
    elsewhere: false,
    asks: false,
    updating: false,
    paused: false,
  } satisfies Progress;
}

/**
 * Each `quit:progress` as `report_quit` sends it: the whole list each time. `begin` sets the
 * sequence to 1, and each row recorded raises it by one.
 */
function quitRun(
  rows: readonly (readonly [number, string, boolean])[],
): RunStep[] {
  const steps: Progress[] = [];
  return rows.map(([at, step, running], index) => {
    const row = quitRow(step, running);
    const known = steps.findIndex((each) => each.step === step);
    if (known === -1) steps.push(row);
    else steps[known] = row;
    return {
      at,
      emit: "quit:progress",
      payload: { seq: index + 2, steps: [...steps] } satisfies QuitStatus,
    };
  });
}

// shutting-down: Quit on a Mac with Docker Desktop. OpenBot's apps stop in 14 s and its services in
// 12 s (`QUIT_PARTS`); then the app closes.
const SHUTTING_DOWN: Scene = {
  id: "shutting-down",
  title: "Shutting down OpenBot",
  group: "Shutting down",
  start: { hash: "#shutting-down", search: "" },
  run: quitRun([
    [0.5, "stop-openbot", true],
    [14.5, "stop-openbot", false],
    [14.6, "stop-intelligence", true],
    [26.6, "stop-intelligence", false],
  ]),
};

export const WINDOW_SCENES: readonly Scene[] = [
  STATUS_STOP_START,
  STATUS_UPDATING,
  RELAUNCH_UPDATE,
  MOVE_TO_CLOUD,
  MOVE_TO_CLOUD_FAILS,
  SHUTTING_DOWN,
];
