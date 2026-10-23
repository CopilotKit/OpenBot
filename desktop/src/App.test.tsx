import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;
type ProgressEvent = {
  step: string;
  ok: boolean;
  detail: string;
  running?: boolean;
  downloadBytes?: number;
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
type OpeningEvent = { state: "opening" | "opened" | "failed"; said: string };
const openingListeners = new Set<(event: { payload: OpeningEvent }) => void>();

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
    const opening = listener as unknown as (event: {
      payload: OpeningEvent;
    }) => void;
    if (name === "intelligence:opening") openingListeners.add(opening);
    return () => {
      progressListeners.delete(listener);
      quitListeners.delete(quit);
      openingListeners.delete(opening);
    };
  },
}));

mock.module("./Mark", () => ({
  Mark: ({ name }: { name: string }) => <span>{name}</span>,
}));

const { App } = await import("./App");
const { PRESET_QUESTIONS } = await import("./Ask");
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
  openingListeners.clear();
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

async function enterInstallation(view: Awaited<ReturnType<typeof renderApp>>) {
  await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
}

async function completeInstallation(
  view: Awaited<ReturnType<typeof renderApp>>,
) {
  await userEvent.click(view.getByRole("button", { name: "Install OpenBot" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Continue to sign in" }),
  );
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
  const previous = invokeHandler;
  invokeHandler = async (command, args) =>
    command === "prepare_installation"
      ? preparation.promise
      : previous(command, args);
  const view = await renderApp();
  await enterInstallation(view);
  await userEvent.click(view.getByRole("button", { name: "Install OpenBot" }));
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

test("installation shows its active stage immediately and advances elapsed time", async () => {
  const { view, preparation } = await beginPendingInstallation();
  const engine = within(
    view.getByRole("listitem", { name: "Container engine" }),
  );
  expect(engine.getByText("Checking the software OpenBot needs.")).toBeTruthy();
  expect(engine.getByText("In progress")).toBeTruthy();
  expect(engine.queryByText("✓")).toBeNull();
  await waitFor(() => expect(engine.getByText(/1s elapsed/)).toBeTruthy(), {
    timeout: 1800,
  });
  await act(async () => preparation.resolve());
  expect(engine.getByText("Complete")).toBeTruthy();
  expect(engine.getByText("✓")).toBeTruthy();
  expect(view.queryByText("In progress") === null).toBe(true);
  expect(view.queryByText(/elapsed/)).toBeNull();
});

test("running updates show real download bytes without completing a stage early", async () => {
  const { view, preparation } = await beginPendingInstallation();
  await emitProgress({
    step: "engine",
    ok: true,
    detail: "Docker is answering.",
  });
  await emitProgress({
    step: "dependencies",
    ok: true,
    running: true,
    detail: "Downloading the local runtime.",
    downloadBytes: 2_400_000,
  });
  const dependencies = within(
    view.getByRole("listitem", { name: "Dependencies" }),
  );
  expect(dependencies.getByText("In progress")).toBeTruthy();
  expect(dependencies.getByText(/2.4 MB downloaded/)).toBeTruthy();
  expect(dependencies.queryByText("✓")).toBeNull();
  await emitProgress({
    step: "dependencies",
    ok: true,
    running: true,
    detail: "Downloading the local runtime.",
    downloadBytes: 5_700_000,
  });
  expect(view.getAllByRole("listitem", { name: "Dependencies" })).toHaveLength(
    1,
  );
  expect(dependencies.getByText(/5.7 MB downloaded/)).toBeTruthy();
  expect(dependencies.queryByText(/2.4 MB downloaded/)).toBeNull();
  expect(dependencies.queryByText("Complete")).toBeNull();
  await emitProgress({
    step: "dependencies",
    ok: true,
    running: false,
    detail: "Local runtime installed.",
  });
  expect(dependencies.getByText("Complete")).toBeTruthy();
  expect(dependencies.getByText("✓")).toBeTruthy();
  expect(dependencies.queryByText("In progress")).toBeNull();
  await emitProgress({
    step: "images",
    ok: true,
    running: true,
    detail: "Downloading local software (2/4).",
  });
  expect(view.getByText("Downloading local software (2/4).")).toBeTruthy();
  await act(async () => preparation.resolve());
  expect(view.queryByText("In progress") === null).toBe(true);
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
  const dependencies = within(
    view.getByRole("listitem", { name: "Dependencies" }),
  );
  expect(dependencies.getByText("Failed")).toBeTruthy();
  expect(dependencies.getByText("✗")).toBeTruthy();
  expect(dependencies.getByText("The download was interrupted.")).toBeTruthy();
  expect(view.queryByText("In progress") === null).toBe(true);
  expect(view.queryByText(/elapsed/)).toBeNull();
  expect(
    within(view.getByRole("listitem", { name: "Container engine" })).getByText(
      "Complete",
    ),
  ).toBeTruthy();
  const secondAttempt = await retry();
  expect(view.queryByRole("listitem", { name: "Dependencies" })).toBeNull();
  expect(view.queryByText("Failed")).toBeNull();
  expect(view.getByText("In progress")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  await act(async () => secondAttempt.resolve());
  expect(view.queryByText("In progress") === null).toBe(true);
  expect(
    view.getByRole("heading", { name: "Installation complete" }),
  ).toBeTruthy();
});

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "startup settles active progress (automatic=%s, succeeds=%s)",
  async (automatic, succeeds) => {
    useInterruptedShutdownSetup();
    const launch = deferred<void>();
    const previous = invokeHandler;
    invokeHandler = async (command, args) => {
      if (command === "last_failure" && automatic) return null;
      if (command === "start_stack") return launch.promise;
      return previous(command, args);
    };
    const view = await renderApp();
    if (!automatic)
      await userEvent.click(
        view.getByRole("button", { name: "Start OpenBot" }),
      );
    await emitProgress({
      step: "services",
      ok: true,
      running: true,
      detail: "Starting local services.",
    });
    expect(view.getByText("In progress")).toBeTruthy();
    await act(async () => {
      if (succeeds) launch.resolve();
      else launch.reject({ said: "Local services could not start." });
    });
    expect(view.queryByText("In progress") === null).toBe(true);
    const services = within(view.getByRole("listitem", { name: "Containers" }));
    expect(services.getByText(succeeds ? "Complete" : "Failed")).toBeTruthy();
    expect(services.getByText(succeeds ? "✓" : "✗")).toBeTruthy();
    if (!succeeds)
      expect(
        view.getByRole("button", { name: "Start OpenBot" }),
      ).toHaveProperty("disabled", false);
  },
);

test("installation completes before either sign-in is available", async () => {
  setupRootConfiguration("/tmp/install-before-signin", async () =>
    emptyConfiguration(),
  );
  const preparation = deferred<void>();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "prepare_installation") return preparation.promise;
    return previous(command, args);
  };
  const view = await renderApp();
  await enterInstallation(view);
  expect(view.getByRole("heading", { name: "Install OpenBot" })).toBeTruthy();
  expect(view.getByLabelText("Where OpenBot lives")).toHaveProperty(
    "value",
    "/tmp/install-before-signin",
  );
  expect(
    view.queryByRole("button", { name: /Sign in|Continue to sign in/i }),
  ).toBeNull();
  await userEvent.click(view.getByRole("button", { name: "Install OpenBot" }));
  expect(installationCalls()).toEqual([
    {
      command: "prepare_installation",
      args: {
        root: "/tmp/install-before-signin",
        harness: { id: "langgraph" },
      },
    },
  ]);
  expect(view.getByLabelText("Where OpenBot lives")).toHaveProperty(
    "disabled",
    true,
  );
  expect(view.getByRole("button", { name: "Back" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(view.queryByRole("heading", { name: "Connect your AI" })).toBeNull();
  expect(
    invokeCalls.some((call) =>
      /sign_in|start_stack|^providers$/.test(call.command),
    ),
  ).toBe(false);
  await act(async () => {
    for (const listener of progressListeners)
      listener({
        payload: {
          step: "dependencies",
          ok: true,
          detail: "Local runtime installed.",
        },
      });
  });
  expect(view.getByText("Local runtime installed.")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: "Continue to sign in" }),
  ).toBeNull();
  await act(async () => preparation.resolve());
  expect(
    view.getByRole("heading", { name: "Installation complete" }),
  ).toBeTruthy();
  expect(
    view
      .getByRole("button", { name: "Repair installation" })
      .closest("details"),
  ).toHaveProperty("open", false);
  expect(view.queryByRole("heading", { name: "Connect your AI" })).toBeNull();
  await userEvent.click(
    view.getByRole("button", { name: "Continue to sign in" }),
  );
  expect(view.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
});

async function reachConnect(view: Awaited<ReturnType<typeof renderApp>>) {
  await enterInstallation(view);
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.type(view.getByLabelText("OpenAI API key"), "model-test-key");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await view.findByRole("heading", { name: "Connect to CopilotKit" });
}

const localListing = { outcome: "completed", stacks: [], reason: null };

test("local Intelligence is not offered when this build has no CLI", async () => {
  setupRootConfiguration("/tmp/local-eval-unavailable", async () =>
    emptyConfiguration(),
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "list_local_eval") throw "unavailable";
    return previous(command, args);
  };
  const view = await renderApp();
  await reachConnect(view);
  expect(view.queryByText("Run Intelligence on this computer")).toBeNull();
  expect(view.queryByRole("radio", { name: /Intelligence/ })).toBeNull();
  expect(view.queryByText("Choose where Intelligence runs")).toBeNull();
  expect(
    view.getByRole("button", { name: "Sign in to CopilotKit" }),
  ).toBeTruthy();
  expect(
    invokeCalls.some((call) => call.command === "begin_intelligence_sign_in"),
  ).toBe(false);
  expect(invokeCalls.some((call) => call.command === "set_up_local_eval")).toBe(
    false,
  );
});

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

const LOCAL_CHOICE = "Run Intelligence on this computer";
const HOSTED_CHOICE = "Use CopilotKit's hosted Intelligence";
const HOSTED_LINK = "Use CopilotKit's hosted service instead";

/** Ask the question already in the Test OpenBot box, and wait for the answer. */
async function askTheTest(
  view: Awaited<ReturnType<typeof renderApp>>,
  answer = "I am working.",
) {
  await userEvent.click(await view.findByRole("button", { name: "Ask" }));
  return view.findByText(answer);
}

function choice(view: Awaited<ReturnType<typeof renderApp>>, name: string) {
  return view.getByRole("radio", { name: new RegExp(name) });
}

/** The first screen's Install, which with a CLI installs OpenBot and local Intelligence. */
async function installLocal(view: Awaited<ReturnType<typeof renderApp>>) {
  await userEvent.click(view.getByRole("button", { name: "Install" }));
}

/** Words about the software underneath, which no local screen says. */
const JARGON = [
  /\bCLI\b/,
  /Docker/i,
  /Podman/i,
  /Container engine/i,
  /Engine machine/i,
  /k3d/i,
];

function expectPlain(view: Awaited<ReturnType<typeof renderApp>>) {
  const text = view.container.textContent ?? "";
  for (const word of JARGON) expect(text).not.toMatch(word);
}

function stepLabel(view: Awaited<ReturnType<typeof renderApp>>) {
  return view.container.querySelector(".steps-of")?.textContent;
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

test("with a CLI, the first screen is Install, local by default with nothing to choose, and without one it is unchanged", async () => {
  setupRootConfiguration("/tmp/local-eval-welcome", async () =>
    emptyConfiguration(),
  );
  withLocalCli({});
  let view = await renderApp();
  expect(view.getByRole("heading", { name: "Set up OpenBot" })).toBeTruthy();
  expect(
    view.getByText(
      "Installs OpenBot and CopilotKit Intelligence on this computer. The first setup takes about 10 minutes.",
    ),
  ).toBeTruthy();
  expect(buttons(view)).toEqual(["Install"]);
  expect(view.queryByRole("radio")).toBeNull();
  expectPlain(view);
  expect(localCliCalls()).toEqual([]);
  cleanup();
  invokeCalls = [];

  setupRootConfiguration("/tmp/local-eval-welcome-none", async () =>
    emptyConfiguration(),
  );
  view = await renderApp();
  expect(
    view.getByRole("heading", {
      name: "Your own AI coworkers, on this computer.",
    }),
  ).toBeTruthy();
  expect(buttons(view)).toEqual(["Set up OpenBot"]);
  await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
  expect(stepLabel(view)).toBe("Step 1 of 4");
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
  expect(stepLabel(view)).toBe("Step 2 of 4");
  expect(view.queryByLabelText("Where OpenBot lives")).toBeNull();
  expect(view.queryByText(/Pick a Bot|Which Bot/i)).toBeNull();
  expect(invokeCalls.some((call) => call.command === "harnesses")).toBe(false);
  // Nothing to press, and no way out while it installs.
  expect(view.queryAllByRole("button")).toEqual([]);
  // Intelligence waits for the engine the install starts: nothing local runs yet.
  expect(localCliCalls()).toEqual([]);
  // Native rows are summarised in plain words.
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
  expect(installing.getByText(/2.4 MB downloaded/)).toBeTruthy();
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
  expect(stepLabel(view)).toBe("Step 1 of 4");
  await waitFor(() =>
    expect(installationCalls().map((call) => call.command)).toEqual([
      "prepare_installation",
    ]),
  );
  expect(localSequence()).toEqual([]);
  await userEvent.click(
    view.getByRole("button", { name: "Sign in to CopilotKit" }),
  );
  await view.findByRole("heading", { name: "Accept the evaluation agreement" });
  expect(
    view.getByText(
      "To run Intelligence on this computer, accept the CopilotKit Intelligence evaluation agreement for Acme.",
    ),
  ).toBeTruthy();
  expect(view.getByRole("link", { name: "Read the agreement" })).toBeTruthy();
  // Nothing licensed runs before Accept.
  expect(localSequence()).toEqual([]);
  await userEvent.click(view.getByRole("button", { name: "Accept" }));
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(stepLabel(view)).toBe("Step 3 of 4");
  expect(view.queryByText(/needs your CopilotKit account/)).toBeNull();
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
  expect(stepLabel(view)).toBe("Step 3 of 4");
  await waitFor(() => expect(localSequence()).toEqual(["set_up_local_eval"]));
  expect(
    invokeCalls.find((call) => call.command === "set_up_local_eval")?.args,
  ).toMatchObject({ root: "/tmp/local-eval-overlap" });
  // Working behind this screen says nothing on it: its progress has its own step.
  expect(view.queryByText(/Setting up Intelligence/)).toBeNull();
  expect(view.queryByRole("alert", { name: "Intelligence" })).toBeNull();
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

test("Continue during setup shows Getting ready, which starts, tests and opens OpenBot by itself", async () => {
  setupRootConfiguration("/tmp/local-eval-auto", async () =>
    emptyConfiguration(),
  );
  const setUp = deferred<unknown>();
  withLocalCli({
    set_up_local_eval: () => setUp.promise,
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    ask_the_bot: "I am working.",
  });
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await view.findByRole("heading", { name: "Getting ready" });
  expect(stepLabel(view)).toBe("Step 4 of 4");
  const row = view.getByRole("listitem", { name: "Setting up Intelligence" });
  expect(row.textContent).toContain("In progress");
  expectPlain(view);
  await act(async () => setUp.resolve(localStatus("starting", "valid")));
  await view.findByRole("heading", { name: "Test OpenBot" });
  expect(stepLabel(view)).toBe("Step 4 of 4");
  expect(localSequence()).toEqual([
    "set_up_local_eval",
    "connect_local_eval",
    "run_local_eval",
    "start_stack",
  ]);
  expect(
    invokeCalls.find((call) => call.command === "run_local_eval")?.args,
  ).toMatchObject({ action: "status", stack: "local-abc123" });
  // The local stack's own addresses, and no key from the window: Start takes the vaulted one.
  expect(getStartStackPayload()).toMatchObject({
    root: "/tmp/local-eval-auto",
    apiUrl: "http://localhost:64770",
    gatewayWsUrl: "ws://localhost:64772",
    apiKey: "",
  });
  // One of the questions is already in the box, nothing is asked until Ask, Another question
  // steps through the rest in order and back round, and a typed question replaces it.
  const question = view.getByLabelText("Your question") as HTMLInputElement;
  const first = PRESET_QUESTIONS.indexOf(
    question.value as (typeof PRESET_QUESTIONS)[number],
  );
  expect(first).toBeGreaterThanOrEqual(0);
  expect(invokeCalls.some((call) => call.command === "ask_the_bot")).toBe(
    false,
  );
  for (let step = 1; step <= PRESET_QUESTIONS.length; step++) {
    await userEvent.click(
      view.getByRole("button", { name: "Another question" }),
    );
    expect(question.value).toBe(
      PRESET_QUESTIONS[(first + step) % PRESET_QUESTIONS.length],
    );
  }
  await userEvent.type(question, "Who are you?", {
    initialSelectionStart: 0,
    initialSelectionEnd: question.value.length,
  });
  await userEvent.click(view.getByRole("button", { name: "Ask" }));
  await view.findByText("I am working.");
  const asked = invokeCalls.filter((call) => call.command === "ask_the_bot");
  expect(asked).toEqual([
    {
      command: "ask_the_bot",
      args: { root: "/tmp/local-eval-auto", question: "Who are you?" },
    },
  ]);
  // Asking again stays open after an answer.
  expect(view.getByRole("button", { name: "Ask again" })).toBeTruthy();
  expectPlain(view);
  await userEvent.click(view.getByRole("button", { name: "Open OpenBot" }));
  await waitFor(() => expect(localSequence()).toContain("show_openbot"));
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

test("a local Test OpenBot screen links to the Intelligence dashboard through the native sign-in", async () => {
  setupRootConfiguration("/tmp/local-eval-view", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    ask_the_bot: "I am working.",
    offer_local_intelligence: null,
    open_local_intelligence: () => opening.promise,
  });
  const opening = deferred<null>();
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await askTheTest(view);
  // The menus offer the dashboard once local mode has a recorded stack.
  expect(intelligenceCalls()).toEqual([
    {
      command: "offer_local_intelligence",
      args: { root: "/tmp/local-eval-view", offered: true },
    },
  ]);
  await userEvent.click(
    view.getByRole("button", { name: "View in Intelligence" }),
  );
  // Said on the click, while the CLI call is still running.
  expectWorking(view, "Opening the Intelligence dashboard…");
  await act(async () => opening.resolve(null));
  expect(view.getByRole("status").textContent).toBe("Opened in your browser.");
  expect(view.queryByText("Opening the Intelligence dashboard…")).toBeNull();
  const opened = intelligenceCalls().filter(
    (call) => call.command === "open_local_intelligence",
  );
  expect(opened).toEqual([
    {
      command: "open_local_intelligence",
      args: { attempt: expect.any(String), root: "/tmp/local-eval-view" },
    },
  ]);
  // The sign-in opens the browser itself; the window stays on its screen.
  expect(localSequence()).not.toContain("show_openbot");
  expect(view.getByRole("heading", { name: "Test OpenBot" })).toBeTruthy();
  expectPlain(view);
});

test("a local Test OpenBot step says it is asking, with a spinner, until the answer arrives", async () => {
  setupRootConfiguration("/tmp/local-eval-asking", async () =>
    emptyConfiguration(),
  );
  const answer = deferred<string>();
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    ask_the_bot: () => answer.promise,
    offer_local_intelligence: null,
  });
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await view.findByRole("heading", { name: "Test OpenBot" });
  await userEvent.click(view.getByRole("button", { name: "Ask" }));
  await waitFor(() => expectWorking(view, "Asking…"));
  await act(async () => answer.resolve("I am working."));
  expect(view.queryByText("Asking…")).toBeNull();
});

test("View in Intelligence says the native sentence when the dashboard does not open", async () => {
  setupRootConfiguration("/tmp/local-eval-view-failed", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    ask_the_bot: "I am working.",
    offer_local_intelligence: null,
    open_local_intelligence: () =>
      Promise.reject({
        said: "Your browser did not open. Try again.",
        detail: null,
      }),
  });
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await askTheTest(view);
  await userEvent.click(
    view.getByRole("button", { name: "View in Intelligence" }),
  );
  expect(
    await view.findByText("Your browser did not open. Try again."),
  ).toBeTruthy();
  // The test result and its way forward are unchanged.
  expect(view.getByText("I am working.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Open OpenBot" })).toBeTruthy();
  expectPlain(view);
});

test("Continue after Intelligence is already ready starts OpenBot with the AI just chosen", async () => {
  setupRootConfiguration("/tmp/local-eval-ready-first", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    ask_the_bot: "I am working.",
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
  await view.findByRole("heading", { name: "Test OpenBot" });
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
    ask_the_bot: "I am working.",
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
  await view.findByRole("heading", { name: "Test OpenBot" }, { timeout: 4000 });
  expect(getStartStackPayload()).toMatchObject({
    model: {
      provider: "anthropic",
      login: "plan",
      token: "synthetic-plan-token",
    },
  });
});

test("a development double mount runs each local step and asks the question once, on Ask", async () => {
  setupRootConfiguration("/tmp/local-eval-strict", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("starting", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    ask_the_bot: "I am working.",
  });
  const view = await renderApp(true);
  await installLocal(view);
  await chooseOpenAi(view);
  await askTheTest(view);
  expect(localSequence()).toEqual([
    "set_up_local_eval",
    "connect_local_eval",
    "run_local_eval",
    "start_stack",
  ]);
  expect(
    invokeCalls.filter((call) => call.command === "ask_the_bot"),
  ).toHaveLength(1);
});

test("Continue after Intelligence is ready starts OpenBot with the chosen model", async () => {
  setupRootConfiguration("/tmp/local-eval-ready-first", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("ready", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    ask_the_bot: "I am working.",
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  await waitFor(() => expect(localSequence()).toContain("run_local_eval"));
  expect(view.queryByRole("alert", { name: "Intelligence" })).toBeNull();
  expect(localSequence()).not.toContain("start_stack");
  await chooseOpenAi(view);
  await askTheTest(view);
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
    begin_intelligence_sign_in: "https://signin.example/fixture",
    finish_intelligence_sign_in: () => new Promise(() => {}),
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
  const row = view.getByRole("listitem", { name: "Setting up Intelligence" });
  await waitFor(() =>
    expect(row.textContent).toContain(
      "Stopped at your request before it finished.",
    ),
  );
  // Once nothing runs, leaving is offered.
  expect(buttons(view)).toEqual(["Back", "Retry", HOSTED_LINK]);
  await userEvent.click(view.getByRole("button", { name: HOSTED_LINK }));
  await view.findByRole("heading", { name: "Connect to CopilotKit" });
  expect(
    invokeCalls.filter((call) => call.command === "set_up_local_eval"),
  ).toHaveLength(1);
});

test("a first local run whose model cannot answer offers Change the model, as hosted does", async () => {
  setupRootConfiguration("/tmp/local-eval-ask-failure", async () =>
    emptyConfiguration(),
  );
  withLocalCli({
    set_up_local_eval: localStatus("ready", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    stop_stack: null,
    ask_the_bot: () => {
      throw { said: "The model could not answer.", detail: "401" };
    },
  });
  const view = await renderApp();
  await installLocal(view);
  await chooseOpenAi(view);
  await userEvent.click(await view.findByRole("button", { name: "Ask" }));
  await view.findByText("The model could not answer.");
  expect(localSequence()).not.toContain("show_openbot");
  expect(view.queryByRole("button", { name: "Open OpenBot" })).toBeNull();
  await userEvent.click(view.getByRole("button", { name: "Change the model" }));
  await view.findByRole("heading", { name: "Connect your AI" });
  expect(invokeCalls.some((call) => call.command === "stop_stack")).toBe(true);
  // The rows start over: what ran before was for the OpenBot that stopped.
  await chooseOpenAi(view);
  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(2),
  );
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
    ask_the_bot: "I am working.",
  });
  const view = await renderApp();
  await installLocal(view);
  await view.findByRole("heading", { name: "Connect your AI" });
  // A stop interrupts the screen in front at once, in a card with its reason and Retry.
  const alert = await view.findByRole("alert", { name: "Intelligence" });
  expect(alert.textContent).toContain("Intelligence stopped");
  expect(alert.textContent).toContain(
    "Intelligence cannot start until the software it runs on is running.",
  );
  await chooseOpenAi(view);
  await view.findByRole("heading", { name: "Getting ready" });
  // Continue does not retry a blocked step: Retry does.
  expect(setups).toBe(1);
  const row = view.getByRole("listitem", { name: "Setting up Intelligence" });
  expect(row.textContent).toContain(
    "Intelligence cannot start until the software it runs on is running.",
  );
  expectPlain(view);
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
  await userEvent.click(view.getByRole("button", { name: "Retry" }));
  await askTheTest(view);
  expect(setups).toBe(2);
});

test("an installation from before the first-screen choice still asks at step 4", async () => {
  setupRootConfiguration("/tmp/local-eval-choice", async () => ({
    ...savedOpenAiConfiguration(),
    saved: {
      ...savedOpenAiConfiguration().saved,
      intelligenceApiKey: false,
      model: "open-ai-api-key",
    },
    installation: { harness: { id: "mastra" } },
  }));
  withLocalCli({
    set_up_local_eval: localStatus("ready", "valid"),
    connect_local_eval: localConnection,
    run_local_eval: localStatus("ready", "valid"),
    ask_the_bot: "I am working.",
  });
  const view = await renderApp();
  await view.findByRole("heading", { name: "Choose where Intelligence runs" });
  expect(choice(view, LOCAL_CHOICE)).toHaveProperty("checked", true);
  expect(choice(view, HOSTED_CHOICE)).toHaveProperty("checked", false);
  expect(
    view.getByText("For evaluation. The first setup takes about 10 minutes."),
  ).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(localCliCalls()).toEqual([]);
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await askTheTest(view);
  expect(localSequence()).toEqual([
    "set_up_local_eval",
    "connect_local_eval",
    "run_local_eval",
    "start_stack",
  ]);
});

test("a hosted connection chosen earlier preselects hosted at step 4", async () => {
  for (const [name, configuration] of [
    [
      "url",
      {
        ...emptyConfiguration(),
        saved: {
          ...savedOpenAiConfiguration().saved,
          model: "open-ai-api-key",
        },
        values: { INTELLIGENCE_API_URL: "https://intelligence.example" },
        installation: { harness: { id: "mastra" } },
      },
    ],
    [
      "key",
      {
        ...savedOpenAiConfiguration(),
        saved: {
          ...savedOpenAiConfiguration().saved,
          model: "open-ai-api-key",
        },
        installation: { harness: { id: "mastra" } },
      },
    ],
  ] as const) {
    setupRootConfiguration(
      `/tmp/local-eval-hosted-chosen-${name}`,
      async () => configuration,
    );
    withLocalCli({});
    const view = await renderApp();
    await view.findByRole("heading", {
      name: "Choose where Intelligence runs",
    });
    expect(choice(view, HOSTED_CHOICE)).toHaveProperty("checked", true);
    expect(choice(view, LOCAL_CHOICE)).toHaveProperty("checked", false);
    // A saved connection is checked at Start; Continue does not sign in again.
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    await view.findByRole("heading", { name: "Connect to CopilotKit" });
    expect(
      invokeCalls.some((call) => call.command === "begin_intelligence_sign_in"),
    ).toBe(false);
    expect(localCliCalls()).toEqual([]);
    cleanup();
    invokeCalls = [];
  }
});

test("a recorded, connected stack on step 4 skips the choice and starts", async () => {
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
    ask_the_bot: "I am working.",
  });
  const view = await renderApp();
  // Never launched, so this is a first run: it tests the model before handing over.
  await askTheTest(view);
  expect(
    view.queryByRole("radio", { name: new RegExp(LOCAL_CHOICE) }),
  ).toBeNull();
  expect(localSequence()).toEqual(["run_local_eval", "start_stack"]);
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
    view.queryByRole("listitem", { name: "Stopping Intelligence" }),
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
    rowStatus(view, "Stopping Intelligence").getByText("In progress"),
  ).toBeTruthy();
  // An older copy arriving late never undoes a newer one.
  await emitQuit({ seq: 3, steps: [complete("stop-openbot")] });
  expect(
    rowStatus(view, "Stopping Intelligence").getByText("In progress"),
  ).toBeTruthy();

  await emitQuit({
    seq: 5,
    steps: [complete("stop-openbot"), failed("stop-intelligence")],
  });
  expect(
    rowStatus(view, "Stopping Intelligence").getByText("Failed"),
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
    rowStatus(view, "Stopping Intelligence").getByText("Complete"),
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
  expectWorking(view, "Opening OpenBot…");
  await act(async () => showing.resolve(null));
  expect(view.queryByText("Opening OpenBot…")).toBeNull();

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

test("the menu's dashboard opening shows on a setup screen with a spinner, then how it went", async () => {
  setupConnectedLocalStack(
    "/tmp/local-eval-menu-opening",
    localStatus("ready", "valid"),
  );
  const view = await renderApp();
  await view.findByRole("heading", { name: "OpenBot is running" });
  const emitOpening = async (payload: OpeningEvent) => {
    await act(async () => {
      for (const listener of openingListeners) listener({ payload });
    });
  };

  await emitOpening({
    state: "opening",
    said: "Opening the Intelligence dashboard…",
  });
  expectWorking(view, "Opening the Intelligence dashboard…");
  // The screen under it is unchanged.
  expect(
    view.getByRole("heading", { name: "OpenBot is running" }),
  ).toBeTruthy();

  await emitOpening({ state: "opened", said: "Opened in your browser." });
  const opened = view
    .getAllByRole("status")
    .find((line) => line.textContent === "Opened in your browser.");
  expect(opened?.querySelector(".step-spinner")).toBeNull();

  await emitOpening({
    state: "failed",
    said: "Your browser did not open. Try again.",
  });
  expect(
    view
      .getAllByRole("status")
      .some(
        (line) => line.textContent === "Your browser did not open. Try again.",
      ),
  ).toBe(true);
  expect(view.queryByText("Opened in your browser.")).toBeNull();
});

test("choosing a CopilotKit project says it is connecting until the key arrives", async () => {
  const root = "/tmp/project-pick-status";
  setupRootConfiguration(root, async () => ({
    ...savedOpenAiConfiguration(),
    saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
    launch: { harness: { id: "mastra" } },
  }));
  const key = deferred<string>();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "start_stack")
      throw {
        said: "That saved CopilotKit connection is no longer available. Sign in again or enter a project key.",
        connection: "intelligence",
      };
    if (command === "begin_intelligence_sign_in")
      return "https://signin.example/fixture";
    if (command === "finish_intelligence_sign_in")
      return [{ id: "fixture", name: "Existing project" }];
    if (command === "intelligence_key_for") return key.promise;
    return previous(command, args);
  };
  const view = await renderApp();
  await userEvent.click(
    await view.findByRole("button", { name: "Sign in to CopilotKit again" }),
  );
  await userEvent.click(
    await view.findByRole("button", { name: "Existing project" }),
  );
  expectWorking(view, "Connecting OpenBot to Existing project…");
  await act(async () => key.resolve("refreshed-intelligence-key"));
  expect(
    view.queryByText("Connecting OpenBot to Existing project…"),
  ).toBeNull();
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
    opening.getByRole("heading", { name: "Opening OpenBot" }),
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
    apiUrl: "http://localhost:64770",
    gatewayWsUrl: "ws://localhost:64772",
    apiKey: "",
  });
  // Stopped by choice: nothing starts again on its own in this session.
  await userEvent.click(view.getByRole("button", { name: "Stop OpenBot" }));
  await view.findByRole("heading", { name: "OpenBot is stopped" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    invokeCalls.filter((call) => call.command === "start_stack"),
  ).toHaveLength(1);
  expect(view.getByRole("button", { name: "Start OpenBot" })).toBeTruthy();
});

test("relaunch never starts a local stack that is not exactly ready and valid", async () => {
  for (const [readiness, licence, said] of [
    [
      "unknown",
      "unknown",
      "Intelligence started. Its licence and readiness are not reported yet.",
    ],
    ["ready", "expired", "The Intelligence evaluation licence has expired."],
    ["degraded", "valid", "Intelligence is running but not healthy."],
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

test("CopilotKit Back preserves the selected AI and connection settings", async () => {
  setupRootConfiguration("/tmp/back-preserves-setup", async () =>
    emptyConfiguration(),
  );
  const view = await renderApp();
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await enterInstallation(view);
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.type(view.getByLabelText("OpenAI API key"), "model-test-key");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    view.getByText("Point at your own Intelligence server"),
  );
  await userEvent.type(view.getByLabelText("Project key"), "project-test-key");
  const api = view.getByLabelText("API URL");
  await user.clear(api);
  await user.type(api, "https://intelligence.example/api");
  const gateway = view.getByLabelText("Gateway WebSocket URL");
  await user.clear(gateway);
  await user.type(gateway, "wss://intelligence.example/ws");
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  expect(view.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
  expect(view.getByRole("radio", { name: /OpenAI/ })).toHaveProperty(
    "checked",
    true,
  );
  expect(view.getByLabelText("OpenAI API key")).toHaveProperty(
    "value",
    "model-test-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(
    view.getByRole("heading", { name: "Connect to CopilotKit" }),
  ).toBeTruthy();
  await userEvent.click(
    view.getByText("Point at your own Intelligence server"),
  );
  expect(view.getByLabelText("Project key")).toHaveProperty(
    "value",
    "project-test-key",
  );
  expect(view.getByLabelText("API URL")).toHaveProperty(
    "value",
    "https://intelligence.example/api",
  );
  expect(view.getByLabelText("Gateway WebSocket URL")).toHaveProperty(
    "value",
    "wss://intelligence.example/ws",
  );
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(
    view.queryByRole("button", { name: "Change AI connection" }) === null,
  ).toBe(true);
  expect(
    view
      .getByRole("button", { name: "Change installation" })
      .closest("details"),
  ).toHaveProperty("open", false);
  expect(installationCalls()).toHaveLength(1);
});

test("failed installation blocks sign-in and retries before reporting completion", async () => {
  setupRootConfiguration("/tmp/install-retry", async () =>
    emptyConfiguration(),
  );
  const previous = invokeHandler;
  let attempts = 0;
  invokeHandler = async (command, args) => {
    if (command === "prepare_installation") {
      if (++attempts === 1)
        throw {
          said: "The download was interrupted.",
          detail: "Synthetic network failure",
        };
      return null;
    }
    return previous(command, args);
  };
  const view = await renderApp();
  await enterInstallation(view);
  await userEvent.click(view.getByRole("button", { name: "Install OpenBot" }));
  expect((await view.findByRole("alert")).textContent).toContain(
    "The download was interrupted.",
  );
  expect(
    view.queryByRole("button", { name: "Continue to sign in" }),
  ).toBeNull();
  expect(
    invokeCalls.some((call) => /sign_in|^providers$/.test(call.command)),
  ).toBe(false);
  await userEvent.click(
    view.getByRole("button", { name: "Retry installation" }),
  );
  expect(
    await view.findByRole("heading", { name: "Installation complete" }),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(attempts).toBe(2);
});

test("provider sign-in retries and Back reuse the completed local installation", async () => {
  setupRootConfiguration("/tmp/provider-retry", async () =>
    emptyConfiguration(),
  );
  const previous = invokeHandler;
  let signIns = 0;
  invokeHandler = async (command, args) => {
    if (command === "prepare_installation") return null;
    if (command === "providers")
      return [
        {
          id: "openai",
          name: "OpenAI",
          summary: "Use OpenAI",
          logins: ["plan"],
          mark: null,
          caution: null,
        },
      ];
    if (command === "begin_chatgpt_sign_in") {
      if (++signIns === 1) throw { said: "Sign-in was interrupted." };
      return "https://sign-in.example";
    }
    if (command === "finish_chatgpt_sign_in") return "synthetic-token";
    return previous(command, args);
  };
  const view = await renderApp();
  await enterInstallation(view);
  await completeInstallation(view);
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  expect(
    view.getByRole("heading", { name: "Installation complete" }),
  ).toBeTruthy();
  await userEvent.click(
    view.getByRole("button", { name: "Continue to sign in" }),
  );
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await view.findByText("Sign-in was interrupted.");
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  // Signed in, so on to the next step by itself, after a second showing the tick.
  await view.findByRole(
    "heading",
    { name: "Connect to CopilotKit" },
    { timeout: 4000 },
  );
  expect(signIns).toBe(2);
  expect(installationCalls()).toHaveLength(1);
});

test("a completed installation can be repaired after a provider reports missing assets", async () => {
  setupRootConfiguration("/tmp/repair-installation", async () =>
    emptyConfiguration(),
  );
  const previous = invokeHandler;
  const repair = deferred<void>();
  let installations = 0;
  invokeHandler = async (command, args) => {
    if (command === "prepare_installation")
      return ++installations === 1 ? null : repair.promise;
    if (command === "providers")
      return [
        {
          id: "openai",
          name: "OpenAI",
          summary: "Use OpenAI",
          logins: ["plan"],
          mark: null,
          caution: null,
        },
      ];
    if (command === "begin_chatgpt_sign_in")
      throw { said: "Return to Install and try again." };
    return previous(command, args);
  };
  const view = await renderApp();
  await enterInstallation(view);
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(
    view.getByRole("button", { name: "Sign in with OpenAI" }),
  );
  await view.findByText("Return to Install and try again.");
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  await userEvent.click(view.getByText("Installation options"));
  await userEvent.click(
    view.getByRole("button", { name: "Repair installation" }),
  );
  expect(
    view.queryByRole("button", { name: "Continue to sign in" }),
  ).toBeNull();
  await act(async () => repair.resolve());
  expect(
    await view.findByRole("button", { name: "Continue to sign in" }),
  ).toBeTruthy();
  expect(installations).toBe(2);
});

test("changing the Bot invalidates its completed installation", async () => {
  useBringYourOwnHarnessSetup();
  const view = await renderApp();
  await enterInstallation(view);
  await completeInstallation(view);
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  await userEvent.click(view.getByText("Choose the agent framework"));
  await userEvent.click(
    view.getByRole("radio", { name: /An agent you already run/ }),
  );
  await userEvent.type(
    view.getByLabelText("AG-UI endpoint"),
    "https://agent.example/ag-ui",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  expect(
    view.queryByRole("button", { name: "Continue to sign in" }),
  ).toBeNull();
  await completeInstallation(view);
  expect(installationCalls()).toEqual([
    {
      command: "prepare_installation",
      args: { root: "/tmp/openbot-app-test", harness: { id: "langgraph" } },
    },
    {
      command: "prepare_installation",
      args: {
        root: "/tmp/openbot-app-test",
        harness: { id: "byo-url", agentUrl: "https://agent.example/ag-ui" },
      },
    },
  ]);
});

test.each([false, true])(
  "reopening a successful setup starts its saved root and connections without the wizard or Ask (Strict Mode=%s)",
  async (strictMode) => {
    const root = "/tmp/successful-setup-root";
    setupRootConfiguration("/tmp/default-root", async () => ({
      values: {
        INTELLIGENCE_API_URL: "https://own.example/api",
        INTELLIGENCE_GATEWAY_WS_URL: "wss://own.example/ws",
      },
      saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
      launch: { harness: { id: "mastra" } },
    }));
    const launch = deferred<void>();
    const previous = invokeHandler;
    invokeHandler = async (command, args) => {
      if (command === "selected_root") return root;
      if (command === "start_stack") return launch.promise;
      if (command === "show_openbot") return null;
      return previous(command, args);
    };
    const view = await renderApp(strictMode);
    expect(
      view.getByRole("heading", { name: "Starting OpenBot" }),
    ).toBeTruthy();
    expect(
      view.queryByRole("heading", { name: "Connect to CopilotKit" }),
    ).toBeNull();
    expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
    await act(async () => launch.resolve());
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({ command: "show_openbot" }),
    );
    expect(getStartStackPayload()).toEqual({
      root,
      apiKey: "",
      apiUrl: "https://own.example/api",
      gatewayWsUrl: "wss://own.example/ws",
      harness: { id: "mastra" },
      model: { provider: "openai", login: "api-key", saved: true },
    });
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(
      invokeCalls.some((call) =>
        /prepare_|sign_in|^providers$|^harnesses$|ask_the_bot/.test(
          call.command,
        ),
      ),
    ).toBe(false);
    expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
    expect(view.queryByRole("button", { name: "Ask" })).toBeNull();
  },
);

test("a failed automatic reopen offers recovery without retrying or installing", async () => {
  setupRootConfiguration("/tmp/reopen-failure", async () => ({
    ...savedOpenAiConfiguration(),
    saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
    launch: { harness: { id: "langgraph" } },
  }));
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
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
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
  setupRootConfiguration(root, async () => ({
    ...savedOpenAiConfiguration(),
    saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
    launch: { harness: { id: "mastra" } },
    autoStart: false,
  }));
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "show_openbot") return null;
    return previous(command, args);
  };
  const view = await renderApp();
  expect(
    view.getByRole("heading", { name: "OpenBot is stopped" }),
  ).toBeTruthy();
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  expect(getStartStackPayload()).toMatchObject({
    root,
    harness: { id: "mastra" },
  });
  expect(invokeCalls).toContainEqual({ command: "show_openbot" });
  expect(installationCalls()).toHaveLength(0);
  expect(view.queryByRole("button", { name: "Ask" })).toBeNull();
});

test("completed local installation resumes at sign-in when it has never launched", async () => {
  setupRootConfiguration("/tmp/installed-before-signin", async () => ({
    ...emptyConfiguration(),
    installation: { harness: { id: "mastra" } },
  }));
  const view = await renderApp();
  expect(view.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
  expect(installationCalls()).toHaveLength(0);
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
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
            : "Refresh your CopilotKit connection",
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
    expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
  },
);

test.each(["reopen", "runtime"])(
  "organization sign-in on %s retains the installation and opens its app after verification",
  async (source) => {
    const root = "/tmp/organization-installation";
    const authorityUrl = "https://company.example";
    setupRootConfiguration(root, async () => ({
      ...savedOpenAiConfiguration(),
      values: { OPENBOT_ORGANIZATION_AUTH_URL: authorityUrl },
      saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
      launch: { harness: { id: "mastra" } },
    }));
    const previous = invokeHandler;
    let opens = 0;
    invokeHandler = async (command, args) => {
      if (command === "last_failure" && source === "runtime")
        return {
          said: "Your organization sign-in needs to be refreshed.",
          connection: "organization",
        };
      if (command === "show_openbot") {
        if (source === "reopen" && opens++ === 0)
          throw {
            said: "Sign in to your organization again.",
            connection: "organization",
          };
        return null;
      }
      if (command === "begin_organization_sign_in")
        return "https://company.example/api/auth/desktop";
      if (command === "finish_organization_sign_in")
        return {
          id: "employee",
          email: "employee@example.test",
          name: "Employee",
          role: "user",
        };
      if (command === "cancel_organization_sign_in") return null;
      return previous(command, args);
    };
    const view = await renderApp();
    expect(
      view.getByRole("heading", { name: "Sign in to your organization" }),
    ).toBeTruthy();
    expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
    expect(view.queryByText(/Step \d of 4/)).toBeNull();
    await userEvent.click(
      view.getByRole("button", { name: "Continue with Google" }),
    );
    expect(invokeCalls).toContainEqual({
      command: "begin_organization_sign_in",
      args: { root, authorityUrl, provider: "google" },
    });
    expect(invokeCalls).toContainEqual({
      command: "finish_organization_sign_in",
      args: { root },
    });
    expect(
      invokeCalls.filter((call) => call.command === "show_openbot"),
    ).toHaveLength(source === "reopen" ? 2 : 1);
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(source === "reopen" ? 1 : 0);
    if (source === "reopen") {
      expect(
        invokeCalls.find((call) => call.command === "start_stack")?.args,
      ).toMatchObject({ root, organizationAuthUrl: authorityUrl });
    }
    expect(installationCalls()).toHaveLength(0);
    expect(view.queryByRole("button", { name: "Ask" })).toBeNull();
  },
);

test.each(["model", "intelligence"])(
  "an unavailable saved %s connection opens only its refresh screen and returns to the existing app",
  async (connection) => {
    const root = "/tmp/installed-refresh";
    setupRootConfiguration(root, async () => ({
      ...savedOpenAiConfiguration(),
      saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
      launch: { harness: { id: "mastra" } },
    }));
    const previous = invokeHandler;
    let starts = 0;
    invokeHandler = async (command, args) => {
      if (command === "start_stack" && starts++ === 0)
        throw {
          said:
            connection === "model"
              ? "That saved OpenAI API key is no longer available."
              : "That saved CopilotKit connection is no longer available. Sign in again or enter a project key.",
          connection,
        };
      if (command === "show_openbot") return null;
      if (command === "begin_intelligence_sign_in")
        return "https://signin.example/fixture";
      if (command === "finish_intelligence_sign_in")
        return [{ id: "fixture", name: "Existing project" }];
      if (command === "intelligence_key_for")
        return "refreshed-intelligence-key";
      return previous(command, args);
    };
    const view = await renderApp();
    expect(
      view.getByRole("heading", {
        name:
          connection === "model"
            ? "Refresh your AI connection"
            : "Refresh your CopilotKit connection",
      }),
    ).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain(
      "no longer available",
    );
    expect(view.queryByText(/Step \d of 4/)).toBeNull();
    expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
    if (connection === "model") {
      await userEvent.type(
        view.getByLabelText("OpenAI API key"),
        "refreshed-provider-key",
      );
      await userEvent.click(view.getByRole("button", { name: "Continue" }));
    } else {
      await userEvent.click(
        view.getByRole("button", { name: "Sign in to CopilotKit again" }),
      );
      await userEvent.click(
        await view.findByRole("button", { name: "Existing project" }),
      );
      await userEvent.click(
        view.getByRole("button", { name: "Start OpenBot" }),
      );
    }
    const startsMade = invokeCalls.filter(
      (call) => call.command === "start_stack",
    );
    expect(startsMade).toHaveLength(2);
    expect(startsMade[1].args).toMatchObject({
      root,
      harness: { id: "mastra" },
      ...(connection === "model"
        ? { model: { apiKey: "refreshed-provider-key" } }
        : { apiKey: "refreshed-intelligence-key" }),
    });
    expect(invokeCalls).toContainEqual({ command: "show_openbot" });
    expect(installationCalls()).toHaveLength(0);
    expect(view.queryByRole("button", { name: "Ask" })).toBeNull();
  },
);

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
  expect(view.getByRole("heading", { name: "Opening OpenBot" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
  await act(async () => configuration.resolve(savedOpenAiConfiguration()));
  // A retained folder with no successful launch still needs the setup screens.
  expect(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  ).toBeTruthy();
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

function useInterruptedShutdownSetup() {
  const root = "/tmp/interrupted-shutdown-root";
  const notice = "OpenBot had trouble shutting down last time.";
  setupRootConfiguration("/tmp/default-root", async () => ({
    values: {
      INTELLIGENCE_API_URL: "https://own.example/api",
      INTELLIGENCE_GATEWAY_WS_URL: "wss://own.example/ws",
    },
    saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
    launch: { harness: { id: "mastra" } },
  }));
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "selected_root") return root;
    if (command === "last_failure") return { said: notice };
    if (command === "show_openbot") return null;
    return previous(command, args);
  };
  return { root, notice };
}

test("a local Intelligence stack left running at Quit is shown without holding auto-start", async () => {
  useInterruptedShutdownSetup();
  const notice = {
    said: "OpenBot could not stop the local Intelligence stack it started when it last quit.",
    detail: "Intelligence stop failed: the CLI timed out",
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
      throw "Intelligence stop failed: the CLI timed out";
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
    "OpenBot stopped, but could not stop the local Intelligence stack it started.",
  );
});

test("Stop that fails for OpenBot itself keeps OpenBot running", async () => {
  useInterruptedShutdownSetup();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "last_failure") return null;
    if (command === "stop_stack")
      throw "Compose down failed: busy\nIntelligence stop failed: the CLI timed out";
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
  expect(view.queryByRole("button", { name: "Set up OpenBot" }) !== null).toBe(
    false,
  );
  expect(
    view.getByRole("heading", { name: "OpenBot is stopped" }),
  ).toBeTruthy();
  const start = view.getByRole("button", { name: "Start OpenBot" });
  expect(start).toHaveProperty("disabled", false);
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );

  await userEvent.click(start);

  expect(getStartStackPayload()).toEqual({
    root,
    apiKey: "",
    apiUrl: "https://own.example/api",
    gatewayWsUrl: "wss://own.example/ws",
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
  expect(view.queryByRole("button", { name: "Ask" }) !== null).toBe(false);
});

test.each(["model", "root", "Intelligence"])(
  "changing the saved %s during recovery only repeats Ask for a different installation",
  async (changed) => {
    useInterruptedShutdownSetup();
    const view = await renderApp();
    const user = userEvent.setup({ document: view.container.ownerDocument });
    if (changed === "model") {
      await user.click(
        view.getByRole("button", { name: "Change AI connection" }),
      );
      await user.type(view.getByLabelText("OpenAI API key"), "new-model-key");
      await user.click(view.getByRole("button", { name: "Continue" }));
    } else if (changed === "root") {
      await user.click(
        view.getByRole("button", { name: "Change installation" }),
      );
      const input = view.getByLabelText("Where OpenBot lives");
      await user.clear(input);
      await user.type(input, "/tmp/changed-recovery-root");
      await completeInstallation(view);
      await user.click(view.getByRole("button", { name: "Continue" }));
    } else {
      await user.click(
        view.getByRole("button", { name: "Change CopilotKit connection" }),
      );
      await user.click(view.getByText("Point at your own Intelligence server"));
      const input = view.getByLabelText("API URL");
      await user.clear(input);
      await user.type(input, "https://different.example/api");
    }

    if (changed !== "model")
      await user.click(view.getByRole("button", { name: "Start OpenBot" }));

    expect(getStartStackPayload()).toMatchObject(
      changed === "root"
        ? { root: "/tmp/changed-recovery-root" }
        : changed === "model"
          ? { model: { apiKey: "new-model-key" } }
          : { apiUrl: "https://different.example/api" },
    );
    expect(invokeCalls.some((call) => call.command === "show_openbot")).toBe(
      changed !== "root",
    );
    expect(view.queryByRole("button", { name: "Ask" }) !== null).toBe(
      changed === "root",
    );
  },
);

test.each(["supervisor", "windows"])(
  "automatic reopen respects the existing %s blocker",
  async (blocker) => {
    setupRootConfiguration("/tmp/reopen-blocked", async () => ({
      ...savedOpenAiConfiguration(),
      saved: { ...savedOpenAiConfiguration().saved, model: "open-ai-api-key" },
      launch: { harness: { id: "langgraph" } },
    }));
    const previous = invokeHandler;
    invokeHandler = async (command, args) => {
      if (blocker === "supervisor" && command === "last_failure")
        return { said: "The supervisor stopped retrying." };
      if (blocker === "windows" && command === "windows_blocker")
        return "wsl-absent";
      if (command === "windows_blocker_instruction")
        return "Install WSL before continuing.";
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
          : "Install WSL before continuing.",
      ),
    ).toBeTruthy();
  },
);

test("setup records telemetry without a consent gate and deduplicates viewed steps", async () => {
  setupRootConfiguration("/tmp/private-setup-root", async () =>
    emptyConfiguration(),
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "record_setup_event") return null;
    return previous(command, args);
  };
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
  await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  expect(setupEvents()).toEqual([
    { event: { kind: "step_viewed", step: "welcome" } },
    { event: { kind: "step_viewed", step: "harness" } },
    { event: { kind: "harness_chosen", harness: "langgraph" } },
    { event: { kind: "step_viewed", step: "install" } },
  ]);
  await userEvent.click(view.getByRole("button", { name: "Back" }));
  expect(setupEvents().at(-1)).toEqual({
    event: { kind: "step_viewed", step: "harness" },
  });
});

test("setup records only model categories and reaches Ask when telemetry is unavailable", async () => {
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
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  await view.findByRole("button", { name: "Ask" });
  expect(setupEvents().at(-1)).toEqual({
    event: { kind: "step_viewed", step: "ask" },
  });
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
      intelligenceApiKey: true,
      modelApiKeys: { openai: true, anthropic: false },
      modelSessions: { openai: false, anthropic: false },
    },
  };
}

function emptyConfiguration() {
  return {
    values: {},
    saved: {
      intelligenceApiKey: false,
      modelApiKeys: { openai: false, anthropic: false },
      modelSessions: { openai: false, anthropic: false },
    },
  };
}

test("leftover database recovery requires confirmation and keeps setup ready to retry", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  const reset = deferred<void>();
  let starts = 0;
  invokeHandler = async (command, args) => {
    if (command === "start_stack" && ++starts === 1)
      throw {
        said: "A previous OpenBot database remains without its encryption key.",
        database_reset: "fixture_postgres-data",
      };
    if (command === "reset_leftover_database") return reset.promise;
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint(
    "https://model.example/v1",
    "synthetic-key",
  );
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  const resets = () =>
    invokeCalls.filter((call) => call.command === "reset_leftover_database");
  await userEvent.click(
    await view.findByRole("button", { name: "Reset leftover database" }),
  );
  expect(view.getByText(/permanently deletes/)).toBeTruthy();
  expect(resets()).toHaveLength(0);
  await userEvent.click(view.getByRole("button", { name: "Keep saved data" }));
  expect(resets()).toHaveLength(0);
  expect(view.queryByRole("button", { name: "Delete saved data" })).toBeNull();
  await userEvent.click(
    view.getByRole("button", { name: "Reset leftover database" }),
  );
  await userEvent.click(
    view.getByRole("button", { name: "Delete saved data" }),
  );
  expect(resets()).toEqual([
    {
      command: "reset_leftover_database",
      args: {
        root: "/tmp/openbot-app-test",
        volume: "fixture_postgres-data",
        confirmed: true,
      },
    },
  ]);
  expect(
    view.getByRole("button", { name: "Deleting saved data…" }),
  ).toHaveProperty("disabled", true);
  expect(view.getByRole("button", { name: "Working…" })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () => reset.resolve());
  expect(
    view.queryByRole("button", { name: "Reset leftover database" }),
  ).toBeNull();
  expect(view.queryByRole("alert")).toBeNull();
  expect(starts).toBe(1);
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  await view.findByRole("button", { name: "Ask" });
  expect(installationCalls()).toHaveLength(1);
});

test("database recovery failure is shown without restarting services", async () => {
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
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Reset leftover database" }),
  );
  await userEvent.click(
    view.getByRole("button", { name: "Delete saved data" }),
  );
  expect(await view.findByText(/database is still in use/)).toBeTruthy();
  expect(
    invokeCalls.filter((call) => call.command === "start_stack"),
  ).toHaveLength(1);
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
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
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
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
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
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
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
});

test("a successfully detected missing WSL feature keeps its setup instruction", async () => {
  setupRootConfiguration("/tmp/openbot-windows-detection-test", async () =>
    emptyConfiguration(),
  );
  const setupHandler = invokeHandler;
  const instruction =
    "Run wsl --install, restart Windows, and start OpenBot again.";
  invokeHandler = async (command, args) => {
    if (command === "windows_blocker") return "wsl-absent";
    if (command === "windows_blocker_instruction") return instruction;
    return setupHandler(command, args);
  };
  const view = await renderApp();
  expect(await view.findByText(instruction)).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
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
  expect(await view.findByText(instruction)).toBeTruthy();
  expect(
    view.getByRole("heading", {
      name: "Virtual Machine Platform is switched off",
    }),
  ).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.queryByRole("button", { name: "Set up OpenBot" })).toBeNull();
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
  INTELLIGENCE_API_KEY?: string;
  INTELLIGENCE_API_URL?: string;
  INTELLIGENCE_GATEWAY_WS_URL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_BASE_URL?: string;
};

function useCompatibleEndpointSetup(
  existingValues: ExistingConfigurationValues,
) {
  invokeHandler = async (command) => {
    if (command === "prepare_installation") return null;
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: existingValues,
        saved: {
          intelligenceApiKey: true,
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
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
    throw new Error(`unexpected command ${command}`);
  };
}

async function enterCompatibleEndpoint(
  baseUrl: string,
  endpointKey = "",
  containerBaseUrl = "",
) {
  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await completeInstallation(view);
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
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Start OpenBot" }),
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
          intelligenceApiKey: true,
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
    await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    await completeInstallation(view);
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
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    );
    await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(getStartStackPayload()).toEqual({
      root: "/tmp/openbot-app-test",
      apiKey: "",
      apiUrl: "https://api.intelligence.copilotkit.ai",
      gatewayWsUrl: "wss://realtime.intelligence.copilotkit.ai",
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
    await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    await completeInstallation(view);
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
  await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await completeInstallation(view);
  expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
    false,
  );
});

test("Change the model after an Ask failure stops the stack and reaches the provider picker", async () => {
  invokeHandler = async (command) => {
    if (command === "prepare_installation") return null;
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: {
          INTELLIGENCE_API_KEY: "ck-test",
          OPENAI_API_KEY: "sk-test",
        },
        saved: {
          intelligenceApiKey: true,
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
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
    if (command === "ask_the_bot") {
      throw { said: "The model could not answer.", detail: "401" };
    }
    if (command === "stop_stack") return stopping.promise;
    throw new Error(`unexpected command ${command}`);
  };
  const stopping = deferred<null>();

  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );

  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  await userEvent.click(await view.findByRole("button", { name: "Ask" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Change the model" }),
  );
  // Stopping takes a while; it is said at once, and nothing else can be pressed meanwhile.
  expectWorking(view, "Stopping OpenBot…");
  expect(view.getByRole("button", { name: "Change the model" })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () => stopping.resolve(null));

  await waitFor(() =>
    expect(invokeCalls.some((call) => call.command === "stop_stack")).toBe(
      true,
    ),
  );
  expect(view.getByRole("heading", { name: "Connect your AI" })).toBeTruthy();
  expect(view.getByRole("radio", { name: /OpenAI/ })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Stop OpenBot" })).toBeNull();
});

test("empty Intelligence projects keep sign-in retryable while Start waits for a project key", async () => {
  let projectLists = 0;
  invokeHandler = async (command) => {
    if (command === "prepare_installation") return null;
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: {
          OPENAI_API_KEY: "sk-test",
        },
        saved: {
          intelligenceApiKey: false,
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
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
    if (command === "begin_intelligence_sign_in") {
      return "https://copilotkit.test/sign-in";
    }
    if (command === "finish_intelligence_sign_in") {
      projectLists += 1;
      if (projectLists === 1) return [];
      return [{ id: "project-1", name: "Project One" }];
    }
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Sign in to CopilotKit" }),
  );

  expect(
    await view.findByText("That account has no projects yet.", {
      exact: false,
    }),
  ).toBeTruthy();
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    true,
  );

  await userEvent.click(view.getByRole("button", { name: "Sign in again" }));

  expect(await view.findByRole("button", { name: "Project One" })).toBeTruthy();

  await userEvent.click(
    view.getByText("Point at your own Intelligence server"),
  );
  await userEvent.type(view.getByLabelText("Project key"), "ck-test");
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
});

async function enterProjectSelection() {
  setupRootConfiguration("/tmp/create-project", async () =>
    emptyConfiguration(),
  );
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "begin_intelligence_sign_in")
      return "https://copilotkit.test/sign-in";
    if (command === "finish_intelligence_sign_in") return [];
    if (command === "intelligence_key_for") return "created-project-key";
    return previous(command, args);
  };
  const view = await renderApp();
  await enterInstallation(view);
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.type(view.getByLabelText("OpenAI API key"), "model-test-key");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    view.getByRole("button", { name: "Sign in to CopilotKit" }),
  );
  return view;
}

test("creating a named project connects it only after the user submits", async () => {
  const view = await enterProjectSelection();
  const creation = deferred<{ id: string; name: string }>();
  const previous = invokeHandler;
  invokeHandler = async (command, args) =>
    command === "create_intelligence_project"
      ? creation.promise
      : previous(command, args);
  expect(
    invokeCalls.some((call) => call.command === "create_intelligence_project"),
  ).toBe(false);
  const create = view.getByRole("button", { name: "Create project" });
  expect(create).toHaveProperty("disabled", true);
  await userEvent.type(
    view.getByLabelText("New project name"),
    "  OpenBot workspace  ",
  );
  await userEvent.click(create);
  expect(invokeCalls).toContainEqual({
    command: "create_intelligence_project",
    args: { name: "OpenBot workspace" },
  });
  expect(
    view.getByRole("button", { name: "Creating project…" }),
  ).toHaveProperty("disabled", true);
  expect(view.getByLabelText("New project name")).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () =>
    creation.resolve({ id: "new-project", name: "OpenBot workspace" }),
  );
  expect(view.getByText("Connected to CopilotKit.")).toBeTruthy();
  expect(invokeCalls).toContainEqual({
    command: "intelligence_key_for",
    args: { project: "new-project" },
  });
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    false,
  );
});

test("project creation failure preserves the name and retries without losing a created project", async () => {
  const view = await enterProjectSelection();
  const previous = invokeHandler;
  let creations = 0;
  let provisions = 0;
  invokeHandler = async (command, args) => {
    if (command === "create_intelligence_project") {
      if (++creations === 1)
        throw { said: "The project could not be created." };
      return { id: "new-project", name: "OpenBot workspace" };
    }
    if (command === "intelligence_key_for" && ++provisions === 1)
      throw { said: "The project key could not be created." };
    return previous(command, args);
  };
  await userEvent.type(
    view.getByLabelText("New project name"),
    "OpenBot workspace",
  );
  await userEvent.click(view.getByRole("button", { name: "Create project" }));
  expect(view.getByRole("alert").textContent).toContain(
    "The project could not be created.",
  );
  expect(view.getByLabelText("New project name")).toHaveProperty(
    "value",
    "OpenBot workspace",
  );
  expect(view.getByRole("button", { name: "Create project" })).toHaveProperty(
    "disabled",
    false,
  );
  await userEvent.click(view.getByRole("button", { name: "Create project" }));
  expect(view.getByRole("alert").textContent).toContain(
    "The project key could not be created.",
  );
  await userEvent.click(
    view.getByRole("button", { name: "OpenBot workspace" }),
  );
  expect(view.getByText("Connected to CopilotKit.")).toBeTruthy();
  expect(creations).toBe(2);
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

  expect(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  ).toBeTruthy();
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
    expect(view.getByRole("button", { name: "Set up OpenBot" })).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain(failure.said);
    expect(view.queryByRole("button", { name: "Stop OpenBot" })).toBeNull();
  });
}

test("saved startup credentials enable Start without raw protected secrets on mount", async () => {
  invokeHandler = async (command) => {
    if (command === "prepare_installation") return null;
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: {},
        saved: {
          intelligenceApiKey: true,
          modelApiKeys: { openai: true, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
      ];
    }
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
    throw new Error(`unexpected command ${command}`);
  };

  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));

  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(
    invokeCalls.filter((call) => call.command === "already_configured"),
  ).toHaveLength(1);
});

async function chooseModelAfterRootEdit(
  view: Awaited<ReturnType<typeof renderApp>>,
  apiKey?: string,
) {
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  if (apiKey)
    await userEvent.type(view.getByLabelText("OpenAI API key"), apiKey);
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
}

test("root edits reload saved configuration for that root and ignore stale saved responses", async () => {
  const rootA = "/tmp/openbot-root-a";
  const rootB = "/tmp/openbot-root-b";
  const rootC = "/tmp/openbot-root-c";
  const savedForRootA = deferred<ReturnType<typeof savedOpenAiConfiguration>>();
  const emptyForRootB = deferred<ReturnType<typeof emptyConfiguration>>();
  const savedForRootC = deferred<ReturnType<typeof savedOpenAiConfiguration>>();

  setupRootConfiguration(rootA, async (requestedRoot) => {
    if (requestedRoot === rootA) return savedForRootA.promise;
    if (requestedRoot === rootB) return emptyForRootB.promise;
    if (requestedRoot === rootC) return savedForRootC.promise;
    throw new Error(`unexpected already_configured root ${requestedRoot}`);
  });

  const view = await renderApp();
  await act(async () => {
    savedForRootA.resolve(savedOpenAiConfiguration());
  });

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  expect(view.getByText(/A saved OpenAI API key will be used/)).toBeTruthy();
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );

  await userEvent.click(
    view.getByRole("button", { name: "Change installation" }),
  );
  const rootField = view.getByLabelText("Where OpenBot lives");
  const user = userEvent.setup({
    document: view.container.ownerDocument,
  });
  await user.clear(rootField);
  await user.type(rootField, rootB);
  await act(async () => {
    rootField.blur();
  });

  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "already_configured"),
    ).toContainEqual({ command: "already_configured", args: { root: rootB } }),
  );
  expect(
    view.queryByRole("button", { name: "Continue to sign in" }),
  ).toBeNull();

  await user.clear(rootField);
  await user.type(rootField, rootC);
  await act(async () => {
    rootField.blur();
  });

  await waitFor(() =>
    expect(
      invokeCalls.filter((call) => call.command === "already_configured"),
    ).toContainEqual({ command: "already_configured", args: { root: rootC } }),
  );
  await act(async () => {
    emptyForRootB.resolve(emptyConfiguration());
  });
  expect(
    view.queryByRole("button", { name: "Continue to sign in" }),
  ).toBeNull();

  await act(async () => {
    savedForRootC.resolve(savedOpenAiConfiguration());
  });
  await chooseModelAfterRootEdit(view);
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));

  expect(getStartStackPayload()).toMatchObject({
    root: rootC,
    model: {
      provider: "openai",
      login: "api-key",
      saved: true,
    },
  });
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

  const view = await renderApp();
  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Continue" }));
  expect(view.getByLabelText("Where OpenBot lives")).toHaveProperty(
    "value",
    rootB,
  );
  await completeInstallation(view);
  await userEvent.click(await view.findByRole("radio", { name: /OpenAI/ }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Start OpenBot" }),
  );

  expect(
    invokeCalls.filter((call) => call.command === "already_configured"),
  ).toEqual([{ command: "already_configured", args: { root: rootB } }]);
  expect(getStartStackPayload().root).toBe(rootB);
});

test.each([
  {
    name: "initial folder reload",
    pendingRoot: "a",
    finalRoot: "b",
    savedModel: false,
  },
  {
    name: "blur-started load",
    pendingRoot: "b",
    finalRoot: "c",
    savedModel: true,
  },
  {
    name: "away-and-back edit",
    pendingRoot: "a",
    finalRoot: "a",
    savedModel: false,
  },
])(
  "root edits invalidate the $name before blur",
  async ({ pendingRoot, finalRoot, savedModel }) => {
    const rootA = "/tmp/openbot-root-a";
    const rootB = "/tmp/openbot-root-b";
    const currentRoot = `/tmp/openbot-root-${finalRoot}`;
    const requests: Array<{
      root: string;
      response: Deferred<ReturnType<typeof savedOpenAiConfiguration>>;
    }> = [];
    setupRootConfiguration(rootA, async (root) => {
      const response = deferred<ReturnType<typeof savedOpenAiConfiguration>>();
      requests.push({ root, response });
      return response.promise;
    });

    const view = await renderApp();
    const user = userEvent.setup({ document: view.container.ownerDocument });
    // Bootstrap must finish checking installation before exposing any wizard controls.
    await act(async () =>
      requests[0].response.resolve(
        savedModel ? savedOpenAiConfiguration() : emptyConfiguration(),
      ),
    );
    await user.click(
      await view.findByRole("button", { name: "Set up OpenBot" }),
    );
    await user.click(await view.findByRole("button", { name: "Continue" }));
    await completeInstallation(view);
    await user.click(await view.findByRole("radio", { name: /OpenAI/ }));
    expect(
      Boolean(view.queryByText(/A saved OpenAI API key will be used/)),
    ).toBe(savedModel);
    if (!savedModel) {
      await user.type(
        view.getByLabelText("OpenAI API key"),
        "sk-synthetic-current-model",
      );
    }
    await user.click(view.getByRole("button", { name: "Continue" }));
    const previousStart = view.getByRole("button", { name: "Start OpenBot" });
    expect(previousStart).toHaveProperty("disabled", !savedModel);
    await user.click(view.getByRole("button", { name: "Change installation" }));
    const rootField = view.getByLabelText("Where OpenBot lives");

    if (pendingRoot === "a") {
      await user.click(rootField);
      await act(async () => rootField.blur());
    }

    await user.clear(rootField);
    await user.type(rootField, rootB);
    if (pendingRoot === "b") {
      await act(async () => rootField.blur());
    }
    if (currentRoot !== rootB) {
      await user.clear(rootField);
      await user.type(rootField, currentRoot);
    }
    const pending = requests[requests.length - 1];
    expect(pending.root).toBe(`/tmp/openbot-root-${pendingRoot}`);
    const requestCountBeforeBlur = requests.length;

    function expectBlockedSetup() {
      expect(rootField).toHaveProperty("value", currentRoot);
      expect(view.container.ownerDocument.activeElement === rootField).toBe(
        true,
      );
      expect(
        view.queryByRole("button", { name: "Continue to sign in" }),
      ).toBeNull();
      expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
      expect(requests).toHaveLength(requestCountBeforeBlur);
      expect(invokeCalls.some((call) => call.command === "start_stack")).toBe(
        false,
      );
    }

    expectBlockedSetup();
    await act(async () =>
      pending.response.resolve({
        ...savedOpenAiConfiguration(),
        values: {
          INTELLIGENCE_API_KEY: "ck-synthetic-stale",
          INTELLIGENCE_API_URL: "https://stale.example/api",
          INTELLIGENCE_GATEWAY_WS_URL: "wss://stale.example/ws",
        },
      }),
    );
    expectBlockedSetup();

    if (savedModel) {
      // A different root's Intelligence connection cannot restore the model cleared by an edit.
      await act(async () => rootField.blur());
      await act(async () =>
        requests[requests.length - 1].response.resolve({
          ...emptyConfiguration(),
          saved: { ...emptyConfiguration().saved, intelligenceApiKey: true },
        }),
      );
      await completeInstallation(view);
      await user.click(await view.findByRole("radio", { name: /OpenAI/ }));
      expect(
        view.queryByText(/A saved OpenAI API key will be used/),
      ).toBeNull();
      expect(view.getByRole("button", { name: "Continue" })).toHaveProperty(
        "disabled",
        true,
      );
      await user.click(view.getByRole("button", { name: "Back" }));
      await user.click(view.getByLabelText("Where OpenBot lives"));
      await act(async () => view.getByLabelText("Where OpenBot lives").blur());
    } else {
      await act(async () => rootField.blur());
    }
    expect(requests[requests.length - 1].root).toBe(currentRoot);
    await act(async () =>
      requests[requests.length - 1].response.resolve({
        ...savedOpenAiConfiguration(),
        values: {
          INTELLIGENCE_API_URL: "https://current.example/api",
          INTELLIGENCE_GATEWAY_WS_URL: "wss://current.example/ws",
        },
      }),
    );
    if (savedModel) {
      await user.click(
        view.getByRole("button", { name: "Continue to sign in" }),
      );
      await user.click(await view.findByRole("radio", { name: /OpenAI/ }));
      await user.click(view.getByRole("button", { name: "Continue" }));
    } else {
      await chooseModelAfterRootEdit(view, "sk-synthetic-current-model");
    }
    expect(
      view.getByText(
        "A saved CopilotKit connection will be checked when you start.",
      ),
    ).toBeTruthy();
    await user.click(view.getByText("Point at your own Intelligence server"));
    expect(view.getByLabelText("Project key")).toHaveProperty("value", "");
    expect(view.getByLabelText("API URL")).toHaveProperty(
      "value",
      "https://current.example/api",
    );
    expect(view.getByLabelText("Gateway WebSocket URL")).toHaveProperty(
      "value",
      "wss://current.example/ws",
    );
    const currentStart = view.getByRole("button", { name: "Start OpenBot" });
    expect(currentStart).toHaveProperty("disabled", false);
    await user.click(currentStart);
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(getStartStackPayload()).toEqual({
      root: currentRoot,
      apiKey: "",
      apiUrl: "https://current.example/api",
      gatewayWsUrl: "wss://current.example/ws",
      harness: { id: "langgraph" },
      model: savedModel
        ? { provider: "openai", login: "api-key", saved: true }
        : {
            provider: "openai",
            login: "api-key",
            apiKey: "sk-synthetic-current-model",
          },
    });
  },
);

function useBringYourOwnHarnessSetup() {
  invokeHandler = async (command) => {
    if (command === "prepare_installation") return null;
    if (command === "detect_engine") {
      return {
        engine: "docker",
        responding: true,
        engine_socket: null,
        detail: "Docker is answering.",
      };
    }
    if (command === "default_root") return "/tmp/openbot-app-test";
    if (command === "already_configured") {
      return {
        values: {},
        saved: {
          intelligenceApiKey: true,
          modelApiKeys: { openai: false, anthropic: false },
          modelSessions: { openai: false, anthropic: false },
        },
      };
    }
    if (command === "already_running") return false;
    if (command === "windows_blocker") return null;
    if (command === "last_failure") return null;
    if (command === "harnesses") {
      return [
        {
          id: "langgraph",
          name: "LangGraph",
          summary: "Default Bot",
          image: null,
          health_path: null,
          credential: "any-provider",
          maintainer: "first-party",
          mark: null,
          port: 8000,
        },
        {
          id: "byo-url",
          name: "An agent you already run",
          summary: "Give its address.",
          image: null,
          health_path: null,
          credential: "their-endpoint",
          maintainer: "community",
          mark: null,
          port: null,
        },
      ];
    }
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
    throw new Error(`unexpected command ${command}`);
  };
}

async function enterBringYourOwnHarnessEndpoint(agentUrl: string) {
  const view = await renderApp();

  await userEvent.click(
    await view.findByRole("button", { name: "Set up OpenBot" }),
  );
  await userEvent.click(await view.findByText("Choose the agent framework"));
  await userEvent.click(
    await view.findByRole("radio", { name: /An agent you already run/ }),
  );

  const continueFromHarness = view.getByRole("button", { name: "Continue" });
  expect(continueFromHarness).toHaveProperty("disabled", true);
  const agentEndpoint = view.getByLabelText("AG-UI endpoint");
  if (agentUrl) {
    await userEvent.type(agentEndpoint, agentUrl.replaceAll("[", "[["));
  }
  expect(agentEndpoint).toHaveProperty("value", agentUrl);
  return view;
}

test.each([
  "",
  "http://",
  "https://",
  "httpx://models.example/v1",
  "httpfoo://models.example/v1",
  "https://exa mple.example/v1",
  "HTTP://agent.example/ag-ui",
  "https:agent.example/ag-ui",
])("bring-your-own agent refuses startup for URL %s", async (agentUrl) => {
  useBringYourOwnHarnessSetup();
  const view = await enterBringYourOwnHarnessEndpoint(agentUrl);

  const continueButton = view.getByRole("button", { name: "Continue" });
  expect(continueButton).toHaveProperty("disabled", true);
  await userEvent.click(continueButton);
  expect(view.getByRole("heading", { name: "Your first Bot" })).toBeTruthy();
  expect(view.queryByRole("heading", { name: "Connect your AI" })).toBeNull();
  expect(view.queryByRole("button", { name: "Start OpenBot" })).toBeNull();
  expect(invokeCalls.filter((call) => call.command === "start_stack")).toEqual(
    [],
  );
});

test.each([
  ["https://agent.example/ag-ui", "https://agent.example/ag-ui"],
  ["http://localhost:11434/v1", "http://localhost:11434/v1"],
  ["https://models.example/v1", "https://models.example/v1"],
  ["https://bücher.example/ag-ui", "https://bücher.example/ag-ui"],
  ["http://[::1]:8000/ag-ui", "http://[::1]:8000/ag-ui"],
  ["  http://localhost:8000/ag-ui  ", "http://localhost:8000/ag-ui"],
])(
  "bring-your-own agent collects a distinct AG-UI endpoint for startup: %s",
  async (agentUrl, expectedAgentUrl) => {
    useBringYourOwnHarnessSetup();
    const view = await enterBringYourOwnHarnessEndpoint(agentUrl);

    const continueFromHarness = view.getByRole("button", { name: "Continue" });
    expect(continueFromHarness).toHaveProperty("disabled", false);
    await userEvent.click(continueFromHarness);
    await completeInstallation(view);
    expect(
      await view.findByRole("heading", { name: "Connect your AI" }),
    ).toBeTruthy();
    await userEvent.click(
      await view.findByRole("radio", { name: /OpenAI-compatible/ }),
    );
    await userEvent.type(
      view.getByLabelText("Base URL"),
      "https://provider.example/v1",
    );
    await userEvent.type(view.getByLabelText("Model name"), "local-model");
    await userEvent.click(view.getByRole("button", { name: "Continue" }));
    await userEvent.click(
      await view.findByRole("button", { name: "Start OpenBot" }),
    );

    const payload = getStartStackPayload();
    expect(
      invokeCalls.filter((call) => call.command === "start_stack"),
    ).toHaveLength(1);
    expect(payload).toEqual({
      root: "/tmp/openbot-app-test",
      apiKey: "",
      apiUrl: "https://api.intelligence.copilotkit.ai",
      gatewayWsUrl: "wss://realtime.intelligence.copilotkit.ai",
      harness: { id: "byo-url", agentUrl: expectedAgentUrl },
      model: {
        provider: "openai-compatible",
        login: "endpoint",
        baseUrl: "https://provider.example/v1",
        model: "local-model",
      },
    });
    expect(payload.model).not.toHaveProperty("apiKey");
  },
);

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
      apiKey: "",
      apiUrl: "https://api.intelligence.copilotkit.ai",
      gatewayWsUrl: "wss://realtime.intelligence.copilotkit.ai",
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
  await userEvent.click(view.getByRole("button", { name: "Set up OpenBot" }));
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await completeInstallation(view);

  expect(
    view.getByLabelText("Container Base URL, if different"),
  ).toHaveProperty("value", "http://ollama:11434/v1");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(
    await view.findByRole("button", { name: "Start OpenBot" }),
  );

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
          intelligenceApiKey: true,
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

      const view = await renderApp();
      await userEvent.click(
        await view.findByRole("button", { name: "Set up OpenBot" }),
      );
      await userEvent.click(
        await view.findByRole("button", { name: "Continue" }),
      );
      await completeInstallation(view);
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
      await userEvent.click(
        await view.findByRole(
          "button",
          { name: "Start OpenBot" },
          // A fresh sign-in shows its tick for a second before it moves on.
          { timeout: 4000 },
        ),
      );

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

  test(`saved ${provider.name} plan session enables Start without raw protected secrets on mount`, async () => {
    invokeHandler = async (command) => {
      if (command === "prepare_installation") return null;
      if (command === "detect_engine") {
        return {
          engine: "docker",
          responding: true,
          engine_socket: null,
          detail: "Docker is answering.",
        };
      }
      if (command === "default_root") return "/tmp/openbot-app-test";
      if (command === "already_configured") {
        return {
          values: {},
          saved: {
            intelligenceApiKey: true,
            modelApiKeys: { openai: false, anthropic: false },
            modelSessions: {
              openai: provider.id === "openai",
              anthropic: provider.id === "anthropic",
            },
          },
        };
      }
      if (command === "already_running") return false;
      if (command === "windows_blocker") return null;
      if (command === "last_failure") return null;
      if (command === "harnesses") {
        return [
          {
            id: "langgraph",
            name: "LangGraph",
            summary: "Default Bot",
            image: null,
            health_path: null,
            credential: "any-provider",
            maintainer: "first-party",
            mark: null,
            port: 8000,
          },
        ];
      }
      if (command === "providers") {
        return [
          {
            id: provider.id,
            name: provider.name,
            summary: `Use ${provider.name}.`,
            logins: ["plan", "api-key"],
            mark: null,
            caution: null,
          },
        ];
      }
      if (command === "start_stack") return null;
      throw new Error(`unexpected command ${command}`);
    };

    const view = await renderApp();

    await userEvent.click(
      await view.findByRole("button", { name: "Set up OpenBot" }),
    );
    await userEvent.click(
      await view.findByRole("button", { name: "Continue" }),
    );
    await completeInstallation(view);
    await userEvent.click(
      await view.findByRole("radio", { name: new RegExp(provider.name) }),
    );
    expect(
      view.getByText(
        new RegExp(`A saved ${provider.name} sign-in will be checked`),
      ),
    ).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(
        view.getByRole("button", { name: "Start OpenBot" }),
      ).toHaveProperty("disabled", false),
    );
    await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));

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
    expect(
      invokeCalls.find((call) => call.command === "start_stack")?.args,
    ).toMatchObject({
      root: "/tmp/openbot-app-test",
      apiKey: "",
      model: {
        provider: provider.id,
        login: "plan",
        saved: true,
      },
      harness: { id: "langgraph" },
    });
  });
}

for (const provider of [
  { id: "openai", name: "OpenAI", plan: "ChatGPT" },
  { id: "anthropic", name: "Anthropic", plan: "Claude" },
]) {
  for (const login of ["plan", "api-key"] as const) {
    test(`unknown legacy ${provider.name} ${login} and Intelligence reuse stays passive until Start`, async () => {
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
      const view = await renderApp();
      await userEvent.click(
        await view.findByRole("button", { name: "Set up OpenBot" }),
      );
      await userEvent.click(
        await view.findByRole("button", { name: "Continue" }),
      );
      await completeInstallation(view);
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
      await userEvent.click(view.getByRole("button", { name: "Continue" }));
      expect(
        view.getByRole("button", { name: "Start OpenBot" }),
      ).toHaveProperty("disabled", true);
      await userEvent.click(
        view.getByRole("button", { name: "Use a saved connection" }),
      );
      expect(view.queryByText("Connected to CopilotKit.")).toBeNull();
      // Returning to the provider screen retains deliberate reuse without signing in automatically.
      await userEvent.click(view.getByRole("button", { name: "Back" }));
      await userEvent.click(
        await view.findByRole("button", { name: "Continue" }),
      );
      expect(
        invokeCalls.some((call) =>
          /sign_in|start_stack|ask_the_bot/.test(call.command),
        ),
      ).toBe(false);
      await userEvent.click(
        view.getByRole("button", { name: "Start OpenBot" }),
      );
      await view.findByText("Synthetic saved credential is unavailable.");
      expect(getStartStackPayload()).toMatchObject({
        apiKey: "",
        model: { provider: provider.id, login, saved: true },
      });
      expect(getStartStackPayload().model).not.toHaveProperty("token");
      expect(getStartStackPayload().model).not.toHaveProperty("apiKey");
      expect(
        view.getByRole("button", { name: "Sign in to CopilotKit again" }),
      ).toBeTruthy();
    });
  }
}

test("Start credential failures do not expose a restore action", async () => {
  useCompatibleEndpointSetup({
    INTELLIGENCE_API_KEY: "synthetic-intelligence",
  });
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
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));

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

test("a hosted Ask screen has no Intelligence dashboard link and leaves the menus alone", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "ask_the_bot") return "42";
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint("https://models.example/v1");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  await userEvent.click(await view.findByRole("button", { name: "Ask" }));
  await view.findByText("42");
  expect(
    view.queryByRole("button", { name: "View in Intelligence" }),
  ).toBeNull();
  expect(
    invokeCalls.filter((call) =>
      ["offer_local_intelligence", "open_local_intelligence"].includes(
        call.command,
      ),
    ),
  ).toEqual([]);
});

test("the Enter that finishes a composed character does not ask the Bot", async () => {
  useCompatibleEndpointSetup({});
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "ask_the_bot") return "42";
    return previous(command, args);
  };
  const view = await enterCompatibleEndpoint("https://models.example/v1");
  await userEvent.click(view.getByRole("button", { name: "Continue" }));
  await userEvent.click(view.getByRole("button", { name: "Start OpenBot" }));
  const question = await view.findByLabelText("Your question");
  // Keys land on the focused field.
  await userEvent.click(question);

  // Japanese, Chinese and Korean are typed through an input method, where Enter confirms the
  // character being built. Chromium marks that keydown `isComposing`; the macOS WebKit webview
  // sends it after compositionend with key code 229. Neither should send the question.
  await act(async () => {
    fireEvent.keyDown(question, { key: "Enter", isComposing: true });
    fireEvent.keyDown(question, { key: "Enter", keyCode: 229 });
  });

  expect(invokeCalls.filter((call) => call.command === "ask_the_bot")).toEqual(
    [],
  );
});

async function enterSelfHostedIntelligence() {
  const view = await enterProjectSelection();
  await userEvent.click(
    view.getByText("Point at your own Intelligence server"),
  );
  const user = userEvent.setup({ document: window.document });
  await user.clear(view.getByLabelText("API URL"));
  await user.type(
    view.getByLabelText("API URL"),
    "https://intelligence.example.test",
  );
  return view;
}

test("self-hosted Intelligence sign-in selects a project and receives its provisioned key", async () => {
  const view = await enterSelfHostedIntelligence();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "begin_self_hosted_intelligence_sign_in")
      return [{ id: "42", name: "Self-hosted team" }];
    if (command === "finish_self_hosted_intelligence_sign_in")
      return "self-hosted-project-key";
    return previous(command, args);
  };
  await userEvent.click(
    view.getByRole("button", { name: "Sign in to Intelligence" }),
  );
  expect(invokeCalls).toContainEqual({
    command: "begin_self_hosted_intelligence_sign_in",
    args: {
      root: "/tmp/create-project",
      apiUrl: "https://intelligence.example.test",
    },
  });
  expect(view.queryByRole("button", { name: "Create project" })).toBeNull();
  await userEvent.click(
    await view.findByRole("button", { name: "Self-hosted team" }),
  );
  expect(invokeCalls).toContainEqual({
    command: "finish_self_hosted_intelligence_sign_in",
    args: { root: "/tmp/create-project", project: "42" },
  });
  expect(await view.findByText("Connected to Intelligence.")).toBeTruthy();
  expect(view.getByLabelText("Project key")).toHaveProperty(
    "value",
    "self-hosted-project-key",
  );
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    false,
  );
});

test("cancelling self-hosted login ignores a late project response and keeps manual setup available", async () => {
  const view = await enterSelfHostedIntelligence();
  const projects = deferred<{ id: string; name: string }[]>();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "begin_self_hosted_intelligence_sign_in")
      return projects.promise;
    if (command === "cancel_self_hosted_intelligence_sign_in") return;
    return previous(command, args);
  };
  await userEvent.click(
    view.getByRole("button", { name: "Sign in to Intelligence" }),
  );
  expect(view.getByRole("status").textContent).toContain(
    "Intelligence browser window",
  );
  expect(view.getByLabelText("API URL")).toHaveProperty("disabled", true);
  await userEvent.click(
    view.getByRole("button", { name: "Cancel Intelligence sign-in" }),
  );
  expect(
    invokeCalls.some(
      (call) => call.command === "cancel_self_hosted_intelligence_sign_in",
    ),
  ).toBe(true);
  await act(async () =>
    projects.resolve([{ id: "42", name: "Cancelled team" }]),
  );
  expect(view.queryByRole("button", { name: "Cancelled team" })).toBeNull();
  expect(view.getByLabelText("API URL")).toHaveProperty("disabled", false);
  await userEvent.type(view.getByLabelText("Project key"), "manual-key");
  expect(view.getByRole("button", { name: "Start OpenBot" })).toHaveProperty(
    "disabled",
    false,
  );
});

test("self-hosted provisioning failure offers a fresh sign-in without retaining a stale picker", async () => {
  const view = await enterSelfHostedIntelligence();
  const previous = invokeHandler;
  invokeHandler = async (command, args) => {
    if (command === "begin_self_hosted_intelligence_sign_in")
      return [{ id: "42", name: "Team" }];
    if (command === "finish_self_hosted_intelligence_sign_in")
      throw { said: "Your account cannot create the Learning container." };
    return previous(command, args);
  };
  await userEvent.click(
    view.getByRole("button", { name: "Sign in to Intelligence" }),
  );
  await userEvent.click(await view.findByRole("button", { name: "Team" }));
  expect(view.getByRole("alert").textContent).toContain(
    "cannot create the Learning container",
  );
  expect(view.queryByRole("button", { name: "Team" })).toBeNull();
  expect(
    view.getByRole("button", { name: "Sign in to Intelligence" }),
  ).toHaveProperty("disabled", false);
  expect(view.getByLabelText("Project key")).toHaveProperty("value", "");
});
