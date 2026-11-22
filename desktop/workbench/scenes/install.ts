/*
 * Install runs, written by hand: what the native side sends and answers during a first install, in
 * the order and words of `main.rs` (`emit_progress`, `report_line`, `report_running_line`,
 * `report_downloads`, `plain_row`), at the times the back end's own steps take
 * (`journeyTimings.json`). Each run plays on top of the fake native side's first run
 * (`src/fakeNative/states.ts`): a command a run does not answer gets that answer.
 *
 * Most runs arrive at the AI step with an OpenAI key a previous OpenBot left in the folder, and
 * press Continue. `install-anthropic-plan` picks a provider tile (a radio input) and signs in.
 */
import type { EarlyDownloads } from "../../src/EarlyDownloads";
import type {
  CopilotKitSignInPage,
  LocalDownload,
  LocalReport,
  LocalSteps,
  LocalTerms,
} from "../../src/localEvalCli";
import type { Problem } from "../../src/Problem";
import type { SavedConfiguration } from "../../src/ProviderPicker";
import type { Progress } from "../../src/SetupProgress";
import type { RunStep, Scene } from "./types";

/** A `setup:progress` payload: a row, numbered as `emit_progress` numbers it. */
type ProgressEvent = Progress & { seq: number };

/** A row as `emit_progress` sends it. Its `seq` is set by `run`, in time order. */
function row(at: number, progress: Progress): RunStep {
  return {
    at,
    emit: "setup:progress",
    payload: { seq: 0, ...progress } satisfies ProgressEvent,
  };
}

/** Where the first screen's downloads are, as `setup:downloads` says it. */
function early(at: number, downloads: EarlyDownloads): RunStep {
  return {
    at,
    emit: "setup:downloads",
    payload: downloads satisfies EarlyDownloads,
  };
}

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

// What the native side's rows say in the window (`plain_row`, `engine.rs`, `upgrade.rs`).
const READY = "This computer is ready to run OpenBot.";
const ENGINE_READY = "The software OpenBot runs on is ready.";
const CHECKING_SOFTWARE = "Checking the software OpenBot needs.";
const CHECKING_RELEASE = "Checking which version of OpenBot to download.";
const DOWNLOADED = "OpenBot is downloaded.";
const CHECKING_DOWNLOAD = "Checking what OpenBot needs to download.";
const DOWNLOADING = "Downloading OpenBot.";

const MB = 1_000_000;

/** OpenBot's images on a Mac with Docker Desktop: the database, the Bot and OpenBot, 1.1 GB. */
const IMAGES = 1_097_400_000;
/** Compose, which the first screen downloads before the images. */
const COMPOSE = 30_532_210;
/** The back end's own download (`local_eval_download`). */
const BACK_END = 1_440_000_000;

const SIGN_IN_PAGE = {
  url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
  userCode: "WXYZ-2345",
} satisfies CopilotKitSignInPage;

const TERMS = {
  status: "required",
  accepted: false,
  version: "developer-edition-2026-10-01-web",
  url: "https://copilotkit.ai/legal/developer-edition",
  organizationName: "Acme",
} satisfies LocalTerms;

/** Nothing installed yet, and an OpenAI key a previous OpenBot left in the folder. */
const KEPT_KEY = {
  values: {},
  saved: {
    modelApiKeys: { openai: true, anthropic: false },
    modelSessions: { openai: false, anthropic: false },
    model: "open-ai-api-key",
  },
};

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

const SET_UP = {
  outcome: "completed",
  stack: STACK,
  reason: null,
  readiness: "starting",
  licence: "valid",
  licenceExpiresAt: null,
  checksPassed: false,
} satisfies LocalReport;

/**
 * The back end's first setup, by the CLI's step names, and the seconds after it starts by which
 * each one ends. Its download runs from 32 to 80 seconds.
 */
const BACK_END_SETUP: readonly (readonly [string, number])[] = [
  ["engine-check", 0],
  ["release-download", 3],
  ["docker-check", 6],
  ["resource-check", 6],
  ["engine-storage-check", 13],
  ["chart-download", 15],
  ["chart-render", 15],
  ["cluster-discovery", 16],
  ["cluster-create", 27],
  ["kubeconfig", 29],
  ["ownership-check", 31],
  ["runtime-inspect", 32],
  ["runtime-identity-write", 32],
  ["image-download", 46],
  ["system-image-download", 71],
  ["system-image-tag", 72],
  ["secrets-apply", 82],
  ["dependencies-install", 85],
  ["dependencies-wait", 112],
  ["hook-apply", 128],
  ["migration-apply", 128],
  ["migration-wait", 143],
  ["hook-wait", 149],
  ["bootstrap-result", 149],
  ["services-start", 183],
  ["service-status", 187],
];
const DOWNLOAD_FROM = 32;
const DOWNLOAD_TO = 80;

/**
 * The back end's setup from `begin` (`set_up_local_eval`): the steps it has ended growing as it
 * goes (`local_eval_steps`), its download (`local_eval_download`), and its answer. On a slow line
 * the download takes `downloadSeconds`, and every step after it ends that much later.
 */
function backEndSetup(
  begin: number,
  downloadSeconds = DOWNLOAD_TO - DOWNLOAD_FROM,
  every = 4,
): RunStep[] {
  const later = downloadSeconds - (DOWNLOAD_TO - DOWNLOAD_FROM);
  const steps: RunStep[] = [];
  const ended: string[] = [];
  BACK_END_SETUP.forEach(([name, at], index) => {
    ended.push(name);
    if (BACK_END_SETUP[index + 1]?.[1] === at) return;
    const when = begin + at + (at > DOWNLOAD_FROM ? later : 0);
    steps.push(
      value(when, "local_eval_steps", {
        ended: [...ended],
        quietSeconds: 0,
      } satisfies LocalSteps),
    );
  });
  const from = begin + DOWNLOAD_FROM;
  const to = from + downloadSeconds;
  for (const t of times(from, to, every).slice(0, -1))
    steps.push(
      value(t, "local_eval_download", {
        done: Math.round((BACK_END * (t - from)) / downloadSeconds),
        total: BACK_END,
      } satisfies LocalDownload),
    );
  steps.push(value(to, "local_eval_download", null));
  const last = BACK_END_SETUP[BACK_END_SETUP.length - 1][1] + later;
  steps.push({
    at: begin + last + 1,
    settle: "set_up_local_eval",
    value: SET_UP,
  });
  return steps;
}

/** OpenBot's own start on the ready back end (`start_stack`), from `begin`. */
function openBotStart(begin: number): RunStep[] {
  return [
    row(begin + 1, {
      step: "env",
      ok: true,
      detail: "Your settings are saved.",
    }),
    row(begin + 1, {
      step: "services",
      ok: true,
      running: true,
      detail: "Starting OpenBot's services.",
    }),
    row(begin + 7, {
      step: "services",
      ok: true,
      detail: "OpenBot's services are running.",
    }),
    row(begin + 7.4, {
      step: "answering",
      ok: true,
      running: true,
      detail: "Starting OpenBot. This can take a few minutes the first time.",
    }),
    row(begin + 8.3, {
      step: "answering",
      ok: true,
      detail: "OpenBot is ready.",
    }),
    { at: begin + 8.4, settle: "start_stack", value: null },
  ];
}

/**
 * Install on a Mac whose Docker Desktop answers (`prepare_installation`), from the click at
 * `click`: the first screen's downloads (compose, then the images) and Install's rows, which wait
 * for those images and show their download. At `bytesPerSecond`.
 */
function macInstall(
  click: number,
  bytesPerSecond: number,
  every: number,
): RunStep[] {
  const size = COMPOSE + IMAGES;
  const from = click + 1;
  const to = Math.round((from + IMAGES / bytesPerSecond) * 10) / 10;
  const steps: RunStep[] = [
    row(click + 0.1, {
      step: "engine",
      ok: true,
      running: true,
      detail: CHECKING_SOFTWARE,
    }),
    early(click + 0.2, { state: "downloading", bytes: 0 }),
    row(click + 0.3, { step: "engine", ok: true, detail: READY }),
    row(click + 0.3, {
      step: "deployment",
      ok: true,
      running: true,
      detail: CHECKING_RELEASE,
    }),
    early(click + 0.6, {
      state: "downloading",
      bytes: COMPOSE,
      size,
    }),
    row(click + 0.6, { step: "deployment", ok: true, detail: DOWNLOADED }),
    row(click + 0.6, {
      step: "images",
      ok: true,
      running: true,
      detail: CHECKING_DOWNLOAD,
    }),
  ];
  for (const t of times(from, to, every)) {
    const bytes = Math.min(IMAGES, Math.round((t - from) * bytesPerSecond));
    const done = bytes >= IMAGES ? 3 : bytes > IMAGES / 4 ? 2 : 1;
    steps.push(
      early(t, {
        state: "downloading",
        bytes: COMPOSE + bytes,
        size,
        bytesPerSecond,
      }),
      row(t, {
        step: "images",
        ok: true,
        running: true,
        detail: DOWNLOADING,
        ...(bytes > 0 ? { downloadBytes: bytes } : {}),
        downloads: { done, total: 3, bytes, size: IMAGES, bytesPerSecond },
      }),
    );
  }
  steps.push(
    early(to + 0.1, { state: "done", bytes: size, size }),
    row(to + 0.3, { step: "images", ok: true, detail: DOWNLOADED }),
    row(to + 0.3, {
      step: "installation",
      ok: true,
      running: true,
      detail: "Finishing the installation.",
    }),
    row(to + 0.4, {
      step: "installation",
      ok: true,
      detail: "OpenBot is installed.",
    }),
    { at: to + 0.5, settle: "prepare_installation", value: null },
  );
  return steps;
}

/** What every install run starts with: a first run, Install waiting on the native side. */
const FIRST_RUN_ANSWERS = {
  prepare_installation: { mode: "never" },
  sign_in_to_copilotkit: { mode: "never" },
  copilotkit_sign_in_page: { mode: "value", value: SIGN_IN_PAGE },
  local_eval_terms: { mode: "value", value: TERMS },
  already_configured: { mode: "value", value: KEPT_KEY },
  set_up_local_eval: { mode: "never" },
  start_stack: { mode: "never" },
} as const;

// install-mac: Install at 2 s, signed in at 37 s (35 s in the browser), Accept at 44 s, Continue on
// the AI step at 60 s, the back end set up from 44 s, and OpenBot open about 3 minutes later.
const MAC_ACCEPT = 44;
const MAC_SET_UP = MAC_ACCEPT + 188;
const INSTALL_MAC: Scene = {
  id: "install-mac",
  title: "Install on a Mac",
  group: "Install",
  start: { hash: "", search: "", os: "mac", answers: { ...FIRST_RUN_ANSWERS } },
  run: run(
    [{ at: 2, click: "Install" }],
    macInstall(2, 75 * MB, 2),
    [
      { at: 37, settle: "sign_in_to_copilotkit", value: { signedIn: true } },
      { at: MAC_ACCEPT, click: "Accept" },
      { at: 60, click: "Continue" },
    ],
    backEndSetup(MAC_ACCEPT),
    openBotStart(MAC_SET_UP),
  ),
};

// install-windows: OpenBot installs Podman and its machine, the machine image coming from the first
// screen's downloads. The account check waits for the engine. The person stays on the AI step
// through the back end's download, then presses Continue.
const WIN_EARLY = 41 * MB + 1_190 * MB + COMPOSE + IMAGES;
const WIN_SPEED = 40 * MB;
const WIN_ACCEPT = 140;
const WIN_SET_UP = WIN_ACCEPT + 188;
function windowsEarly(): RunStep[] {
  const steps: RunStep[] = [early(2.2, { state: "downloading", bytes: 0 })];
  for (const t of times(3, 59, 3))
    steps.push(
      early(t, {
        state: "downloading",
        bytes: Math.min(WIN_EARLY, Math.round((t - 2) * WIN_SPEED)),
        size: WIN_EARLY,
        bytesPerSecond: WIN_SPEED,
      }),
    );
  steps.push(early(61, { state: "done", bytes: WIN_EARLY, size: WIN_EARLY }));
  return steps;
}
const PREPARING_WINDOWS =
  "Preparing this computer to run OpenBot. If a window asks to install a Windows feature OpenBot needs, allow it. Windows then asks for your approval and a restart.";
function windowsInstall(): RunStep[] {
  const machine = 1_190 * MB;
  const machineAt = (t: number) =>
    Math.max(0, Math.min(machine, Math.round((t - 2) * WIN_SPEED - 41 * MB)));
  return [
    row(2.1, {
      step: "engine",
      ok: true,
      running: true,
      detail: CHECKING_SOFTWARE,
    }),
    row(3, {
      step: "install-engine",
      ok: true,
      running: true,
      detail: "Preparing this computer to run OpenBot.",
    }),
    row(25, { step: "install-engine", ok: true, detail: READY }),
    row(25, {
      step: "create-machine",
      ok: true,
      running: true,
      elsewhere: true,
      detail: PREPARING_WINDOWS,
    }),
    ...[26, 29, 32].map((t) =>
      row(t, {
        step: "create-machine",
        ok: true,
        running: true,
        elsewhere: true,
        detail: PREPARING_WINDOWS,
        downloadBytes: machineAt(t),
        downloads: {
          done: 0,
          total: 1,
          bytes: machineAt(t),
          size: machine,
          bytesPerSecond: WIN_SPEED,
        },
      }),
    ),
    row(33, {
      step: "create-machine",
      ok: true,
      running: true,
      elsewhere: true,
      detail: PREPARING_WINDOWS,
    }),
    row(96, { step: "create-machine", ok: true, detail: READY }),
    row(96, {
      step: "start-machine",
      ok: true,
      running: true,
      detail: "Starting the software OpenBot runs on.",
    }),
    row(118, { step: "start-machine", ok: true, detail: READY }),
    row(118, {
      step: "health-gate",
      ok: true,
      running: true,
      detail: "Checking that the software OpenBot runs on is ready.",
    }),
    row(121, { step: "health-gate", ok: true, detail: READY }),
    row(121, { step: "engine", ok: true, detail: ENGINE_READY }),
    row(121.3, {
      step: "deployment",
      ok: true,
      running: true,
      detail: CHECKING_RELEASE,
    }),
    row(121.8, { step: "deployment", ok: true, detail: DOWNLOADED }),
    row(121.8, {
      step: "images",
      ok: true,
      running: true,
      detail: CHECKING_DOWNLOAD,
    }),
    // Downloaded by the first screen already: loaded into the engine, part by part.
    ...[122, 125, 128].map((t, done) =>
      row(t, {
        step: "images",
        ok: true,
        running: true,
        detail: DOWNLOADING,
        downloadBytes: IMAGES,
        downloads: { done, total: 3, bytes: IMAGES, size: IMAGES },
      }),
    ),
    row(131, { step: "images", ok: true, detail: DOWNLOADED }),
    row(131, {
      step: "installation",
      ok: true,
      running: true,
      detail: "Finishing the installation.",
    }),
    row(133, {
      step: "installation",
      ok: true,
      detail: "OpenBot is installed.",
    }),
    { at: 133.5, settle: "prepare_installation", value: null },
  ];
}
const INSTALL_WINDOWS: Scene = {
  id: "install-windows",
  title: "Install on Windows",
  group: "Install",
  start: {
    hash: "",
    search: "",
    os: "windows",
    answers: {
      ...FIRST_RUN_ANSWERS,
      windows_blocker: { mode: "value", value: null },
      windows_restart_pending: { mode: "value", value: false },
      // No engine answers until Install has set up Podman: the account check waits.
      local_eval_terms: {
        mode: "value",
        value: { status: "engine-not-ready" },
      },
    },
  },
  run: run(
    [{ at: 2, click: "Install" }],
    windowsEarly(),
    windowsInstall(),
    [
      { at: 30, settle: "sign_in_to_copilotkit", value: { signedIn: true } },
      value(121.5, "local_eval_terms", TERMS),
      { at: WIN_ACCEPT, click: "Accept" },
      { at: WIN_ACCEPT + 95, click: "Continue" },
    ],
    backEndSetup(WIN_ACCEPT),
    openBotStart(WIN_SET_UP),
  ),
};

// install-slow-download: a Mac on a slow line (2.5 MB a second). The account step is done long
// before OpenBot is downloaded, so the window goes on to Install's own screen. The back end's
// download shares the line and takes about 6 minutes.
const SLOW_SPEED = 2.5 * MB;
const SLOW_ACCEPT = 44;
const SLOW_BACK_END_DOWNLOAD = 348;
const SLOW_INSTALLED = Math.round((3 + IMAGES / SLOW_SPEED) * 10) / 10 + 0.5;
const SLOW_SET_UP = SLOW_ACCEPT + 188 + (SLOW_BACK_END_DOWNLOAD - 48);
const INSTALL_SLOW_DOWNLOAD: Scene = {
  id: "install-slow-download",
  title: "Install on a slow internet connection",
  group: "Install",
  start: { hash: "", search: "", os: "mac", answers: { ...FIRST_RUN_ANSWERS } },
  run: run(
    [{ at: 2, click: "Install" }],
    macInstall(2, SLOW_SPEED, 10),
    [
      { at: 37, settle: "sign_in_to_copilotkit", value: { signedIn: true } },
      { at: SLOW_ACCEPT, click: "Accept" },
      // Install's own screen until it is done, then the AI step.
      { at: SLOW_INSTALLED + 10, click: "Continue" },
    ],
    backEndSetup(SLOW_ACCEPT, SLOW_BACK_END_DOWNLOAD, 10),
    openBotStart(SLOW_SET_UP),
  ),
};

// install-step-fails: the line drops while OpenBot's images download. Install fails on the account
// step, with Try again in its card. Try again downloads them again, and setup goes on.
const LINE_DROPPED = {
  said: "OpenBot couldn't download the software it needs. Check your internet connection, proxy or firewall, and try again.",
  detail:
    'pulling ghcr.io/copilotkit/openbot: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host',
} satisfies Problem;
const FAILS_ACCEPT = 50;
const FAILS_SET_UP = FAILS_ACCEPT + 188;
function failingInstall(): RunStep[] {
  const size = COMPOSE + IMAGES;
  const speed = 75 * MB;
  const steps: RunStep[] = [
    row(2.1, {
      step: "engine",
      ok: true,
      running: true,
      detail: CHECKING_SOFTWARE,
    }),
    early(2.2, { state: "downloading", bytes: 0 }),
    row(2.3, { step: "engine", ok: true, detail: READY }),
    row(2.3, {
      step: "deployment",
      ok: true,
      running: true,
      detail: CHECKING_RELEASE,
    }),
    early(2.6, { state: "downloading", bytes: COMPOSE, size }),
    row(2.6, { step: "deployment", ok: true, detail: DOWNLOADED }),
    row(2.6, {
      step: "images",
      ok: true,
      running: true,
      detail: CHECKING_DOWNLOAD,
    }),
  ];
  for (const t of [3, 5, 7, 9]) {
    const bytes = Math.round((t - 3) * speed);
    steps.push(
      early(t, {
        state: "downloading",
        bytes: COMPOSE + bytes,
        size,
        bytesPerSecond: speed,
      }),
      row(t, {
        step: "images",
        ok: true,
        running: true,
        detail: DOWNLOADING,
        ...(bytes > 0 ? { downloadBytes: bytes } : {}),
        downloads: {
          done: bytes > IMAGES / 4 ? 2 : 1,
          total: 3,
          bytes,
          size: IMAGES,
          bytesPerSecond: speed,
        },
      }),
    );
  }
  // Nothing comes in for a few seconds, then the pull gives up. No row says so: the window marks
  // the running row with the failure (`settleProgress`).
  steps.push(
    early(11, {
      state: "downloading",
      bytes: COMPOSE + 6 * speed,
      size,
      bytesPerSecond: 0,
    }),
    early(14.9, { state: "failed", bytes: COMPOSE + 6 * speed, size }),
    { at: 15, fail: "prepare_installation", problem: LINE_DROPPED },
    // The line is back. Try again runs the install again, which waits for the native side.
    { at: 29.9, answer: "prepare_installation", with: { mode: "never" } },
    { at: 30, click: "Try again" },
    row(30.1, {
      step: "engine",
      ok: true,
      running: true,
      detail: CHECKING_SOFTWARE,
    }),
    row(30.3, { step: "engine", ok: true, detail: READY }),
    row(30.3, {
      step: "deployment",
      ok: true,
      running: true,
      detail: CHECKING_RELEASE,
    }),
    row(30.4, { step: "deployment", ok: true, detail: DOWNLOADED }),
    row(30.4, {
      step: "images",
      ok: true,
      running: true,
      detail: CHECKING_DOWNLOAD,
    }),
  );
  // The parts already in are kept: about a third of the bytes are left.
  const resumed = 6 * speed;
  for (const t of times(31, 39, 2)) {
    const bytes = Math.min(IMAGES, Math.round(resumed + (t - 31) * speed));
    steps.push(
      row(t, {
        step: "images",
        ok: true,
        running: true,
        detail: DOWNLOADING,
        downloadBytes: bytes,
        downloads: {
          done: bytes >= IMAGES ? 3 : 2,
          total: 3,
          bytes,
          size: IMAGES,
          bytesPerSecond: speed,
        },
      }),
    );
  }
  steps.push(
    row(39.3, { step: "images", ok: true, detail: DOWNLOADED }),
    row(39.3, {
      step: "installation",
      ok: true,
      running: true,
      detail: "Finishing the installation.",
    }),
    row(39.4, {
      step: "installation",
      ok: true,
      detail: "OpenBot is installed.",
    }),
    { at: 39.5, settle: "prepare_installation", value: null },
  );
  return steps;
}
const INSTALL_STEP_FAILS: Scene = {
  id: "install-step-fails",
  title: "Install: the download stops, then Try again works",
  group: "Install",
  start: { hash: "", search: "", os: "mac", answers: { ...FIRST_RUN_ANSWERS } },
  run: run(
    [{ at: 2, click: "Install" }],
    failingInstall(),
    [
      { at: 37, settle: "sign_in_to_copilotkit", value: { signedIn: true } },
      { at: FAILS_ACCEPT, click: "Accept" },
      { at: 66, click: "Continue" },
    ],
    backEndSetup(FAILS_ACCEPT),
    openBotStart(FAILS_SET_UP),
  ),
};

// install-slow-sign-in: the person takes 4 minutes to sign in in the browser. Install is done after
// 17 seconds and waits on them meanwhile.
const LATE_ACCEPT = 250;
const LATE_SET_UP = LATE_ACCEPT + 188;
const INSTALL_SLOW_SIGN_IN: Scene = {
  id: "install-slow-sign-in",
  title: "Install: the sign-in takes 4 minutes",
  group: "Install",
  start: { hash: "", search: "", os: "mac", answers: { ...FIRST_RUN_ANSWERS } },
  run: run(
    [{ at: 2, click: "Install" }],
    macInstall(2, 75 * MB, 2),
    [
      { at: 242, settle: "sign_in_to_copilotkit", value: { signedIn: true } },
      { at: LATE_ACCEPT, click: "Accept" },
      { at: LATE_ACCEPT + 16, click: "Continue" },
    ],
    backEndSetup(LATE_ACCEPT),
    openBotStart(LATE_SET_UP),
  ),
};

// install-relaunch-update: OpenBot opens again after the app updated from 1.0.0 to 1.0.1 (`#start`).
// It starts by itself, and the Start updates the installation: stop, back up, download, install,
// then start, at the times the update typically takes (`journeyTimings.json` release).
const UPDATE_IMAGES = 96 * MB;
function update(begin: number): RunStep[] {
  const release = (at: number, detail: string): RunStep =>
    row(begin + at, { step: "release", ok: true, running: true, detail });
  return [
    row(begin + 0.1, {
      step: "engine",
      ok: true,
      running: true,
      detail: CHECKING_SOFTWARE,
    }),
    row(begin + 0.3, { step: "engine", ok: true, detail: READY }),
    release(
      0.3,
      "Updating OpenBot. Your Bots, sign-ins and data stay as they are.",
    ),
    release(0.4, "Checking there's room for the update."),
    release(2, "Stopping OpenBot."),
    release(8, "Backing up your data."),
    release(21, "Downloading the update."),
    release(71, "Installing the update."),
    row(begin + 71.1, {
      step: "engine",
      ok: true,
      running: true,
      detail: CHECKING_SOFTWARE,
    }),
    row(begin + 71.2, { step: "engine", ok: true, detail: READY }),
    row(begin + 71.2, {
      step: "deployment",
      ok: true,
      running: true,
      detail: CHECKING_RELEASE,
    }),
    row(begin + 71.3, { step: "deployment", ok: true, detail: DOWNLOADED }),
    row(begin + 71.3, {
      step: "images",
      ok: true,
      running: true,
      detail: CHECKING_DOWNLOAD,
    }),
    ...[71.6, 72.1, 72.6].map((at, index) => {
      const bytes = Math.round((UPDATE_IMAGES * (index + 1)) / 3);
      return row(begin + at, {
        step: "images",
        ok: true,
        running: true,
        detail: DOWNLOADING,
        downloadBytes: bytes,
        downloads: {
          done: 3 + index,
          total: 5,
          bytes,
          size: UPDATE_IMAGES,
          bytesPerSecond: 190 * MB,
        },
      });
    }),
    row(begin + 72.8, { step: "images", ok: true, detail: DOWNLOADED }),
    row(begin + 72.8, {
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
    release(73, "Starting OpenBot."),
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
      detail: "Starting OpenBot. This can take a few minutes the first time.",
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
    // Not typed: its type, `ReleaseOutcome`, is not exported from `App.tsx`.
    {
      at: begin + 108.2,
      settle: "upgrade_and_start",
      value: { from: "1.0.0", to: "1.0.1", moved: true, notice: null },
    },
  ];
}
const INSTALL_RELAUNCH_UPDATE: Scene = {
  id: "install-relaunch-update",
  title: "Open again after an update",
  group: "Install",
  start: {
    hash: "#start",
    search: "",
    os: "mac",
    answers: { upgrade_and_start: { mode: "never" } },
  },
  run: run(update(1)),
};

// install-anthropic-plan: a first run on a Mac where the person picks Anthropic on "Connect your
// AI" and signs in with their plan. Install does not download a plan's image on a first run
// (`preparation::PLAN_IMAGES`), so `begin_claude_sign_in` downloads it first through
// `download_missing` (`main.rs`): an `images` row says "Downloading OpenBot.", rows with its
// download follow (`report_downloads`), and a last row says it is downloaded. While the sign-in
// waits on that download, `ProviderPicker` draws the row as a "Local software" card inside the
// Anthropic panel. The back end's own download runs at the same time.
const PLAN_ACCEPT = 44;
/** The Claude Agent SDK image (`plan::SIGN_IN_IMAGE`). Its size here is a fair guess. */
const SIGN_IN_IMAGE = 420 * MB;
/** The line, shared with the back end's download. */
const PLAN_SPEED = 25 * MB;
const PLAN_PICK = 70;
const PLAN_SIGN_IN = 74;
const PLAN_DOWNLOAD_FROM = PLAN_SIGN_IN + 1;
const PLAN_DOWNLOAD_TO =
  Math.round((PLAN_DOWNLOAD_FROM + SIGN_IN_IMAGE / PLAN_SPEED) * 10) / 10;
/** When the person types the code. The determinism test seeks to just after it. */
export const PLAN_CODE = PLAN_DOWNLOAD_TO + 8;
const PLAN_FINISH = PLAN_CODE + 2;
const PLAN_SET_UP = PLAN_ACCEPT + 188;
/** The address `SigningIn::begin` gives back once the sign-in container has started. */
const CLAUDE_SIGN_IN_PAGE =
  "https://claude.ai/oauth/authorize?code=true&response_type=code&state=example";

/** Nothing installed yet, and nothing saved: no key, no plan sign-in. */
const NOTHING_KEPT = {
  values: {},
  saved: {
    modelApiKeys: { openai: false, anthropic: false },
    modelSessions: { openai: false, anthropic: false },
  } satisfies SavedConfiguration,
};

/** `begin_claude_sign_in` from the click at `click`: the image's download, then the address. */
function claudeSignIn(click: number): RunStep[] {
  const steps: RunStep[] = [
    // `download_missing`: the image is missing, so the row starts with no download yet.
    row(click + 0.3, {
      step: "images",
      ok: true,
      running: true,
      detail: DOWNLOADING,
    }),
  ];
  for (const t of times(PLAN_DOWNLOAD_FROM, PLAN_DOWNLOAD_TO, 1)) {
    const bytes = Math.min(
      SIGN_IN_IMAGE,
      Math.round((t - PLAN_DOWNLOAD_FROM) * PLAN_SPEED),
    );
    steps.push(
      row(t, {
        step: "images",
        ok: true,
        running: true,
        detail: DOWNLOADING,
        ...(bytes > 0 ? { downloadBytes: bytes } : {}),
        downloads: {
          done: bytes >= SIGN_IN_IMAGE ? 1 : 0,
          total: 1,
          bytes,
          size: SIGN_IN_IMAGE,
          // `Pacer` says a speed once it has a window to measure it over.
          ...(t > PLAN_DOWNLOAD_FROM ? { bytesPerSecond: PLAN_SPEED } : {}),
        },
      }),
    );
  }
  steps.push(
    row(PLAN_DOWNLOAD_TO + 0.1, {
      step: "images",
      ok: true,
      detail: DOWNLOADED,
    }),
    // The sign-in container starts, and gives the address to open.
    {
      at: PLAN_DOWNLOAD_TO + 3,
      settle: "begin_claude_sign_in",
      value: CLAUDE_SIGN_IN_PAGE satisfies string,
    },
  );
  return steps;
}

const INSTALL_ANTHROPIC_PLAN: Scene = {
  id: "install-anthropic-plan",
  title: "Install and sign in with a Claude plan",
  group: "Install",
  start: {
    hash: "",
    search: "",
    os: "mac",
    answers: {
      ...FIRST_RUN_ANSWERS,
      already_configured: { mode: "value", value: NOTHING_KEPT },
      begin_claude_sign_in: { mode: "never" },
      finish_claude_sign_in: { mode: "never" },
    },
  },
  run: run(
    [{ at: 2, click: "Install" }],
    macInstall(2, 75 * MB, 2),
    [
      { at: 37, settle: "sign_in_to_copilotkit", value: { signedIn: true } },
      { at: PLAN_ACCEPT, click: "Accept" },
      // The plan is the first way in, so "Sign in with my plan" is already chosen.
      { at: PLAN_PICK, click: "Anthropic" },
      { at: PLAN_SIGN_IN, click: "Sign in with Anthropic" },
      // The person pastes the code the browser shows, and presses Finish signing in. The code here
      // is made up.
      {
        at: PLAN_CODE,
        type: "abc123#xyz" satisfies string,
        into: "Code from your browser",
      },
      { at: PLAN_FINISH, click: "Finish signing in" },
      {
        at: PLAN_FINISH + 1.5,
        settle: "finish_claude_sign_in",
        value: "example-claude-plan-token" satisfies string,
      },
      // No Continue step: once finish_claude_sign_in settles, the window goes on to Finishing
      // setup by itself.
    ],
    claudeSignIn(PLAN_SIGN_IN),
    backEndSetup(PLAN_ACCEPT),
    openBotStart(PLAN_SET_UP),
  ),
};

export const INSTALL_SCENES: readonly Scene[] = [
  INSTALL_MAC,
  INSTALL_WINDOWS,
  INSTALL_SLOW_DOWNLOAD,
  INSTALL_STEP_FAILS,
  INSTALL_SLOW_SIGN_IN,
  INSTALL_RELAUNCH_UPDATE,
  INSTALL_ANTHROPIC_PLAN,
];
