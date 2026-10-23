import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import type { LocalConnection, LocalReport } from "./localEvalCli";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeHandler: Invoke = async () => {
  throw new Error("invoke handler was not installed");
};

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return invokeHandler(command, args);
  },
}));

const { LocalIntelligence, LocalStatus, useLocalSequence } = await import(
  "./LocalIntelligence"
);

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  // Unmounting cancels a running step, so clear the record after it.
  cleanup();
  invokeCalls = [];
});
afterAll(() => GlobalRegistrator.unregister());

function report(overrides: Partial<LocalReport> = {}): LocalReport {
  return {
    outcome: "completed",
    stack: {
      id: "local-abc123",
      installedRelease: "0.13.14",
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
    readiness: "unknown",
    licence: "unknown",
    licenceExpiresAt: null,
    ...overrides,
  };
}

const ready = report({ readiness: "ready", licence: "valid" });
const starting = report({ readiness: "starting", licence: "valid" });

function connection(overrides: Partial<LocalConnection> = {}): LocalConnection {
  return {
    outcome: "completed",
    stack: report().stack,
    reason: null,
    conflicted: false,
    ...overrides,
  };
}

const startableUrls = {
  apiUrl: "http://localhost:64770",
  gatewayWsUrl: "ws://localhost:64772",
};

const blockedOnTerms = report({
  outcome: "blocked",
  stack: null,
  reason: "eula-acceptance-required",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Startable = { apiUrl: string; gatewayWsUrl: string };

type Props = {
  stack?: string | null;
  connected?: boolean;
  /** Gives the go-ahead on arrival. Without it, Start OpenBot does. */
  auto?: boolean;
  /** Runs up to ready on arrival, without the go-ahead, under its status line. */
  prepare?: boolean;
  onStart?: (startable: Startable) => Promise<boolean>;
  pollDelays?: number[];
};

/** The window's part: it holds the sequence, and a screen shows it. */
function Holder(props: Props) {
  const sequence = useLocalSequence({
    root: "/tmp/openbot",
    stack: props.stack ?? null,
    connected: props.connected ?? false,
    onStart: props.onStart ?? (async () => true),
    pollDelays: props.pollDelays ?? [0, 0, 0],
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival.
  useEffect(() => {
    if (props.prepare) sequence.prepare();
    else if (props.auto ?? true) sequence.start();
  }, []);
  return (
    <>
      {props.prepare && <LocalStatus sequence={sequence} />}
      <LocalIntelligence sequence={sequence} offerStart />
    </>
  );
}

function view(props: Props = {}) {
  return render(<Holder {...props} />);
}

/** Answers each command from its own queue; the last answer repeats. */
function answers(queues: Record<string, unknown[]>): Invoke {
  return async (command) => {
    const queue = queues[command];
    if (!queue) throw new Error(`unexpected ${command}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  };
}

function statusCalls() {
  return invokeCalls.filter(
    (call) =>
      call.command === "run_local_eval" &&
      (call.args as { action: string }).action === "status",
  );
}

function commands() {
  return invokeCalls.map((call) =>
    call.command === "run_local_eval"
      ? `${call.command}:${(call.args as { action: string }).action}`
      : call.command,
  );
}

function row(screen: ReturnType<typeof view>, name: string) {
  return screen.getByRole("listitem", { name });
}

const SETUP = "Setting up Intelligence";
const CONNECT = "Connecting OpenBot";
const WAIT = "Waiting for Intelligence";
const START = "Starting OpenBot";

test("the whole sequence runs by itself: set up, connect, wait for ready and valid, start", async () => {
  invokeHandler = answers({
    set_up_local_eval: [report()],
    connect_local_eval: [connection()],
    run_local_eval: [starting, starting, ready],
  });
  const started: Startable[] = [];
  const screen = view({
    onStart: async (startable) => {
      started.push(startable);
      return true;
    },
  });
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual([
    "set_up_local_eval",
    "connect_local_eval",
    "run_local_eval:status",
    "run_local_eval:status",
    "run_local_eval:status",
  ]);
  expect(
    invokeCalls.find((call) => call.command === "set_up_local_eval")?.args,
  ).toMatchObject({ root: "/tmp/openbot" });
  expect(
    invokeCalls.find((call) => call.command === "connect_local_eval")?.args,
  ).toMatchObject({ root: "/tmp/openbot" });
  for (const name of [SETUP, CONNECT, WAIT, START]) {
    expect(row(screen, name).textContent).toContain("Complete");
  }
  // Nothing to press: the installation is the consent.
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
});

test("a recorded, connected stack skips straight to waiting", async () => {
  invokeHandler = answers({ run_local_eval: [ready] });
  const started: Startable[] = [];
  view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return true;
    },
  });
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual(["run_local_eval:status"]);
  expect(statusCalls()[0]?.args).toMatchObject({ stack: "local-abc123" });
});

const blockedOnSignIn = report({
  outcome: "blocked",
  stack: null,
  reason: "authentication-required",
});

const requiredTerms = {
  status: "required",
  accepted: false,
  version: "developer-edition-2026-10-01-web",
  url: "https://copilotkit.ai/legal/developer-edition",
  organizationName: "Acme",
};

test("setup that needs a CopilotKit sign-in offers it in the window, then carries on by itself", async () => {
  invokeHandler = answers({
    // Blocked on the sign-in, then set up once it is done.
    set_up_local_eval: [blockedOnSignIn, report()],
    sign_in_to_copilotkit: [{ signedIn: true }],
    connect_local_eval: [connection()],
    run_local_eval: [ready],
    cancel_local_eval: [null],
  });
  const screen = view();
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign in to CopilotKit" }),
  );
  await waitFor(() =>
    expect(row(screen, START).textContent).toContain("Complete"),
  );
  expect(commands().filter((c) => c === "sign_in_to_copilotkit")).toHaveLength(
    1,
  );
  expect(commands().filter((c) => c === "set_up_local_eval")).toHaveLength(2);
});

test("a CopilotKit sign-in that does not finish says so and can be tried again", async () => {
  invokeHandler = answers({
    set_up_local_eval: [blockedOnSignIn],
    sign_in_to_copilotkit: [{ signedIn: false }],
    cancel_local_eval: [null],
  });
  const screen = view();
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign in to CopilotKit" }),
  );
  await screen.findByText("Sign-in did not finish. Try again.");
  expect(
    screen.getByRole("button", { name: "Sign in to CopilotKit" }),
  ).toBeTruthy();
  expect(commands().filter((c) => c === "set_up_local_eval")).toHaveLength(1);
});

test("setup that needs the agreement shows it, and only Accept sets up again with that version", async () => {
  invokeHandler = answers({
    set_up_local_eval: [blockedOnTerms, report()],
    local_eval_terms: [requiredTerms],
    connect_local_eval: [connection()],
    run_local_eval: [ready],
    cancel_local_eval: [null],
  });
  const screen = view();
  await screen.findByText(
    "To run Intelligence on this computer, accept the CopilotKit Intelligence evaluation agreement for Acme.",
  );
  expect(screen.getByRole("link", { name: "Read the agreement" })).toBeTruthy();
  // Nothing is accepted until the person clicks Accept.
  expect(
    invokeCalls.filter((call) => call.command === "set_up_local_eval"),
  ).toEqual([
    {
      command: "set_up_local_eval",
      args: expect.objectContaining({ acceptedEulaVersion: null }),
    },
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Accept" }));
  await waitFor(() =>
    expect(row(screen, START).textContent).toContain("Complete"),
  );
  const setups = invokeCalls.filter(
    (call) => call.command === "set_up_local_eval",
  );
  expect(
    setups.map(
      (call) =>
        (call.args as { acceptedEulaVersion: string | null })
          .acceptedEulaVersion,
    ),
  ).toEqual([null, "developer-edition-2026-10-01-web"]);
});

test("an acceptance setup does not take is said once, not offered again", async () => {
  invokeHandler = answers({
    set_up_local_eval: [blockedOnTerms, blockedOnTerms],
    local_eval_terms: [requiredTerms, requiredTerms],
    cancel_local_eval: [null],
  });
  const screen = view();
  await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
  await screen.findByText(/Intelligence did not take the acceptance/);
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(
    invokeCalls.filter((call) => call.command === "set_up_local_eval"),
  ).toHaveLength(2);
});

test("no build sends the person to a terminal", async () => {
  for (const [blocked, terms] of [
    [blockedOnTerms, requiredTerms],
    [blockedOnSignIn, requiredTerms],
  ] as const) {
    invokeHandler = answers({
      set_up_local_eval: [blocked],
      local_eval_terms: [terms],
      cancel_local_eval: [null],
    });
    const screen = view();
    await screen.findByRole("button", {
      name: blocked === blockedOnTerms ? "Accept" : "Sign in to CopilotKit",
    });
    expect(screen.queryByText(/copilotkit |Terminal/)).toBeNull();
    cleanup();
    invokeCalls = [];
  }
});

test("a blocked or conflicted connection stops at its row, and Retry resumes at Connect", async () => {
  for (const [answer, said] of [
    [
      connection({ outcome: "blocked", reason: "confirmation-required" }),
      "Intelligence asked for a confirmation OpenBot cannot give.",
    ],
    [
      connection({ outcome: "blocked", conflicted: true }),
      "Settings Intelligence wrote for OpenBot were changed since. OpenBot did not connect.",
    ],
  ] as const) {
    invokeHandler = answers({
      set_up_local_eval: [report()],
      connect_local_eval: [answer],
    });
    const started: Startable[] = [];
    const screen = view({
      onStart: async (startable) => {
        started.push(startable);
        return true;
      },
    });
    await waitFor(() =>
      expect(row(screen, CONNECT).textContent).toContain(said),
    );
    expect(statusCalls()).toHaveLength(0);
    invokeHandler = answers({
      connect_local_eval: [connection()],
      run_local_eval: [ready],
    });
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(started).toEqual([startableUrls]));
    expect(commands().filter((c) => c === "set_up_local_eval")).toHaveLength(1);
    cleanup();
    invokeCalls = [];
  }
});

test("readiness or a licence that is not exactly ready and valid never starts", async () => {
  for (const [answer, said] of [
    [
      report(),
      "Intelligence started. Its licence and readiness are not reported yet.",
    ],
    [
      report({ readiness: "ready", licence: "expired" }),
      "The Intelligence evaluation licence has expired.",
    ],
    [
      report({ readiness: "degraded", licence: "valid" }),
      "Intelligence is running but not healthy.",
    ],
  ] as const) {
    invokeHandler = answers({ run_local_eval: [answer] });
    const started: Startable[] = [];
    const screen = view({
      stack: "local-abc123",
      connected: true,
      onStart: async (startable) => {
        started.push(startable);
        return true;
      },
    });
    await waitFor(() => expect(row(screen, WAIT).textContent).toContain(said));
    // Unknown is not polled: an older CLI never reports more.
    expect(statusCalls()).toHaveLength(1);
    expect(started).toEqual([]);
    expect(screen.queryByRole("listitem", { name: START })).toBeNull();
    invokeHandler = answers({ run_local_eval: [ready] });
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(started).toEqual([startableUrls]));
    expect(commands()).toEqual([
      "run_local_eval:status",
      "run_local_eval:status",
    ]);
    cleanup();
    invokeCalls = [];
  }
});

test("polling is bounded, and says so when Intelligence never became ready", async () => {
  invokeHandler = answers({ run_local_eval: [starting] });
  const screen = view({
    stack: "local-abc123",
    connected: true,
    pollDelays: [0, 0],
  });
  await screen.findByText("Intelligence did not report ready in time.");
  expect(statusCalls()).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("Cancel stops the running CLI call by its own attempt, and Retry resumes there", async () => {
  const pending = deferred<LocalReport>();
  invokeHandler = async (command) => {
    if (command === "set_up_local_eval") return pending.promise;
    if (command === "cancel_local_eval") {
      pending.reject("cancelled");
      return null;
    }
    throw new Error(`unexpected ${command}`);
  };
  const screen = view();
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  const setup = invokeCalls.find(
    (call) => call.command === "set_up_local_eval",
  );
  expect(
    invokeCalls.find((call) => call.command === "cancel_local_eval")?.args,
  ).toEqual({
    attempt: (setup?.args as { attempt: string } | undefined)?.attempt,
  });
  await waitFor(() =>
    expect(row(screen, SETUP).textContent).toContain(
      "Stopped at your request before it finished.",
    ),
  );
  invokeHandler = answers({ set_up_local_eval: [blockedOnTerms] });
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(commands().filter((c) => c === "set_up_local_eval")).toHaveLength(2),
  );
});

test("polling stops when cancelled", async () => {
  invokeHandler = async (command) => {
    if (command === "run_local_eval") return starting;
    throw new Error(`unexpected ${command}`);
  };
  const screen = view({
    stack: "local-abc123",
    connected: true,
    pollDelays: [60_000],
  });
  await waitFor(() => expect(statusCalls()).toHaveLength(1));
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await screen.findByRole("button", { name: "Retry" });
  expect(statusCalls()).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
});

test("a stopped stack is started, then polled", async () => {
  const stopped = report({ readiness: "stopped", licence: "valid" });
  invokeHandler = async (command, args) => {
    const action = (args as { action?: string }).action;
    if (command === "run_local_eval" && action === "start") return report();
    if (command === "run_local_eval") {
      return invokeCalls.some(
        (call) => (call.args as { action?: string }).action === "start",
      )
        ? ready
        : stopped;
    }
    throw new Error(`unexpected ${command}`);
  };
  const started: Startable[] = [];
  view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return true;
    },
  });
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual([
    "run_local_eval:status",
    "run_local_eval:start",
    "run_local_eval:status",
  ]);
});

test("a start that fails stops at its row, and Retry starts again without asking the CLI", async () => {
  invokeHandler = answers({ run_local_eval: [ready] });
  let starts = 0;
  const screen = view({
    stack: "local-abc123",
    connected: true,
    onStart: async () => ++starts > 1,
  });
  await waitFor(() =>
    expect(row(screen, START).textContent).toContain("OpenBot did not start."),
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(starts).toBe(2));
  expect(statusCalls()).toHaveLength(1);
});

test("without auto, nothing runs until Start OpenBot is chosen", async () => {
  invokeHandler = answers({ run_local_eval: [ready] });
  const started: Startable[] = [];
  const screen = view({
    stack: "local-abc123",
    connected: true,
    auto: false,
    onStart: async (startable) => {
      started.push(startable);
      return true;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(invokeCalls).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Start OpenBot" }));
  await waitFor(() => expect(started).toEqual([startableUrls]));
});

test("prepare runs to ready and waits for the go-ahead, which starts at once", async () => {
  invokeHandler = answers({
    set_up_local_eval: [report()],
    connect_local_eval: [connection()],
    run_local_eval: [ready],
  });
  const started: Startable[] = [];
  const screen = view({
    prepare: true,
    onStart: async (startable) => {
      started.push(startable);
      return true;
    },
  });
  await screen.findByText("Intelligence is ready.");
  expect(row(screen, WAIT).textContent).toContain("Complete");
  expect(screen.queryByRole("listitem", { name: START })).toBeNull();
  expect(started).toEqual([]);
  // No Start OpenBot once it has run: the go-ahead comes from the screen in front.
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  invokeCalls = [];
});

test("the status line names the running row and its elapsed time", async () => {
  invokeHandler = answers({
    set_up_local_eval: [new Promise(() => {})],
    cancel_local_eval: [null],
  });
  const screen = view({ prepare: true });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "Setting up Intelligence · 0s elapsed",
    ),
  );
});

test("the running screen offers no way to the hosted service", async () => {
  invokeHandler = answers({ set_up_local_eval: [blockedOnTerms] });
  const screen = view();
  await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByRole("button", { name: /hosted/ })).toBeNull();
});

test("failures arrive as categories, and a stack that could not be recorded as a problem", async () => {
  invokeHandler = async () => {
    throw "timeout";
  };
  const screen = view();
  await waitFor(() =>
    expect(row(screen, SETUP).textContent).toContain(
      "Intelligence could not start.",
    ),
  );
  invokeHandler = async () => {
    throw {
      said: "OpenBot could not save its local evaluation progress.",
      detail: "synthetic",
    };
  };
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "OpenBot could not save its local evaluation progress.",
  );
});

test("an answer OpenBot does not recognise is never echoed", async () => {
  invokeHandler = async () => {
    throw "synthetic-secret-marker";
  };
  const screen = view();
  await screen.findByRole("alert");
  expect(document.body.textContent).not.toContain("synthetic-secret-marker");
});
