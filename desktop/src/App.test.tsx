import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
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
  downloadBytes?: number;
  downloads?: {
    done: number;
    total: number;
    bytes: number;
    bytesPerSecond?: number;
    pulling: Array<{ name: string; bytes: number; size?: number }>;
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

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
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
}));

const { App } = await import("./App");
const { ShuttingDownWindow, isShuttingDownPage } = await import(
  "./ShuttingDown"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  // Unmounting can still call (a running local step is cancelled), so clear the record after it.
  cleanup();
  invokeCalls = [];
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

test("installation shows its active stage immediately without an elapsed timer", async () => {
  const { view, preparation } = await beginPendingInstallation();
  const preparing = within(
    view.getByRole("listitem", { name: "Preparing this computer" }),
  );
  expect(
    preparing.getByText("Checking the software OpenBot needs."),
  ).toBeTruthy();
  expect(preparing.getByText("In progress")).toBeTruthy();
  expect(preparing.queryByText("✓")).toBeNull();
  expect(preparing.queryByText(/elapsed/)).toBeNull();
  await act(async () => preparation.resolve());
  // Installed: on to the AI provider screen, with nothing left in progress.
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(view.queryByText("In progress")).toBeNull();
  expect(view.queryByText(/elapsed/)).toBeNull();
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
    view.getByRole("listitem", { name: "Installing OpenBot" }),
  );
  expect(installing.getByText("Failed")).toBeTruthy();
  expect(installing.getByText("✗")).toBeTruthy();
  expect(view.getByRole("alert").textContent).toContain(
    "The download was interrupted.",
  );
  expect(view.queryByText("In progress") === null).toBe(true);
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
  expect(view.getByText("In progress")).toBeTruthy();
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
      observed: null,
    },
    reason: null,
    readiness,
    licence,
    licenceExpiresAt: null,
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
    // Signed in and agreed already, unless a test says otherwise: the account step passes.
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
// Docker and Podman are not here: they are the engine a person may already know, and their prompts
// and agreements show windows of their own, so a screen names them when it waits on one. See
// `plainInstallSteps`. Intelligence is: a screen names the part of OpenBot, the back end, instead.
const JARGON = [
  /\bCLI\b/,
  /Container engine/i,
  /Engine machine/i,
  /k3d/i,
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
      "Installs the OpenBot app and backend on this computer. The first setup takes about 10 minutes.",
    ),
  ).toBeTruthy();
  expect(buttons(view)).toEqual(["Install"]);
  expect(view.queryByRole("radio")).toBeNull();
  expect(view.queryByText(/hosted/i)).toBeNull();
  expectPlain(view);
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
      /installs OpenBot on this computer: the front end, the back end, the database/,
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
    detail: "The container engine is answering.",
  });
  await emitProgress({
    step: "create-machine",
    ok: true,
    detail: "Preparing the engine machine.",
  });
  await emitProgress({
    step: "images",
    ok: true,
    running: true,
    detail: "Checking which local software to download.",
  });
  const checking = rowStatus(view, "Installing OpenBot");
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
    view.getByRole("listitem", { name: "Installing OpenBot" }),
  );
  expect(installing.getByText("In progress")).toBeTruthy();
  expect(installing.queryByText(/Downloading local software/)).toBeNull();
  expect(installing.queryByRole("progressbar")).toBeNull();
  await emitProgress({
    step: "images",
    ok: true,
    running: true,
    detail: "Downloading local software.",
    downloadBytes: 52_000_000,
    downloads: {
      done: 2,
      total: 7,
      bytes: 52_000_000,
      bytesPerSecond: 3_000_000,
      pulling: [{ name: "agent-bot", bytes: 12_000_000, size: 40_000_000 }],
    },
  });
  expect(
    installing.queryByText("Checking which local software to download."),
  ).toBeNull();
  expect(installing.getByText("5 of 7 items remaining")).toBeTruthy();
  expect(installing.getByRole("progressbar").getAttribute("value")).toBe("2");
  expect(installing.queryByText("agent-bot")).toBeNull();
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

test("a signed-out first run signs in to CopilotKit and accepts the agreement as its own step, before choosing an AI", async () => {
  setupRootConfiguration("/tmp/local-eval-account", async () =>
    emptyConfiguration(),
  );
  let signedIn = false;
  withLocalCli({
    local_eval_terms: () =>
      signedIn
        ? { ...ACCEPTED_TERMS, accepted: false }
        : { status: "signed-out" },
    sign_in_to_copilotkit: () => {
      signedIn = true;
      return { signedIn: true };
    },
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
  });
  const view = await renderApp();
  await installLocal(view);
  // The first step. OpenBot needs no account, so it installs behind it, exactly once; nothing
  // of Intelligence's runs before the agreement.
  await view.findByRole("heading", { name: "Sign in to CopilotKit" });
  expect(
    view.getByText(
      "Your conversations and files are stored on this computer. Signing in does not send them to CopilotKit.",
    ),
  ).toBeTruthy();
  expect(stepLabel(view)).toBe("Account");
  await waitFor(() =>
    expect(installationCalls().map((call) => call.command)).toEqual([
      "prepare_installation",
    ]),
  );
  expect(localSequence()).toEqual([]);
  await userEvent.click(
    view.getByRole("button", { name: "Sign in to CopilotKit" }),
  );
  await view.findByRole("heading", { name: "Accept the license agreement" });
  expect(
    view.getByText(
      "To run OpenBot on this computer, accept the CopilotKit license agreement for Acme.",
    ),
  ).toBeTruthy();
  expect(view.getByRole("link", { name: "Read the agreement" })).toBeTruthy();
  // Nothing licensed runs before Accept.
  expect(localSequence()).toEqual([]);
  await userEvent.click(view.getByRole("button", { name: "Accept" }));
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(stepLabel(view)).toBe("AI");
  expect(view.queryByText(/needs your CopilotKit account/)).toBeNull();
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
    { name: "Sign in to CopilotKit" },
    { timeout: 6000 },
  );
  expect(asked).toBe(2);
  expect(view.queryByText(/Couldn.t check your CopilotKit account/)).toBeNull();
}, 15000);

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
  expect(
    invokeCalls.some((call) => call.command === "sign_in_to_copilotkit"),
  ).toBe(false);
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
  // Working behind this screen says nothing on it: its progress has its own step.
  expect(view.queryByText(/Setting up OpenBot/)).toBeNull();
  expect(view.queryByRole("alert", { name: "Back end" })).toBeNull();
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
  expect(invokeCalls.some((call) => call.command === "cancel_local_eval")).toBe(
    false,
  );
  expectPlain(view);
});

test("Continue during setup shows Getting ready, which starts and opens OpenBot by itself", async () => {
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
  await view.findByRole("heading", { name: "Getting ready" });
  expect(stepLabel(view)).toBe("Start");
  const row = view.getByRole("listitem", { name: "Setting up OpenBot" });
  expect(row.textContent).toContain("In progress");
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

test("a first local run offers the back end dashboard to the app page and opens OpenBot", async () => {
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
  // A tick for a second, then on by itself.
  expect((await view.findByText(/✓/)).closest("p")?.textContent).toContain(
    "Signed in to Anthropic.",
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
  expect(view.queryByRole("alert", { name: "Back end" })).toBeNull();
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
  await view.findByRole("heading", { name: "Getting ready" });
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
  const alert = await view.findByRole("alert", { name: "Back end" });
  expect(alert.textContent).toContain("Back end setup stopped");
  expect(alert.textContent).toContain(
    "The back end cannot start until the software it runs on is running.",
  );
  await chooseOpenAi(view);
  await view.findByRole("heading", { name: "Getting ready" });
  // Continue does not retry a blocked step: Retry does.
  expect(setups).toBe(1);
  const row = view.getByRole("listitem", { name: "Setting up OpenBot" });
  expect(row.textContent).toContain(
    "The back end cannot start until the software it runs on is running.",
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
    view.queryByRole("listitem", { name: "Stopping the back end" }),
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
    rowStatus(view, "Stopping the back end").getByText("In progress"),
  ).toBeTruthy();
  // An older copy arriving late never undoes a newer one.
  await emitQuit({ seq: 3, steps: [complete("stop-openbot")] });
  expect(
    rowStatus(view, "Stopping the back end").getByText("In progress"),
  ).toBeTruthy();

  await emitQuit({
    seq: 5,
    steps: [complete("stop-openbot"), failed("stop-intelligence")],
  });
  expect(
    rowStatus(view, "Stopping the back end").getByText("Failed"),
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
    rowStatus(view, "Stopping the back end").getByText("Complete"),
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
    "Updating OpenBot from v0.3.0 to v0.3.1. Your Bots, sign-ins and data stay as they are.";
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
 * Start's rows are the back end's, and one line under them says what the upgrade is doing. The
 * release row carries that sentence, and each upgrade step now says itself on it as it begins
 * (`upgrade::now_said`). The install and the start report rows of their own as well, and those
 * never take the line over. On Windows the line said "Stopping OpenBot." through a whole start,
 * under a list where every step but the last was complete.
 */
test("the line under Start's rows says the upgrade step running now, never one that finished", async () => {
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
  const lines = () =>
    [...view.container.querySelectorAll(".status-line")].map(
      (line) => line.textContent,
    );
  const release = (detail: string) => ({
    step: "release",
    ok: true,
    running: true,
    detail,
  });
  // What `upgrade_and_start` reports, in order: the release row as each step begins, and the
  // install's and the start's own rows between them.
  const upgrade: [ProgressEvent[], string][] = [
    [
      [
        release(
          "Updating OpenBot from v0.3.0 to v0.3.1. Your Bots, sign-ins and data stay as they are.",
        ),
      ],
      "Updating OpenBot from v0.3.0 to v0.3.1. Your Bots, sign-ins and data stay as they are.",
    ],
    [[release("Stopping OpenBot.")], "Stopping OpenBot."],
    [
      [release("Backing up OpenBot's database.")],
      "Backing up OpenBot's database.",
    ],
    [[release("Downloading OpenBot v0.3.1.")], "Downloading OpenBot v0.3.1."],
    [
      [
        release("Installing OpenBot v0.3.1."),
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
          downloadBytes: 1_200_000_000,
        },
        {
          step: "installation",
          ok: true,
          running: false,
          detail: "Installed.",
        },
      ],
      "Installing OpenBot v0.3.1.",
    ],
    [
      [
        release("Starting OpenBot v0.3.1."),
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
      "Starting OpenBot v0.3.1.",
    ],
  ];
  for (const [events, said] of upgrade) {
    for (const event of events) await emitProgress(event);
    expect(
      view.getByRole("heading", { name: "Starting OpenBot" }),
    ).toBeTruthy();
    // One line, the step running now, with the spinner.
    expect(lines()).toEqual([said]);
    expectWorking(view, said);
  }
  // Nothing an earlier step said is left on the screen.
  for (const finished of [
    "Stopping OpenBot.",
    "Backing up OpenBot's database.",
    "Downloading OpenBot v0.3.1.",
    "Installing OpenBot v0.3.1.",
  ])
    expect(view.queryByText(finished)).toBeNull();
  await act(async () =>
    moving.resolve({ from: "v0.3.0", to: "v0.3.1", moved: true }),
  );
  await view.findByRole("heading", { name: "OpenBot is running" });
  expect(view.queryByText("Starting OpenBot v0.3.1.")).toBeNull();
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
      "The back end started. Its licence and readiness are not reported yet.",
    ],
    ["ready", "expired", "The evaluation licence has expired."],
    ["degraded", "valid", "The back end is running but not healthy."],
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

test("Back from a stopped Getting ready keeps the AI already chosen", async () => {
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
  await view.findByRole("heading", { name: "Getting ready" });
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
            : "Getting ready",
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
              : "OpenBot's connection to its back end on this computer is no longer available. Set up the back end again.",
          connection,
        };
      return previous(command, args);
    };
    const view = await renderApp();
    await view.findByRole("heading", {
      name:
        connection === "model" ? "Refresh your AI connection" : "Getting ready",
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
    said: "When OpenBot last quit, it could not stop its back end.",
    detail: "Back end stop failed: the CLI timed out",
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
      throw "Back end stop failed: the CLI timed out";
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
    "OpenBot stopped, but could not stop its back end.",
  );
});

test("Stop that fails for OpenBot itself keeps OpenBot running", async () => {
  useInterruptedShutdownSetup();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "last_failure") return null;
    if (command === "stop_stack")
      throw "Compose down failed: busy\nBack end stop failed: the CLI timed out";
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
  expect(view.getByText(/stopped containers/)).toBeTruthy();
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
