import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;
type ProgressEvent = {
  step: string;
  ok: boolean;
  detail: string;
  running?: boolean;
  elsewhere?: boolean;
  asks?: boolean;
  updating?: boolean;
  downloadBytes?: number;
  downloads?: {
    done: number;
    total: number;
    bytes: number;
    size?: number;
    bytesPerSecond?: number;
  };
};
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeHandler: Invoke = async () => {
  throw new Error("invoke handler was not installed");
};
const progressListeners = new Set<
  (event: { payload: ProgressEvent }) => void
>();
type QuitEvent = { seq: number; steps: ProgressEvent[] };
const quitListeners = new Set<(event: { payload: QuitEvent }) => void>();

/** What `local_eval_steps` answers for the CLI call running now: the steps it has finished. */
let localSteps: unknown = null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    // Asked every second while a CLI call runs: not a step of the sequence.
    if (command === "local_eval_steps") return Promise.resolve(localSteps);
    invokeCalls.push({ command, args });
    return invokeHandler(command, args);
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    listener: (event: { payload: ProgressEvent }) => void,
  ) => {
    if (name === "setup:progress") progressListeners.add(listener);
    const quit = listener as unknown as (event: { payload: QuitEvent }) => void;
    if (name === "quit:progress") quitListeners.add(quit);
    return () => {
      progressListeners.delete(listener);
      quitListeners.delete(quit);
    };
  },
}));

mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
  // The mark a "Sign in with" button carries, by the id it was given. The real one draws that
  // vendored file, which needs Vite's glob.
  ButtonMark: ({ id }: { id: string | null }) =>
    id ? <img alt="" data-mark={id} /> : null,
}));

const { App } = await import("./App");
const { ShuttingDownWindow, isShuttingDownPage } = await import(
  "./ShuttingDown"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  // Unmounting can still call (a running local step is cancelled), so clear the record after it.
  cleanup();
  setSystemTime();
  invokeCalls = [];
  localSteps = null;
  progressListeners.clear();
  quitListeners.clear();
});
afterAll(() => GlobalRegistrator.unregister());

async function renderApp(strictMode = false) {
  let view!: ReturnType<typeof render>;

  await act(async () => {
    view = render(
      strictMode ? (
        <StrictMode>
          <App />
        </StrictMode>
      ) : (
        <App />
      ),
    );
  });

  return view;
}

function setupEvents() {
  return invokeCalls
    .filter((call) => call.command === "record_setup_event")
    .map((call) => call.args);
}

/** Install on the first screen, past the account step, to the AI provider screen. */
async function reachAi(view: Awaited<ReturnType<typeof renderApp>>) {
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
}

function installationCalls() {
  return invokeCalls.filter((call) =>
    ["prepare_installation", "prepare_engine"].includes(call.command),
  );
}

async function beginPendingInstallation() {
  setupRootConfiguration("/tmp/install-progress", async () =>
    emptyConfiguration(),
  );
  let preparation = deferred<void>();
  withLocalCli({
    prepare_installation: () => preparation.promise,
    set_up_local_eval: () => new Promise(() => {}),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Installing OpenBot" });
  return {
    view,
    preparation,
    retry: async () => {
      preparation = deferred<void>();
      await userEvent.click(
        view.getByRole("button", { name: "Retry installation" }),
      );
      return preparation;
    },
  };
}

async function emitQuit(payload: QuitEvent) {
  await act(async () => {
    for (const listener of quitListeners) listener({ payload });
  });
}

/** One centred column, as every setup screen: the heading, its lede and rows in one sheet. */
function expectStandardSheet(heading: HTMLElement) {
  const sheet = heading.closest(".sheet");
  expect(sheet).not.toBeNull();
  expect(sheet?.classList.contains("connection-sheet")).toBe(true);
  expect(sheet?.parentElement?.tagName).toBe("MAIN");
  // Nothing beside the sheet: the grid would give each child its own row and spread them apart.
  expect(sheet?.parentElement?.children).toHaveLength(1);
  expect(sheet?.querySelector(".lede, [role=status]")).not.toBeNull();
}

const running = (step: string) => ({
  step,
  ok: true,
  detail: "",
  running: true,
});
const complete = (step: string) => ({
  step,
  ok: true,
  detail: "",
  running: false,
});
const failed = (step: string) => ({
  step,
  ok: false,
  detail: "",
  running: false,
});

/**
 * The background install's row, on a screen that asks for something else meanwhile: what it says,
 * how far along it is, and whether it is working (its spinner) or waiting for the person.
 */
function expectBehind(
  view: ReturnType<typeof render>,
  at: number,
  said: string,
  { waiting = false }: { waiting?: boolean } = {},
) {
  const row = view.getByRole("listitem", {
    name: "Installing OpenBot in the background",
  });
  expect(row.querySelector(".detail")?.textContent).toBe(said);
  expect(row.querySelector(".step-status")?.textContent).toContain(
    `Step ${at} of 4`,
  );
  expect(row.querySelector(".step-spinner") !== null).toBe(!waiting);
  expect(row.textContent?.includes("Waiting for you")).toBe(waiting);
}

/** What the Start screen's journey says is happening now, with its spinner (`StartJourney`). */
function expectJourney(view: ReturnType<typeof render>, said: string) {
  const journey = view.getByRole("region", { name: "How far along" });
  expect(journey.querySelector(".journey-said")?.textContent).toBe(said);
  expect(journey.querySelector(".step-spinner")).not.toBeNull();
  expect(journey.querySelector("progress")).not.toBeNull();
}

/** A status line that is still working: its words, with the setup rows' spinner beside them. */
function expectWorking(view: ReturnType<typeof render>, said: string) {
  const status = view
    .getAllByRole("status")
    .find((line) => line.textContent === said);
  expect(status?.textContent).toBe(said);
  expect(status?.querySelector(".step-spinner")).not.toBeNull();
}

function rowStatus(view: ReturnType<typeof render>, name: string) {
  return within(view.getByRole("listitem", { name }));
}

async function emitProgress(payload: ProgressEvent) {
  await act(async () => {
    for (const listener of progressListeners) listener({ payload });
  });
}

/**
 * A download's report again, once it has run long enough for its speed to say a time from: a
 * row says no time left before 3 seconds and 5 MB (`STEADY_SECONDS`, `STEADY_BYTES`).
 */
async function steadied(payload: ProgressEvent) {
  setSystemTime(new Date(Date.now() + 3_500));
  await emitProgress(payload);
}

/*
 * The install's rows say their time so far, counted from when the install began. Windows F showed
 * a row with neither a time so far nor a time left, under a full bar, and it looked stuck.
 */
test("installation shows its active stage immediately, with its time so far", async () => {
  const { view, preparation } = await beginPendingInstallation();
  const preparing = within(
    view.getByRole("listitem", { name: "Preparing this computer" }),
  );
  expect(
    preparing.getByText("Checking the software OpenBot needs."),
  ).toBeTruthy();
  // Running, it says how far along the install is: the first of its four parts.
  expect(preparing.getByText("Step 1 of 4")).toBeTruthy();
  expect(preparing.queryByText("✓")).toBeNull();
  expect(preparing.getByText(/· \d+s elapsed/)).toBeTruthy();
  await act(async () => preparation.resolve());
  // Installed: on to the AI provider screen. The install's rows are done; what is left, setting
  // up the rest of OpenBot, is said on one row under the choice.
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(
    view.queryByRole("listitem", { name: "Preparing this computer" }),
  ).toBeNull();
  expect(
    view.queryByRole("listitem", { name: "Downloading OpenBot" }),
  ).toBeNull();
  expectBehind(
    view,
    3,
    "Setting up OpenBot on this computer. This takes a few minutes the first time.",
  );
});

/*
 * The rest of OpenBot downloads alongside OpenBot's own download, once the software OpenBot runs on
 * answers. On a live Windows run the Install step showed both at once, "Downloading OpenBot ·
 * Step 2 of 4" and "Downloading the rest of OpenBot · Step 3 of 4", each with its spinner, which
 * read as two steps at the same time. The step says one step at a time: the third once the
 * second is done, with as much of its download as has come in meanwhile.
 */
test("the Install step shows one step in progress at a time while both downloads run", async () => {
  setupRootConfiguration("/tmp/one-step", async () => emptyConfiguration());
  const preparation = deferred<void>();
  withLocalCli({
    prepare_installation: () => preparation.promise,
    set_up_local_eval: () => new Promise(() => {}),
    local_eval_download: () => ({ done: 400_000_000, total: 1_600_000_000 }),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Installing OpenBot" });
  await emitProgress({
    step: "engine",
    ok: true,
    running: false,
    detail: "The software OpenBot runs on is ready.",
  });
  await emitProgress({
    step: "images",
    ok: true,
    running: true,
    detail: "Downloading local software.",
    downloads: {
      done: 1,
      total: 5,
      bytes: 1_200_000_000,
      size: 3_400_000_000,
      bytesPerSecond: 9_000_000,
    },
  });
  // The rest of OpenBot is downloading too, and the window has heard how far it has got.
  await waitFor(() =>
    expect(
      invokeCalls.some((call) => call.command === "local_eval_download"),
    ).toBe(true),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  const inProgress = () =>
    [...view.container.querySelectorAll(".step")]
      .filter((row) => row.querySelector(".mark.active"))
      .map(
        (row) =>
          `${row.getAttribute("aria-label")} | ${row.querySelector(".step-status")?.textContent?.replace(/ · [\dms ]+ elapsed$/, "")}`,
      );
  expect(inProgress()).toEqual(["Downloading OpenBot | Step 2 of 4"]);
  expect(view.container.textContent).not.toContain("Step 3 of 4");
  // Step 2 done: the third step is the one in progress, its download as far as it has got.
  await act(async () => preparation.resolve());
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(inProgress()).toEqual([
    "Installing OpenBot in the background | Step 3 of 4",
  ]);
  expect(view.container.textContent).toContain("400.0 MB of 1.6 GB");
});

test("installation failure stops active indicators and retry begins fresh", async () => {
  const { view, preparation, retry } = await beginPendingInstallation();
  await emitProgress({
    step: "engine",
    ok: true,
    running: false,
    detail: "Docker is answering.",
  });
  await emitProgress({
    step: "dependencies",
    ok: true,
    running: true,
    detail: "Installing the local runtime.",
  });
  await act(async () =>
    preparation.reject({ said: "The download was interrupted." }),
  );
  const installing = within(
    view.getByRole("listitem", { name: "Downloading OpenBot" }),
  );
  expect(installing.getByText("Failed")).toBeTruthy();
  expect(installing.getByText("✗")).toBeTruthy();
  expect(view.getByRole("alert").textContent).toContain(
    "The download was interrupted.",
  );
  expect(view.queryByText(/In progress|Step \d of \d/) === null).toBe(true);
  expect(view.queryByText(/elapsed/)).toBeNull();
  expect(
    within(
      view.getByRole("listitem", { name: "Preparing this computer" }),
    ).getByText("Complete"),
  ).toBeTruthy();
  // Nothing goes on to the AI step while the install has failed.
  expect(view.queryByRole("heading", { name: "Connect your AI" })).toBeNull();
  const secondAttempt = await retry();
  expect(view.queryByText("Failed")).toBeNull();
  expect(view.getByText("Step 1 of 4")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  await act(async () => secondAttempt.resolve());
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(
    installationCalls().filter(
      (call) => call.command === "prepare_installation",
    ),
  ).toHaveLength(2);
});

const localListing = { outcome: "completed", stacks: [], reason: null };

function localStatus(readiness: string, licence: string) {
  return {
    outcome: "completed",
    stack: {
      id: "local-abc123",
      installedRelease: "0.15.0",
      step: "ready",
      urls: {
        api: "http://localhost:64770",
        dashboard: "http://cpk.localhost:64771",
        gateway: "ws://localhost:64772",
      },
      hasFailedStep: false,
      updateInProgress: false,
      unfinishedUpdate: null,
      observed: null,
    },
    reason: null,
    readiness,
    licence,
    licenceExpiresAt: null,
    checksPassed: false,
  };
}

const localConnection = {
  outcome: "completed",
  stack: localStatus("unknown", "unknown").stack,
  reason: null,
  conflicted: false,
};

/** Local Intelligence that sets up, connects and reports ready and valid straight away. */
function readyLocal() {
  return {
    set_up_local_eval: localStatus("ready", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  };
}

/** The local stack's own addresses, as `localStatus` reports them. */
const LOCAL_ADDRESSES = {
  apiUrl: "http://localhost:64770",
  gatewayWsUrl: "ws://localhost:64772",
};

/** This build has a CLI; each local command answers from `local`. */
/** The agreement as the CLI reports it for a person who has already accepted it. */
const ACCEPTED_TERMS = {
  status: "required",
  accepted: true,
  version: "developer-edition-2026-10-01-web",
  url: "https://copilotkit.ai/legal/developer-edition",
  organizationName: "Acme",
};

function withLocalCli(local: Record<string, unknown>) {
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "list_local_eval") return localListing;
    if (command === "cancel_local_eval") return null;
    if (command === "show_openbot") return null;
    // Signed in and agreed already, unless a test says otherwise: the account step passes. The
    // CLI's `login` answers at once for a sign-in it already has, and opens no browser.
    if (
      command === "sign_in_to_copilotkit" &&
      !("sign_in_to_copilotkit" in local)
    )
      return { signedIn: true };
    if (command === "local_eval_terms" && !("local_eval_terms" in local))
      return ACCEPTED_TERMS;
    // Apps connect once signed in, unless a test says otherwise.
    if (
      command === "connect_copilotkit_apps" &&
      !("connect_copilotkit_apps" in local)
    )
      return null;
    if (command in local) {
      const answer = local[command];
      return typeof answer === "function" ? answer(args) : answer;
    }
    return previous(command, args);
  };
}

function localSequence() {
  return invokeCalls
    .map((call) => call.command)
    .filter((command) =>
      [
        "set_up_local_eval",
        "connect_local_eval",
        "run_local_eval",
        "start_stack",
        "show_openbot",
      ].includes(command),
    );
}

/** Commands that set up, connect or run local Intelligence, or stop a call. */
function localCliCalls() {
  return invokeCalls.filter((call) =>
    [
      "set_up_local_eval",
      "connect_local_eval",
      "run_local_eval",
      "cancel_local_eval",
    ].includes(call.command),
  );
}

/** A first run hands over the moment Start succeeds: OpenBot opens, and nothing is asked first. */
async function expectHandover(timeout?: number) {
  await waitFor(
    () =>
      expect(invokeCalls.some((call) => call.command === "show_openbot")).toBe(
        true,
      ),
    { timeout },
  );
  expect(invokeCalls.some((call) => call.command === "ask_the_bot")).toBe(
    false,
  );
}

/** The first screen's Install, which with a CLI installs OpenBot and local Intelligence. */
async function installLocal(view: Awaited<ReturnType<typeof renderApp>>) {
  await userEvent.click(view.getByRole("button", { name: "Install" }));
}

/** Words about the software underneath, which no local screen says. */
// Docker is not here: Docker Desktop is an app a person may already have, and its prompts and
// agreements show windows of its own, so a screen names it when it waits on one. See
// `plainInstallSteps`. Podman is: OpenBot installs it, and a person reads "the software OpenBot
// runs on" instead. The log names it.
const JARGON = [
  /\bCLI\b/,
  /Container engine/i,
  /Engine machine/i,
  /k3d/i,
  /k3s/i,
  /\bHelm\b/,
  /Podman/,
  /\bWSL\b/,
  /Windows Subsystem for Linux/,
  /Intelligence/,
];

function expectPlain(view: Awaited<ReturnType<typeof renderApp>>) {
  const text = view.container.textContent ?? "";
  for (const word of JARGON) expect(text).not.toMatch(word);
}

/** The section the screen is in, as the section list marks it. */
function stepLabel(view: Awaited<ReturnType<typeof renderApp>>) {
  return view.container.querySelector('[aria-current="step"]')?.textContent;
}

function buttons(view: Awaited<ReturnType<typeof renderApp>>) {
  return view
    .getAllByRole("button")
    .map((button) => button.textContent)
    .sort();
}

async function chooseOpenAi(view: Awaited<ReturnType<typeof renderApp>>) {
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.type(view.getByLabelText("OpenAI API key"), "model-test-key");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
}

test("the first screen is Install, with nothing to choose", async () => {
  setupRootConfiguration("/tmp/local-eval-welcome", async () =>
    emptyConfiguration(),
  );
  withLocalCli({});
  const view = await renderApp();
  expect(view.getByRole("heading", { name: "Set up OpenBot" })).toBeTruthy();
  expect(
    view.getByText(
      "This installs OpenBot on this computer. The first setup takes about 10 minutes.",
    ),
  ).toBeTruthy();
  expect(buttons(view)).toEqual(["Install"]);
  expect(view.queryByRole("radio")).toBeNull();
  expect(view.queryByText(/hosted/i)).toBeNull();
  expectPlain(view);
  expect(localCliCalls()).toEqual([]);
});

test("the first screen says what usage data OpenBot sends, before the sign-in links it", async () => {
  setupRootConfiguration("/tmp/local-eval-welcome-usage", async () =>
    emptyConfiguration(),
  );
  withLocalCli({});
  const view = await renderApp();
  const notice = view.getByText(/OpenBot sends usage data/);
  expect(notice.textContent).toBe(
    "OpenBot sends usage data, linked to your OpenBot account. It never sends your conversations, files or keys. You can turn this off in Settings. What OpenBot sends",
  );
  const link = view.getByRole("link", { name: "What OpenBot sends" });
  expect(link.getAttribute("href")).toBe(
    "https://github.com/CopilotKit/OpenBot/blob/main/desktop/TELEMETRY.md",
  );
  // Before anything is installed or signed in to: the notice comes first.
  expect(localCliCalls()).toEqual([]);
});

test("Install prepares the default Bot in the default folder, with no Bot or folder screen", async () => {
  setupRootConfiguration("/tmp/local-eval-install", async () =>
    emptyConfiguration(),
  );
  const preparation = deferred<void>();
  withLocalCli({ prepare_installation: () => preparation.promise });
  const view = await renderApp();
  await installLocal(view);
  expect(installationCalls()).toEqual([
    {
      command: "prepare_installation",
      args: { root: "/tmp/local-eval-install", harness: { id: "langgraph" } },
    },
  ]);
  expect(
    view.getByRole("heading", { name: "Installing OpenBot" }),
  ).toBeTruthy();
  expect(stepLabel(view)).toBe("Install");
  // Names every part it installs, so a large download is expected.
  expect(
    view.getByText(
      /installs OpenBot on this computer: the app, its database, your Bots/,
    ),
  ).toBeTruthy();
  expect(view.queryByLabelText("Where OpenBot lives")).toBeNull();
  expect(view.queryByText(/Pick a Bot|Which Bot/i)).toBeNull();
  expect(invokeCalls.some((call) => call.command === "harnesses")).toBe(false);
  // Nothing to press, and no way out while it installs.
  expect(view.queryAllByRole("button")).toEqual([]);
  // Intelligence waits for the engine the install starts: nothing local runs yet.
  expect(localCliCalls()).toEqual([]);
  // Native rows are summarised in plain words, with what the computer is doing now.
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    detail: "Downloading Docker Desktop.",
    downloadBytes: 48_000_000,
  });
  const preparing = within(
    view.getByRole("listitem", { name: "Preparing this computer" }),
  );
  expect(preparing.getByText(/Downloading Docker Desktop\./)).toBeTruthy();
  expect(preparing.getByText(/48\.0 MB downloaded/)).toBeTruthy();
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    detail:
      "Starting Docker Desktop. Accept its terms in its own window when it asks.",
  });
  expect(
    preparing.getByText(/Accept its terms in its own window/),
  ).toBeTruthy();
  expect(preparing.queryByText(/downloaded/)).toBeNull();
  await emitProgress({
    step: "install-engine",
    ok: true,
    detail: "Docker Desktop 4.96.3 installed and running.",
  });
  await emitProgress({
    step: "engine",
    ok: true,
    detail: "The software OpenBot runs on is ready.",
  });
  await emitProgress({
    step: "create-machine",
    ok: true,
    detail: "openbot created.",
  });
  await emitProgress({
    step: "images",
    ok: true,
    running: true,
    detail: "Checking which local software to download.",
  });
  const checking = rowStatus(view, "Downloading OpenBot");
  expect(
    checking.getByText("Checking which local software to download."),
  ).toBeTruthy();
  expect(checking.queryByRole("progressbar")).toBeNull();
  await emitProgress({
    step: "images",
    ok: true,
    running: true,
    detail: "Downloading local software (2/4).",
    downloadBytes: 2_400_000,
  });
  expect(
    within(
      view.getByRole("listitem", { name: "Preparing this computer" }),
    ).getByText("Complete"),
  ).toBeTruthy();
  const installing = within(
    view.getByRole("listitem", { name: "Downloading OpenBot" }),
  );
  expect(installing.getByText("Step 2 of 4")).toBeTruthy();
  expect(installing.queryByText(/Downloading local software/)).toBeNull();
  expect(installing.queryByRole("progressbar")).toBeNull();
  const pulling: ProgressEvent = {
    step: "images",
    ok: true,
    running: true,
    detail: "Downloading local software.",
    downloadBytes: 52_000_000,
    downloads: {
      done: 2,
      total: 7,
      bytes: 52_000_000,
      size: 1_300_000_000,
      bytesPerSecond: 3_000_000,
    },
  };
  await emitProgress(pulling);
  // No time left before its speed is steady: Windows F said "About 164011 minutes left".
  expect(installing.queryByText(/left\.$/)).toBeNull();
  await steadied(pulling);
  expect(
    installing.queryByText("Checking which local software to download."),
  ).toBeNull();
  expect(
    installing.getByText("52.0 MB of 1.3 GB · 5 of 7 parts left"),
  ).toBeTruthy();
  // One bar for the bytes and the parts unpacking after them: the bytes most of it.
  const bar = installing.getByRole("progressbar");
  expect(bar.getAttribute("max")).toBe("1");
  expect(Number(bar.getAttribute("value"))).toBeCloseTo(
    0.8 * (52 / 1300) + 0.2 * (2 / 7),
    3,
  );
  // What it is doing and the time left from its speed, with the time so far beside the step.
  expect(installing.getByText(/^About \d+ minutes left\.$/)).toBeTruthy();
  expect(installing.getByText(/elapsed/)).toBeTruthy();
  expectPlain(view);
  expect(
    setupEvents().filter(
      (event) =>
        (event as { event: { kind: string } }).event.kind === "harness_chosen",
    ),
  ).toEqual([{ event: { kind: "harness_chosen", harness: "langgraph" } }]);
  // Once the engine answers, Intelligence sets itself up alongside the install, once.
  await waitFor(() =>
    expect(
      localCliCalls().filter((call) => call.command === "set_up_local_eval"),
    ).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ root: "/tmp/local-eval-install" }),
      }),
    ]),
  );
});

test("a signed-out first run signs in and accepts the agreement as its own step, before choosing an AI", async () => {
  setupRootConfiguration("/tmp/local-eval-account", async () =>
    emptyConfiguration(),
  );
  const browser = deferred<{ signedIn: boolean }>();
  withLocalCli({
    local_eval_terms: () => ({ ...ACCEPTED_TERMS, accepted: false }),
    // The CLI opens the browser and waits for the person to approve there.
    sign_in_to_copilotkit: () => browser.promise,
    copilotkit_sign_in_page: () => ({
      url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
      userCode: "WXYZ-2345",
    }),
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  // The first step. OpenBot needs no account, so it installs behind it, exactly once; nothing
  // of Intelligence's runs before the agreement. The browser sign-in starts without a click.
  await view.findByRole("heading", { name: "Self-contained OpenBot" });
  await view.findByText("Finish signing in to OpenBot in your browser…");
  expect(
    view.getByText(/Your conversations and files stay on this computer/),
  ).toBeTruthy();
  expect(stepLabel(view)).toBe("Account");
  await waitFor(() =>
    expect(installationCalls().map((call) => call.command)).toEqual([
      "prepare_installation",
    ]),
  );
  expect(localSequence()).toEqual([]);
  await act(async () => browser.resolve({ signedIn: true }));
  await view.findByRole("heading", { name: "Accept the license agreement" });
  expect(
    view.getByText(
      "To run OpenBot on this computer, accept the OpenBot by CopilotKit license agreement.",
    ),
  ).toBeTruthy();
  expect(
    view.getByRole("link", { name: "Read the license agreement" }),
  ).toBeTruthy();
  // The agreement's version and the organization are the log's, not the screen's.
  expect(document.body.textContent).not.toMatch(/developer-edition|Acme/);
  // Nothing licensed runs before Accept.
  expect(localSequence()).toEqual([]);
  await userEvent.click(view.getByRole("button", { name: "Accept" }));
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(stepLabel(view)).toBe("AI");
  expect(view.queryByText(/Sign in to finish setting up OpenBot/)).toBeNull();
  // Signed in, this installation's apps were connected before moving on.
  expect(
    invokeCalls
      .filter((call) => call.command === "connect_copilotkit_apps")
      .map((call) => call.args),
  ).toEqual([{ attempt: expect.any(String), root: "/tmp/local-eval-account" }]);
  // Leaving the account step does not install a second time.
  expect(
    installationCalls().filter(
      (call) => call.command === "prepare_installation",
    ),
  ).toHaveLength(1);
  await waitFor(() => expect(localSequence()).toContain("set_up_local_eval"));
  expect(
    invokeCalls.find((call) => call.command === "set_up_local_eval")?.args,
  ).toMatchObject({
    root: "/tmp/local-eval-account",
    acceptedEulaVersion: "developer-edition-2026-10-01-web",
  });
  expectPlain(view);
});

/**
 * A new Mac sat on "Checking your OpenBot account…" for the whole of Podman's install, and no
 * browser opened: the check ran the CLI's `onboard local-terms`, which checks the engine first. The
 * CLI's `login` needs no engine. So the sign-in starts the moment the step opens, and the engine is
 * waited for only after it, for the agreement.
 */
test("the account step opens the CopilotKit sign-in at once, without waiting for the engine Install is setting up", async () => {
  setupRootConfiguration("/tmp/local-eval-sign-in-first", async () =>
    emptyConfiguration(),
  );
  const browser = deferred<{ signedIn: boolean }>();
  withLocalCli({
    // Install is still putting Podman in: no engine answers, for as long as this test runs.
    prepare_installation: () => new Promise(() => {}),
    local_eval_terms: () => ({ status: "engine-not-ready" }),
    sign_in_to_copilotkit: () => browser.promise,
    copilotkit_sign_in_page: () => ({
      url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
      userCode: "WXYZ-2345",
    }),
  });
  const view = await renderApp();
  await installLocal(view);
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    detail: DOWNLOADING_SOFTWARE,
  });

  // The browser sign-in, first, with nothing asked of the engine before it. Under it, what is
  // installing meanwhile.
  await view.findByText("Finish signing in to OpenBot in your browser…");
  expect(view.getByText("WXYZ-2345")).toBeTruthy();
  expectBehind(view, 1, DOWNLOADING_SOFTWARE);
  const accountCalls = () =>
    invokeCalls
      .map((call) => call.command)
      .filter((command) =>
        ["sign_in_to_copilotkit", "local_eval_terms"].includes(command),
      );
  expect(accountCalls()).toEqual(["sign_in_to_copilotkit"]);

  // Signed in, the agreement waits for the engine, and the step says what it waits on.
  await act(async () => browser.resolve({ signedIn: true }));
  await view.findByRole("heading", { name: "Setting up this computer" });
  expect(
    view.getByText(
      "You're signed in. OpenBot is setting up the software it runs on. The license agreement comes next.",
    ),
  ).toBeTruthy();
  expectBehind(view, 1, DOWNLOADING_SOFTWARE);
  expect(accountCalls()[0]).toBe("sign_in_to_copilotkit");
  expect(accountCalls()).toContain("local_eval_terms");
});

// What Install says as it downloads the software OpenBot runs on, before macOS asks for the
// password, and after a prompt the person closed (`install::podman_downloading`,
// `podman_install_said`, `podman_declined`).
const DOWNLOADING_SOFTWARE = "Downloading the software OpenBot runs on.";
const PODMAN_PROMPTING =
  "Your Mac will ask for your password so OpenBot can install what it needs to run.";
const PODMAN_DECLINED =
  "OpenBot needs your password to install what it needs to run. It asks again in a moment, or choose Try again.";

/**
 * David's direction for 1.0.1: no Continue before macOS asks for the password. #1385 put one
 * there; an install step informs the person and moves forward. Install says what is coming and
 * why, and the prompt comes by itself (`install::install_with_password`). A prompt closed without a
 * password is said plainly, with Try again, and Install asks again by itself.
 */
test("macOS's password prompt is explained and comes without a click, and a closed one is asked again", async () => {
  setupRootConfiguration("/tmp/local-eval-podman-no-gate", async () =>
    emptyConfiguration(),
  );
  const browser = deferred<{ signedIn: boolean }>();
  withLocalCli({
    prepare_installation: () => new Promise(() => {}),
    local_eval_terms: () => ({ status: "engine-not-ready" }),
    sign_in_to_copilotkit: () => browser.promise,
    copilotkit_sign_in_page: () => null,
    allow_podman_install: () => true,
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByText("Checking your OpenBot account…");

  // Downloaded while the person signs in, then said before the prompt, with nothing to click.
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    detail: DOWNLOADING_SOFTWARE,
  });
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    elsewhere: true,
    detail: PODMAN_PROMPTING,
  });
  expectBehind(view, 1, PODMAN_PROMPTING);
  expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  await act(async () => browser.resolve({ signedIn: true }));
  await view.findByRole("heading", { name: "Setting up this computer" });
  expect(view.queryByRole("button", { name: "Continue" })).toBeNull();
  expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  const allowed = () =>
    invokeCalls.filter((call) => call.command === "allow_podman_install");
  expect(allowed()).toHaveLength(0);

  // The person closed the prompt: said plainly, not as a failure, with Try again.
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    asks: true,
    detail: PODMAN_DECLINED,
  });
  const card = await view.findByRole("region", {
    name: "Your password is needed",
  });
  expect(card.textContent).toContain(PODMAN_DECLINED);
  expect(view.queryByRole("alert")).toBeNull();
  await userEvent.click(view.getByRole("button", { name: "Try again" }));
  expect(allowed()).toHaveLength(1);

  // Asked again: the card goes, and the line before the prompt is back.
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    elsewhere: true,
    detail: PODMAN_PROMPTING,
  });
  expect(
    view.queryByRole("region", { name: "Your password is needed" }),
  ).toBeNull();
  expectBehind(view, 1, PODMAN_PROMPTING);
});

// What Install says on a Mac whose own Podman OpenBot can't use (`own_machine::PAUSE_OFFER`).
const PAUSE_OFFER =
  "Your Podman is set up in a way OpenBot can't use. OpenBot will use its own, and pause yours while OpenBot is running. Yours starts again when you quit OpenBot.";

/**
 * David's decision for 1.0.2: on a Mac, where Podman runs one machine at a time, OpenBot says it
 * needs its own and offers to pause the person's while it runs. Pausing theirs is their choice:
 * the card says so with one button, and nothing is paused until it is pressed. The password card is
 * not shown for it, and the background row says what it waits for.
 */
test("a Mac whose own Podman OpenBot can't use is offered a pause, and nothing is paused until the person says yes", async () => {
  setupRootConfiguration("/tmp/local-eval-pause-podman", async () =>
    emptyConfiguration(),
  );
  const browser = deferred<{ signedIn: boolean }>();
  withLocalCli({
    prepare_installation: () => new Promise(() => {}),
    local_eval_terms: () => ({ status: "engine-not-ready" }),
    sign_in_to_copilotkit: () => browser.promise,
    copilotkit_sign_in_page: () => null,
    allow_pause_podman: () => true,
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByText("Checking your OpenBot account…");
  await emitProgress({
    step: "pause-podman",
    ok: true,
    running: true,
    asks: true,
    detail: PAUSE_OFFER,
  });
  // Said before and after signing in, on whichever part of the step the person is on.
  const offered = () =>
    view.findByRole("region", { name: "OpenBot needs its own Podman" });
  expect((await offered()).textContent).toContain(PAUSE_OFFER);
  expectBehind(view, 1, "Waiting for you to pause your Podman.", {
    waiting: true,
  });
  await act(async () => browser.resolve({ signedIn: true }));
  await view.findByRole("heading", { name: "Setting up this computer" });
  const card = await offered();
  expect(card.textContent).toContain(PAUSE_OFFER);
  expect(
    view.queryByRole("region", { name: "Your password is needed" }),
  ).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  const paused = () =>
    invokeCalls.filter((call) => call.command === "allow_pause_podman");
  expect(paused()).toHaveLength(0);

  await userEvent.click(view.getByRole("button", { name: "Pause my Podman" }));
  expect(paused()).toHaveLength(1);

  // Paused: the card goes, and the row says so.
  await emitProgress({
    step: "pause-podman",
    ok: true,
    running: false,
    detail: "Your Podman is paused while OpenBot runs.",
  });
  expect(
    view.queryByRole("region", { name: "OpenBot needs its own Podman" }),
  ).toBeNull();
});

test("the account step waits for a container engine Install is still setting up, rather than failing", async () => {
  // A new Windows computer installs Podman while the person signs in, and until an engine answers
  // the CLI says nothing about the account ("engine-not-ready"). That was shown as "Couldn't check
  // your CopilotKit account", and Try again failed the same way until Podman was up.
  setupRootConfiguration("/tmp/local-eval-engine-wait", async () =>
    emptyConfiguration(),
  );
  let asked = 0;
  withLocalCli({
    local_eval_terms: () => {
      asked += 1;
      return asked === 1
        ? { status: "engine-not-ready" }
        : { status: "signed-out" };
    },
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole(
    "button",
    { name: "Sign in for a free local license key" },
    { timeout: 6000 },
  );
  expect(asked).toBe(2);
  expect(view.queryByText(/Couldn.t check your OpenBot account/)).toBeNull();
}, 15000);

/*
 * A live Windows run: the install behind the account step updated the person's Podman, and its
 * machine stopped answering. The step showed the failure with nothing to press, and once signed in
 * it said "Preparing this computer…" under it forever, waiting for an engine nothing was bringing
 * up. Try again runs the install again, its engine check and its restart included.
 */
test("an install that failed behind the account step offers Try again, which runs it again", async () => {
  setupRootConfiguration("/tmp/account-install-retry", async () =>
    emptyConfiguration(),
  );
  let preparation = deferred<void>();
  let engineAnswers = false;
  withLocalCli({
    prepare_installation: () => preparation.promise,
    local_eval_terms: () =>
      engineAnswers ? ACCEPTED_TERMS : { status: "engine-not-ready" },
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Setting up this computer" });

  await act(async () =>
    preparation.reject({
      said: "OpenBot updated Podman, but Podman isn't answering. Try again.",
      detail:
        "npipe:////./pipe/podman-machine-default: The system cannot find the file specified. (os error 2)",
    }),
  );
  const card = await view.findByRole("alert");
  expect(card.textContent).toContain("Podman isn't answering");
  // Nothing says the engine is still coming while the install that brings it has stopped.
  expect(view.queryByText("Preparing this computer…")).toBeNull();
  expect(
    installationCalls().filter(
      (call) => call.command === "prepare_installation",
    ),
  ).toHaveLength(1);

  preparation = deferred<void>();
  await userEvent.click(
    within(card).getByRole("button", { name: "Try again" }),
  );
  expect(
    installationCalls().filter(
      (call) => call.command === "prepare_installation",
    ),
  ).toHaveLength(2);
  expect(view.queryByRole("alert")).toBeNull();

  // This time the engine answers, and setup goes on from the account step by itself.
  engineAnswers = true;
  await act(async () => preparation.resolve());
  await view.findByRole(
    "heading",
    { name: "Connect your AI" },
    { timeout: 6000 },
  );
}, 15000);

/**
 * What `local_eval_terms` answered on a Windows tester's Docker Desktop 4.31.1, whose engine
 * (26.1.4) reports its OperatingSystem as "Docker Desktop (containerized)": the CLI's sentence, in
 * the shape `local_eval.rs` gives the window (as `local-eval-terms-orbstack.json`).
 */
const OLD_DOCKER_DESKTOP_REFUSED = {
  status: "blocked",
  reason: "unsupported-engine",
  said: "Docker Desktop or rootful Podman is required on Windows. This machine runs Docker Desktop (containerized).",
  switchEngine: true,
};
const DOCKER_UPDATING =
  "The Docker Desktop on this computer is too old for OpenBot, so OpenBot is updating it. About 9 minutes left.";

/*
 * The same tester: the account's licence check ran while Install was updating that Docker Desktop,
 * and the step said "Switch to Docker Desktop or Podman" on a computer running Docker Desktop.
 * Under it the update's failure card had a second Try again. Until Install has the engine new
 * enough, a refusal of it waits for Install, and the step says what Install is doing.
 */
test("an old engine refused while Install updates it shows the update, and one Try again", async () => {
  setupRootConfiguration("/tmp/account-old-docker", async () =>
    emptyConfiguration(),
  );
  let preparation = deferred<void>();
  let updated = false;
  withLocalCli({
    prepare_installation: () => preparation.promise,
    local_eval_terms: () =>
      updated ? ACCEPTED_TERMS : OLD_DOCKER_DESKTOP_REFUSED,
  });
  const view = await renderApp();
  await installLocal(view);
  await emitProgress({
    step: "engine",
    ok: true,
    running: true,
    updating: true,
    detail: DOCKER_UPDATING,
  });
  await view.findByRole("heading", { name: "Setting up this computer" });
  const askedBeforeTheUpdate = invokeCalls.filter(
    (call) => call.command === "local_eval_terms",
  ).length;
  expectBehind(view, 1, DOCKER_UPDATING);
  expect(
    view.queryByRole("heading", { name: "Switch to Docker Desktop or Podman" }),
  ).toBeNull();
  expect(view.queryByText("docker context use desktop-linux")).toBeNull();
  // Not asked at all while the update runs: the old engine would only refuse it. On the tester's
  // computer it answered "(containerized)" fourteen times in forty seconds.
  await act(async () => new Promise((settle) => setTimeout(settle, 2500)));
  expect(askedBeforeTheUpdate).toBeLessThanOrEqual(1);
  expect(
    invokeCalls.filter((call) => call.command === "local_eval_terms"),
  ).toHaveLength(askedBeforeTheUpdate);
  expect(
    view.queryByRole("heading", { name: "Switch to Docker Desktop or Podman" }),
  ).toBeNull();

  // The update stops: one card, one Try again, which runs the install and the check again.
  await act(async () =>
    preparation.reject({
      said: "The Docker update OpenBot downloaded could not be checked, so it has not been run. Try again.",
    }),
  );
  await view.findByRole("alert");
  expect(view.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
  expect(
    view.queryByRole("heading", { name: "Switch to Docker Desktop or Podman" }),
  ).toBeNull();
  preparation = deferred<void>();
  await userEvent.click(view.getByRole("button", { name: "Try again" }));
  expect(
    installationCalls().filter(
      (call) => call.command === "prepare_installation",
    ),
  ).toHaveLength(2);

  // Updated this time: Docker Desktop 4.98 is not "containerized", and the account goes on.
  updated = true;
  await emitProgress({
    step: "engine",
    ok: true,
    running: false,
    detail: "OpenBot updated Docker.",
  });
  await act(async () => preparation.resolve());
  await view.findByRole(
    "heading",
    { name: "Connect your AI" },
    { timeout: 6000 },
  );
}, 20000);

// What the native side says as it opens Docker Desktop: `docker_desktop::HAND_OFF`.
const DOCKER_HAND_OFF =
  "Docker Desktop is starting in its own window. If it asks you to accept its terms or sign in, do that there. OpenBot comes back when Docker is ready.";

function broughtToFront() {
  return invokeCalls.filter((call) => call.command === "bring_setup_to_front");
}

test("the account step says Docker Desktop is starting while Install waits on it, until Docker answers", async () => {
  // Dogfooding 0.3.3: Install opened Docker Desktop, whose window came to the front. OpenBot's,
  // behind it on the account step, said only "Checking your OpenBot account…" for minutes.
  setupRootConfiguration("/tmp/hand-off-docker", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    prepare_installation: () => new Promise(() => {}),
    // The account check waits on the engine Install is bringing up.
    local_eval_terms: () => ({ status: "engine-not-ready" }),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Setting up this computer" });

  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    elsewhere: true,
    detail: DOCKER_HAND_OFF,
  });
  expectBehind(view, 1, DOCKER_HAND_OFF);
  // One line, saying what the wait is for.
  expect(view.queryByText("Checking your OpenBot account…")).toBeNull();
  expect(view.getAllByText(DOCKER_HAND_OFF)).toHaveLength(1);

  // Docker answers: the line goes. Until the account check hears the engine, the step says what
  // Install is doing, as Install's own row does.
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: false,
    detail: "Docker Desktop is running.",
  });
  expect(view.queryByText(DOCKER_HAND_OFF)).toBeNull();
  expectBehind(view, 1, "Checking the software OpenBot needs.");
});

/**
 * The line about the install behind the account step stays whatever the step shows: signing in,
 * waiting for the engine, the agreement. A person on any of them knows OpenBot is still installing.
 */
test("the install behind the account step is said on every part of it, signing in included", async () => {
  setupRootConfiguration("/tmp/hand-off-none", async () =>
    emptyConfiguration(),
  );
  let engineAnswers = false;
  withLocalCli({
    prepare_installation: () => new Promise(() => {}),
    local_eval_terms: () =>
      engineAnswers ? { status: "signed-out" } : { status: "engine-not-ready" },
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Setting up this computer" });
  await emitProgress({
    step: "install-engine",
    ok: true,
    running: true,
    detail: "Installing the software OpenBot runs on.",
  });
  // What the account check waits on, in Install's own words, said once.
  expectBehind(view, 1, "Installing the software OpenBot runs on.");
  expect(view.queryByText("Checking your OpenBot account…")).toBeNull();
  expect(view.queryAllByRole("status")).toHaveLength(0);

  // Signed out, the step is about signing in, and the install behind it is still said.
  engineAnswers = true;
  await view.findByRole(
    "button",
    { name: "Sign in for a free local license key" },
    { timeout: 5000 },
  );
  expectBehind(view, 1, "Installing the software OpenBot runs on.");
}, 15000);

/*
 * A tester waited minutes on the first setup step and could not tell whether it was stuck: the
 * screen read "Preparing the engine machine", "Installing Podman", "Waiting for the back end",
 * "Updating the back end to 0.16.0-rc.10". The product's rule: the log keeps the technical parts,
 * and the screen says what OpenBot is doing in plain words.
 *
 * These walk setup as a person meets it, with the native side's lines word for word as it sends
 * them, and read every screen. The log side is `install::tests::every_line_shown_while_preparing_
 * this_computer_is_plain_and_the_log_keeps_the_detail`: each of these lines is logged with the
 * technical words beside it, and the back end's releases by `log_update_due`.
 */

/** Words a person setting OpenBot up doesn't know, the back end's versions, and CopilotKit alone. */
const TECHNICAL = [
  /Podman/i,
  /\bWSL\b/,
  /Windows Subsystem for Linux/i,
  /engine machine/i,
  /\bengine\b/i,
  /\bk3[sd]\b/i,
  /\bHelm\b/,
  /\bkubectl\b/i,
  /\bback ?end\b/i,
  /Intelligence/,
  /\bCLI\b/,
  /\bCompose\b/,
  /0\.16\.0/,
  // The company alone. It is named only as OpenBot by CopilotKit, which the Account step's header
  // reads as "OpenBot™by CopilotKit" here: two spans, set apart by the stylesheet, the first with
  // its trademark sign.
  /(?<!OpenBot™?\s*by\s+)CopilotKit/,
];

/** The native side's lines while it prepares this computer (`engine.rs`, `install.rs`). */
const NATIVE = {
  checking: "Checking the software OpenBot needs.",
  looking: "Looking for the software OpenBot runs on.",
  downloading: DOWNLOADING_SOFTWARE,
  declined: PODMAN_DECLINED,
  prompting: PODMAN_PROMPTING,
  installingWindows: "Installing the software OpenBot runs on.",
  // The row of a finished install keeps Install's own words: never shown, and checked here.
  installed: "Podman 5.6.2 and Compose 2.40.3 installed.",
  preparingMac:
    "Preparing this computer to run OpenBot. This takes a few minutes the first time.",
  preparingWindows:
    "Preparing this computer to run OpenBot. If a window asks to install a Windows feature OpenBot needs, allow it. Windows then asks for your approval and a restart.",
  starting: "Starting the software OpenBot runs on.",
  answering: "Checking that the software OpenBot runs on is ready.",
  ready: "The software OpenBot runs on is ready.",
  version: "Checking which version of OpenBot to download.",
  images: "Checking which local software to download.",
};

type Beat = { beat: string; text: string; behind: string | null };

/** The background install's row as a person reads it, less its ticking time: status | line. */
function behindNow(view: ReturnType<typeof render>): string | null {
  const row = view.queryByRole("listitem", {
    name: "Installing OpenBot in the background",
  });
  if (!row) return null;
  const status = row
    .querySelector(".step-status")
    ?.textContent?.replace(/ · [\dms ]+ elapsed$/, "");
  return `${status} | ${row.querySelector(".detail")?.textContent ?? ""}`;
}

function technicalOn(beats: Beat[]) {
  return beats.flatMap(({ beat, text }) =>
    TECHNICAL.filter((word) => word.test(text)).map(
      (word) => `${beat}: ${text.match(word)?.[0]}`,
    ),
  );
}

/** What each part of a first run said, from the first screen to OpenBot opening. */
async function walkFirstRun(platform: "macOS" | "Windows"): Promise<Beat[]> {
  setupRootConfiguration(`/tmp/plain-walk-${platform}`, async () =>
    emptyConfiguration(),
  );
  const preparation = deferred<void>();
  const browser = deferred<{ signedIn: boolean }>();
  const setUp = deferred<unknown>();
  let engineAnswers = false;
  withLocalCli({
    prepare_installation: () => preparation.promise,
    sign_in_to_copilotkit: () => browser.promise,
    copilotkit_sign_in_page: () => ({
      url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
      userCode: "WXYZ-2345",
    }),
    local_eval_terms: () =>
      engineAnswers
        ? { ...ACCEPTED_TERMS, accepted: false }
        : { status: "engine-not-ready" },
    allow_podman_install: () => true,
    set_up_local_eval: () => setUp.promise,
    local_eval_download: () => ({ done: 400_000_000, total: 1_600_000_000 }),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const beats: Beat[] = [];
  const view = await renderApp();
  const seen = (beat: string) =>
    beats.push({
      beat,
      text: view.container.textContent ?? "",
      behind: behindNow(view),
    });
  const running = (step: string, detail: string, more = {}) =>
    emitProgress({ step, ok: true, running: true, detail, ...more });
  const done = (step: string, detail: string) =>
    emitProgress({ step, ok: true, running: false, detail });
  seen("welcome");

  await installLocal(view);
  await view.findByText("Finish signing in to OpenBot in your browser…");
  seen("signing in");
  await running("install-engine", NATIVE.looking);
  seen("signing in, looking");
  await running("install-engine", NATIVE.downloading);
  seen("signing in, downloading");
  if (platform === "macOS") {
    // Said before macOS asks for the password, with nothing to click, then asked.
    await running("install-engine", NATIVE.prompting, { elsewhere: true });
    seen("signing in, before the password prompt");
    await act(async () => browser.resolve({ signedIn: true }));
    await view.findByRole("heading", { name: "Setting up this computer" });
    seen("password prompt");
    // Closed without a password: said, with Try again, and asked again.
    await running("install-engine", NATIVE.declined, { asks: true });
    seen("password prompt closed");
    await running("install-engine", NATIVE.prompting, { elsewhere: true });
  } else {
    await running("install-engine", NATIVE.installingWindows);
    seen("signing in, installing");
    await act(async () => browser.resolve({ signedIn: true }));
  }
  await done("install-engine", NATIVE.installed);
  await running(
    "create-machine",
    platform === "macOS" ? NATIVE.preparingMac : NATIVE.preparingWindows,
    { elsewhere: platform === "Windows" },
  );
  seen("preparing this computer");
  await done("create-machine", "openbot created.");
  await running("start-machine", NATIVE.starting);
  seen("starting the software");
  await done("start-machine", "openbot started.");
  await running("health-gate", NATIVE.answering);
  seen("checking the software");
  await done("health-gate", "The engine answers.");
  await done("engine", NATIVE.ready);
  engineAnswers = true;
  await running("deployment", NATIVE.version);
  seen("checking the version");
  await done("deployment", "v0.3.4 in /tmp/plain-walk");
  await running("images", NATIVE.images);
  seen("checking what to download");
  const downloading: ProgressEvent = {
    step: "images",
    ok: true,
    running: true,
    detail: "Downloading local software.",
    downloadBytes: 1_200_000_000,
    downloads: {
      done: 1,
      total: 5,
      bytes: 1_200_000_000,
      size: 3_400_000_000,
      bytesPerSecond: 9_000_000,
    },
  };
  await emitProgress(downloading);
  await steadied(downloading);
  seen("downloading");

  // The agreement, once the software it is checked on answers.
  await view.findByRole("button", { name: "Accept" }, { timeout: 5000 });
  seen("agreement");
  await userEvent.click(view.getByRole("button", { name: "Accept" }));
  await view.findByRole("heading", { name: "Installing OpenBot" });
  const installing: ProgressEvent = {
    step: "images",
    ok: true,
    running: true,
    detail: "Downloading local software.",
    downloadBytes: 3_000_000_000,
    downloads: {
      done: 4,
      total: 5,
      bytes: 3_000_000_000,
      size: 3_400_000_000,
      bytesPerSecond: 9_000_000,
    },
  };
  await emitProgress(installing);
  await steadied(installing);
  seen("install");

  await act(async () => preparation.resolve());
  await view.findByRole("heading", { name: "Connect your AI" });
  await waitFor(() => expect(localSequence()).toContain("set_up_local_eval"));
  await waitFor(
    () => expect(view.container.textContent).toContain("of 1.6 GB"),
    { timeout: 3000 },
  );
  seen("AI, downloading the rest");
  await act(async () => setUp.resolve(localStatus("starting", "valid")));
  await waitFor(() => expect(localSequence()).toContain("run_local_eval"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  seen("AI, installed");

  await chooseOpenAi(view);
  await expectHandover();
  seen("start");
  return beats;
}

for (const platform of ["macOS", "Windows"] as const) {
  test(`a first run on ${platform} says every line in plain words, and what is installing behind every screen`, async () => {
    const beats = await walkFirstRun(platform);

    // No technical word on any screen, at any point.
    expect(technicalOn(beats)).toEqual([]);

    // Behind the account and AI steps: one line, in plain words, saying what is installing and
    // how far along it is. It changes as the install moves on.
    const behind = Object.fromEntries(
      beats.map(({ beat, behind }) => [beat, behind]),
    );
    const mac = platform === "macOS";
    expect(behind).toEqual({
      welcome: null,
      "signing in": `Step 1 of 4 | ${NATIVE.checking}`,
      "signing in, looking": `Step 1 of 4 | ${NATIVE.looking}`,
      "signing in, downloading": `Step 1 of 4 | ${NATIVE.downloading}`,
      ...(mac
        ? {
            "signing in, before the password prompt": `Step 1 of 4 | ${NATIVE.prompting}`,
            "password prompt": `Step 1 of 4 | ${NATIVE.prompting}`,
            "password prompt closed":
              "Step 1 of 4 · Waiting for you | Waiting for your password.",
            "preparing this computer": `Step 1 of 4 | ${NATIVE.preparingMac}`,
          }
        : {
            "signing in, installing": `Step 1 of 4 | ${NATIVE.installingWindows}`,
            "preparing this computer": `Step 1 of 4 | ${NATIVE.preparingWindows}`,
          }),
      "starting the software": `Step 1 of 4 | ${NATIVE.starting}`,
      "checking the software": `Step 1 of 4 | ${NATIVE.answering}`,
      "checking the version": `Step 2 of 4 | ${NATIVE.version}`,
      "checking what to download": `Step 2 of 4 | ${NATIVE.images}`,
      downloading: "Step 2 of 4 | Downloading OpenBot. About 4 minutes left.",
      agreement: "Step 2 of 4 | Downloading OpenBot. About 4 minutes left.",
      // The install is the screen itself here: its own rows say it.
      install: null,
      "AI, downloading the rest":
        "Step 3 of 4 | Downloading the rest of OpenBot.",
      "AI, installed": null,
      start: null,
    });
    // Once everything is installed, the AI step says so, and what comes next.
    const installed = beats.find(({ beat }) => beat === "AI, installed");
    expect(installed?.text).toContain(
      "OpenBot is installedCompleteOpenBot starts as soon as you connect your AI.",
    );
    // The Install step's own rows say how far along, the time so far and the time left. Its row
    // is not named as the heading above it is: on Windows F both said "Installing OpenBot".
    const install = beats.find(({ beat }) => beat === "install");
    expect(install?.text).toMatch(
      /Downloading OpenBotStep 2 of 4 · \d+s elapsedLess than a minute left\./,
    );
    expect(install?.text).not.toContain("Installing OpenBotStep");
  });
}

/**
 * Every day: a start after a restart wakes the software OpenBot runs on, and a start after an app
 * update updates what runs behind OpenBot. "Waiting for the back end" and "Updating the back end to
 * 0.16.0-rc.9" are now "Getting OpenBot ready" and "Updating OpenBot", with how far along.
 */
test("a start that wakes the computer's software and updates OpenBot says it in plain words", async () => {
  const after = pinnedCli.updateDidNotFinish;
  const before = {
    ...after,
    readiness: "ready",
    stack: {
      ...after.stack,
      step: "ready",
      hasFailedStep: false,
      updateInProgress: false,
      unfinishedUpdate: null,
    },
  };
  setupConnectedLocalStack("/tmp/plain-walk-start", before);
  const wake = deferred<unknown>();
  const update = deferred<unknown>();
  let asked = 0;
  let downloading = false;
  withLocalCli({
    wake_engine: () => wake.promise,
    local_eval_download: () =>
      downloading ? { done: 300_000_000, total: 900_000_000 } : null,
    run_local_eval: (args: { action: string }) => {
      if (args.action === "update") return update.promise;
      asked += 1;
      return asked === 1 ? before : after;
    },
  });
  const beats: Beat[] = [];
  const view = await renderApp();
  const seen = (beat: string) =>
    beats.push({
      beat,
      text: view.container.textContent ?? "",
      behind: behindNow(view),
    });
  await view.findByRole("heading", { name: "Starting OpenBot" });
  await emitProgress({
    step: "start-machine",
    ok: true,
    running: true,
    detail: NATIVE.starting,
  });
  seen("waking the software");
  await emitProgress({
    step: "start-machine",
    ok: true,
    running: false,
    detail: "openbot started.",
  });
  await act(async () => wake.resolve(null));
  await waitFor(() => expect(localActions()).toContain("update"));
  seen("updating");
  downloading = true;
  await waitFor(
    () => expect(view.container.textContent).toContain("of 900.0 MB"),
    { timeout: 3000 },
  );
  seen("downloading the update");
  await act(async () => update.resolve(updateFailed));
  await view.findByRole("heading", { name: "OpenBot is running" });
  seen("running on the version it had");

  // No technical word, and no version of what runs behind OpenBot, at any point.
  expect(technicalOn(beats)).toEqual([]);

  // What each part said instead: the row that waits says how far along, and what it is doing.
  const said = Object.fromEntries(beats.map(({ beat, text }) => [beat, text]));
  // One journey over the whole Start: what is happening now, the time left, then the rows.
  expect(said["waking the software"]).toContain(
    "Starting the software OpenBot runs onAbout a minute left · 0s so far",
  );
  expect(said["waking the software"]).toContain(
    "Getting OpenBot readyStep 3 of 4",
  );
  expect(said.updating).toContain(
    "Getting the update readyAbout 2 minutes left",
  );
  expect(said.updating).toContain(
    "Getting OpenBot readyStep 3 of 4Updating OpenBot. Your Bots and data stay as they are.",
  );
  // The download is the journey's: what is happening, and its measure beside the time left. The row
  // keeps what this part is, and has no measure of its own.
  expect(said["downloading the update"]).toMatch(
    /Downloading the update(About \d+ minutes|About a minute|Less than a minute) left · 300\.0 MB of 900\.0 MB · \d+s so far/,
  );
  expect(said["downloading the update"].match(/MB of/g)).toHaveLength(1);
  expect(said["downloading the update"]).toContain(
    "Getting OpenBot readyStep 3 of 4Updating OpenBot. Your Bots and data stay as they are.",
  );
  expect(said["running on the version it had"]).toContain(KEPT_RELEASE);
});

/*
 * When setup stops: every failure screen says what happened and what to do, in plain words. The
 * engine's output and the CLI's words are behind "Technical details" and in the logs a person
 * copies, never the headline. A product is named only where the person acts in it: Docker Desktop,
 * a Podman command they run.
 */

/** A failure's headline as the native side now sends it (`acquire.rs`, `problem.rs`). */
const NATIVE_FAILURE = {
  machine: "OpenBot couldn't prepare this computer to run it. Try again.",
  unreachable:
    "OpenBot can't reach the software it runs on. If you use Docker Desktop, open it and wait for it to start. Then try again.",
  lastQuit:
    "When OpenBot last quit, some of its services didn't stop. They may still be running. Stopping OpenBot again asks them to stop.",
};

/** What a person reads on a failure screen: not the technical details or the logs' own controls. */
function readable(view: ReturnType<typeof render>): string {
  const copy = view.container.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll(".detail-of, .troubleshooting"))
    hidden.remove();
  return copy.textContent ?? "";
}

/** Where the person acts in Podman: switching to it, or a command they run in it. */
const ACTS_IN_PODMAN =
  /Docker Desktop or Podman|To use Podman instead|start Podman|Stop your Podman machine|run podman machine set(?: --[a-z-]+(?: \d+)?)+|your Podman machine/g;

const FAILURE_TECHNICAL = [
  ...TECHNICAL,
  /\bcontainers?\b/i,
  /\brootful\b/i,
  /\bcluster\b/i,
];

function failureTechnical(beats: Beat[]) {
  return beats.flatMap(({ beat, text }) => {
    const left = text.replace(ACTS_IN_PODMAN, "");
    return FAILURE_TECHNICAL.filter((word) => word.test(left)).map(
      (word) => `${beat}: ${left.match(word)?.[0]}`,
    );
  });
}

/** The AI step with setup stopped behind it, on `answer` from the CLI's setup. */
async function stoppedBehindAi(answer: () => unknown): Promise<string> {
  setupRootConfiguration("/tmp/plain-failure", async () =>
    emptyConfiguration(),
  );
  withLocalCli({ set_up_local_eval: answer });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  await view.findByRole("alert", undefined, { timeout: 3000 });
  const text = readable(view);
  cleanup();
  invokeCalls = [];
  return text;
}

test("every failure screen says what happened and what to do, in plain words", async () => {
  const beats: Beat[] = [];
  const seen = (beat: string, text: string) =>
    beats.push({ beat, text, behind: null });
  const blocked =
    (reason: string, more: Record<string, unknown> = {}) =>
    () => ({
      ...localStatus("unknown", "unknown"),
      outcome: "blocked",
      stack: null,
      reason,
      ...more,
    });

  // Setup stopping behind the AI step, for what stops it most.
  for (const reason of [
    "docker-unavailable",
    "port-unavailable",
    "local-command-failed",
    "local-command-busy",
    "unsupported-engine",
    "confirmation-required",
  ])
    seen(`AI step, ${reason}`, await stoppedBehindAi(blocked(reason)));
  seen(
    "AI step, out of disk on Windows",
    await stoppedBehindAi(
      blocked("resources-short", {
        shortfall: {
          podman: true,
          cpu: false,
          memory: false,
          disk: true,
          diskGb: "30",
          wsl: true,
          drive: "C:",
        },
      }),
    ),
  );
  seen(
    "AI step, short of memory in Podman",
    await stoppedBehindAi(
      blocked("resources-short", {
        shortfall: { podman: true, cpu: false, memory: true, disk: false },
      }),
    ),
  );
  for (const category of ["timeout", "unexpected-exit", "unverified", "spawn"])
    seen(
      `AI step, ${category}`,
      await stoppedBehindAi(() => {
        throw category;
      }),
    );

  // The account step, refused the software this computer runs things on.
  {
    setupRootConfiguration("/tmp/plain-refused", async () =>
      emptyConfiguration(),
    );
    withLocalCli({
      local_eval_terms: () => ({
        status: "blocked",
        reason: "unsupported-engine",
        switchEngine: true,
        said: "Docker Desktop or rootful Podman is required on macOS. This machine runs OrbStack.",
      }),
    });
    const view = await renderApp();
    await installLocal(view);
    // OrbStack's Docker answers and is new enough: Install has settled the engine, so a refusal
    // of it is the person's to act on (until then the step waits for Install).
    await emitProgress({
      step: "engine",
      ok: true,
      running: false,
      detail: "Docker is answering.",
    });
    await view.findByRole(
      "heading",
      { name: "Switch to Docker Desktop or Podman" },
      { timeout: 6000 },
    );
    seen("account, refused", readable(view));
    cleanup();
    invokeCalls = [];
  }

  // Install failing while it prepares this computer, with the engine's own words behind it.
  {
    const { view, preparation } = await beginPendingInstallation();
    await act(async () =>
      preparation.reject({
        said: NATIVE_FAILURE.machine,
        detail: "Error: podman machine init openbot: exit status 125",
      }),
    );
    await view.findByRole("button", { name: "Retry installation" });
    seen("install, failed", readable(view));
    expect(view.container.textContent).toContain("exit status 125");
    cleanup();
    invokeCalls = [];
  }

  // Start failing, and the notice a start shows after a quit that left something running.
  {
    setupConnectedLocalStack(
      "/tmp/plain-start-failed",
      localStatus("ready", "valid"),
    );
    const previous = invokeHandler;
    invokeHandler = async (command, args) => {
      if (command === "start_stack")
        throw {
          said: NATIVE_FAILURE.unreachable,
          detail: "dial unix /var/run/docker.sock: connect: connection refused",
        };
      if (command === "last_local_eval_stop_failure")
        return {
          said: NATIVE_FAILURE.lastQuit,
          detail: "the backend stack did not stop when OpenBot last quit",
        };
      return previous(command, args);
    };
    const view = await renderApp();
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "can't reach the software it runs on",
      ),
    );
    seen("start, failed", readable(view));
  }

  expect(failureTechnical(beats)).toEqual([]);
  // Each says what to do: retry, a setting, a command, or who to ask.
  for (const { beat, text } of beats)
    expect({
      beat,
      next: /Retry|Try again|try again|Repair|Start OpenBot|Free up|Quit|Open Docker Desktop|Stop your Podman machine|Wait|update|copy the logs|Copy the logs/.test(
        text,
      ),
    }).toEqual({ beat, next: true });
});

test("a finished install brings the window to the front for the next step", async () => {
  const { view, preparation } = await beginPendingInstallation();
  // Nothing is the person's while it installs: the window stays where they left it.
  expect(broughtToFront()).toHaveLength(0);
  await act(async () => preparation.resolve());
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(broughtToFront()).toHaveLength(1);
});

test("a failed install brings the window to the front with its failure", async () => {
  const { view, preparation } = await beginPendingInstallation();
  expect(broughtToFront()).toHaveLength(0);
  await act(async () =>
    preparation.reject({ said: "The download was interrupted." }),
  );
  await view.findByRole("button", { name: "Retry installation" });
  expect(broughtToFront()).toHaveLength(1);
});

const APPS_UNAVAILABLE = {
  said: "OpenBot couldn't connect your apps. Check your connection, then choose Connect apps. If it keeps happening, ask an admin.",
};

test("apps that could not be connected at sign-in say so, and Connect apps tries again", async () => {
  setupRootConfiguration("/tmp/local-eval-apps-retry", async () =>
    emptyConfiguration(),
  );
  let attempts = 0;
  withLocalCli({
    connect_copilotkit_apps: () => {
      attempts += 1;
      if (attempts === 1) throw APPS_UNAVAILABLE;
      return null;
    },
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByText(APPS_UNAVAILABLE.said);
  expect(stepLabel(view)).toBe("Account");
  expect(view.getByRole("heading", { name: "Connect your apps" })).toBeTruthy();
  expect(
    view.getByText(
      "You can continue without them. OpenBot tries again each time it starts.",
    ),
  ).toBeTruthy();
  // Intelligence waits for the account step, and nothing of the key reaches the window.
  expect(localSequence()).toEqual([]);
  await userEvent.click(view.getByRole("button", { name: "Connect apps" }));
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(attempts).toBe(2);
  await waitFor(() => expect(localSequence()).toContain("set_up_local_eval"));
  expectPlain(view);
});

test("Continue goes on without apps when they could not be connected", async () => {
  setupRootConfiguration("/tmp/local-eval-apps-skip", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    connect_copilotkit_apps: () => {
      throw APPS_UNAVAILABLE;
    },
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByText(APPS_UNAVAILABLE.said);
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await view.findByRole("heading", { name: "Connect your AI" });
  await waitFor(() => expect(localSequence()).toContain("set_up_local_eval"));
  expect(
    invokeCalls.find((call) => call.command === "set_up_local_eval")?.args,
  ).toMatchObject({ acceptedEulaVersion: null });
});

test("a first run already signed in with the agreement accepted passes the account step by itself", async () => {
  setupRootConfiguration("/tmp/local-eval-account-done", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  // The CLI's sign-in answered at once from the sign-in it had: asked once, and nothing clicked.
  expect(
    invokeCalls.filter((call) => call.command === "sign_in_to_copilotkit"),
  ).toHaveLength(1);
  await waitFor(() => expect(localSequence()).toContain("set_up_local_eval"));
  expect(
    invokeCalls.find((call) => call.command === "set_up_local_eval")?.args,
  ).toMatchObject({ acceptedEulaVersion: null });
});

test("the local sequence starts when installation completes and survives the provider screen", async () => {
  setupRootConfiguration("/tmp/local-eval-overlap", async () =>
    emptyConfiguration(),
  );
  const preparation = deferred<void>();
  const setUp = deferred<unknown>();
  withLocalCli({
    prepare_installation: () => preparation.promise,
    set_up_local_eval: () => setUp.promise,
    connect_local_eval: () => new Promise(() => {}),
  });
  const view = await renderApp();
  await installLocal(view);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(localCliCalls()).toEqual([]);
  await act(async () => preparation.resolve());
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(stepLabel(view)).toBe("AI");
  await waitFor(() => expect(localSequence()).toEqual(["set_up_local_eval"]));
  expect(
    invokeCalls.find((call) => call.command === "set_up_local_eval")?.args,
  ).toMatchObject({ root: "/tmp/local-eval-overlap" });
  // Working behind this screen is said on one row, how far along included. Its own rows wait for
  // their step.
  expectBehind(
    view,
    3,
    "Setting up OpenBot on this computer. This takes a few minutes the first time.",
  );
  expect(
    view.queryByRole("listitem", { name: "Setting up OpenBot" }),
  ).toBeNull();
  expect(view.queryByRole("alert", { name: "Setup" })).toBeNull();
  // A local first run has nothing behind this screen to go back to.
  expect(view.queryByRole("button", { name: "Back" })).toBeNull();
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await act(async () => setUp.resolve(localStatus("starting", "valid")));
  await waitFor(() =>
    expect(localSequence()).toEqual([
      "set_up_local_eval",
      "connect_local_eval",
    ]),
  );
  expect(view.queryByText(/Connecting OpenBot/)).toBeNull();
  expectBehind(
    view,
    3,
    "Setting up OpenBot on this computer. This takes a few minutes the first time.",
  );
  expect(invokeCalls.some((call) => call.command === "cancel_local_eval")).toBe(
    false,
  );
  expectPlain(view);
});

test("Continue during setup shows Finishing setup, which starts and opens OpenBot by itself", async () => {
  setupRootConfiguration("/tmp/local-eval-auto", async () =>
    emptyConfiguration(),
  );
  const setUp = deferred<unknown>();
  withLocalCli({
    set_up_local_eval: () => setUp.promise,
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await view.findByRole("heading", { name: "Finishing setup" });
  expect(stepLabel(view)).toBe("Start");
  const row = view.getByRole("listitem", { name: "Setting up OpenBot" });
  expect(row.textContent).toContain("Step 1 of 4");
  expectPlain(view);
  await act(async () => setUp.resolve(localStatus("starting", "valid")));
  await expectHandover();
  expect(localSequence()).toEqual([
    "set_up_local_eval",
    "connect_local_eval",
    "run_local_eval",
    "start_stack",
    "show_openbot",
  ]);
  expect(
    invokeCalls.find((call) => call.command === "run_local_eval")?.args,
  ).toMatchObject({ action: "status", stack: "local-abc123" });
  // The local stack's own addresses, and no key from the window: Start takes the vaulted one.
  expect(getStartStackPayload()).toMatchObject({
    root: "/tmp/local-eval-auto",
    ...LOCAL_ADDRESSES,
  });
  expect(getStartStackPayload()).not.toHaveProperty("apiKey");
  expect(getStartStackPayload()).not.toHaveProperty("organizationAuthUrl");
  expectPlain(view);
  expect(
    invokeCalls.filter((call) => call.command === "start_stack"),
  ).toHaveLength(1);
});

function intelligenceCalls() {
  return invokeCalls.filter((call) =>
    ["offer_local_intelligence", "open_local_intelligence"].includes(
      call.command,
    ),
  );
}

test("a first local run offers the backend dashboard to the app page and opens OpenBot", async () => {
  setupRootConfiguration("/tmp/local-eval-view", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    offer_local_intelligence: null,
  });
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await expectHandover();
  // The app page may offer the dashboard once local mode has a recorded stack.
  expect(intelligenceCalls()).toEqual([
    {
      command: "offer_local_intelligence",
      args: { root: "/tmp/local-eval-view", offered: true },
    },
  ]);
});

test("Continue after Intelligence is already ready starts OpenBot with the AI just chosen", async () => {
  setupRootConfiguration("/tmp/local-eval-ready-first", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  // Intelligence finishes while the person is still choosing.
  await waitFor(() =>
    expect(localSequence()).toEqual([
      "set_up_local_eval",
      "connect_local_eval",
      "run_local_eval",
    ]),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  await chooseOpenAi(view);
  await expectHandover();
  expect(getStartStackPayload()).toMatchObject({
    model: { provider: "openai", login: "api-key", apiKey: "model-test-key" },
  });
});

test("a Claude plan signed in on the provider screen reaches Start with its token", async () => {
  setupRootConfiguration("/tmp/local-eval-plan", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        summary: "Sign in with a Claude plan.",
        logins: ["plan", "api-key"],
        mark: null,
        caution: null,
      },
    ],
    begin_claude_sign_in: "https://claude.example/authorize",
    finish_claude_sign_in: "synthetic-plan-token",
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  await userEvent.click(await view.findByRole("radio", { name: /Anthropic/ }));
  await userEvent.click(
    await view.findByRole("button", { name: "Sign in with Anthropic" }),
  );
  await userEvent.type(
    await view.findByLabelText("Code from your browser"),
    "synthetic-code",
  );
  // Intelligence is ready and waiting before the sign-in finishes, as on a real machine. The
  // finished sign-in then moves on by itself, from an effect rather than a click, and Start must
  // still get the model it chose (it once got null: Start ran before the choice had rendered).
  await waitFor(() => expect(localSequence()).toContain("run_local_eval"));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  await userEvent.click(
    view.getByRole("button", { name: "Finish signing in" }),
  );
  // A tick for a second, then on by itself. (The install's row under it has a tick of its own.)
  await waitFor(() =>
    expect(
      view
        .getAllByText(/✓/)
        .map((tick) => tick.closest("p")?.textContent ?? ""),
    ).toContainEqual(expect.stringContaining("Signed in to Anthropic.")),
  );
  await expectHandover(4000);
  expect(getStartStackPayload()).toMatchObject({
    model: {
      provider: "anthropic",
      login: "plan",
      token: "synthetic-plan-token",
    },
  });
});

test("a development double mount runs each local step and opens OpenBot once", async () => {
  setupRootConfiguration("/tmp/local-eval-strict", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp(true);
  await installLocal(view);
  await chooseOpenAi(view);
  await expectHandover();
  expect(localSequence()).toEqual([
    "set_up_local_eval",
    "connect_local_eval",
    "run_local_eval",
    "start_stack",
    "show_openbot",
  ]);
});

test("Continue after Intelligence is ready starts OpenBot with the chosen model", async () => {
  setupRootConfiguration("/tmp/local-eval-ready-first", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("ready", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  await waitFor(() => expect(localSequence()).toContain("run_local_eval"));
  expect(view.queryByRole("alert", { name: "Setup" })).toBeNull();
  expect(localSequence()).not.toContain("start_stack");
  await chooseOpenAi(view);
  await expectHandover();
  expect(getStartStackPayload()).toMatchObject({
    model: { provider: "openai" },
  });
});

test("while a CLI step runs only Cancel is offered, and Cancel stops the call and says so", async () => {
  setupRootConfiguration("/tmp/local-eval-cancel", async () =>
    emptyConfiguration(),
  );
  const pending = deferred<unknown>();
  withLocalCli({
    set_up_local_eval: () => pending.promise,
    cancel_local_eval: () => {
      pending.reject("cancelled");
      return null;
    },
  });
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await view.findByRole("heading", { name: "Finishing setup" });
  expect(buttons(view)).toEqual(["Cancel"]);
  expect(view.queryByText("Installation options")).toBeNull();
  await userEvent.click(view.getByRole("button", { name: "Cancel" }));
  const setup = invokeCalls.find(
    (call) => call.command === "set_up_local_eval",
  );
  expect(
    invokeCalls.find((call) => call.command === "cancel_local_eval")?.args,
  ).toEqual({
    attempt: (setup?.args as { attempt: string } | undefined)?.attempt,
  });
  const row = view.getByRole("listitem", { name: "Setting up OpenBot" });
  await waitFor(() =>
    expect(row.textContent).toContain(
      "Stopped at your request before it finished.",
    ),
  );
  // Once nothing runs, leaving is offered.
  expect(buttons(view)).toEqual(["Back", "Retry"]);
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(
    invokeCalls.filter((call) => call.command === "set_up_local_eval"),
  ).toHaveLength(1);
});

test("a blocked setup stops at its row in plain words and Retry resumes there", async () => {
  setupRootConfiguration("/tmp/local-eval-blocked", async () =>
    emptyConfiguration(),
  );
  let setups = 0;
  withLocalCli({
    set_up_local_eval: () =>
      ++setups === 1
        ? {
            ...localStatus("unknown", "unknown"),
            outcome: "blocked",
            stack: null,
            reason: "docker-unavailable",
          }
        : localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  // A stop interrupts the screen in front at once, in a card with its reason and Retry.
  const alert = await view.findByRole("alert", { name: "Setup" });
  expect(alert.textContent).toContain("Setup stopped");
  expect(alert.textContent).toContain(
    "The software OpenBot runs on isn't running. Retry to start it.",
  );
  await chooseOpenAi(view);
  await view.findByRole("heading", { name: "Finishing setup" });
  // Continue does not retry a blocked step: Retry does.
  expect(setups).toBe(1);
  const row = view.getByRole("listitem", { name: "Setting up OpenBot" });
  expect(row.textContent).toContain(
    "The software OpenBot runs on isn't running. Retry to start it.",
  );
  expectPlain(view);
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
  await userEvent.click(view.getByRole("button", { name: "Retry" }));
  await expectHandover();
  expect(setups).toBe(2);
});

test("a recorded, connected stack that never launched starts by itself and opens OpenBot", async () => {
  setupRootConfiguration("/tmp/local-eval-recorded", async () => ({
    ...savedOpenAiConfiguration(),
    saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
    installation: { harness: { id: "mastra" } },
    localEval: {
      stack: "local-abc123",
      ownership: "created",
      phase: "installed",
      connected: true,
    },
  }));
  withLocalCli({
    run_local_eval: localStatus("ready", "valid"),
  });
  await renderApp();
  // Never launched, so this is a first run: it hands over as soon as Start succeeds.
  await expectHandover();
  expect(localSequence()).toEqual([
    "run_local_eval",
    "start_stack",
    "show_openbot",
  ]);
});

test("relaunch says it is starting while it starts, and never offers a CopilotKit connection", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-relaunch-heading",
    localStatus("ready", "valid"),
  );
  const status = deferred<unknown>();
  const previous = invokeHandler;
  invokeHandler = async (command, args) =>
    command === "run_local_eval" ? status.promise : previous(command, args);
  const view = await renderApp();
  await view.findByRole("heading", { name: "Starting OpenBot" });
  expect(
    view.queryByRole("heading", { name: "OpenBot is stopped" }),
  ).toBeNull();
  expect(buttons(view)).toEqual(["Cancel"]);
  expectPlain(view);
  await act(async () => status.resolve(localStatus("ready", "valid")));
  await view.findByRole("heading", { name: "OpenBot is running" });
  await userEvent.click(view.getByRole("button", { name: "Stop OpenBot" }));
  await view.findByRole("heading", { name: "OpenBot is stopped" });
  expect(
    view.queryByRole("button", { name: "Change CopilotKit connection" }),
  ).toBeNull();
  expect(
    view.getByRole("button", { name: "Change AI connection" }),
  ).toBeTruthy();
  expectPlain(view);
});

/*
 * The bug, on a signed 0.3.2 on Windows: the stopped window's update check asked an old mechanism
 * release builds do not carry (`check_shell_update`), and said "Signed desktop shell updates are
 * not configured. This build does not include the optional updater feature." Both commands answer
 * here as a release build answered them, so only the one the window asks decides what it says.
 */
test("the stopped window's update check asks the update feed and says this version is up to date", async () => {
  setupConnectedLocalStack(
    "/tmp/check-for-updates",
    localStatus("ready", "valid"),
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "app_update_offer")
      return {
        version: null,
        current: "0.3.2",
        installing: null,
        updatesItself: true,
      };
    if (command === "check_app_update")
      return { found: "upToDate", current: "0.3.2" };
    if (command === "check_shell_update")
      return {
        configured: false,
        available: false,
        version: null,
        detail:
          "Signed desktop shell updates are not configured. This build does not include the optional updater feature.",
      };
    return previous(command, args);
  };
  const view = await renderApp();
  await view.findByRole("heading", { name: "OpenBot is running" });
  await userEvent.click(view.getByRole("button", { name: "Stop OpenBot" }));
  await view.findByRole("heading", { name: "OpenBot is stopped" });
  await userEvent.click(view.getByRole("button", { name: /^Check/ }));
  await waitFor(() =>
    expect(view.getByText("OpenBot 0.3.2 is up to date.")).toBeTruthy(),
  );
  expect(view.queryByText(/not configured/)).toBeNull();
  expect(view.getByText(/^OpenBot updates itself/)).toBeTruthy();
  expect(
    invokeCalls.filter(
      (call) =>
        call.command.includes("update") && call.command !== "app_update_offer",
    ),
  ).toEqual([{ command: "check_app_update", args: undefined }]);
});

/*
 * The bug, on an internal build on Windows: the stopped window's Updates section opened with
 * "OpenBot updates itself with signed updates from its publisher", and Check for updates then said
 * "This version of OpenBot doesn't update itself" in the same box. A build that never updates
 * itself now says so up front, with no promise and nothing to check.
 */
test("the stopped window on a build that never updates itself says so and promises no updates", async () => {
  setupConnectedLocalStack(
    "/tmp/check-for-updates-internal",
    localStatus("ready", "valid"),
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "app_update_offer")
      return {
        version: null,
        current: "0.3.2-internal.731.gabc1234",
        installing: null,
        updatesItself: false,
      };
    if (command === "check_app_update")
      return { found: "notOffered", current: "0.3.2-internal.731.gabc1234" };
    return previous(command, args);
  };
  const view = await renderApp();
  await view.findByRole("heading", { name: "OpenBot is running" });
  await userEvent.click(view.getByRole("button", { name: "Stop OpenBot" }));
  await view.findByRole("heading", { name: "OpenBot is stopped" });
  await view.findByText(
    "This version of OpenBot doesn't update itself. Install a released version of OpenBot to get updates.",
  );
  expect(view.queryByText(/updates itself with|signed updates/)).toBeNull();
  expect(view.queryByRole("button", { name: /^Check/ })).toBeNull();
  expect(
    invokeCalls.filter((call) => call.command === "check_app_update"),
  ).toEqual([]);
});

test("Quit shows Shutting down with each part's row as it starts and ends", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-quit-screen",
    localStatus("ready", "valid"),
  );
  const view = await renderApp();
  await view.findByRole("heading", { name: "OpenBot is running" });
  const callsBefore = invokeCalls.length;

  await emitQuit({ seq: 2, steps: [running("stop-openbot")] });
  const heading = view.getByRole("heading", { name: "Shutting down OpenBot" });
  expectStandardSheet(heading);
  expect(
    rowStatus(view, "Stopping OpenBot").getByText("In progress"),
  ).toBeTruthy();
  expect(
    view.queryByRole("listitem", { name: "Stopping OpenBot's services" }),
  ).toBeNull();
  // Nothing to press: the app exits by itself.
  expect(view.queryAllByRole("button")).toHaveLength(0);

  await emitQuit({
    seq: 4,
    steps: [complete("stop-openbot"), running("stop-intelligence")],
  });
  expect(
    rowStatus(view, "Stopping OpenBot").getByText("Complete"),
  ).toBeTruthy();
  expect(
    rowStatus(view, "Stopping OpenBot's services").getByText("In progress"),
  ).toBeTruthy();
  // An older copy arriving late never undoes a newer one.
  await emitQuit({ seq: 3, steps: [complete("stop-openbot")] });
  expect(
    rowStatus(view, "Stopping OpenBot's services").getByText("In progress"),
  ).toBeTruthy();

  await emitQuit({
    seq: 5,
    steps: [complete("stop-openbot"), failed("stop-intelligence")],
  });
  expect(
    rowStatus(view, "Stopping OpenBot's services").getByText("Failed"),
  ).toBeTruthy();
  expect(view.getByRole("status").textContent).toBe(
    "Part of it could not be stopped. OpenBot says what happened the next time it opens.",
  );
  // The window only shows; it never asks anything of the native side while it quits.
  expect(invokeCalls.slice(callsBefore)).toEqual([]);
});

test("a window sent to the Shutting down page catches up, then follows the rows", async () => {
  expect(isShuttingDownPage("#shutting-down")).toBe(true);
  expect(isShuttingDownPage("")).toBe(false);
  invokeHandler = async (command) => {
    if (command === "quit_status")
      return {
        seq: 3,
        steps: [complete("stop-openbot"), running("stop-intelligence")],
      };
    throw new Error(`unexpected ${command}`);
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ShuttingDownWindow />);
  });
  const heading = await view.findByRole("heading", {
    name: "Shutting down OpenBot",
  });
  expectStandardSheet(heading);
  await waitFor(() =>
    expect(
      rowStatus(view, "Stopping OpenBot").getByText("Complete"),
    ).toBeTruthy(),
  );
  expect(view.getByRole("status").textContent).toBe(
    "OpenBot is stopping what it started on this computer, then it closes.",
  );
  await emitQuit({
    seq: 4,
    steps: [complete("stop-openbot"), complete("stop-intelligence")],
  });
  expect(
    rowStatus(view, "Stopping OpenBot's services").getByText("Complete"),
  ).toBeTruthy();
  // Only the catch-up call; nothing that starts or stops anything.
  expect(invokeCalls.map((call) => call.command)).toEqual(["quit_status"]);
});

test("Stop OpenBot and Show OpenBot say what they are doing at once", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-stop-status",
    localStatus("ready", "valid"),
  );
  const stopping = deferred<null>();
  const showing = deferred<null>();
  const previous = invokeHandler;
  let shows = 0;
  invokeHandler = async (command, args) => {
    if (command === "stop_stack") return stopping.promise;
    // The first show is the relaunch's own handover.
    if (command === "show_openbot" && shows++ > 0) return showing.promise;
    return previous(command, args);
  };
  const view = await renderApp();
  await view.findByRole("heading", { name: "OpenBot is running" });

  await userEvent.click(view.getByRole("button", { name: "Show OpenBot" }));
  expectWorking(view, "Loading OpenBot…");
  await act(async () => showing.resolve(null));
  expect(view.queryByText("Loading OpenBot…")).toBeNull();

  await userEvent.click(view.getByRole("button", { name: "Stop OpenBot" }));
  expectWorking(view, "Stopping OpenBot…");
  expect(view.getByRole("button", { name: "Stop OpenBot" })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () => stopping.resolve(null));
  await view.findByRole("heading", { name: "OpenBot is stopped" });
  expect(view.queryByText("Stopping OpenBot…")).toBeNull();
});

test("relaunch's Starting and Opening screens use the standard setup column", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-relaunch-layout",
    localStatus("ready", "valid"),
  );
  const status = deferred<unknown>();
  const previous = invokeHandler;
  invokeHandler = async (command, args) =>
    command === "run_local_eval" ? status.promise : previous(command, args);
  const view = await renderApp();
  const starting = await view.findByRole("heading", {
    name: "Starting OpenBot",
  });
  expectStandardSheet(starting);
  const sheet = starting.closest(".sheet") as HTMLElement;
  expect(
    await within(sheet).findByRole("list", { name: "Setup progress" }),
  ).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: "Cancel" })).toBeTruthy();
  await act(async () => status.resolve(localStatus("ready", "valid")));
  await view.findByRole("heading", { name: "OpenBot is running" });
  await userEvent.click(view.getByRole("button", { name: "Stop OpenBot" }));
  expectStandardSheet(
    await view.findByRole("heading", { name: "OpenBot is stopped" }),
  );
  cleanup();

  const reopened = "/tmp/reopen-layout";
  const configuration = deferred<ReturnType<typeof savedOpenAiConfiguration>>();
  setupRootConfiguration(reopened, async () => configuration.promise);
  const reopening = invokeHandler;
  invokeHandler = async (command, args) =>
    command === "selected_root" ? reopened : reopening(command, args);
  const opening = await renderApp();
  expectStandardSheet(
    opening.getByRole("heading", { name: "Getting OpenBot ready" }),
  );
  await act(async () => configuration.resolve(savedOpenAiConfiguration()));
});

function setupConnectedLocalStack(
  root: string,
  status: unknown,
  overrides: Record<string, unknown> = {},
) {
  setupRootConfiguration(root, async () => ({
    ...savedOpenAiConfiguration(),
    saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
    launch: { harness: { id: "mastra" } },
    localEval: {
      stack: "local-abc123",
      ownership: "created",
      phase: "installed",
      connected: true,
    },
    ...overrides,
  }));
  withLocalCli({
    set_up_local_eval: status,
    connect_local_eval: localConnection,
    run_local_eval: status,
    stop_stack: null,
  });
}

test("relaunch starts a connected local stack that reports ready and valid", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-ready",
    localStatus("ready", "valid"),
  );
  const view = await renderApp();
  await view.findByRole("heading", { name: "OpenBot is running" });
  // A recorded, connected stack goes straight to waiting.
  expect(localSequence()).toEqual([
    "run_local_eval",
    "start_stack",
    "show_openbot",
  ]);
  expect(getStartStackPayload()).toMatchObject({
    root: "/tmp/local-eval-ready",
    ...LOCAL_ADDRESSES,
  });
  expect(getStartStackPayload()).not.toHaveProperty("apiKey");
  // Stopped by choice: nothing starts again on its own in this session.
  await userEvent.click(view.getByRole("button", { name: "Stop OpenBot" }));
  await view.findByRole("heading", { name: "OpenBot is stopped" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    invokeCalls.filter((call) => call.command === "start_stack"),
  ).toHaveLength(1);
  expect(view.getByRole("button", { name: "Start OpenBot" })).toBeTruthy();
});

const DOCKER_DID_NOT_START = {
  said: "Docker Desktop didn't start. Open it and finish anything it shows, then try again.",
};

/**
 * The engine as the CLI sees it: stopped until `wake_engine` opens Docker Desktop. Each wake
 * waits on `docker.wake`, which the test settles with nothing (Docker answers) or a `Problem`.
 * The native side's progress lines are emitted by the test, as `docker_desktop::start` says them.
 */
function withDockerQuit() {
  const docker = {
    running: false,
    wakes: 0,
    wake: deferred<unknown>(),
  };
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "wake_engine") {
      docker.wakes += 1;
      const refused = await docker.wake.promise;
      if (refused) throw refused;
      docker.running = true;
      return null;
    }
    if (
      ["set_up_local_eval", "connect_local_eval", "run_local_eval"].includes(
        command,
      ) &&
      !docker.running
    ) {
      return {
        ...localStatus("unknown", "unknown"),
        outcome: "blocked",
        stack: null,
        reason: "docker-unavailable",
      };
    }
    return previous(command, args);
  };
  return docker;
}

test("relaunch with Docker Desktop quit opens it, says so, and starts once it answers", async () => {
  // Live Mac check of #1295: after a reboot Docker Desktop was not running. The relaunch went
  // straight to the CLI, which answered "docker-unavailable", and stopped at "Waiting for the back
  // end" without ever opening Docker. Start, which opens it, was never reached.
  setupConnectedLocalStack(
    "/tmp/local-eval-docker-quit",
    localStatus("ready", "valid"),
  );
  const docker = withDockerQuit();
  const view = await renderApp();
  // Docker is opened first, before any CLI call, and the screen says what to do.
  await waitFor(() => expect(docker.wakes).toBe(1));
  await view.findByRole("heading", { name: "Starting OpenBot" });
  await emitDockerHandOff();
  expectJourney(view, DOCKER_HAND_OFF);
  const row = view.getByRole("listitem", { name: "Getting OpenBot ready" });
  expect(row.textContent).toContain("Step 3 of 4");
  expect(localSequence()).toEqual([]);
  // Docker answers: the hand-off goes, and the back end and OpenBot start.
  await emitDockerSettled(true, "Docker Desktop is running.");
  await act(async () => docker.wake.resolve(null));
  await view.findByRole("heading", { name: "OpenBot is running" });
  expect(view.queryByText(DOCKER_HAND_OFF)).toBeNull();
  expect(localSequence()).toEqual([
    "run_local_eval",
    "start_stack",
    "show_openbot",
  ]);
  expect(
    view.queryByText(
      "The software OpenBot runs on isn't running. Retry to start it.",
    ),
  ).toBeNull();
});

test("relaunch with the engine machine stopped says it is starting it, in plain words", async () => {
  // Seen on Windows: Podman's machine was stopped, and for the ten seconds it took to start the
  // screen said only "Waiting for the back end", while the log said "Starting the engine machine".
  // The screen says it plainly now (`engine::starting_machine_line`); the log keeps the machine.
  setupConnectedLocalStack(
    "/tmp/local-eval-machine-stopped",
    localStatus("ready", "valid"),
  );
  const machine = deferred<unknown>();
  const previous = invokeHandler;
  invokeHandler = async (command, args) =>
    command === "wake_engine" ? machine.promise : previous(command, args);
  const view = await renderApp();
  await view.findByRole("heading", { name: "Starting OpenBot" });
  // As `wake_installation_engine` reports it, before the machine answers.
  await emitProgress({
    step: "start-machine",
    ok: true,
    running: true,
    detail: "Starting the software OpenBot runs on.",
  });
  // Said as the journey's other lines are: a phrase, with no full stop.
  expectJourney(view, "Starting the software OpenBot runs on");
  await emitProgress({
    step: "start-machine",
    ok: true,
    running: false,
    detail: "The engine machine is running.",
  });
  expect(view.queryByText("Starting the software OpenBot runs on.")).toBeNull();
  await act(async () => machine.resolve(null));
  await view.findByRole("heading", { name: "OpenBot is running" });
});

test("the running screen shows none of Start's own steps, and names the system tray on Windows", async () => {
  // Seen on Windows: "OpenBot is running" flashed "settings written, credentials stored" and
  // "containers up" for the moment before OpenBot opened, and sent the person to "the menu bar",
  // which Windows does not have.
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  });
  try {
    setupConnectedLocalStack(
      "/tmp/local-eval-running-words",
      localStatus("ready", "valid"),
    );
    const started = deferred<unknown>();
    const previous = invokeHandler;
    invokeHandler = async (command, args) =>
      command === "start_stack"
        ? started.promise.then(() => previous(command, args))
        : previous(command, args);
    const view = await renderApp();
    await waitFor(() => expect(localSequence()).toContain("start_stack"));
    // What the native side reports as it starts OpenBot.
    for (const progress of [
      { step: "env", ok: true, detail: "Your settings are saved." },
      {
        step: "services",
        ok: true,
        running: true,
        detail: "Starting OpenBot's services.",
      },
      { step: "services", ok: true, detail: "OpenBot's services are running." },
      { step: "answering", ok: true, detail: "OpenBot is ready." },
    ])
      await emitProgress(progress);
    await act(async () => started.resolve(null));
    await view.findByRole("heading", { name: "OpenBot is running" });
    const screen = document.body.textContent ?? "";
    expect(view.queryByRole("list", { name: "Setup progress" })).toBeNull();
    for (const internal of [
      "settings written",
      "credentials stored",
      "containers up",
      "menu bar",
    ])
      expect(screen).not.toContain(internal);
    expect(
      view.getByText(
        "OpenBot is open in this window. You can also show it or stop it from its icon in the system tray.",
      ),
    ).toBeTruthy();
  } finally {
    delete (navigator as { userAgent?: string }).userAgent;
  }
});

/*
 * Seen on Windows: with Start's rows gone from the running screen, the card opened on a divider
 * and "Updates", with nothing above the line, and "OpenBot is running" under them. The heading
 * comes first; Updates sits under the buttons, as on the stopped screen.
 */
test("the running screen opens on its heading, with Updates under the buttons, with and without a failure", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-running-order",
    localStatus("ready", "valid"),
  );
  let showFails = false;
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "show_openbot" && showFails)
      throw "OpenBot is not answering on port 3010 yet, so there is nothing to show.";
    return previous(command, args);
  };
  const view = await renderApp();
  await waitFor(() => expect(localSequence()).toContain("start_stack"));
  await emitProgress({ step: "env", ok: true, detail: "Saved." });
  await emitProgress({
    step: "services",
    ok: true,
    running: true,
    detail: "Starting OpenBot's services.",
  });

  /** The card's own children in order, by what each one is. */
  const order = (sheet: Element) =>
    [...sheet.children].map((child) =>
      child.tagName === "H1"
        ? "heading"
        : child.tagName === "DETAILS"
          ? `details:${child.querySelector("summary")?.textContent}`
          : child.getAttribute("aria-label") === "Setup progress"
            ? "rows"
            : child.classList.contains("row")
              ? "buttons"
              : child.tagName.toLowerCase(),
    );

  const heading = await view.findByRole("heading", {
    name: "OpenBot is running",
  });
  const sheet = heading.closest(".sheet") as HTMLElement;
  expect(order(sheet)).toEqual(["heading", "p", "buttons", "details:Updates"]);
  expect(sheet.firstElementChild === heading).toBe(true);
  expect(view.queryByRole("list", { name: "Setup progress" })).toBeNull();

  showFails = true;
  await userEvent.click(view.getByRole("button", { name: "Show OpenBot" }));
  const stopped = await view.findByRole("heading", { name: "OpenBot stopped" });
  const failedSheet = stopped.closest(".sheet") as HTMLElement;
  // The rows still show where it stopped, between the heading and the buttons.
  const rows = view.getByRole("list", { name: "Setup progress" });
  expect(within(rows).getAllByRole("listitem").length).toBeGreaterThan(0);
  expect(order(failedSheet)).toEqual([
    "heading",
    "rows",
    expect.any(String),
    "buttons",
    "details:Updates",
  ]);
  expect(failedSheet.firstElementChild === stopped).toBe(true);
  expect(view.getByRole("alert").textContent).toContain(
    "OpenBot is not answering on port 3010 yet",
  );
});

test("relaunch says when Docker Desktop did not start, and Retry opens it again", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-docker-never",
    localStatus("ready", "valid"),
  );
  const docker = withDockerQuit();
  const view = await renderApp();
  await waitFor(() => expect(docker.wakes).toBe(1));
  await emitDockerHandOff();
  await emitDockerSettled(false, DOCKER_DID_NOT_START.said);
  await act(async () => docker.wake.resolve(DOCKER_DID_NOT_START));
  await view.findByText(DOCKER_DID_NOT_START.said);
  expect(view.queryByText(DOCKER_HAND_OFF)).toBeNull();
  expect(localSequence()).toEqual([]);
  // Retry opens Docker Desktop again, and this time it answers.
  docker.wake = deferred<unknown>();
  await userEvent.click(view.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(docker.wakes).toBe(2));
  await act(async () => docker.wake.resolve(null));
  await view.findByRole("heading", { name: "OpenBot is running" });
});

/** What `docker_desktop::start` says as it opens Docker Desktop. */
async function emitDockerHandOff() {
  await emitProgress({
    step: "engine",
    ok: true,
    running: true,
    elsewhere: true,
    detail: DOCKER_HAND_OFF,
  });
}

/** The engine row ending once Docker answers or is given up on. */
async function emitDockerSettled(ok: boolean, detail: string) {
  await emitProgress({ step: "engine", ok, running: false, detail });
}

/** Start finds the installation on an older release than this app, and `upgrade_and_start` answers. */
function withOlderDeployment(outcome: unknown) {
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "upgrade_due") return { from: "v0.3.0", to: "v0.3.1" };
    if (command === "upgrade_and_start")
      return typeof outcome === "function" ? outcome() : outcome;
    return previous(command, args);
  };
}

test("relaunch upgrades an older installation to this app's release as part of Start, then opens OpenBot", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-older-release",
    localStatus("ready", "valid"),
  );
  const moving = deferred<unknown>();
  withOlderDeployment(() => moving.promise);
  const view = await renderApp();
  await waitFor(() =>
    expect(
      invokeCalls.some((call) => call.command === "upgrade_and_start"),
    ).toBe(true),
  );
  // Said while the upgrade runs, which can take minutes.
  const said =
    "Updating OpenBot. Your Bots, sign-ins and data stay as they are.";
  await emitProgress({
    step: "release",
    ok: true,
    running: true,
    detail: said,
  });
  expect(view.getByRole("heading", { name: "Starting OpenBot" })).toBeTruthy();
  expect(view.getByText(said)).toBeTruthy();
  await act(async () =>
    moving.resolve({ from: "v0.3.0", to: "v0.3.1", moved: true }),
  );
  await view.findByRole("heading", { name: "OpenBot is running" });
  await expectHandover();
  const sequence = invokeCalls
    .map((call) => call.command)
    .filter((command) =>
      [
        "run_local_eval",
        "upgrade_due",
        "upgrade_and_start",
        "start_stack",
        "show_openbot",
      ].includes(command),
    );
  // The upgrade is the Start: nothing starts the older release first.
  expect(sequence).toEqual([
    "run_local_eval",
    "upgrade_due",
    "upgrade_and_start",
    "show_openbot",
  ]);
  expect(
    invokeCalls.find((call) => call.command === "upgrade_and_start")?.args,
  ).toMatchObject({
    root: "/tmp/local-eval-older-release",
    ...LOCAL_ADDRESSES,
  });
});

/*
 * Start updating OpenBot itself, in the Start journey: what the update is doing now, said from the
 * step running now (`upgrade::now_said`), on the one bar that covers every row. The install and the
 * start report rows of their own as well, and those never take the line over. On Windows the line
 * said "Stopping OpenBot." through a whole start, under a list where every step but the last was
 * complete; later a second row under the journey carried a bar of its own and said the same thing.
 */
test("the journey says the update step running now, never one that finished, on its one bar", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-upgrade-steps",
    localStatus("ready", "valid"),
  );
  const moving = deferred<unknown>();
  withOlderDeployment(() => moving.promise);
  const view = await renderApp();
  await waitFor(() =>
    expect(
      invokeCalls.some((call) => call.command === "upgrade_and_start"),
    ).toBe(true),
  );
  const journey = () => view.getByRole("region", { name: "How far along" });
  const release = (detail: string) => ({
    step: "release",
    ok: true,
    running: true,
    detail,
  });
  // What `upgrade_and_start` reports, in order: the release row as each step begins, and the
  // install's and the start's own rows between them. Then what the journey says meanwhile, and the
  // measure under its bar while a download runs.
  const upgrade: [ProgressEvent[], string, string?][] = [
    [
      [
        release(
          "Updating OpenBot. Your Bots, sign-ins and data stay as they are.",
        ),
      ],
      "Getting the update ready",
    ],
    [[release("Stopping OpenBot.")], "Getting the update ready"],
    [[release("Backing up your data.")], "Getting the update ready"],
    [[release("Downloading the update.")], "Downloading the update"],
    [
      [
        release("Installing the update."),
        {
          step: "engine",
          ok: true,
          running: true,
          detail: "Checking the software OpenBot needs.",
        },
        {
          step: "engine",
          ok: true,
          running: false,
          detail: "Docker is answering.",
        },
        {
          step: "images",
          ok: true,
          running: true,
          detail: "Downloading local software.",
          downloads: {
            done: 2,
            total: 5,
            bytes: 600_000_000,
            size: 1_200_000_000,
          },
        },
      ],
      "Downloading the update",
      " · 600.0 MB of 1.2 GB",
    ],
    [
      [
        { step: "images", ok: true, running: false, detail: "Downloaded." },
        {
          step: "installation",
          ok: true,
          running: false,
          detail: "Installed.",
        },
      ],
      "Installing the update",
    ],
    [
      [
        release("Starting OpenBot."),
        {
          step: "services",
          ok: true,
          running: true,
          detail: "starting installed containers",
        },
        { step: "services", ok: true, running: false, detail: "containers up" },
        {
          step: "answering",
          ok: true,
          running: true,
          detail: "Waiting for OpenBot to answer.",
        },
      ],
      "Starting the updated OpenBot",
    ],
  ];
  let fraction = 0;
  for (const [events, said, bytes] of upgrade) {
    for (const event of events) await emitProgress(event);
    expect(
      view.getByRole("heading", { name: "Starting OpenBot" }),
    ).toBeTruthy();
    expect(journey().querySelector(".journey-said")?.textContent).toBe(said);
    expect(journey().querySelector(".journey-bytes")?.textContent ?? null).toBe(
      bytes ?? null,
    );
    // One bar on the screen, the journey's, and it only moves forward.
    const bars = view.getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    const value = Number(bars[0]?.getAttribute("value"));
    expect(value).toBeGreaterThanOrEqual(fraction);
    fraction = value;
    // No row of its own for the update: the start's row says what this part is.
    expect(view.queryByRole("list", { name: "Update progress" })).toBeNull();
    expect(
      view.getByRole("listitem", { name: "Opening OpenBot" }).textContent,
    ).toContain(
      "Updating OpenBot. Your Bots, sign-ins and data stay as they are.",
    );
  }
  // Nothing an earlier step said is left on the screen.
  for (const finished of [
    "Stopping OpenBot.",
    "Backing up your data.",
    "Downloading the update.",
    "Installing the update.",
  ])
    expect(view.queryByText(finished)).toBeNull();
  await act(async () =>
    moving.resolve({ from: "v0.3.0", to: "v0.3.1", moved: true }),
  );
  await view.findByRole("heading", { name: "OpenBot is running" });
  expect(view.queryByText("Starting OpenBot.")).toBeNull();
});

test("an upgrade that could not put the previous version back is retried from the Retry its sentence names", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-upgrade-stuck",
    localStatus("ready", "valid"),
  );
  const said =
    "OpenBot couldn't update to v0.3.1 or put v0.3.0 back. Choose Retry to try putting it back again.";
  let attempts = 0;
  withOlderDeployment(() => {
    attempts += 1;
    if (attempts === 1)
      throw {
        said,
        detail: "the database backup could not be restored",
      };
    // The second Start puts the previous version back, tries the update again, and keeps v0.3.0.
    return {
      from: "v0.3.0",
      to: "v0.3.1",
      moved: false,
      notice: {
        said: "OpenBot couldn't update to v0.3.1, so it's still on v0.3.0, with your data as it was.",
      },
    };
  });
  const view = await renderApp();
  await view.findByText(said);
  // The button the sentence names is the one on this screen, and there is no Start to choose.
  expect(view.queryByRole("button", { name: /^Start/ })).toBeNull();
  await userEvent.click(view.getByRole("button", { name: "Retry" }));
  await view.findByText(
    "OpenBot couldn't update to v0.3.1, so it's still on v0.3.0, with your data as it was.",
  );
  expect(
    invokeCalls.filter((call) => call.command === "upgrade_and_start"),
  ).toHaveLength(2);
  // Each Retry asks first, and an interrupted upgrade is always due: Start never runs around it.
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

test("an upgrade that did not finish says so on the running screen before handing over", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-move-undone",
    localStatus("ready", "valid"),
  );
  const said =
    "OpenBot couldn't update to v0.3.1, so it's still on v0.3.0, with your data as it was.";
  withOlderDeployment({
    from: "v0.3.0",
    to: "v0.3.1",
    moved: false,
    notice: { said, detail: "The image for v0.3.1 could not be pulled." },
  });
  const view = await renderApp();
  await view.findByText(said);
  expect(
    view.getByRole("heading", { name: "OpenBot is running" }),
  ).toBeTruthy();
  expect(view.getByText("Technical details")).toBeTruthy();
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
  // The release it had is running; the person opens it when they have read why.
  expect(invokeCalls.some((call) => call.command === "show_openbot")).toBe(
    false,
  );
  await userEvent.click(view.getByRole("button", { name: "Show OpenBot" }));
  await waitFor(() =>
    expect(invokeCalls.some((call) => call.command === "show_openbot")).toBe(
      true,
    ),
  );
});

test("relaunch never starts a local stack that is not exactly ready and valid", async () => {
  for (const [readiness, licence, said] of [
    [
      "unknown",
      "unknown",
      "OpenBot started, and hasn't said yet whether it's ready.",
    ],
    ["ready", "expired", "The evaluation licence has expired."],
    [
      "degraded",
      "valid",
      "OpenBot is running but not working properly. Retry to start it again.",
    ],
  ]) {
    setupConnectedLocalStack(
      `/tmp/local-eval-${readiness}-${licence}`,
      localStatus(readiness, licence),
    );
    const view = await renderApp();
    await view.findByText(said);
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
      false,
    );
    cleanup();
    invokeCalls = [];
  }
});

/**
 * What `run_local_eval` answers for `status` from the CLI this app pins, for a back end whose
 * update to 0.16.0-rc.9 stopped at the image download. `local_eval_ipc_tests.rs` runs the real CLI
 * over that record and checks its answers are these, so the window is tested against what the CLI
 * really says.
 */
const pinnedCli = JSON.parse(
  readFileSync(
    new URL(
      "../src-tauri/test-fixtures/local-eval/update-did-not-finish.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const KEPT_RELEASE =
  "The OpenBot update didn't finish downloading, so OpenBot is running the version it had. It tries again the next time it starts.";

/** `local update` as the CLI answers when it stops at the image download again. */
const updateFailed = {
  ...localStatus("unknown", "unknown"),
  outcome: "failed",
  stack: null,
  reason: "local-command-failed",
};

/** A connected stack whose `status` answers come from `statuses`, in turn, and whose update fails. */
function withUnfinishedUpdate(root: string, statuses: unknown[]) {
  setupConnectedLocalStack(root, statuses[0]);
  let asked = 0;
  withLocalCli({
    run_local_eval: (args: { action: string }) => {
      if (args.action === "update") return updateFailed;
      if (args.action !== "status")
        throw new Error(`unexpected ${args.action}`);
      asked += 1;
      return statuses[Math.min(asked, statuses.length) - 1];
    },
  });
}

function localActions() {
  return invokeCalls
    .filter((call) => call.command === "run_local_eval")
    .map((call) => (call.args as { action: string }).action);
}

/** OpenBot started on the back end's own addresses, said why on the running screen, and waits. */
async function startedOnKeptRelease(
  view: Awaited<ReturnType<typeof renderApp>>,
) {
  // Information, not a failure: said as a status, with no alert and no setup help beside it.
  expect((await view.findByRole("status")).textContent).toBe(KEPT_RELEASE);
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("link", { name: "Get setup help" })).toBeNull();
  expect(
    view.getByRole("heading", { name: "OpenBot is running" }),
  ).toBeTruthy();
  expect(
    view.queryByText(
      "OpenBot is running but not working properly. Retry to start it again.",
    ),
  ).toBeNull();
  expect(
    view.queryByRole("heading", { name: "OpenBot is stopped" }),
  ).toBeNull();
  expect(getStartStackPayload()).toMatchObject({
    apiUrl: "http://localhost:18082",
    gatewayWsUrl: "ws://localhost:14401",
  });
  // The person reads the notice, then opens OpenBot on the release it has.
  expect(invokeCalls.some((call) => call.command === "show_openbot")).toBe(
    false,
  );
  await userEvent.click(view.getByRole("button", { name: "Show OpenBot" }));
  await waitFor(() =>
    expect(invokeCalls.some((call) => call.command === "show_openbot")).toBe(
      true,
    ),
  );
}

/**
 * Found on 0.3.3 on a slow connection. Start began updating the back end from 0.16.0-rc.5 to
 * 0.16.0-rc.9; the CLI stopped downloading one image at its own limit and kept the update on
 * record. Nothing in the cluster had changed and every check passed, but the CLI said `degraded`,
 * and the window said "OpenBot is running but not working properly. Retry to start it again." and stopped OpenBot.
 */
test("an update that did not finish opens OpenBot on the release the backend runs, and says so", async () => {
  const after = pinnedCli.updateDidNotFinish;
  // The same stack before the update: ready on rc.5, with rc.9 to install.
  const before = {
    ...after,
    readiness: "ready",
    stack: {
      ...after.stack,
      step: "ready",
      hasFailedStep: false,
      updateInProgress: false,
      unfinishedUpdate: null,
    },
  };
  withUnfinishedUpdate("/tmp/local-eval-update-did-not-finish", [
    before,
    after,
  ]);
  const view = await renderApp();
  await startedOnKeptRelease(view);
  expect(localActions()).toEqual(["status", "update", "status"]);
});

test("the next Start tries the update again on a backend that is still running", async () => {
  withUnfinishedUpdate("/tmp/local-eval-update-again-running", [
    pinnedCli.updateDidNotFinish,
  ]);
  const view = await renderApp();
  await startedOnKeptRelease(view);
  expect(localActions()).toEqual(["status", "update", "status"]);
});

/**
 * Quit stops the back end. With the update on record, the CLI refuses `local start`
 * (`update_recovery_required`) and names `local update`, which starts the stack itself.
 */
test("the next Start after Quit tries the update again, and never asks the CLI to start", async () => {
  withUnfinishedUpdate("/tmp/local-eval-update-again-stopped", [
    pinnedCli.stoppedByQuit,
    pinnedCli.updateDidNotFinish,
  ]);
  const view = await renderApp();
  await startedOnKeptRelease(view);
  expect(localActions()).toEqual(["status", "update", "status"]);
});

test("a backend whose check fails is still not healthy, with an update on record or not", async () => {
  withUnfinishedUpdate("/tmp/local-eval-update-check-fails", [
    pinnedCli.apiCheckFails,
  ]);
  const view = await renderApp();
  await view.findByText(
    "OpenBot is running but not working properly. Retry to start it again.",
  );
  expect(
    view.getByRole("heading", { name: "OpenBot is stopped" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
  expect(view.queryByText(KEPT_RELEASE)).toBeNull();
  expect(localActions()).toEqual(["status"]);
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

test("relaunch waits for Start when auto-start is off, interrupted, or the stack is not connected", async () => {
  for (const [name, overrides, failure] of [
    ["auto-start-off", { autoStart: false }, null],
    [
      "not-connected",
      {
        localEval: {
          stack: "local-abc123",
          ownership: "created",
          phase: "installed",
        },
      },
      null,
    ],
    ["interrupted", {}, { said: "OpenBot stopped unexpectedly." }],
  ] as const) {
    setupConnectedLocalStack(
      `/tmp/local-eval-${name}`,
      localStatus("ready", "valid"),
      overrides,
    );
    if (failure) {
      const previous = invokeHandler;
      invokeHandler = async (command, args) =>
        command === "last_failure" ? failure : previous(command, args);
    }
    const view = await renderApp();
    await view.findByRole("heading", { name: "OpenBot is stopped" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(localSequence()).toEqual([]);
    await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
    await waitFor(() => expect(localSequence()).toContain("start_stack"));
    cleanup();
    invokeCalls = [];
  }
});

test("Back from a stopped Finishing setup keeps the AI already chosen", async () => {
  setupRootConfiguration("/tmp/back-preserves-setup", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: {
      ...localStatus("unknown", "unknown"),
      outcome: "blocked",
      stack: null,
      reason: "docker-unavailable",
    },
  });
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await view.findByRole("heading", { name: "Finishing setup" });
  await userEvent.click(await view.findByRole("button", { name: "Back" }));
  expect(view.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
  expect(view.getByRole("radio", { name: /OpenAI/ })).toHaveProperty(
    "checked",
    true,
  );
  expect(view.getByLabelText("OpenAI API key")).toHaveProperty(
    "value",
    "model-test-key",
  );
  expect(installationCalls()).toHaveLength(1);
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

test("a provider sign-in can be tried again on the AI step without installing again", async () => {
  setupRootConfiguration("/tmp/provider-retry", async () =>
    emptyConfiguration(),
  );
  let signIns = 0;
  withLocalCli({
    ...readyLocal(),
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        summary: "Use OpenAI",
        logins: ["plan"],
        mark: null,
        caution: null,
      },
    ],
    begin_chatgpt_sign_in: () => {
      if (++signIns === 1) throw { said: "Sign-in was interrupted." };
      return "https://sign-in.example";
    },
    finish_chatgpt_sign_in: "synthetic-token",
  });
  const view = await renderApp();
  await reachAi(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await view.findByText("Sign-in was interrupted.");
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  // Signed in, so on by itself after a second showing the tick, and OpenBot opens once started.
  await expectHandover(4000);
  expect(signIns).toBe(2);
  expect(installationCalls()).toHaveLength(1);
  expect(getStartStackPayload().model).toMatchObject({
    provider: "openai",
    login: "plan",
    token: "synthetic-token",
  });
});

test("a failed automatic reopen offers recovery without retrying or installing", async () => {
  setupConnectedLocalStack(
    "/tmp/reopen-failure",
    localStatus("ready", "valid"),
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "start_stack")
      throw { said: "Return to Install and try again." };
    return previous(command, args);
  };
  const view = await renderApp();
  expect((await view.findByRole("alert")).textContent).toContain(
    "Return to Install and try again.",
  );
  expect(
    invokeCalls.filter((call) => call.command === "start_stack"),
  ).toHaveLength(1);
  expect(installationCalls()).toHaveLength(0);
  expect(view.getByRole("button", { name: "Retry" })).toHaveProperty(
    "disabled",
    false,
  );
  await userEvent.click(
    view.getByRole("button", { name: "Change installation" }),
  );
  expect(view.getByRole("button", { name: "Install OpenBot" })).toBeTruthy();
});

test("menu Stop retains the installed root for explicit Start without the wizard", async () => {
  const root = "/tmp/menu-stopped-installation";
  setupConnectedLocalStack(root, localStatus("ready", "valid"), {
    autoStart: false,
  });
  const view = await renderApp();
  await view.findByRole("heading", { name: "OpenBot is stopped" });
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  await waitFor(() =>
    expect(invokeCalls).toContainEqual({ command: "show_openbot" }),
  );
  expect(getStartStackPayload()).toMatchObject({
    root,
    harness: { id: "mastra" },
  });
  expect(installationCalls()).toHaveLength(0);
});

test("a completed installation with a recorded stack resumes at the AI step when it has never launched", async () => {
  setupRootConfiguration("/tmp/installed-before-signin", async () => ({
    ...emptyConfiguration(),
    installation: { harness: { id: "langgraph" } },
    localEval: {
      stack: "local-abc123",
      ownership: "created",
      phase: "installed",
    },
  }));
  withLocalCli({});
  const view = await renderApp();
  expect(
    await view.findByRole("heading", { name: "Connect your AI" }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Install" })).toBeNull();
  expect(installationCalls()).toHaveLength(0);
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

/** What an earlier app saved for an installation it connected to hosted Intelligence. */
function previouslyHostedConfiguration(harness: string) {
  return {
    values: {
      INTELLIGENCE_API_KEY: "synthetic-hosted-key",
      INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
      INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.copilotkit.ai",
      OPENBOT_ORGANIZATION_AUTH_URL: "https://company.example",
    },
    saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
    launch: { harness: { id: harness } },
    installation: { harness: { id: harness } },
    autoStart: true,
  };
}

test("an installation an earlier app connected to hosted Intelligence starts at the first screen and keeps its install", async () => {
  const root = "/tmp/previously-hosted";
  setupRootConfiguration(root, async () =>
    previouslyHostedConfiguration("langgraph"),
  );
  withLocalCli(readyLocal());
  const view = await renderApp();
  await view.findByRole("heading", { name: "Set up OpenBot" });
  expect(buttons(view)).toEqual(["Install"]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Nothing hosted is started, and nothing local either, until Install.
  expect(
    invokeCalls.some((call) =>
      ["start_stack", "run_local_eval", "set_up_local_eval"].includes(
        call.command,
      ),
    ),
  ).toBe(false);
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  // The finished install of the same Bot is kept.
  expect(installationCalls()).toEqual([]);
  await userEvent.click(view.getByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await expectHandover();
  expect(localSequence()).toEqual([
    "set_up_local_eval",
    "connect_local_eval",
    "run_local_eval",
    "start_stack",
    "show_openbot",
  ]);
  // Started against the local stack, with nothing of the hosted connection.
  expect(getStartStackPayload()).toEqual({
    root,
    ...LOCAL_ADDRESSES,
    harness: { id: "langgraph" },
    model: { provider: "openai", login: "api-key", saved: true },
  });
});

test("a previously hosted installation of another Bot installs the default Bot", async () => {
  const root = "/tmp/previously-hosted-crewai";
  setupRootConfiguration(root, async () =>
    previouslyHostedConfiguration("crewai"),
  );
  withLocalCli(readyLocal());
  const view = await renderApp();
  await view.findByRole("heading", { name: "Set up OpenBot" });
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(installationCalls()).toEqual([
    {
      command: "prepare_installation",
      args: { root, harness: { id: "langgraph" } },
    },
  ]);
});

test.each(["model", "intelligence"])(
  "a runtime %s authentication notification focuses refresh without adopting the running app",
  async (connection) => {
    useInterruptedShutdownSetup();
    const previous = invokeHandler;
    invokeHandler = async (command, args) => {
      if (command === "last_failure")
        return { said: "Connection was refused.", connection };
      if (command === "already_running") return true;
      return previous(command, args);
    };
    const view = await renderApp();
    expect(
      view.getByRole("heading", {
        name:
          connection === "model"
            ? "Refresh your AI connection"
            : "Finishing setup",
      }),
    ).toBeTruthy();
    expect(
      invokeCalls.some((call) =>
        ["start_stack", "show_openbot", "already_running"].includes(
          call.command,
        ),
      ),
    ).toBe(false);
    expect(installationCalls()).toHaveLength(0);
    expect(view.queryByRole("button", { name: "Install" })).toBeNull();
  },
);

test.each(["model", "intelligence"])(
  "an unavailable saved %s connection opens only its refresh screen and returns to the existing app",
  async (connection) => {
    const root = "/tmp/installed-refresh";
    setupConnectedLocalStack(root, localStatus("ready", "valid"));
    const previous = invokeHandler;
    let starts = 0;
    invokeHandler = async (command, args) => {
      if (command === "start_stack" && starts++ === 0)
        throw {
          said:
            connection === "model"
              ? "That saved OpenAI API key is no longer available."
              : "OpenBot's connection to its backend on this computer is no longer available. Set up the backend again.",
          connection,
        };
      return previous(command, args);
    };
    const view = await renderApp();
    await view.findByRole("heading", {
      name:
        connection === "model"
          ? "Refresh your AI connection"
          : "Finishing setup",
    });
    expect(
      view
        .getAllByRole("alert")
        .some((alert) => alert.textContent?.includes("no longer available")),
    ).toBe(true);
    expect(view.queryByRole("button", { name: "Install" })).toBeNull();
    if (connection === "model") {
      // The provider's fields render after the heading: wait for the one typed into.
      await userEvent.type(
        await view.findByLabelText("OpenAI API key"),
        "refreshed-provider-key",
      );
      await userEvent.click(view.getByRole("button", { name: "Continue" }));
    } else {
      await userEvent.click(view.getByRole("button", { name: "Retry" }));
    }
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({ command: "show_openbot" }),
    );
    const startsMade = invokeCalls.filter(
      (call) => call.command === "start_stack",
    );
    expect(startsMade).toHaveLength(2);
    expect(startsMade[1].args).toMatchObject({
      root,
      harness: { id: "mastra" },
      ...(connection === "model"
        ? { model: { apiKey: "refreshed-provider-key" } }
        : {}),
    });
    expect(installationCalls()).toHaveLength(0);
  },
);

const INSTALL_AGAIN = {
  said: "Finish installing OpenBot's local software before signing in or starting. Return to Install and try again.",
  connection: "installation",
};

/**
 * An installation from an earlier app, saved Claude plan sign-in and all, opened by a newer one:
 * its deployment is one this app cannot start, so Start is refused until Install lays out the new
 * one, and the window installs again by itself.
 *
 * Seen on a Mac replacing OpenBot 0.3.1: Starting OpenBot, then Installing OpenBot under an alert
 * "OpenBot did not start", then "Refresh your AI connection", though nothing about the sign-in had
 * changed and Continue with it started OpenBot at once. The Start was only waiting on the install,
 * and after the install it carries on with the saved sign-in.
 */
async function reopenAfterUpdate(
  root: string,
  startStack: (starts: number) => unknown,
) {
  setupConnectedLocalStack(root, localStatus("ready", "valid"), {
    saved: { ...savedOpenAiConfiguration().saved, model: "claude-plan" },
    // Installed with the default Bot, as the window itself installs: what it recorded as finished
    // has to be installed again all the same.
    launch: { harness: { id: "langgraph" } },
  });
  const installed = deferred<null>();
  const previous = invokeHandler;
  let starts = 0;
  invokeHandler = async (command, args) => {
    if (command === "start_stack") return startStack(++starts);
    if (command === "prepare_installation") return installed.promise;
    return previous(command, args);
  };
  const view = await renderApp();
  await view.findByRole("heading", { name: "Installing OpenBot" });
  return { view, installed };
}

function startsMade() {
  return invokeCalls.filter((call) => call.command === "start_stack");
}

test("a Start that waits for the install it asked for carries on with the saved sign-in", async () => {
  const root = "/tmp/installed-upgrade";
  const { view, installed } = await reopenAfterUpdate(root, (starts) => {
    if (starts === 1) throw INSTALL_AGAIN;
    return null;
  });
  // Waiting on the install is not a Start that failed.
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByText(/did not start/)).toBeNull();
  expect(
    invokeCalls.find((call) => call.command === "prepare_installation")?.args,
  ).toMatchObject({ root });

  await act(async () => installed.resolve(null));
  await view.findByRole("heading", { name: "OpenBot is running" });
  // Never asked to pick the AI it already had.
  expect(
    view.queryByRole("heading", { name: /AI connection|Connect your AI/ }),
  ).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  expect(startsMade()).toHaveLength(2);
  expect(startsMade()[1].args).toMatchObject({
    root,
    ...LOCAL_ADDRESSES,
    model: { provider: "anthropic", login: "plan", saved: true },
  });
  expect(
    invokeCalls.filter((call) => call.command === "show_openbot"),
  ).toHaveLength(1);
  expect(
    invokeCalls.filter((call) => call.command === "prepare_installation"),
  ).toHaveLength(1);
});

test("a saved sign-in refused after the install sends the person to refresh it", async () => {
  const root = "/tmp/installed-upgrade-refused-sign-in";
  const { view, installed } = await reopenAfterUpdate(root, (starts) => {
    if (starts === 1) throw INSTALL_AGAIN;
    throw {
      said: "Your Claude sign-in has expired. Sign in again.",
      connection: "model",
    };
  });
  await act(async () => installed.resolve(null));
  await view.findByRole("heading", { name: "Refresh your AI connection" });
  expect(
    view
      .getAllByRole("alert")
      .some((alert) => alert.textContent?.includes("has expired")),
  ).toBe(true);
  expect(startsMade()).toHaveLength(2);
});

test("a Start refused again straight after its install says so, and does not install round in a loop", async () => {
  const { view, installed } = await reopenAfterUpdate(
    "/tmp/installed-upgrade-refused-again",
    () => {
      throw INSTALL_AGAIN;
    },
  );
  await act(async () => installed.resolve(null));
  await view.findByRole("alert", { name: "OpenBot" });
  // The second install the refusal asks for goes to the AI screen, from which Start runs again.
  await view.findByRole("heading", { name: /AI connection|Connect your AI/ });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(startsMade()).toHaveLength(2);
  expect(
    invokeCalls.filter((call) => call.command === "prepare_installation"),
  ).toHaveLength(2);
});

test("a refused provider's failure sits in the AI card and goes when another provider is chosen", async () => {
  setupConnectedLocalStack(
    "/tmp/installed-switch-provider",
    localStatus("ready", "valid"),
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "last_failure")
      return { said: "OpenAI refused the saved API key.", connection: "model" };
    if (command === "providers")
      return [
        {
          id: "openai",
          name: "OpenAI",
          summary: "Use OpenAI.",
          logins: ["api-key"],
          mark: null,
          caution: null,
        },
        {
          id: "anthropic",
          name: "Anthropic",
          summary: "Use Claude.",
          logins: ["api-key"],
          mark: null,
          caution: null,
        },
      ];
    return previous(command, args);
  };
  const view = await renderApp();
  const heading = await view.findByRole("heading", {
    name: "Refresh your AI connection",
  });
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain("OpenAI refused the saved API key.");
  // Inside the card it belongs to, not under it.
  expect(alert.closest(".sheet")).toBe(heading.closest(".sheet"));

  await userEvent.click(
    view.getByRole("button", { name: "Choose a different provider" }),
  );
  expect(view.queryByRole("alert")).toBeNull();
  await userEvent.click(view.getByRole("radio", { name: /Anthropic/ }));
  expect(view.queryByRole("alert")).toBeNull();
});

test("reopening a retained root waits for its saved setup without flashing the wizard", async () => {
  const root = "/tmp/reopen-pending-configuration";
  const configuration = deferred<ReturnType<typeof savedOpenAiConfiguration>>();
  setupRootConfiguration(root, async () => configuration.promise);
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "selected_root") return root;
    return previous(command, args);
  };
  const view = await renderApp();
  expect(
    view.getByRole("heading", { name: "Getting OpenBot ready" }),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Install" })).toBeNull();
  await act(async () => configuration.resolve(savedOpenAiConfiguration()));
  // A retained folder with no successful launch still needs the setup screens.
  expect(await view.findByRole("button", { name: "Install" })).toBeTruthy();
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

function useInterruptedShutdownSetup() {
  const root = "/tmp/interrupted-shutdown-root";
  const notice = "OpenBot had trouble shutting down last time.";
  setupConnectedLocalStack("/tmp/default-root", localStatus("ready", "valid"));
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "selected_root") return root;
    if (command === "last_failure") return { said: notice };
    return previous(command, args);
  };
  return { root, notice };
}

test("a local Intelligence stack left running at Quit is shown without holding auto-start", async () => {
  useInterruptedShutdownSetup();
  const notice = {
    said: "When OpenBot last quit, some of its services didn't stop. They may still be running. Stopping OpenBot again asks them to stop.",
    detail: "Backend stop failed: the CLI timed out",
  };
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "last_failure") return null;
    if (command === "last_local_eval_stop_failure") return notice;
    return previous(command, args);
  };
  const view = await renderApp();
  await waitFor(() =>
    expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
      true,
    ),
  );
  expect(view.getByRole("alert").textContent).toContain(notice.said);
});

test("Stop that fails only for the local Intelligence stack still stops OpenBot", async () => {
  useInterruptedShutdownSetup();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "last_failure") return null;
    if (command === "stop_stack")
      throw "Backend stop failed: the CLI timed out";
    return previous(command, args);
  };
  const view = await renderApp();
  await userEvent.click(
    await view.findByRole("button", { name: "Stop OpenBot" }),
  );
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop OpenBot" })).toBeNull(),
  );
  expect(view.getByRole("alert").textContent).toContain(
    "OpenBot stopped, but some of its services didn't. They may still be running.",
  );
});

test("Stop that fails for OpenBot itself keeps OpenBot running", async () => {
  useInterruptedShutdownSetup();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "last_failure") return null;
    if (command === "stop_stack")
      throw "Compose down failed: busy\nBackend stop failed: the CLI timed out";
    return previous(command, args);
  };
  const view = await renderApp();
  await userEvent.click(
    await view.findByRole("button", { name: "Stop OpenBot" }),
  );
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain(
      "Compose down failed: busy",
    ),
  );
  expect(view.getByRole("button", { name: "Stop OpenBot" })).toBeTruthy();
});

test("an interrupted shutdown restores saved setup for explicit recovery", async () => {
  const { root, notice } = useInterruptedShutdownSetup();
  const view = await renderApp();
  expect(view.getByRole("alert").textContent).toContain(notice);
  expect(view.queryByRole("button", { name: "Install" })).toBeNull();
  expect(
    view.getByRole("heading", { name: "OpenBot is stopped" }),
  ).toBeTruthy();
  const start = view.getByRole("button", { name: "Start OpenBot" });
  expect(start).toHaveProperty("disabled", false);
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );

  await userEvent.click(start);
  await waitFor(() =>
    expect(invokeCalls).toContainEqual({ command: "show_openbot" }),
  );

  expect(getStartStackPayload()).toEqual({
    root,
    ...LOCAL_ADDRESSES,
    harness: { id: "mastra" },
    model: { provider: "openai", login: "api-key", saved: true },
  });
  expect(
    invokeCalls.filter((call) => call.command === "start_stack"),
  ).toHaveLength(1);
  expect(
    invokeCalls.some((call) =>
      /prepare_|sign_in|^providers$|^harnesses$/.test(call.command),
    ),
  ).toBe(false);
  expect(view.queryByText(notice)).toBeNull();
  expect(invokeCalls).toContainEqual({ command: "show_openbot" });
});

/*
 * The report: somebody on 1.0.0 could not find which AI they had signed in with, or change it.
 * Settings' AI model row has a Change, which stops OpenBot and brings this window back. It opens at
 * the AI screen, the one Change AI connection opens, and the new choice is what starts OpenBot.
 */
test("Settings' Change AI connection opens setup at the AI screen and starts with the new choice", async () => {
  setupConnectedLocalStack(
    "/tmp/settings-change-ai-connection",
    localStatus("ready", "valid"),
    // Stopped in this session, as the Change from Settings leaves it.
    { autoStart: false },
  );
  const previous = invokeHandler;
  let asked = true;
  invokeHandler = async (command, args) => {
    if (command === "take_ai_connection_change") {
      const answer = asked;
      asked = false;
      return answer;
    }
    return previous(command, args);
  };
  const view = await renderApp();
  await view.findByLabelText("OpenAI API key");
  expect(
    view.queryByRole("heading", { name: "OpenBot is stopped" }),
  ).toBeNull();
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
  await userEvent.type(view.getByLabelText("OpenAI API key"), "new-model-key");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(invokeCalls).toContainEqual({ command: "show_openbot" }),
  );
  expect(getStartStackPayload()).toMatchObject({
    model: { apiKey: "new-model-key" },
  });
});

test("Back from Settings' Change AI connection shows the stopped screen with Start", async () => {
  setupConnectedLocalStack(
    "/tmp/settings-change-ai-connection-back",
    localStatus("ready", "valid"),
    { autoStart: false },
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) =>
    command === "take_ai_connection_change" ? true : previous(command, args);
  const view = await renderApp();
  await view.findByLabelText("OpenAI API key");
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  await view.findByRole("heading", { name: "OpenBot is stopped" });
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

test("changing the saved model during recovery still opens OpenBot after Start", async () => {
  useInterruptedShutdownSetup();
  const view = await renderApp();
  await userEvent.click(
    view.getByRole("button", { name: "Change AI connection" }),
  );
  await userEvent.type(view.getByLabelText("OpenAI API key"), "new-model-key");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(invokeCalls).toContainEqual({ command: "show_openbot" }),
  );
  expect(getStartStackPayload()).toMatchObject({
    model: { apiKey: "new-model-key" },
  });
  expect(view.queryByRole("button", { name: "Ask" })).toBeNull();
});

test.each(["supervisor", "windows"])(
  "automatic reopen respects the existing %s blocker",
  async (blocker) => {
    setupConnectedLocalStack(
      "/tmp/reopen-blocked",
      localStatus("ready", "valid"),
    );
    const previous = invokeHandler;
    invokeHandler = async (command, args) => {
      if (blocker === "supervisor" && command === "last_failure")
        return { said: "The supervisor stopped retrying." };
      if (blocker === "windows" && command === "windows_blocker")
        return "wsl-absent";
      if (command === "windows_blocker_instruction")
        return "Install WSL: run `wsl --install`.";
      return previous(command, args);
    };
    const view = await renderApp();
    await waitFor(() =>
      expect(
        invokeCalls.some((call) => call.command === "already_running"),
      ).toBe(true),
    );
    expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
      false,
    );
    expect(installationCalls()).toHaveLength(0);
    expect(
      view.getByText(
        blocker === "supervisor"
          ? "The supervisor stopped retrying."
          : "wsl --install",
      ),
    ).toBeTruthy();
  },
);

test("setup records telemetry without a consent gate and deduplicates viewed steps", async () => {
  setupRootConfiguration("/tmp/private-setup-root", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    record_setup_event: null,
    set_up_local_eval: () => new Promise(() => {}),
  });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });

  expect(view.queryByRole("checkbox")).toBeNull();
  expect(view.queryByRole("switch")).toBeNull();
  expect(setupEvents()).toEqual([
    { event: { kind: "step_viewed", step: "welcome" } },
  ]);
  await userEvent.click(view.getByRole("button", { name: "Install" }));
  await view.findByRole("heading", { name: "Connect your AI" });

  const events = setupEvents().map(
    (event) => (event as { event: { kind: string; step?: string } }).event,
  );
  expect(events.slice(0, 3)).toEqual([
    { kind: "step_viewed", step: "welcome" },
    { kind: "harness_chosen", harness: "langgraph" } as never,
    { kind: "step_viewed", step: "account" },
  ]);
  expect(events.at(-1)).toEqual({ kind: "step_viewed", step: "model" });
  // Each step once, the development double mount included.
  const viewed = events
    .filter((event) => event.kind === "step_viewed")
    .map((event) => event.step);
  expect(new Set(viewed).size).toBe(viewed.length);
});

test("setup records only model categories and opens OpenBot when telemetry is unavailable", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "record_setup_event") throw new Error("offline");
    return previous(command, args);
  };
  const privateUrl = "https://private-model.example/v1";
  const privateKey = "synthetic-secret-endpoint-key";
  const view = await enterCompatibleEndpoint(privateUrl, privateKey);
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(setupEvents()).toContainEqual({
    event: {
      kind: "model_chosen",
      provider: "compatible",
      credential_path: "api_key",
      custom_base_url: true,
    },
  });
  // Continue starts OpenBot, and it opens even though no event could be recorded.
  await expectHandover();
  const serialized = JSON.stringify(setupEvents());
  for (const privateValue of [
    privateUrl,
    privateKey,
    "local-model",
    "/tmp/openbot-app-test",
  ]) {
    expect(serialized).not.toContain(privateValue);
  }
  expect(view.queryByText(/Nothing here leaves this computer/)).toBeNull();
});

type StartStackPayload = {
  root?: unknown;
  apiKey?: unknown;
  apiUrl?: unknown;
  gatewayWsUrl?: unknown;
  harness?: unknown;
  model: {
    provider?: unknown;
    login?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
    containerBaseUrl?: unknown;
    model?: unknown;
    saved?: unknown;
  };
};

function isStartStackPayload(value: unknown): value is StartStackPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "model" in value &&
    typeof value.model === "object" &&
    value.model !== null
  );
}

function getStartStackPayload() {
  const args = invokeCalls.find((call) => call.command === "start_stack")?.args;
  if (!isStartStackPayload(args)) {
    throw new Error("start_stack payload was not captured");
  }
  return args;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function savedOpenAiConfiguration() {
  return {
    values: {},
    saved: {
      modelApiKeys: { openai: true, anthropic: false },
      modelSessions: { openai: false, anthropic: false },
    },
  };
}

function emptyConfiguration() {
  return {
    values: {},
    saved: {
      modelApiKeys: { openai: false, anthropic: false },
      modelSessions: { openai: false, anthropic: false },
    },
  };
}

test("leftover database is offered as a fresh start that carries on into Start", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  const reset = deferred<void>();
  let starts = 0;
  invokeHandler = async (command, args) => {
    if (command === "start_stack" && ++starts === 1)
      throw {
        said: "A previous OpenBot database remains without its encryption key.",
        database_reset: "fixture_postgres-data",
        leftover_reset: ["fixture_postgres-data"],
      };
    if (command === "reset_leftover_database") return reset.promise;
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint(
    "https://model.example/v1",
    "synthetic-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  const resets = () =>
    invokeCalls.filter((call) => call.command === "reset_leftover_database");
  const startFresh = await view.findByRole("button", { name: "Start fresh" });
  // A choice, not a failure: nothing announces that Start did not finish.
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByText(/saved chats, Bots, and settings/)).toBeTruthy();
  expect(view.getByText(/permanently deletes/)).toBeTruthy();
  expect(view.getByText(/with its original encryption key/)).toBeTruthy();
  expect(view.getByText("fixture_postgres-data")).toBeTruthy();
  expect(resets()).toHaveLength(0);
  await userEvent.click(startFresh);
  expect(resets()).toEqual([
    {
      command: "reset_leftover_database",
      args: {
        root: "/tmp/openbot-app-test",
        volumes: ["fixture_postgres-data"],
        containers: [],
        confirmed: true,
      },
    },
  ]);
  expect(view.getByRole("button", { name: "Starting fresh…" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(starts).toBe(1);
  await act(async () => reset.resolve());
  await expectHandover();
  expect(starts).toBe(2);
  expect(installationCalls()).toHaveLength(1);
});

test("starting fresh names every container and volume and removes only that list", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  const volumes = [
    "openbot-profile-general-assistant",
    "openbot-workspace-general-assistant",
    "openbot_agent-profiles",
  ];
  const containers = [
    "openbot-agent-computer-1",
    "openbot-computer-general-assistant",
  ];
  invokeHandler = async (command, args) => {
    if (command === "start_stack")
      throw {
        said: "OpenBot found data from a previous installation.",
        leftover_reset: volumes,
        leftover_containers: containers,
      };
    if (command === "reset_leftover_database") return null;
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint(
    "https://model.example/v1",
    "synthetic-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  const startFresh = await view.findByRole("button", { name: "Start fresh" });
  expect(view.queryByText(/saved chats/)).toBeNull();
  expect(view.queryByText(/encryption key/)).toBeNull();
  expect(view.getByText(/browser sign-ins/)).toBeTruthy();
  expect(
    view.getByText(/Restore the previous installation’s folder/),
  ).toBeTruthy();
  for (const volume of volumes) expect(view.getByText(volume)).toBeTruthy();
  expect(view.getByText(/stopped parts of the previous/)).toBeTruthy();
  for (const container of containers)
    expect(view.getByText(container)).toBeTruthy();
  await userEvent.click(startFresh);
  expect(
    invokeCalls.filter((call) => call.command === "reset_leftover_database"),
  ).toEqual([
    {
      command: "reset_leftover_database",
      args: {
        root: "/tmp/openbot-app-test",
        volumes,
        containers,
        confirmed: true,
      },
    },
  ]);
});

test("a fresh start that cannot delete the leftovers is shown without starting", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "start_stack")
      throw {
        said: "A previous database remains.",
        database_reset: "fixture_postgres-data",
      };
    if (command === "reset_leftover_database")
      throw {
        said: "The database is still in use. Close the other OpenBot installation first.",
      };
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint(
    "https://model.example/v1",
    "synthetic-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Start fresh" }),
  );
  expect(await view.findByText(/database is still in use/)).toBeTruthy();
  expect(view.getByRole("alert")).toBeTruthy();
  expect(
    invokeCalls.filter((call) => call.command === "start_stack"),
  ).toHaveLength(1);
  // The way on is the Start step's own Retry.
  expect(view.getByRole("button", { name: "Retry" })).toHaveProperty(
    "disabled",
    false,
  );
});

function setupRootConfiguration(
  rootA: string,
  loadConfiguration: (root: string) => Promise<unknown>,
) {
  invokeHandler = async (command, args) => {
    if (command === "prepare_installation") return null;
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return rootA;
    if (command === "selected_root") return null;
    if (command === "already_configured") {
      if (
        typeof args !== "object" ||
        args === null ||
        !("root" in args) ||
        typeof args.root !== "string"
      ) {
        throw new Error("already_configured requires a root");
      }
      return loadConfiguration(args.root);
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "providers") {
      return [
        {
          id: "openai",
          name: "OpenAI",
          summary: "Use OpenAI.",
          logins: ["api-key"],
          mark: null,
          caution: null,
        },
      ];
    }
    if (command === "start_stack") return null;
    if (command === "show_openbot") return null;
    if (command === "connect_intelligence_apps") return null;
    // The engine already answers, unless a test says otherwise.
    if (command === "wake_engine") return null;
    if (command === "bring_setup_to_front") return null;
    throw new Error(`unexpected command ${command}`);
  };
}

test("Windows detection failure blocks setup and displays its diagnostic", async () => {
  setupRootConfiguration("/tmp/openbot-windows-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  const problem = {
    said: "OpenBot could not check Windows virtualization support.",
    detail: "powershell exited with 17: synthetic CIM access denied",
  };
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker") throw problem;
    return setupHandler(command, args);
  };

  const view = await renderApp();
  const alert = await view.findByRole("alert");
  expect(alert.textContent).toContain(problem.said);
  await userEvent.click(view.getByText("Technical details"));
  expect(alert.textContent).toContain(problem.detail);
  expect(view.queryByRole("button", { name: "Install" })).toBeNull();
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(
    view.queryByText(/firmware settings|wsl --install|wsl --update/),
  ).toBeNull();
  expect(
    invokeCalls.some((call) => call.command === "windows_blocker_instruction"),
  ).toBe(false);
});

test("a failed Windows blocker instruction is visible instead of an empty blocker", async () => {
  setupRootConfiguration("/tmp/openbot-windows-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker") return "wsl-absent";
    if (command === "windows_blocker_instruction") {
      throw { said: "The blocker instruction could not be read." };
    }
    return setupHandler(command, args);
  };
  const view = await renderApp();
  expect((await view.findByRole("alert")).textContent).toContain(
    "The blocker instruction could not be read.",
  );
  expect(view.queryByRole("button", { name: "Install" })).toBeNull();
});

test("a restart still owed from a Windows fix comes before any check or setup", async () => {
  setupRootConfiguration("/tmp/openbot-windows-restart-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "windows_restart_pending") return true;
    return setupHandler(command, args);
  };
  const view = await renderApp();
  expect(
    await view.findByRole("heading", { name: "Restart Windows to finish" }),
  ).toBeTruthy();
  expect(invokeCalls.some((call) => call.command === "windows_blocker")).toBe(
    false,
  );
  expect(view.queryByRole("button", { name: "Install" })).toBeNull();
});

test("a successfully detected missing WSL feature keeps its setup instruction", async () => {
  setupRootConfiguration("/tmp/openbot-windows-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  const instruction =
    "Run `wsl --install`, restart Windows, and start OpenBot again.";
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker") return "wsl-absent";
    if (command === "windows_blocker_instruction") return instruction;
    return setupHandler(command, args);
  };
  const view = await renderApp();
  expect(await view.findByText("wsl --install")).toBeTruthy();
  expect(
    view.getByRole("heading", { name: "Turn on Windows Subsystem for Linux" }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Copy" })).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Install" })).toBeNull();
});

test("disabled Virtual Machine Platform displays its feature-specific fix and blocks setup", async () => {
  setupRootConfiguration("/tmp/openbot-vmp-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  const instruction =
    "Virtual Machine Platform is switched off. Open Windows Terminal or PowerShell as an administrator, run `dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart`, restart Windows, and start OpenBot again.";
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker")
      return "virtual-machine-platform-disabled";
    if (command === "windows_blocker_instruction") {
      expect(args).toEqual({ blocker: "virtual-machine-platform-disabled" });
      return instruction;
    }
    return setupHandler(command, args);
  };
  const view = await renderApp();
  expect(
    await view.findByText(
      "dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart",
    ),
  ).toBeTruthy();
  expect(
    view.getByRole("heading", { name: "Turn on Virtual Machine Platform" }),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Install" })).toBeNull();
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(
    invokeCalls.some((call) =>
      ["prepare_installation", "prepare_engine", "start_stack"].includes(
        call.command,
      ),
    ),
  ).toBe(false);
});

type ExistingConfigurationValues = {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_BASE_URL?: string;
};

function useCompatibleEndpointSetup(
  existingValues: ExistingConfigurationValues,
) {
  invokeHandler = async (command) => {
    if (command === "prepare_installation") return null;
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: existingValues,
        saved: {
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "providers") {
      return [
        {
          id: "openai-compatible",
          name: "OpenAI-compatible",
          summary: "Use your own endpoint.",
          logins: ["endpoint"],
          mark: null,
          caution: null,
        },
      ];
    }
    if (command === "start_stack") return null;
    if (command === "show_openbot") return null;
    if (command === "wake_engine") return null;
    throw new Error(`unexpected command ${command}`);
  };
  withLocalCli(readyLocal());
}

async function enterCompatibleEndpoint(
  baseUrl: string,
  endpointKey = "",
  containerBaseUrl = "",
) {
  const view = await renderApp();

  await reachAi(view);
  await userEvent.click(
    await view.findByRole("radio", { name: /OpenAI-compatible/ }),
  );
  await userEvent.type(view.getByLabelText("Base URL"), baseUrl);
  if (containerBaseUrl) {
    await userEvent.type(
      view.getByLabelText("Container Base URL, if different"),
      containerBaseUrl,
    );
  }
  await userEvent.type(view.getByLabelText("Model name"), "local-model");
  if (endpointKey) {
    await userEvent.type(
      view.getByLabelText("API key, if the endpoint needs one"),
      endpointKey,
    );
  }
  return view;
}

async function startWithCompatibleEndpoint(
  endpointKey = "",
  baseUrl = "https://models.example/v1",
  containerBaseUrl = "",
) {
  const view = await enterCompatibleEndpoint(
    baseUrl,
    endpointKey,
    containerBaseUrl,
  );
  // The go-ahead: OpenBot starts once local Intelligence reports ready.
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitForStart();
}

async function waitForStart(timeout?: number) {
  await waitFor(
    () =>
      expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
        true,
      ),
    timeout ? { timeout } : undefined,
  );
}

function useSavedCompatibleEndpointSetup(
  baseUrl = "https://models.example/v1",
  model = "saved-model",
  keyed = true,
  savedModel = "compatible-endpoint",
  containerBaseUrl: string | undefined = undefined,
) {
  useCompatibleEndpointSetup({});
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "already_configured") {
      return {
        values: {
          OPENAI_BASE_URL: baseUrl,
          ...(containerBaseUrl === undefined
            ? {}
            : { OPENAI_CONTAINER_BASE_URL: containerBaseUrl }),
          BOT_MODEL: model,
        },
        saved: {
          model: savedModel,
          modelApiKeys: { compatible: keyed },
          modelSessions: {},
        },
      };
    }
    return setupHandler(command, args);
  };
}

test.each([true, false])(
  "saved compatible endpoint reaches Start with scoped public fields (keyed=%s)",
  async (keyed) => {
    useSavedCompatibleEndpointSetup(undefined, undefined, keyed);
    const view = await renderApp();
    await reachAi(view);
    expect(view.getByLabelText("Base URL")).toHaveProperty(
      "value",
      "https://models.example/v1",
    );
    expect(view.getByLabelText("Model name")).toHaveProperty(
      "value",
      "saved-model",
    );
    expect(
      view.getByLabelText("API key, if the endpoint needs one"),
    ).toHaveProperty("value", "");
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    await waitForStart();
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(getStartStackPayload()).toEqual({
      root: "/tmp/openbot-app-test",
      ...LOCAL_ADDRESSES,
      harness: { id: "langgraph" },
      model: {
        provider: "openai-compatible",
        login: "endpoint",
        baseUrl: "https://models.example/v1",
        model: "saved-model",
        ...(keyed ? { saved: true } : {}),
      },
    });
  },
);

test.each([
  ["", "saved-model"],
  ["https://models.example/v1", ""],
  ["https://models.example/v1", "   "],
  ["ftp://models.example/v1", "saved-model"],
  ["https://", "saved-model"],
])(
  "incomplete saved endpoint stays on the provider screen (%s, %s)",
  async (baseUrl, model) => {
    useSavedCompatibleEndpointSetup(baseUrl, model);
    const view = await renderApp();
    await reachAi(view);
    expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
    expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
      false,
    );
  },
);

test("an unsupported saved model kind does not become a startable endpoint", async () => {
  useSavedCompatibleEndpointSetup(
    undefined,
    undefined,
    true,
    "unsupported-model",
  );
  const view = await renderApp();
  await reachAi(view);
  expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

test("mount navigates to OpenBot only when the selected root is already owned and running", async () => {
  const root = "/tmp/openbot-owned-running-root";
  setupRootConfiguration(root, async () => emptyConfiguration());
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "already_running") {
      expect(args).toEqual({ root });
      return true;
    }
    return setupHandler(command, args);
  };

  await renderApp();
  await waitFor(() =>
    expect(invokeCalls).toContainEqual({ command: "show_openbot" }),
  );
});

test("mount leaves setup visible when the shared port answers without selected root ownership", async () => {
  const root = "/tmp/openbot-unowned-running-root";
  setupRootConfiguration(root, async () => emptyConfiguration());

  const view = await renderApp();

  expect(await view.findByRole("button", { name: "Install" })).toBeTruthy();
  expect(invokeCalls.some((call) => call.command === "show_openbot")).toBe(
    false,
  );
});

for (const staleProbe of [false, true]) {
  test(`recovery mount keeps setup available after ${staleProbe ? "a stale positive" : "a negative"} adoption probe`, async () => {
    setupRootConfiguration("/tmp/openbot-worker-recovery", async () =>
      emptyConfiguration(),
    );
    const setupHandler = invokeHandler;
    const failure = {
      said: "Part of OpenBot (worker) stopped and could not be started again. Try starting OpenBot once more.",
    };
    invokeHandler = async (command, args) => {
      if (command === "already_running") return staleProbe;
      if (command === "last_failure") return failure;
      if (command === "show_openbot") throw failure;
      return setupHandler(command, args);
    };
    const view = await renderApp();
    await waitFor(() =>
      expect(
        invokeCalls.some((call) => call.command === "already_running"),
      ).toBe(true),
    );
    if (staleProbe) {
      await waitFor(() =>
        expect(
          invokeCalls.some((call) => call.command === "show_openbot"),
        ).toBe(true),
      );
    }
    expect(view.getByRole("button", { name: "Install" })).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain(failure.said);
    expect(view.queryByRole("button", { name: "Stop OpenBot" })).toBeNull();
  });
}

test("saved startup credentials start without raw protected secrets on mount", async () => {
  setupRootConfiguration("/tmp/openbot-app-test", async () =>
    savedOpenAiConfiguration(),
  );
  withLocalCli(readyLocal());

  const view = await renderApp();
  await reachAi(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitForStart();

  expect(getStartStackPayload().model).toEqual({
    provider: "openai",
    login: "api-key",
    saved: true,
  });
  expect(
    invokeCalls.filter((call) => call.command === "already_configured"),
  ).toHaveLength(1);
});

test("same-process setup remount prefers the retained selected root", async () => {
  const rootA = "/tmp/openbot-default-root";
  const rootB = "/tmp/openbot-retained-root";
  setupRootConfiguration(rootA, async (requestedRoot) => {
    if (requestedRoot !== rootB)
      throw new Error(`unexpected already_configured root ${requestedRoot}`);
    return savedOpenAiConfiguration();
  });
  const setupHandler = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "selected_root") return rootB;
    return setupHandler(command, args);
  };
  withLocalCli(readyLocal());

  const view = await renderApp();
  await reachAi(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitForStart();

  expect(
    invokeCalls.filter((call) => call.command === "already_configured"),
  ).toEqual([{ command: "already_configured", args: { root: rootB } }]);
  expect(installationCalls()[0].args).toMatchObject({ root: rootB });
  expect(getStartStackPayload().root).toBe(rootB);
});

test.each([
  "http://",
  "https://",
  "httpx://models.example/v1",
  "httpfoo://models.example/v1",
  "https://exa mple.example/v1",
])("custom compatible endpoint refuses startup for URL %s", async (baseUrl) => {
  useCompatibleEndpointSetup({});
  const view = await enterCompatibleEndpoint(baseUrl);

  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);
  await userEvent.click(continueButton);
  expect(view.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(invokeCalls.filter((call) => call.command === "start_stack")).toEqual(
    [],
  );
});

test.each(["http://localhost:11434/v1", "https://models.example/v1"])(
  "custom compatible endpoint startup for URL %s does not submit a saved OpenAI API key",
  async (baseUrl) => {
    useCompatibleEndpointSetup({
      OPENAI_API_KEY: "sk-synthetic-openai",
    });

    await startWithCompatibleEndpoint("", baseUrl);

    const payload = getStartStackPayload();
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(payload).toEqual({
      root: "/tmp/openbot-app-test",
      ...LOCAL_ADDRESSES,
      harness: { id: "langgraph" },
      model: {
        provider: "openai-compatible",
        login: "endpoint",
        baseUrl,
        model: "local-model",
      },
    });
    expect(payload.model).not.toHaveProperty("apiKey");
    expect(JSON.stringify(payload)).not.toContain("sk-synthetic-openai");
  },
);

test("custom compatible endpoint startup can route containers to a different public URL", async () => {
  useCompatibleEndpointSetup({});

  await startWithCompatibleEndpoint(
    "",
    "http://127.0.0.1:11434/v1",
    "http://ollama:11434/v1",
  );

  const payload = getStartStackPayload();
  expect(payload.model).toEqual({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "http://127.0.0.1:11434/v1",
    containerBaseUrl: "http://ollama:11434/v1",
    model: "local-model",
  });
});

test("saved compatible endpoint restores the optional container URL", async () => {
  useSavedCompatibleEndpointSetup(
    "http://127.0.0.1:11434/v1",
    "qwen3-vl:2b",
    false,
    "compatible-endpoint",
    "http://ollama:11434/v1",
  );

  const view = await renderApp();
  await reachAi(view);

  expect(
    view.getByLabelText("Container Base URL, if different"),
  ).toHaveProperty("value", "http://ollama:11434/v1");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitForStart();

  expect(getStartStackPayload().model).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    baseUrl: "http://127.0.0.1:11434/v1",
    containerBaseUrl: "http://ollama:11434/v1",
    model: "qwen3-vl:2b",
  });
});

test("custom compatible endpoint startup submits an explicitly typed endpoint key", async () => {
  useCompatibleEndpointSetup({
    OPENAI_API_KEY: "sk-synthetic-openai",
  });

  await startWithCompatibleEndpoint("endpoint-key");

  const payload = getStartStackPayload();
  expect(payload.model).toMatchObject({
    provider: "openai-compatible",
    login: "endpoint",
    apiKey: "endpoint-key",
    baseUrl: "https://models.example/v1",
    model: "local-model",
  });
  expect(JSON.stringify(payload)).not.toContain("sk-synthetic-openai");
});

for (const provider of [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
] as const) {
  test.each(["fresh", "saved"])(
    `${provider.name} %s plan startup omits a key typed before switching login tabs`,
    async (session) => {
      const planToken = `synthetic-${provider.id}-plan-token`;
      const hiddenKey = `sk-synthetic-${provider.id}-hidden`;
      setupRootConfiguration("/tmp/openbot-app-test", async () => ({
        ...emptyConfiguration(),
        saved: {
          ...emptyConfiguration().saved,
          modelSessions: { [provider.id]: session === "saved" },
        },
      }));
      const setupHandler = invokeHandler;
      invokeHandler = async (command, args) => {
        if (command === "providers") {
          return [
            {
              ...provider,
              summary: `Use ${provider.name}.`,
              logins: ["plan", "api-key"],
              mark: null,
              caution: null,
            },
          ];
        }
        if (session === "fresh") {
          const signIn = provider.id === "openai" ? "chatgpt" : "claude";
          if (command === `begin_${signIn}_sign_in`)
            return "https://sign-in.example";
          if (command === `finish_${signIn}_sign_in`) return planToken;
        }
        return setupHandler(command, args);
      };
      withLocalCli(readyLocal());

      const view = await renderApp();
      await reachAi(view);
      await userEvent.click(
        await view.findByRole("radio", { name: new RegExp(provider.name) }),
      );
      await userEvent.click(view.getByRole("tab", { name: "Use an API key" }));
      await userEvent.type(
        view.getByLabelText(`${provider.name} API key`),
        hiddenKey,
      );
      await userEvent.click(
        view.getByRole("tab", { name: "Sign in with my plan" }),
      );
      if (session === "fresh") {
        await userEvent.click(
          view.getByRole("button", { name: `Sign in with ${provider.name}` }),
        );
        if (provider.id === "anthropic") {
          await userEvent.type(
            await view.findByLabelText("Code from your browser"),
            "synthetic-code",
          );
          await userEvent.click(
            view.getByRole("button", { name: "Finish signing in" }),
          );
        }
      }
      // A fresh sign-in moves on by itself; a saved one is only offered, so it waits for Continue.
      if (session === "saved") {
        await view.findByText(
          new RegExp(`A saved ${provider.name} sign-in will be checked`),
        );
        await userEvent.click(view.getByRole("button", { name: "Continue" }));
      }
      // A fresh sign-in shows its tick for a second before it moves on.
      await waitForStart(4000);

      const payload = getStartStackPayload();
      expect(payload.model).not.toHaveProperty("apiKey");
      expect(payload.model).toEqual({
        provider: provider.id,
        login: "plan",
        ...(session === "saved" ? { saved: true } : { token: planToken }),
      });
      expect(JSON.stringify(payload)).not.toContain(hiddenKey);
    },
  );

  test(`saved ${provider.name} plan session starts without raw protected secrets on mount`, async () => {
    setupRootConfiguration("/tmp/openbot-app-test", async () => ({
      values: {},
      saved: {
        modelApiKeys: { openai: false, anthropic: false },
        modelSessions: {
          openai: provider.id === "openai",
          anthropic: provider.id === "anthropic",
        },
      },
    }));
    const setupHandler = invokeHandler;
    invokeHandler = async (command, args) =>
      command === "providers"
        ? [
            {
              id: provider.id,
              name: provider.name,
              summary: `Use ${provider.name}.`,
              logins: ["plan", "api-key"],
              mark: null,
              caution: null,
            },
          ]
        : setupHandler(command, args);
    withLocalCli(readyLocal());

    const view = await renderApp();
    await reachAi(view);
    await userEvent.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    expect(
      view.getByText(
        new RegExp(`A saved ${provider.name} sign-in will be checked`),
      ),
    ).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    await waitForStart();

    expect(
      invokeCalls.filter((call) => call.command === "already_configured"),
    ).toEqual([
      {
        command: "already_configured",
        args: { root: "/tmp/openbot-app-test" },
      },
    ]);
    for (const call of invokeCalls) {
      const args = JSON.stringify(call.args ?? {});
      expect(args).not.toContain("OPENAI_API_KEY");
      expect(args).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    }
    expect(getStartStackPayload()).toMatchObject({
      root: "/tmp/openbot-app-test",
      model: {
        provider: provider.id,
        login: "plan",
        saved: true,
      },
      harness: { id: "langgraph" },
    });
    expect(getStartStackPayload()).not.toHaveProperty("apiKey");
  });
}

for (const provider of [
  { id: "openai", name: "OpenAI", plan: "ChatGPT" },
  { id: "anthropic", name: "Anthropic", plan: "Claude" },
]) {
  for (const login of ["plan", "api-key"] as const) {
    test(`unknown legacy ${provider.name} ${login} reuse stays passive until Continue`, async () => {
      setupRootConfiguration("/tmp/synthetic-legacy-root", async () => ({
        values: {},
        saved: {},
      }));
      const setupHandler = invokeHandler;
      invokeHandler = async (command, args) => {
        if (command === "providers")
          return [
            {
              ...provider,
              summary: "Synthetic provider",
              logins: ["plan", "api-key"],
              mark: null,
              caution: null,
            },
          ];
        if (command === "start_stack")
          throw {
            said: "Synthetic saved credential is unavailable.",
            detail: "Synthetic denial",
          };
        return setupHandler(command, args);
      };
      withLocalCli(readyLocal());
      const view = await renderApp();
      await reachAi(view);
      await userEvent.click(
        await view.findByRole("radio", { name: new RegExp(provider.name) }),
      );
      if (login === "api-key")
        await userEvent.click(
          view.getByRole("tab", { name: "Use an API key" }),
        );
      await userEvent.click(
        view.getByRole("button", {
          name:
            login === "plan"
              ? `Use a saved ${provider.plan} sign-in`
              : `Use a saved ${provider.name} API key`,
        }),
      );
      // Choosing to reuse it signs in to nothing and starts nothing.
      expect(
        invokeCalls.some((call) =>
          /_sign_in$|start_stack|show_openbot/.test(call.command),
        ),
      ).toBe(false);
      await userEvent.click(view.getByRole("button", { name: "Continue" }));
      await view.findByText("Synthetic saved credential is unavailable.");
      expect(getStartStackPayload()).toMatchObject({
        model: { provider: provider.id, login, saved: true },
      });
      expect(getStartStackPayload()).not.toHaveProperty("apiKey");
      expect(getStartStackPayload().model).not.toHaveProperty("token");
      expect(getStartStackPayload().model).not.toHaveProperty("apiKey");
    });
  }
}

test("Start credential failures do not expose a restore action", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "start_stack")
      throw {
        said: "Saved credential needs authorization.",
        detail: "synthetic item refusal",
        [["reco", "very"].join("")]: {
          ticket: "synthetic-one-use",
          operation: "read",
          setting: "INTELLIGENCE_API_KEY",
          label: "Restore access to saved setup",
          explanation:
            "This Mac is protecting a credential from your saved OpenBot setup. Restoring access may ask macOS to confirm this app. Your saved data stays in place.",
        },
      };
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint(
    "https://models.example/v1",
    "synthetic-model-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(
    await view.findByText("Saved credential needs authorization."),
  ).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Restore access to saved setup" }),
  ).toBeNull();
  expect(
    invokeCalls.some((c) => c.command === ["reco", "ver_credential"].join("")),
  ).toBe(false);
  expect(
    invokeCalls.filter(
      (c) => c.command === ["cancel", "_credential", "_reco", "very"].join(""),
    ),
  ).toEqual([]);
});

const INSTALL_REQUIRED =
  "Finish installing OpenBot's local software before signing in or starting. Return to Install and try again.";

function withAnthropicPlan(begin: () => unknown) {
  withLocalCli({
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        summary: "Sign in with a Claude plan.",
        logins: ["plan", "api-key"],
        mark: null,
        caution: null,
      },
    ],
    begin_claude_sign_in: begin,
    finish_claude_sign_in: "synthetic-plan-token",
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
}

test("a plan sign-in refused for a stale installation goes back to Install and returns to the same provider", async () => {
  setupRootConfiguration("/tmp/stale-install", async () =>
    emptyConfiguration(),
  );
  let refused = true;
  withAnthropicPlan(() => {
    if (refused)
      throw {
        said: INSTALL_REQUIRED,
        detail:
          "The deployment folder or Bot selection changed after installation.",
      };
    return "https://claude.example/authorize";
  });
  const view = await renderApp();
  await installLocal(view);
  await userEvent.click(await view.findByRole("radio", { name: /Anthropic/ }));
  await userEvent.click(
    await view.findByRole("button", { name: "Sign in with Anthropic" }),
  );
  expect((await view.findByRole("alert")).textContent).toContain(
    INSTALL_REQUIRED,
  );
  expect(stepLabel(view)).toContain("Install");
  refused = false;
  await userEvent.click(view.getByRole("button", { name: "Install OpenBot" }));
  const radio = await view.findByRole("radio", { name: /Anthropic/ });
  expect((radio as HTMLInputElement).checked).toBe(true);
  expect(stepLabel(view)).toContain("AI");
  expect(view.queryByRole("alert")).toBeNull();
});

test("any other plan sign-in failure still shows inline on the AI step", async () => {
  setupRootConfiguration("/tmp/other-failure", async () =>
    emptyConfiguration(),
  );
  withAnthropicPlan(() => {
    throw { said: "Sign-in was interrupted." };
  });
  const view = await renderApp();
  await installLocal(view);
  await userEvent.click(await view.findByRole("radio", { name: /Anthropic/ }));
  await userEvent.click(
    await view.findByRole("button", { name: "Sign in with Anthropic" }),
  );
  await view.findByText("Sign-in was interrupted.");
  expect(stepLabel(view)).toContain("AI");
});
