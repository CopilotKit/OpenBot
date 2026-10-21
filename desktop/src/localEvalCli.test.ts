import { afterEach, expect, mock, test } from "bun:test";
import type { ChatGateInput, LocalReport } from "./localEvalCli";

// Wire-format cases live with the parser in src-tauri/src/local_eval.rs. These cover the window's
// side: the command it invokes, how failures arrive, and the chat gate.

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

const {
  cancelLocalEval,
  chatGate,
  intelligenceStopFailed,
  intelligenceStopProblem,
  listLocalEval,
  LocalEvalError,
  runLocalEval,
  splitStopFailure,
} = await import("./localEvalCli");

afterEach(() => {
  invokeCalls = [];
});

function report(overrides: Partial<LocalReport> = {}): LocalReport {
  return {
    outcome: "completed",
    stack: {
      id: "local-abc123",
      installedRelease: "0.15.0",
      step: "ready",
      urls: {
        api: "http://localhost:8082",
        dashboard: "http://intelligence.localhost:8080",
        gateway: "ws://localhost:4401",
      },
      hasFailedStep: false,
      updateInProgress: false,
      observed: {
        running: true,
        services: [
          { name: "cpki-app-api-test", phase: "Running", ready: true },
        ],
      },
    },
    reason: null,
    readiness: "unknown",
    licence: "unknown",
    ...overrides,
  };
}

test("runs one native command named by its attempt", async () => {
  invokeHandler = async () => report();
  const { attempt, report: pending } = runLocalEval("status", "local-abc123");
  expect((await pending).outcome).toBe("completed");
  expect(invokeCalls).toEqual([
    {
      command: "run_local_eval",
      args: { attempt, action: "status", stack: "local-abc123" },
    },
  ]);
});

test("gives each call its own attempt", () => {
  invokeHandler = async () => report();
  const first = runLocalEval("status", "local-abc123");
  const second = runLocalEval("status", "local-abc123");
  expect(first.attempt).not.toBe(second.attempt);
});

test("passes known failure categories through", async () => {
  invokeHandler = async () => {
    throw "unavailable";
  };
  const error = await runLocalEval("start", "local-abc123").report.catch(
    (e) => e,
  );
  expect(error).toBeInstanceOf(LocalEvalError);
  expect(error.category).toBe("unavailable");
});

test("never echoes an unrecognized rejection", async () => {
  invokeHandler = async () => {
    throw "synthetic-secret-marker";
  };
  const error = await runLocalEval("status", "local-abc123").report.catch(
    (e) => e,
  );
  expect(error.category).toBe("unrecognized");
  expect(String(error.message)).not.toContain("synthetic-secret-marker");
});

test("lists recorded stacks without a stack argument", async () => {
  invokeHandler = async () => ({
    outcome: "completed",
    stacks: [report().stack],
    reason: null,
  });
  const { attempt, listing } = listLocalEval();
  expect((await listing).stacks[0].id).toBe("local-abc123");
  expect(invokeCalls).toEqual([
    { command: "list_local_eval", args: { attempt } },
  ]);
  invokeHandler = async () => {
    throw "timeout";
  };
  const error = await listLocalEval().listing.catch((e) => e);
  expect(error.category).toBe("timeout");
});

test("cancels the attempt it names", async () => {
  invokeHandler = async () => undefined;
  await cancelLocalEval("attempt-1");
  expect(invokeCalls).toEqual([
    { command: "cancel_local_eval", args: { attempt: "attempt-1" } },
  ]);
});

const good: ChatGateInput = {
  intelligence: report(),
  openBot: "connected",
  provider: "validated",
};

test("a v1 report with every service ready does not open chat", () => {
  expect(chatGate(good)).toEqual({ open: false, blockers: ["intelligence"] });
});

test("unknown, failed and missing Intelligence states all block", () => {
  for (const intelligence of [
    null,
    "unavailable" as const,
    "timeout" as const,
    report({ outcome: "blocked", reason: "authentication-required" }),
    report({ outcome: "failed", stack: null }),
  ]) {
    expect(chatGate({ ...good, intelligence }).blockers).toContain(
      "intelligence",
    );
  }
});

test("future readiness and licence values open chat only when exactly good", () => {
  const future = (readiness: string, licence: string) =>
    ({ ...report(), readiness, licence }) as unknown as LocalReport;
  expect(chatGate({ ...good, intelligence: future("ready", "valid") })).toEqual(
    { open: true, blockers: [] },
  );
  for (const [readiness, licence] of [
    ["not-ready", "valid"],
    ["ready", "expired"],
    ["ready", "unknown"],
    ["unknown", "valid"],
  ]) {
    expect(
      chatGate({ ...good, intelligence: future(readiness, licence) }).open,
    ).toBe(false);
  }
});

test("OpenBot and provider states block independently", () => {
  const ready = { ...report(), readiness: "ready", licence: "valid" };
  const intelligence = ready as unknown as LocalReport;
  expect(
    chatGate({ intelligence, openBot: "unknown", provider: "invalid" }),
  ).toEqual({ open: false, blockers: ["openbot", "provider"] });
  expect(
    chatGate({ intelligence, openBot: "not-connected", provider: "validated" })
      .blockers,
  ).toEqual(["openbot"]);
  expect(
    chatGate({ intelligence, openBot: "connected", provider: "unvalidated" })
      .blockers,
  ).toEqual(["provider"]);
});

test("the Stop failure prefix is the one the native side writes", async () => {
  const native = await Bun.file(
    new URL("../src-tauri/src/main.rs", import.meta.url),
  ).text();
  expect(native).toContain(
    `const INTELLIGENCE_STOP_FAILED: &str = "${intelligenceStopFailed}";`,
  );
});

test("a Stop failure is split into OpenBot's part and Intelligence's part", () => {
  const intelligence = `${intelligenceStopFailed}the CLI timed out`;
  expect(splitStopFailure(intelligence)).toEqual({
    openBot: null,
    intelligence,
  });
  expect(
    splitStopFailure(`Compose down failed: busy\n${intelligence}`),
  ).toEqual({ openBot: "Compose down failed: busy", intelligence });
  expect(splitStopFailure("Compose down failed: busy")).toEqual({
    openBot: "Compose down failed: busy",
    intelligence: null,
  });
  // Anything that is not the native line format is OpenBot's own failure.
  expect(splitStopFailure({ said: "x" }).openBot).not.toBeNull();
  expect(intelligenceStopProblem(intelligence)).toEqual({
    said: "OpenBot stopped, but could not stop the local Intelligence stack it started.",
    detail: intelligence,
  });
});
