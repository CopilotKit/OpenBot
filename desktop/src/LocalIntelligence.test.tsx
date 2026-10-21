import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LocalReport } from "./localEvalCli";

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

const { LocalIntelligence } = await import("./LocalIntelligence");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  invokeCalls = [];
  cleanup();
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
    ...overrides,
  };
}

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

function view(props: { stack?: string | null; developer?: boolean } = {}) {
  return render(
    <LocalIntelligence
      root="/tmp/openbot"
      stack={props.stack ?? null}
      developer={props.developer ?? false}
      onLeave={() => {}}
    />,
  );
}

test("setup runs in this installation and a development build says how to accept the terms", async () => {
  invokeHandler = async () => blockedOnTerms;
  const screen = view({ developer: true });
  await userEvent.click(
    screen.getByRole("button", { name: "Set up local Intelligence" }),
  );
  await screen.findByText(/local accept-terms/);
  const setup = invokeCalls.find(
    (call) => call.command === "set_up_local_eval",
  );
  expect(setup?.args).toMatchObject({ root: "/tmp/openbot" });
  expect(
    screen.getByText("The Intelligence terms have not been accepted."),
  ).toBeTruthy();
});

test("other builds never send the person to a terminal", async () => {
  invokeHandler = async () => blockedOnTerms;
  const screen = view({ developer: false });
  await userEvent.click(
    screen.getByRole("button", { name: "Set up local Intelligence" }),
  );
  await screen.findByText("The Intelligence terms have not been accepted.");
  expect(screen.queryByText(/accept-terms|Terminal/)).toBeNull();
});

test("a completed setup is not readiness, and Start stays closed", async () => {
  invokeHandler = async () => report();
  const screen = view();
  await userEvent.click(
    screen.getByRole("button", { name: "Set up local Intelligence" }),
  );
  await screen.findByText(
    "Intelligence started. Its licence and readiness are not reported yet.",
  );
  expect(screen.getByText(/local-abc123/)).toBeTruthy();
  expect(
    screen.getByText(/OpenBot cannot start against local Intelligence yet/),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
});

test("a recorded stack is checked on arrival", async () => {
  invokeHandler = async () => report();
  view({ stack: "local-abc123" });
  await waitFor(() =>
    expect(
      invokeCalls.find((call) => call.command === "run_local_eval")?.args,
    ).toMatchObject({ action: "status", stack: "local-abc123" }),
  );
});

test("a long setup can be cancelled by its own attempt", async () => {
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
  await userEvent.click(
    screen.getByRole("button", { name: "Set up local Intelligence" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  const setup = invokeCalls.find(
    (call) => call.command === "set_up_local_eval",
  );
  const cancel = invokeCalls.find(
    (call) => call.command === "cancel_local_eval",
  );
  expect(setup).toBeDefined();
  expect(cancel?.args).toEqual({
    attempt: (setup?.args as { attempt: string } | undefined)?.attempt,
  });
  await screen.findByText(
    "The Intelligence command was stopped before it finished.",
  );
});

test("failures arrive as categories, and a stack that could not be recorded as a problem", async () => {
  invokeHandler = async () => {
    throw "timeout";
  };
  const screen = view();
  await userEvent.click(
    screen.getByRole("button", { name: "Set up local Intelligence" }),
  );
  await screen.findByText("Intelligence could not start.");

  invokeHandler = async () => {
    throw {
      said: "OpenBot could not save its local evaluation progress.",
      detail: "synthetic",
    };
  };
  await userEvent.click(
    screen.getByRole("button", { name: "Set up local Intelligence" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "OpenBot could not save its local evaluation progress.",
  );
});

test("an answer OpenBot does not recognise is never echoed", async () => {
  invokeHandler = async () => {
    throw "synthetic-secret-marker";
  };
  const screen = view();
  await userEvent.click(
    screen.getByRole("button", { name: "Set up local Intelligence" }),
  );
  await screen.findByRole("alert");
  expect(document.body.textContent).not.toContain("synthetic-secret-marker");
});
