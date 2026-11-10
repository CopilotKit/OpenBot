import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import type { StartOutcome } from "./LocalIntelligence";
import type { LocalConnection, LocalReport } from "./localEvalCli";

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeHandler: Invoke = async () => {
  throw new Error("invoke handler was not installed");
};
/** What `local_eval_update_step` answers for the update running now, and who asked. */
let updateStep: unknown = null;
let updateStepAsked: unknown[] = [];

/** What `local_eval_steps` answers for the CLI call running now: the steps it has finished. */
let localSteps: unknown = null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    // The engine already answers here: these tests are about the CLI calls after it. Waking a
    // stopped engine is App.test.tsx's "relaunch with Docker Desktop quit".
    if (command === "wake_engine") return Promise.resolve(null);
    // Asked every second while a CLI call runs: not a step of the sequence.
    if (command === "local_eval_steps") return Promise.resolve(localSteps);
    // Asking which step an update is in is not a step of the sequence either.
    if (command === "local_eval_update_step") {
      updateStepAsked.push(args);
      return Promise.resolve(updateStep);
    }
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
  updateStep = null;
  updateStepAsked = [];
  localSteps = null;
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
      unfinishedUpdate: null,
      observed: null,
    },
    reason: null,
    readiness: "unknown",
    licence: "unknown",
    licenceExpiresAt: null,
    checksPassed: false,
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

type Startable = { apiUrl: string; gatewayWsUrl: string; notice?: string };

type Props = {
  stack?: string | null;
  connected?: boolean;
  /** Gives the go-ahead on arrival. Without it, Start OpenBot does. */
  auto?: boolean;
  /** Runs up to ready on arrival, without the go-ahead, under its status line. */
  prepare?: boolean;
  /** Shows the status card another screen shows, whatever runs. */
  status?: boolean;
  onStart?: (startable: Startable) => Promise<StartOutcome>;
  pollDelays?: number[];
};

/** The window's part: it holds the sequence, and a screen shows it. */
function Holder(props: Props) {
  const sequence = useLocalSequence({
    root: "/tmp/openbot",
    stack: props.stack ?? null,
    connected: props.connected ?? false,
    onStart: props.onStart ?? (async () => "started"),
    pollDelays: props.pollDelays ?? [0, 0, 0],
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival.
  useEffect(() => {
    if (props.prepare) sequence.prepare();
    else if (props.auto ?? true) sequence.start();
  }, []);
  return (
    <>
      {(props.prepare || props.status) && <LocalStatus sequence={sequence} />}
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

/** The steps the sequence ran. Asking how far a download has got is not one. */
/** The step's calls, in order. Not the download poll, nor what it tells the log. */
function commands() {
  return invokeCalls
    .filter(
      (call) =>
        call.command !== "local_eval_download" &&
        call.command !== "back_end_wait_ended",
    )
    .map((call) =>
      call.command === "run_local_eval"
        ? `${call.command}:${(call.args as { action: string }).action}`
        : call.command,
    );
}

function row(screen: ReturnType<typeof view>, name: string) {
  return screen.getByRole("listitem", { name });
}

/** The Start's one journey: what is happening now, how far along, and any download's measure. */
function journeyOf(screen: ReturnType<typeof view>) {
  return screen.getByRole("region", { name: "How far along" });
}

const SETUP = "Setting up OpenBot";
const CONNECT = "Connecting OpenBot";
const WAIT = "Getting OpenBot ready";
const START = "Opening OpenBot";

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
      return "started";
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

/**
 * The Windows fresh-install probe: "Setting up OpenBot · In progress" said nothing while ~690 MB of
 * back-end images came down, and the person waited behind the AI screen with nothing either. A
 * first setup's download now shows on the screen in front of it while it runs there, with the bar
 * Install shows, and on Start as the journey's own step: one bar, which the download moves, and
 * its measure under it. The setup's row has no bar of its own.
 */
test("a first setup shows its download on the journey and on the screen in front of it", async () => {
  const settingUp = deferred<LocalReport>();
  let arrived: { done: number; total: number } | null = null;
  invokeHandler = async (command) => {
    if (command === "cancel_local_eval") return null;
    if (command === "local_eval_download") return arrived;
    if (command === "set_up_local_eval") return settingUp.promise;
    throw new Error(`unexpected ${command}`);
  };
  const screen = view({ prepare: true });
  await waitFor(() =>
    expect(row(screen, SETUP).textContent).toContain("Step 1 of 4"),
  );
  arrived = { done: 245_000_000, total: 690_000_000 };
  await waitFor(
    () =>
      expect(journeyOf(screen).textContent).toContain("245.0 MB of 690.0 MB"),
    { timeout: 3_000 },
  );
  const journey = within(journeyOf(screen));
  expect(journey.getByText("Downloading the rest of OpenBot")).toBeTruthy();
  // One bar on Start: the journey's. The row says only which step it is.
  expect(within(row(screen, SETUP)).queryByRole("progressbar")).toBeNull();
  expect(row(screen, SETUP).textContent).not.toContain("MB");
  // The screen in front (Install, or Connect your AI) shows the same download while it runs.
  const behind = within(screen.getByRole("list", { name: "OpenBot download" }));
  expect(
    behind.getByRole("listitem", { name: "Downloading the rest of OpenBot" })
      .textContent,
  ).toContain("245.0 MB of 690.0 MB");
  expect(
    Number(
      behind
        .getByRole("progressbar", { name: "Download progress" })
        .getAttribute("value"),
    ),
  ).toBeCloseTo(245 / 690, 3);
  // It asked about the setup's own call.
  const setup = invokeCalls.find(
    (call) => call.command === "set_up_local_eval",
  );
  expect(
    invokeCalls.find((call) => call.command === "local_eval_download")?.args,
  ).toEqual({
    attempt: (setup?.args as { attempt?: string } | undefined)?.attempt,
  });
  // Downloaded: its measure and the front screen's row go, and the setup carries on.
  arrived = null;
  await waitFor(
    () => expect(journeyOf(screen).textContent).not.toContain("MB"),
    { timeout: 3_000 },
  );
  expect(
    screen.queryByRole("progressbar", { name: "Download progress" }),
  ).toBeNull();
  expect(screen.queryByRole("list", { name: "OpenBot download" })).toBeNull();
});

test("a recorded, connected stack skips straight to waiting", async () => {
  invokeHandler = answers({ run_local_eval: [ready] });
  const started: Startable[] = [];
  view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual(["run_local_eval:status"]);
  expect(statusCalls()[0]?.args).toMatchObject({ stack: "local-abc123" });
});

/** A ready stack an older app set up on rc.8, which this app's CLI would install as rc.9. */
function onRelease(installedRelease: string, updateTo: string | null) {
  const base = report({ readiness: "ready", licence: "valid", updateTo });
  return { ...base, stack: base.stack && { ...base.stack, installedRelease } };
}

test("a backend an older app installed is updated to this app's release before OpenBot starts on it", async () => {
  const updating = deferred<LocalReport>();
  let calls = 0;
  invokeHandler = async (command, args) => {
    if (command === "cancel_local_eval") return null;
    const action = (args as { action: string }).action;
    if (action === "update") return updating.promise;
    calls += 1;
    return calls === 1
      ? onRelease("0.16.0-rc.8", "0.16.0-rc.9")
      : onRelease("0.16.0-rc.9", null);
  };
  const started: Startable[] = [];
  const screen = view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  // One plain line while it runs, on the back end's own row.
  await waitFor(() =>
    expect(row(screen, WAIT).textContent).toContain(
      "Updating OpenBot. Your Bots and data stay as they are.",
    ),
  );
  expect(started).toEqual([]);
  updating.resolve(onRelease("0.16.0-rc.9", null));
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual([
    "run_local_eval:status",
    "run_local_eval:update",
    "run_local_eval:status",
  ]);
  expect(
    invokeCalls.find(
      (call) => (call.args as { action?: string })?.action === "update",
    )?.args,
  ).toMatchObject({ stack: "local-abc123" });
  expect(
    screen.queryByRole("listitem", { name: "Updating OpenBot" }),
  ).toBeNull();
});

/**
 * Found on a Mac: Quit stops the back end, so the first Start after an app update finds an rc.8
 * stack stopped. Updated while stopped, the CLI waited three minutes for services that were not
 * running and failed. It is started first, as any stopped stack is, and updated once it is up.
 */
test("a stopped backend an older app installed is started first, then updated", async () => {
  const stopped = {
    ...onRelease("0.16.0-rc.8", "0.16.0-rc.9"),
    readiness: "stopped" as const,
  };
  invokeHandler = async (command, args) => {
    if (command === "cancel_local_eval") return null;
    const action = (args as { action: string }).action;
    const done = (what: string) =>
      invokeCalls.some(
        (call) => (call.args as { action?: string })?.action === what,
      );
    if (action === "start") return report();
    if (action === "update") return onRelease("0.16.0-rc.9", null);
    if (done("update")) return onRelease("0.16.0-rc.9", null);
    return done("start") ? onRelease("0.16.0-rc.8", "0.16.0-rc.9") : stopped;
  };
  const started: Startable[] = [];
  view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual([
    "run_local_eval:status",
    "run_local_eval:start",
    "run_local_eval:status",
    "run_local_eval:update",
    "run_local_eval:status",
  ]);
});

test("a backend already on this app's release is not updated", async () => {
  invokeHandler = answers({
    run_local_eval: [onRelease("0.16.0-rc.9", null)],
  });
  const started: Startable[] = [];
  view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual(["run_local_eval:status"]);
});

test("an update that fails says so and starts OpenBot on the release the backend still has", async () => {
  for (const failed of [
    report({
      outcome: "failed",
      stack: null,
      reason: "local-command-failed",
    }),
    new Error("timeout"),
  ]) {
    let calls = 0;
    invokeHandler = async (command, args) => {
      if (command === "cancel_local_eval") return null;
      if (command === "local_eval_download") return null;
      const action = (args as { action: string }).action;
      if (action === "update") {
        if (failed instanceof Error) throw "timeout";
        return failed;
      }
      calls += 1;
      // Still rc.8, and still due: tried once in this run, not again.
      return onRelease("0.16.0-rc.8", "0.16.0-rc.9");
    };
    const started: Startable[] = [];
    const screen = view({
      stack: "local-abc123",
      connected: true,
      onStart: async (startable) => {
        started.push(startable);
        return "started";
      },
    });
    await waitFor(() => expect(started).toEqual([startableUrls]));
    expect(commands()).toEqual([
      "run_local_eval:status",
      "run_local_eval:update",
      "run_local_eval:status",
    ]);
    expect(row(screen, "Updating OpenBot").textContent).toContain(
      "OpenBot couldn't finish updating, so it runs the version it had. Your data is kept, and OpenBot tries again the next time it starts.",
    );
    expect(calls).toBe(2);
    cleanup();
    invokeCalls = [];
  }
});

/**
 * Found on OpenBot Desktop, 0.16.0-rc.9 to rc.10: every Start after an interrupted update failed
 * with the same generic line, while the CLI had recorded exactly where it stopped. The row now
 * says where it stopped from the record, in plain words, and that the data is kept. The step's own
 * name is the log's.
 */
test("an update that fails says the step it stopped at and that the data is kept", async () => {
  const stoppedAt = {
    ...onRelease("0.16.0-rc.9", "0.16.0-rc.10"),
    readiness: "degraded" as const,
  };
  const recorded = {
    ...stoppedAt,
    stack: stoppedAt.stack && {
      ...stoppedAt.stack,
      updateInProgress: true,
      unfinishedUpdate: {
        to: "0.16.0-rc.10",
        prepared: false,
        stoppedDownloading: false,
        failedStep: "update-quiesce",
      },
    },
  };
  let calls = 0;
  invokeHandler = async (command, args) => {
    if (command === "cancel_local_eval") return null;
    if (command === "local_eval_download") return null;
    const action = (args as { action: string }).action;
    if (action === "update")
      return report({
        outcome: "failed",
        stack: null,
        reason: "local-command-failed",
      });
    calls += 1;
    return calls === 1 ? onRelease("0.16.0-rc.9", "0.16.0-rc.10") : recorded;
  };
  const screen = view({ stack: "local-abc123", connected: true });
  await waitFor(() =>
    expect(row(screen, "Updating OpenBot").textContent).toContain(
      "OpenBot couldn't finish updating, so it runs the version it had. It stopped while pausing OpenBot's services. Your data is kept, and OpenBot tries again the next time it starts.",
    ),
  );
});

/**
 * Found on OpenBot Desktop: an update sat on "Updating the back end" for minutes with nothing
 * else on the row, while the CLI waited on its databases and Jobs (up to ten minutes each) and
 * logged nothing until each ended. The journey now says which step it is in, from the steps the
 * CLI has finished, and how long is left; the row keeps what this part is, and a part that failed
 * is said on it at once, not ten minutes later.
 */
const UPDATING_SAID = "Updating OpenBot. Your Bots and data stay as they are.";

test("a running update says what it is doing on the journey, and a failed part at once on its row", async () => {
  const updating = deferred<LocalReport>();
  invokeHandler = async (command, args) => {
    if (command === "cancel_local_eval") return null;
    if (command === "local_eval_download") return null;
    const action = (args as { action: string }).action;
    if (action === "update") return updating.promise;
    return invokeCalls.some(
      (call) => (call.args as { action?: string })?.action === "update",
    )
      ? onRelease("0.16.0-rc.10", null)
      : onRelease("0.16.0-rc.9", "0.16.0-rc.10");
  };
  const screen = view({ stack: "local-abc123", connected: true });
  await waitFor(() =>
    expect(row(screen, WAIT).textContent).toContain(UPDATING_SAID),
  );
  // Waiting on its databases: everything before them finished.
  localSteps = {
    ended: [
      "release-download",
      "chart-download",
      "chart-render",
      "cluster-discovery",
      "kubeconfig",
      "runtime-identity-write",
      "image-download",
      "system-image-download",
      "system-image-tag",
      "secrets-apply",
      "update-schedules",
      "update-suspend",
      "update-quiesce",
      "update-quiesce-wait",
      "update-jobs",
      "update-agent-stop",
      "update-agent-wait",
      "dependencies-install",
    ],
    quietSeconds: 4,
  };
  updateStep = { step: "dependencies-wait", seconds: 130 };
  await waitFor(
    () =>
      expect(journeyOf(screen).textContent).toContain(
        "Updating where OpenBot keeps your data",
      ),
    { timeout: 3_000 },
  );
  // Said once: the row does not repeat the step or its time.
  expect(row(screen, WAIT).textContent).not.toContain("so far");
  expect(row(screen, WAIT).textContent).not.toContain("where OpenBot keeps");
  // In the chart's Jobs: a failed one at once, not ten minutes later. Its name is the log's.
  updateStep = {
    step: "jobs",
    seconds: 40,
    job: null,
    failedJob: "cpki-bootstrap-ef56ab78",
  };
  await waitFor(
    () =>
      expect(row(screen, WAIT).textContent).toContain(
        `${UPDATING_SAID} Part of the update didn't work, so it will stop. OpenBot waits up to 10 minutes for it first. Your data is kept.`,
      ),
    { timeout: 3_000 },
  );
  expect(row(screen, WAIT).textContent).not.toContain("cpki");
  // It asked about the update's own call.
  const update = invokeCalls.find(
    (call) => (call.args as { action?: string })?.action === "update",
  );
  expect(updateStepAsked[0]).toEqual({
    attempt: (update?.args as { attempt?: string } | undefined)?.attempt,
  });
  updating.resolve(onRelease("0.16.0-rc.10", null));
});

/** `run_local_eval` answers from the CLI this app pins: see `local_eval_ipc_tests.rs`. */
const pinnedCli = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "../src-tauri/test-fixtures/local-eval/update-did-not-finish.json",
    ),
    "utf8",
  ),
);

/**
 * Quit stopped the back end with an update on record. The CLI refuses `start` then, and `update`
 * starts the stack itself. When the update stops again, the release the stack had is still coming
 * up: its checks fail for a while, and it is waited on, not called not healthy.
 */
test("after Quit, the unfinished update starts the stack, and the release it had is waited on", async () => {
  const statuses = [
    pinnedCli.stoppedByQuit,
    pinnedCli.apiCheckFails,
    pinnedCli.updateDidNotFinish,
  ];
  invokeHandler = async (command, args) => {
    if (command === "cancel_local_eval") return null;
    const action = (args as { action: string }).action;
    if (action === "update")
      return report({
        outcome: "failed",
        stack: null,
        reason: "local-command-failed",
      });
    if (action !== "status") throw new Error(`unexpected ${action}`);
    return statuses.length > 1 ? statuses.shift() : statuses[0];
  };
  const started: Startable[] = [];
  view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  await waitFor(() =>
    expect(started).toEqual([
      {
        apiUrl: "http://localhost:18082",
        gatewayWsUrl: "ws://localhost:14401",
        notice:
          "The OpenBot update didn't finish downloading, so OpenBot is running the version it had. It tries again the next time it starts.",
      },
    ]),
  );
  expect(commands()).toEqual([
    "run_local_eval:status",
    "run_local_eval:update",
    "run_local_eval:status",
    "run_local_eval:status",
  ]);
});

/**
 * The next Start's retry of an update that did not finish: its download shows on the journey while
 * it runs, and when it stalls OpenBot opens on the release the back end has, with the
 * running screen's "did not finish" line.
 */
test("a retried update shows its download, and a stall keeps the line that it did not finish", async () => {
  const updating = deferred<LocalReport>();
  let arrived: { done: number; total: number } | null = null;
  invokeHandler = async (command, args) => {
    if (command === "cancel_local_eval") return null;
    if (command === "local_eval_download") return arrived;
    const action = (args as { action: string }).action;
    if (action === "update") return updating.promise;
    if (action !== "status") throw new Error(`unexpected ${action}`);
    return pinnedCli.updateDidNotFinish;
  };
  const started: Startable[] = [];
  const screen = view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  arrived = { done: 61_400_000, total: 147_000_000 };
  await waitFor(
    () =>
      expect(journeyOf(screen).textContent).toContain("61.4 MB of 147.0 MB"),
    { timeout: 3_000 },
  );
  updating.reject("download-stalled");
  await waitFor(() =>
    expect(started).toEqual([
      {
        apiUrl: "http://localhost:18082",
        gatewayWsUrl: "ws://localhost:14401",
        notice:
          "The OpenBot update didn't finish downloading, so OpenBot is running the version it had. It tries again the next time it starts.",
      },
    ]),
  );
  expect(commands()).toEqual([
    "run_local_eval:status",
    "run_local_eval:update",
    "run_local_eval:status",
  ]);
});

test("an update says how much of its download has arrived, so a slow line reads as moving", async () => {
  const updating = deferred<LocalReport>();
  let arrived: { done: number; total: number } | null = null;
  let calls = 0;
  invokeHandler = async (command, args) => {
    if (command === "cancel_local_eval") return null;
    if (command === "local_eval_download") return arrived;
    const action = (args as { action: string }).action;
    if (action === "update") return updating.promise;
    calls += 1;
    return calls === 1
      ? onRelease("0.16.0-rc.5", "0.16.0-rc.9")
      : onRelease("0.16.0-rc.9", null);
  };
  const started: Startable[] = [];
  const screen = view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  await waitFor(() =>
    expect(row(screen, WAIT).textContent).toContain(
      "Updating OpenBot. Your Bots and data stay as they are.",
    ),
  );
  arrived = { done: 48_200_000, total: 147_000_000 };
  await waitFor(
    () =>
      expect(journeyOf(screen).textContent).toContain("48.2 MB of 147.0 MB"),
    { timeout: 3_000 },
  );
  // The journey says it is downloading, and its one bar is the only one on the screen: the row
  // keeps what this part is, with no bar or measure of its own.
  const journey = within(journeyOf(screen));
  expect(journey.getByText("Downloading the update")).toBeTruthy();
  expect(screen.getAllByRole("progressbar")).toEqual([
    journey.getByRole("progressbar", { name: "How far along" }),
  ]);
  const waiting = within(row(screen, WAIT));
  expect(row(screen, WAIT).textContent).toContain(
    "Updating OpenBot. Your Bots and data stay as they are.",
  );
  expect(row(screen, WAIT).textContent).not.toContain("MB");
  // Downloaded: the CLI's update runs, the measure goes, and the row says the same.
  arrived = null;
  await waitFor(
    () => expect(journeyOf(screen).textContent).not.toContain("MB"),
    { timeout: 3_000 },
  );
  expect(row(screen, WAIT).textContent).toContain(
    "Updating OpenBot. Your Bots and data stay as they are.",
  );
  expect(waiting.queryByRole("progressbar")).toBeNull();
  updating.resolve(onRelease("0.16.0-rc.9", null));
  await waitFor(() => expect(started).toEqual([startableUrls]));
  const asked = invokeCalls.find(
    (call) => call.command === "local_eval_download",
  );
  const update = invokeCalls.find(
    (call) => (call.args as { action?: string })?.action === "update",
  );
  // It asked about the update's own call.
  expect(asked?.args).toEqual({
    attempt: (update?.args as { attempt?: string } | undefined)?.attempt,
  });
});

test("an update whose download stopped says so, and that the next start continues it", async () => {
  let calls = 0;
  invokeHandler = async (command, args) => {
    if (command === "cancel_local_eval") return null;
    if (command === "local_eval_download") return null;
    const action = (args as { action: string }).action;
    if (action === "update") throw "download-stalled";
    calls += 1;
    return onRelease("0.16.0-rc.5", "0.16.0-rc.9");
  };
  const started: Startable[] = [];
  const screen = view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(row(screen, "Updating OpenBot").textContent).toContain(
    "The update stopped downloading, so OpenBot runs the version it had. It picks up the download the next time it starts.",
  );
  expect(calls).toBe(2);
});

test("a setup whose download stopped offers Retry, which continues where it left off", async () => {
  let setups = 0;
  invokeHandler = async (command) => {
    if (command === "cancel_local_eval") return null;
    if (command === "local_eval_download") return null;
    if (command === "set_up_local_eval") {
      setups += 1;
      if (setups === 1) throw "download-stalled";
      return report();
    }
    if (command === "connect_local_eval") return connection();
    return ready;
  };
  const started: Startable[] = [];
  const screen = view({
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  await waitFor(() =>
    expect(row(screen, "Setting up OpenBot").textContent).toContain(
      "The download stopped. Retry continues where it left off.",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(setups).toBe(2);
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

test("setup that needs a sign-in offers it in the window, then carries on by itself", async () => {
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
    await screen.findByRole("button", { name: "Sign in to OpenBot" }),
  );
  await waitFor(() =>
    expect(row(screen, START).textContent).toContain("Complete"),
  );
  expect(commands().filter((c) => c === "sign_in_to_copilotkit")).toHaveLength(
    1,
  );
  expect(commands().filter((c) => c === "set_up_local_eval")).toHaveLength(2);
});

/**
 * A fresh Mac stopped at Start with "The back end stopped with an error partway through": Docker's
 * disk was full, and the CLI's resource check failed. Its report, as `local_eval.rs` reads the
 * CLI's `LOCAL_DOCKER_RESOURCES_SHORT` with "0 GiB free storage (requires 40)", now says the disk
 * is short and where to raise it.
 */
test("a setup refused for a full Docker disk says so, with Retry", async () => {
  invokeHandler = answers({
    set_up_local_eval: [
      report({
        outcome: "failed",
        stack: null,
        reason: "resources-short",
        // As `local_eval.rs` reads the rc.10 CLI's "Docker available resources: 9.871234 CPUs
        // (requires 4), 18.9 GiB RAM available (requires 4), 0 GiB free storage (requires 40)."
        shortfall: {
          podman: false,
          cpu: false,
          memory: false,
          disk: true,
          cpus: "9.8",
          memoryGb: "18.9",
          diskGb: "0",
        },
      }),
    ],
    local_eval_download: [null],
    cancel_local_eval: [null],
  });
  const screen = view();
  await screen.findByRole("button", { name: "Retry" });
  const setup = row(screen, SETUP).textContent;
  expect(setup).toContain(
    "Docker Desktop has 0 GB of free disk. OpenBot needs 40 GB. Raise the disk limit in Docker Desktop > Settings > Resources, or free space in Docker, then Retry.",
  );
  expect(setup).not.toContain("partway through");
});

test("a sign-in that does not finish says so and can be tried again", async () => {
  invokeHandler = answers({
    set_up_local_eval: [blockedOnSignIn],
    sign_in_to_copilotkit: [{ signedIn: false }],
    cancel_local_eval: [null],
  });
  const screen = view();
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign in to OpenBot" }),
  );
  await screen.findByText("Sign-in did not finish. Try again.");
  expect(
    screen.getByRole("button", { name: "Sign in to OpenBot" }),
  ).toBeTruthy();
  expect(commands().filter((c) => c === "set_up_local_eval")).toHaveLength(1);
});

test("a sign-in waiting on the browser shows its code and page, and Cancel stops it", async () => {
  const page = {
    url: "https://dashboard.copilotkit.ai/cli-auth/device?user_code=WXYZ-2345",
    userCode: "WXYZ-2345",
  };
  invokeHandler = answers({
    set_up_local_eval: [blockedOnSignIn],
    // Waits on the browser until it is stopped.
    sign_in_to_copilotkit: [new Promise(() => {})],
    copilotkit_sign_in_page: [page],
    cancel_local_eval: [null],
  });
  const screen = view();
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign in to OpenBot" }),
  );
  await screen.findByText("WXYZ-2345");
  expect(
    screen.getByText("Finish signing in to OpenBot in your browser…"),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Open the sign-in page" })
      .getAttribute("href"),
  ).toBe(page.url);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const signIn = invokeCalls.find(
    (call) => call.command === "sign_in_to_copilotkit",
  );
  expect(
    invokeCalls.filter((call) => call.command === "cancel_local_eval"),
  ).toContainEqual({
    command: "cancel_local_eval",
    args: {
      attempt: (signIn?.args as { attempt?: string } | undefined)?.attempt,
    },
  });
  expect(
    await screen.findByRole("button", { name: "Sign in to OpenBot" }),
  ).toBeTruthy();
  expect(screen.queryByText("WXYZ-2345")).toBeNull();
});

/*
 * The sign-in setup stops for leads with OpenBot by CopilotKit, before and while it waits on the
 * browser, as the Account step does. It showed none, then CopilotKit's logotype alone.
 */
test("a sign-in setup stops for leads with OpenBot by CopilotKit, before and while it waits", async () => {
  invokeHandler = answers({
    set_up_local_eval: [blockedOnSignIn],
    sign_in_to_copilotkit: [new Promise(() => {})],
    copilotkit_sign_in_page: [
      {
        url: "https://dashboard.copilotkit.ai/cli-auth/device",
        userCode: "WXYZ-2345",
      },
    ],
    cancel_local_eval: [null],
  });
  const screen = view();
  const leads = () => {
    const card = screen.getByText("Sign in to finish setting up OpenBot.")
      .parentElement as HTMLElement;
    expect(card.querySelector(".lockup")?.textContent).toBe(
      "OpenBot™by CopilotKit",
    );
    expect(screen.queryByRole("img", { name: "CopilotKit" })).toBeNull();
  };
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign in to OpenBot" }),
  );
  await screen.findByText("WXYZ-2345");
  leads();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("button", { name: "Sign in to OpenBot" });
  leads();
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
    "To run OpenBot on this computer, accept the OpenBot by CopilotKit license agreement.",
  );
  expect(
    screen.getByRole("link", { name: "Read the license agreement" }),
  ).toBeTruthy();
  // The agreement's version and the organization are the log's, not the screen's.
  expect(document.body.textContent).not.toMatch(/developer-edition|Acme/);
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
  await screen.findByText(/OpenBot couldn't record your acceptance/);
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
      name: blocked === blockedOnTerms ? "Accept" : "Sign in to OpenBot",
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
      "Setup stopped to ask something OpenBot can't answer. Copy the logs below and ask for help.",
    ],
    [
      connection({ outcome: "blocked", conflicted: true }),
      "Settings OpenBot saved were changed since, so it didn't connect. Retry, or repair the installation.",
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
        return "started";
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
    [report(), "OpenBot started, and hasn't said yet whether it's ready."],
    [
      report({ readiness: "ready", licence: "expired" }),
      "The evaluation licence has expired.",
    ],
    [
      report({ readiness: "degraded", licence: "valid" }),
      "OpenBot is running but not working properly. Retry to start it again.",
    ],
  ] as const) {
    invokeHandler = answers({ run_local_eval: [answer] });
    const started: Startable[] = [];
    const screen = view({
      stack: "local-abc123",
      connected: true,
      onStart: async (startable) => {
        started.push(startable);
        return "started";
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
  await screen.findByText(
    "OpenBot didn't get ready in time. Retry to check again.",
  );
  expect(statusCalls()).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  // The log says why the wait ended, with how long it took and what the back end last said
  // (`back_end_wait_ended`): a five-minute wait on Windows had left no line at all.
  expect(
    invokeCalls.filter((call) => call.command === "back_end_wait_ended"),
  ).toEqual([
    {
      command: "back_end_wait_ended",
      args: { why: "OpenBot didn't get ready in time. Retry to check again." },
    },
  ]);
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

/*
 * Closing the window halts the setup and asks the CLI to stop, but the call it made settles only once the CLI has. The
 * download it followed was asked about every second until then, from a window no longer there: in App.test.tsx those
 * asks landed in later tests, one of which counts every call the window makes while it quits.
 */
test("a closed window stops asking how far the download has got, before the CLI call it followed has settled", async () => {
  invokeHandler = async (command) => {
    if (command === "set_up_local_eval") return new Promise(() => {});
    if (command === "cancel_local_eval") return null;
    if (command === "local_eval_download") return null;
    throw new Error(`unexpected ${command}`);
  };
  const screen = view();
  const asked = () =>
    invokeCalls.filter((call) => call.command === "local_eval_download").length;
  await waitFor(() => expect(asked()).toBe(1));
  screen.unmount();
  expect(
    invokeCalls.filter((call) => call.command === "cancel_local_eval"),
  ).toHaveLength(1);
  // Past the next ask (DOWNLOAD_EVERY_MS, one second): none comes.
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  expect(asked()).toBe(1);
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
      return "started";
    },
  });
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual([
    "run_local_eval:status",
    "run_local_eval:start",
    "run_local_eval:status",
  ]);
});

/**
 * 1.0.0 on Windows: a used install relaunched with its back end's disk nearly full said only "The
 * back end stopped with an error partway through." The start the window runs on a stopped stack now
 * comes back from `local_eval::checked_call` naming the disk, as `local_eval.rs` reports it.
 */
test("a relaunch whose start fails on a nearly full disk names the disk on its row, with Retry", async () => {
  const stopped = report({ readiness: "stopped", licence: "valid" });
  invokeHandler = async (command, args) => {
    const action = (args as { action?: string }).action;
    if (command === "run_local_eval" && action === "start") {
      return report({
        outcome: "failed",
        stack: null,
        reason: "resources-short",
        shortfall: {
          podman: true,
          cpu: false,
          memory: false,
          disk: true,
          diskGb: "30.5",
          nearlyFull: true,
          diskSizeGb: "1006.8",
          wsl: true,
          drive: "C:",
        },
      });
    }
    if (command === "run_local_eval") return stopped;
    throw new Error(`unexpected ${command}`);
  };
  const screen = view({ stack: "local-abc123", connected: true });
  await screen.findByRole("button", { name: "Retry" });
  const waiting = row(screen, WAIT).textContent;
  expect(waiting).toContain(
    "OpenBot is nearly out of disk space. It has 30.5 GB free of 1006.8 GB. It needs 40 GB. Free up space on drive C:, then Retry.",
  );
  expect(waiting).not.toContain("partway through");
  expect(commands()).toEqual(["run_local_eval:status", "run_local_eval:start"]);
});

/**
 * Windows, after space was freed: Retry reads the status of the back end the failed start left
 * running, which says `degraded`, and the row said only "OpenBot is running but not working properly. Retry to start it again."
 * while k3s still reported low disk. `local_eval::checked_when_unhealthy` now says why.
 */
test("a backend running but not healthy after low disk says it is recovering, and Retry asks again", async () => {
  const recovering = report({
    readiness: "degraded",
    licence: "valid",
    shortfall: {
      podman: true,
      cpu: false,
      memory: false,
      disk: false,
      recovering: true,
      wsl: true,
      drive: "C:",
    },
  });
  invokeHandler = answers({ run_local_eval: [recovering, ready] });
  const started: Startable[] = [];
  const screen = view({
    stack: "local-abc123",
    connected: true,
    onStart: async (startable) => {
      started.push(startable);
      return "started";
    },
  });
  const retry = await screen.findByRole("button", { name: "Retry" });
  const waiting = row(screen, WAIT).textContent;
  expect(waiting).toContain(
    "OpenBot is recovering from low disk space. Wait a few minutes, then Retry.",
  );
  expect(waiting).not.toContain("running but not healthy");
  await userEvent.click(retry);
  await waitFor(() => expect(started).toEqual([startableUrls]));
  expect(commands()).toEqual([
    "run_local_eval:status",
    "run_local_eval:status",
  ]);
});

test("a start that fails stops at its row, and Retry starts again without asking the CLI", async () => {
  invokeHandler = answers({ run_local_eval: [ready] });
  let starts = 0;
  const screen = view({
    stack: "local-abc123",
    connected: true,
    onStart: async () => (++starts > 1 ? "started" : "failed"),
  });
  await waitFor(() =>
    expect(row(screen, START).textContent).toContain("OpenBot did not start."),
  );
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(starts).toBe(2));
  expect(statusCalls()).toHaveLength(1);
});

/**
 * OpenBot itself failing to start is not Intelligence stopping. After a refused Start the AI screen
 * said "Intelligence stopped" over a stack the CLI reported ready and licensed.
 */
test("a start that fails says OpenBot did not start, not that Intelligence stopped", async () => {
  invokeHandler = answers({ run_local_eval: [ready] });
  const screen = view({
    stack: "local-abc123",
    connected: true,
    status: true,
    onStart: async () => "failed",
  });
  const card = await screen.findByRole("alert", { name: "OpenBot" });
  expect(card.textContent).toContain("OpenBot did not start");
  expect(card.textContent).toContain("Everything else is ready");
  expect(card.textContent).not.toContain("Setup stopped");
  expect(within(card).getByRole("button", { name: "Retry" })).toBeTruthy();
});

/**
 * A Start the window put off until OpenBot is installed again is not one that failed. Saying "OpenBot
 * did not start" over it sent a person who had changed nothing to look for a problem.
 */
test("a start that is put off says nothing, and starts on the next go-ahead", async () => {
  invokeHandler = answers({ run_local_eval: [ready, ready] });
  let starts = 0;
  let sequence!: ReturnType<typeof useLocalSequence>;
  function Window() {
    sequence = useLocalSequence({
      root: "/tmp/openbot",
      stack: "local-abc123",
      connected: true,
      onStart: async () => (++starts > 1 ? "started" : "deferred"),
      pollDelays: [0, 0, 0],
    });
    return (
      <>
        <LocalStatus sequence={sequence} />
        <LocalIntelligence sequence={sequence} />
      </>
    );
  }
  const screen = render(<Window />);
  sequence.start();
  await waitFor(() => expect(starts).toBe(1));
  await waitFor(() => expect(sequence.running).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/did not start/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  sequence.start();
  await waitFor(() => expect(starts).toBe(2));
  expect(screen.queryByRole("alert")).toBeNull();
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
      return "started";
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
      return "started";
    },
  });
  await waitFor(() =>
    expect(row(screen, WAIT).textContent).toContain("Complete"),
  );
  expect(screen.queryByRole("alert", { name: "Setup" })).toBeNull();
  expect(screen.queryByRole("listitem", { name: START })).toBeNull();
  expect(started).toEqual([]);
  // No Start OpenBot once it has run: the go-ahead comes from the screen in front.
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  invokeCalls = [];
});

test("the screen in front hears nothing while Intelligence works, and a stop interrupts it", async () => {
  invokeHandler = answers({
    set_up_local_eval: [new Promise(() => {})],
    cancel_local_eval: [null],
  });
  const working = view({ prepare: true });
  await waitFor(() =>
    expect(row(working, SETUP).textContent).toContain("Step 1 of 4"),
  );
  expect(working.queryByRole("alert", { name: "Setup" })).toBeNull();
  cleanup();
  invokeCalls = [];

  invokeHandler = answers({
    set_up_local_eval: [
      report({ outcome: "blocked", stack: null, reason: "port-unavailable" }),
    ],
    cancel_local_eval: [null],
  });
  const failed = view({ prepare: true });
  const stopped = await failed.findByRole("alert", { name: "Setup" });
  expect(stopped.textContent).toContain("Setup stopped");
  expect(stopped.textContent).toContain(
    "Another app is using a network port OpenBot needs. Quit that app, then Retry.",
  );
  expect(within(stopped).getByRole("button", { name: "Retry" })).toBeTruthy();
  // The logs to paste into an AI assistant, beside the card that says it stopped.
  expect(
    within(stopped).getByRole("button", { name: "Copy logs" }),
  ).toBeTruthy();
  expect(
    within(stopped).getByRole("button", { name: "Save to a file" }),
  ).toBeTruthy();
  cleanup();
  invokeCalls = [];

  invokeHandler = answers({
    set_up_local_eval: [blockedOnTerms],
    local_eval_terms: [requiredTerms],
    cancel_local_eval: [null],
  });
  const waiting = view({ prepare: true });
  const needs = await waiting.findByRole("alert", { name: "Setup" });
  expect(needs.textContent).toContain("Setup needs you");
  expect(
    await within(needs).findByRole("button", { name: "Accept" }),
  ).toBeTruthy();
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
      "OpenBot took too long to set up",
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

/**
 * On the Install screen the card follows the install's own rows, and it sat on them with no gap,
 * its border against theirs. Whatever comes before it, it stands apart.
 */
test("the card stands apart from the install rows above it", () => {
  const styles = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
  const rule =
    styles.match(/\.steps\s*\+\s*\.local-alert\s*\{([^}]*)\}/)?.[1] ?? "";
  const gap = Number(rule.match(/margin-top:\s*(\d+)px/)?.[1] ?? 0);
  expect(gap).toBeGreaterThanOrEqual(12);
});
