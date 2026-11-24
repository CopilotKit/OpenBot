/**
 * The app's own problems, handed to OpenBot Desktop for its log.
 *
 * Found on a 1.2.0-rc.4 dogfood signed in to OpenBot Cloud: Desktop's Get Troubleshooting Logs had
 * nothing of the app's own, because the page shown through the desktop app's relay wrote its failed
 * requests, its errors and its broken replies nowhere the desktop app could read. Now each one is
 * handed to the desktop app's page plugin as it happens: `record_problem`, answered null.
 *
 * The requests leave through the app's real transport (`lib/client.ts`, and the generated client on
 * top of it) and reach a real HTTP server on this computer. The desktop app stands in at
 * `window.__TAURI_INTERNALS__` as Tauri injects it (`desktop-shell.fixture.ts`): `invoke(command,
 * args)`, answering with a promise. Runs fail through a real AG-UI agent. Only the 30 seconds a slow
 * request waits are not waited: the recorder's timers are handed in, and fired by the test.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type RunAgentInput,
} from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { waitFor } from "@testing-library/react";
import { Observable } from "rxjs";
import { listOrganizations } from "@/lib/api/generated/organizations/organizations";
import { ClientError, client, NoAnswerError } from "@/lib/client";
import { watchStoppedTurn } from "@/lib/copilot/stopped-turn";
import {
  type ProblemClock,
  recentProblems,
  recordProblem,
  SLOW_AFTER_MS,
  setProblemClock,
} from "@/lib/desktop/problems";
import {
  installAppErrorReporting,
  resetAppErrorReports,
} from "@/lib/error-reporting";
import { setCurrentOrganization } from "@/lib/organizations/current";
import {
  installDesktopShell,
  removeDesktopShell,
  type ShellCall,
} from "./desktop-shell.fixture";
import { nativeFetch, pageFetch } from "./page-fetch";
import { settleReactWork } from "./settle-react-work";

const RECORD = "plugin:openbot-desktop|record_problem";
const VERSION = "1.2.0-rc.4";
// The server answers in the runtime's own Response, not the page's.
const NativeResponse = globalThis.Response;

let openbot: ReturnType<typeof Bun.serve>;
let releaseSlow: () => void = () => {};
let slowArrived = false;
let calls: ShellCall[] = [];

/** The recorder's clock and timers, in the test's hands. */
let now = 0;
let timers = new Map<number, { at: number; run: () => void }>();
let timersStarted = 0;
const clock: ProblemClock = {
  now: () => now,
  setTimeout: (run, ms) => {
    timersStarted += 1;
    timers.set(timersStarted, { at: now + ms, run });
    return timersStarted;
  },
  clearTimeout: (timer) => {
    timers.delete(timer as number);
  },
};
/** Time passes: every timer due by then runs. */
function waitOut(ms: number) {
  now += ms;
  for (const [id, timer] of [...timers])
    if (timer.at <= now) {
      timers.delete(id);
      timer.run();
    }
}

/** What the page handed the desktop app, in order. */
function recorded(): unknown[] {
  return calls
    .filter((call) => call.command === RECORD)
    .map((call) => call.args?.problem);
}

const problemBody = (status: number, detail: string, requestId: string) => ({
  type: "https://open.bot/errors/internal",
  title: "Internal error",
  status,
  detail,
  requestId,
});

beforeAll(() => {
  (globalThis as Record<string, unknown>).__OPENBOT_APP_VERSION__ = VERSION;
  openbot = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/v2/people/me/organizations")
        return NativeResponse.json(
          problemBody(500, "Something broke.", "req_list500"),
          {
            status: 500,
            headers: {
              "content-type": "application/problem+json",
              "x-request-id": "req_list500",
            },
          },
        );
      if (path === "/api/things/secret")
        return NativeResponse.json(
          problemBody(500, "person@example.com broke it.", "req_secret"),
          {
            status: 500,
            headers: {
              "content-type": "application/problem+json",
              "x-request-id": "req_secret",
            },
          },
        );
      if (path === "/api/things/starting")
        return NativeResponse.json(
          problemBody(503, "The backend is starting.", "req_body503"),
          {
            status: 503,
            headers: { "content-type": "application/problem+json" },
          },
        );
      if (path === "/api/things/slow") {
        slowArrived = true;
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        return NativeResponse.json({ thing: { id: "late" } });
      }
      return NativeResponse.json({ thing: { id: "one" } });
    },
  });
  GlobalRegistrator.register({ url: `http://127.0.0.1:${openbot.port}/` });
  globalThis.fetch = pageFetch();
});
beforeEach(() => {
  now = 1_000_000;
  timers = new Map();
  timersStarted = 0;
  slowArrived = false;
  setProblemClock(clock);
  resetAppErrorReports();
  setCurrentOrganization(undefined);
  calls = installDesktopShell().calls;
});
afterEach(() => {
  removeDesktopShell();
  setProblemClock();
  globalThis.fetch = pageFetch();
});
afterAll(async () => {
  delete (globalThis as Record<string, unknown>).__OPENBOT_APP_VERSION__;
  globalThis.fetch = nativeFetch;
  await settleReactWork();
  await GlobalRegistrator.unregister();
  openbot.stop(true);
});

/** What the agent and the sentence write to the console for a failed run, kept out of the output. */
function quietConsole(): () => void {
  const spies = [
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

/** A Bot whose run fails as the backend's runtime reports it. */
class FailingBot extends AbstractAgent {
  constructor(private failure: "run-error" | "rest") {
    super({ agentId: "bot", threadId: "thread-1" });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      if (this.failure === "rest") {
        // The runtime client's own words for a run request the server refused, body and all.
        subscriber.error(
          new Error(
            `REST run request failed: ${JSON.stringify(problemBody(500, "Couldn't start the run.", "req_run500"))}`,
          ),
        );
        return;
      }
      const ids = { threadId: input.threadId, runId: input.runId };
      subscriber.next({ type: EventType.RUN_STARTED, ...ids } as BaseEvent);
      subscriber.next({
        type: EventType.RUN_ERROR,
        message: "The model refused the request.",
      } as BaseEvent);
      subscriber.complete();
    });
  }
}

test("a request the server answers 500 is handed to Desktop once: method, path without the query, status, request id", async () => {
  await expect(listOrganizations({ limit: 1 })).rejects.toBeInstanceOf(
    ClientError,
  );
  expect(recorded()).toEqual([
    {
      kind: "request",
      method: "GET",
      path: "/api/v2/people/me/organizations",
      outcome: "failed",
      status: 500,
      requestId: "req_list500",
      appVersion: VERSION,
    },
  ]);
  // Its wait for an answer ended with the answer.
  expect(timers.size).toBe(0);
});

test("with no request id header, the id is read from the problem body, and the caller still reads its sentence", async () => {
  const refused = await client("/api/things/starting", "thing").catch(
    (error: unknown) => error,
  );
  expect(refused).toBeInstanceOf(ClientError);
  expect((refused as ClientError).message).toBe("The backend is starting.");
  await waitFor(() => expect(recorded()).toHaveLength(1));
  expect(recorded()).toEqual([
    {
      kind: "request",
      method: "GET",
      path: "/api/things/starting",
      outcome: "failed",
      status: 503,
      requestId: "req_body503",
      appVersion: VERSION,
    },
  ]);
});

test("the page never sends a query string, a body, an email address or a token", async () => {
  await expect(
    client("/api/things/secret?token=tok_abc123&email=person@example.com#x", {
      method: "post",
      body: { email: "person@example.com", password: "hunter2" },
    }),
  ).rejects.toBeInstanceOf(ClientError);
  expect(recorded()).toEqual([
    {
      kind: "request",
      method: "POST",
      path: "/api/things/secret",
      outcome: "failed",
      status: 500,
      requestId: "req_secret",
      appVersion: VERSION,
    },
  ]);
  const sent = JSON.stringify(calls);
  for (const secret of [
    "tok_abc123",
    "token",
    "person@example.com",
    "hunter2",
    "?",
    "#",
  ])
    expect([secret, sent.includes(secret)]).toEqual([secret, false]);
});

test("a request that got no answer is handed over as no-answer, with how long it waited", async () => {
  // The Desktop window's WebKit rejects a request the network failed with this TypeError.
  globalThis.fetch = Object.assign(
    async () => {
      now += 1234;
      throw new TypeError("Load failed");
    },
    { preconnect: nativeFetch.preconnect },
  ) as typeof fetch;
  await expect(client("/api/things/gone?q=1", "thing")).rejects.toBeInstanceOf(
    NoAnswerError,
  );
  expect(recorded()).toEqual([
    {
      kind: "request",
      method: "GET",
      path: "/api/things/gone",
      outcome: "no-answer",
      waitedMs: 1234,
      appVersion: VERSION,
    },
  ]);
  expect(timers.size).toBe(0);
});

test("a request the page gave up on is not a problem", async () => {
  globalThis.fetch = Object.assign(
    async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    },
    { preconnect: nativeFetch.preconnect },
  ) as typeof fetch;
  await expect(client("/api/things/one", "thing")).rejects.toThrow();
  expect(recorded()).toEqual([]);
  expect(timers.size).toBe(0);
});

test("a request with no answer after 30 seconds is handed over once as slow, and nothing more when it answers", async () => {
  const pending = client<{ id: string }>("/api/things/slow?page=2", "thing");
  await waitFor(() => expect(slowArrived).toBe(true));
  waitOut(SLOW_AFTER_MS - 1);
  expect(recorded()).toEqual([]);
  waitOut(1);
  waitOut(SLOW_AFTER_MS);
  expect(recorded()).toEqual([
    {
      kind: "request",
      method: "GET",
      path: "/api/things/slow",
      outcome: "slow",
      waitedMs: SLOW_AFTER_MS,
      appVersion: VERSION,
    },
  ]);
  releaseSlow();
  expect(await pending).toEqual({ id: "late" });
  expect(timers.size).toBe(0);
  expect(recorded()).toHaveLength(1);
});

test("a request answered in time sets one timer, clears it, and hands nothing over", async () => {
  expect(await client<{ id: string }>("/api/things/one", "thing")).toEqual({
    id: "one",
  });
  expect(timersStarted).toBe(1);
  expect(timers.size).toBe(0);
  expect(recorded()).toEqual([]);
});

test("an error the page threw and a promise nobody handled are handed over once each, before the organization is known", async () => {
  installAppErrorReporting();
  const thrown = new TypeError("x is not a function");
  for (let time = 0; time < 2; time += 1)
    window.dispatchEvent(
      new ErrorEvent("error", {
        error: thrown,
        message: thrown.message,
        filename: `http://127.0.0.1:${openbot.port}/assets/index-B2x9.js?v=3`,
        lineno: 12,
        colno: 34,
      }),
    );
  const rejection = new Event("unhandledrejection") as Event & {
    reason: unknown;
  };
  rejection.reason = new Error("nobody handled this");
  window.dispatchEvent(rejection);
  expect(recorded()).toEqual([
    {
      kind: "page-error",
      message: "TypeError: x is not a function",
      source: `http://127.0.0.1:${openbot.port}/assets/index-B2x9.js:12:34`,
      appVersion: VERSION,
    },
    {
      kind: "unhandled-rejection",
      message: "Error: nobody handled this",
      appVersion: VERSION,
    },
  ]);
});

test("a long message is cut to 500 characters", () => {
  installAppErrorReporting();
  window.dispatchEvent(
    new ErrorEvent("error", { error: new Error("é".repeat(800)) }),
  );
  const [problem] = recorded() as { message: string }[];
  expect(Array.from(problem?.message ?? "")).toHaveLength(500);
});

test("a run that ends with an error is handed over as the sentence the person was shown", async () => {
  const shown: (string | null)[] = [];
  const bot = new FailingBot("run-error");
  const stop = watchStoppedTurn(bot, "bot", (stopped) =>
    shown.push(stopped?.message ?? null),
  );
  await bot.runAgent();
  stop();
  expect(shown.at(-1)).toBe("The model refused the request.");
  expect(recorded()).toEqual([
    {
      kind: "run",
      message: "The model refused the request.",
      appVersion: VERSION,
    },
  ]);
});

test("a run whose request the server refused is handed over with the request id from its problem body", async () => {
  const quiet = quietConsole();
  try {
    const shown: (string | null)[] = [];
    const bot = new FailingBot("rest");
    const stop = watchStoppedTurn(
      bot,
      "bot",
      (stopped) => shown.push(stopped?.message ?? null),
      async () => false,
    );
    await bot.runAgent().catch(() => undefined);
    await waitFor(() => expect(recorded()).toHaveLength(1));
    stop();
    const sentence =
      "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot.";
    expect(shown.at(-1)).toBe(sentence);
    expect(recorded()).toEqual([
      {
        kind: "run",
        message: sentence,
        requestId: "req_run500",
        appVersion: VERSION,
      },
    ]);
  } finally {
    quiet();
  }
});

test("at most 60 a minute are handed over; the rest are dropped", () => {
  for (let at = 0; at < 70; at += 1)
    recordProblem({ kind: "page-error", message: `Error: ${at}` });
  expect(recorded()).toHaveLength(60);
  now += 60_000;
  recordProblem({ kind: "page-error", message: "Error: later" });
  expect(recorded()).toHaveLength(61);
});

test("in a browser, the same failures are kept in the page for the troubleshooting logs, and sent nowhere", async () => {
  removeDesktopShell();
  const sent: string[] = [];
  const pageFetchOf = pageFetch();
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(input));
      return pageFetchOf(input, init);
    },
    { preconnect: nativeFetch.preconnect },
  ) as typeof fetch;
  installAppErrorReporting();
  const quiet = quietConsole();
  try {
    await expect(listOrganizations({ limit: 1 })).rejects.toBeInstanceOf(
      ClientError,
    );
    await client("/api/things/starting", "thing").catch(() => undefined);
    expect(await client<{ id: string }>("/api/things/one", "thing")).toEqual({
      id: "one",
    });
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("in a browser") }),
    );
    const bot = new FailingBot("rest");
    const stop = watchStoppedTurn(
      bot,
      "bot",
      () => {},
      async () => false,
    );
    await bot.runAgent().catch(() => undefined);
    await settleReactWork();
    stop();
    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      { preconnect: nativeFetch.preconnect },
    ) as typeof fetch;
    await client("/api/things/gone", "thing").catch(() => undefined);
  } finally {
    quiet();
  }
  expect(recentProblems().map(({ problem }) => problem)).toEqual([
    {
      kind: "request",
      method: "GET",
      path: "/api/v2/people/me/organizations",
      outcome: "failed",
      status: 500,
      requestId: "req_list500",
      appVersion: VERSION,
    },
    {
      kind: "request",
      method: "GET",
      path: "/api/things/starting",
      outcome: "failed",
      status: 503,
      requestId: "req_body503",
      appVersion: VERSION,
    },
    {
      kind: "page-error",
      message: "Error: in a browser",
      appVersion: VERSION,
    },
    {
      kind: "run",
      message:
        "OpenBot couldn't reach its backend, so your message wasn't sent. Try again, or quit and reopen OpenBot.",
      requestId: "req_run500",
      appVersion: VERSION,
    },
    {
      kind: "request",
      method: "GET",
      path: "/api/things/gone",
      outcome: "no-answer",
      waitedMs: 0,
      appVersion: VERSION,
    },
  ]);
  // Only the app's own requests left the page: no problem was sent anywhere.
  expect(sent).toEqual([
    "/api/v2/people/me/organizations?limit=1",
    "/api/things/starting",
    "/api/things/one",
  ]);
  // Nothing was waiting to be handed over to a desktop app either.
  calls = installDesktopShell().calls;
  await settleReactWork();
  expect(calls).toEqual([]);
});

test("a page keeps the last 100 from the last 30 minutes, whatever it meets", () => {
  removeDesktopShell();
  for (let minute = 0; minute < 3; minute += 1) {
    for (let at = 0; at < 50; at += 1)
      recordProblem({ kind: "page-error", message: `Error: ${minute}.${at}` });
    now += 60_000;
  }
  const kept = recentProblems();
  expect(kept).toHaveLength(100);
  expect(kept[0]?.problem.message).toBe("Error: 1.0");
  expect(kept.at(-1)?.problem.message).toBe("Error: 2.49");
  now += 30 * 60_000;
  expect(recentProblems()).toEqual([]);
});

test("an older Desktop that refuses the command: nothing throws, nothing is retried, the app's own handling is unchanged", async () => {
  removeDesktopShell();
  const refused: string[] = [];
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
      refused.push(command);
      // How Tauri refuses a command a plugin does not have: a rejection carrying a string.
      throw `Command ${command} not found`;
    },
    transformCallback: () => 0,
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const failure = await listOrganizations({ limit: 1 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ClientError);
    expect((failure as ClientError).message).toBe("Something broke.");
    expect((failure as ClientError).status).toBe(500);
    installAppErrorReporting();
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("with an older Desktop") }),
    );
    await settleReactWork();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refused).toEqual([RECORD, RECORD]);
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
