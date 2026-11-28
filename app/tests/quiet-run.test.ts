import { afterEach, expect, test } from "bun:test";
import {
  askRunEnding,
  askRunLiveness,
  type RunLiveness,
  watchQuietRun,
} from "@/lib/copilot/quiet-run";

/*
 * FOUND IN TESTING, with the service that carries a conversation's events frozen mid-run. The reply
 * stopped half written and the step said "Running", with Stop up, for as long as anybody watched:
 * the server had given the run up, and nothing could tell this browser. A quiet run is now asked
 * about, and ended on the server's answer, never on the quiet alone.
 */

const later = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const JOIN_TOKENS =
  "/api/v2/organizations/default/conversations/channel_1/join-tokens";

/** What a join token for the conversation answers, with a run going or without. */
const joined = (runId: string | null) =>
  Response.json(
    {
      joinToken: "jt_1",
      expiresAt: "2026-11-14T12:00:30.000Z",
      threadId: "t1",
      runId,
      realtime: { clientUrl: "ws://127.0.0.1:4401/client", topic: "thread:t1" },
    },
    { status: 201 },
  );

/** A refusal as the API answers one: problem details, with its stable code. */
const problem = (status: number, code: string) =>
  new Response(
    JSON.stringify({
      status,
      code,
      title: code,
      detail: "No.",
      type: "about:blank",
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The server, at the API's join-token operation, answering as it does. */
function server(answer: () => Promise<Response>) {
  const asked: { path: string; method: string; key: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({
      path: String(input),
      method: init?.method ?? "GET",
      key: new Headers(init?.headers).get("idempotency-key"),
    });
    return answer();
  }) as typeof fetch;
  return asked;
}

test("the server's answer says whether a conversation still has a run going", async () => {
  const asked = server(async () => joined("run-7"));
  expect(await askRunLiveness("channel_1")).toBe("live");
  // Asked through the API's join-token operation, as a write of its own each time.
  expect(asked).toHaveLength(1);
  expect(asked[0]?.path).toBe(JOIN_TOKENS);
  expect(asked[0]?.method).toBe("POST");
  expect(asked[0]?.key).toBeTruthy();
  expect(await askRunLiveness("channel_1")).toBe("live");
  expect(asked[1]?.key).not.toBe(asked[0]?.key);

  // Joined, with no run named: the conversation has none going.
  server(async () => joined(null));
  expect(await askRunLiveness("channel_1")).toBe("over");
  // No Bot has run in it yet, so none is going.
  server(async () => problem(409, "CONVERSATION_NOT_STARTED"));
  expect(await askRunLiveness("channel_1")).toBe("over");

  // It could not say, as while the service behind it does not answer.
  server(async () => problem(502, "LIVE_CHANNELS_UNAVAILABLE"));
  expect(await askRunLiveness("channel_1")).toBe("unreachable");
  // Any other refusal is not an answer about the run either.
  server(async () => problem(404, "CONVERSATION_NOT_FOUND"));
  expect(await askRunLiveness("channel_1")).toBe("unreachable");
  server(async () => {
    throw new TypeError("Failed to fetch");
  });
  expect(await askRunLiveness("channel_1")).toBe("unreachable");
});

test("a server that never answers, as with the service behind it frozen, has not answered", async () => {
  server(() => new Promise<Response>(() => {}));
  const started = Date.now();
  expect(await askRunLiveness("channel_1", { answerMs: 40 })).toBe(
    "unreachable",
  );
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a quiet run is asked about, kept while the server says it is going, and ended when it says it is not", async () => {
  const answers: RunLiveness[] = ["live", "live", "over"];
  let asked = 0;
  const watch = watchQuietRun({
    quietMs: 20,
    ask: async () => {
      asked += 1;
      return answers.shift() ?? "over";
    },
  });
  expect(await watch.over).toBe("over");
  // Alive but quiet twice over, and still waited for.
  expect(asked).toBe(3);
});

/*
 * FOUND ON OPENBOT CLOUD. A long answer went quiet on a slow app, the one ask about it never reached
 * a server, and the turn ended "lost touch" with the run still going.
 */
test("an ask the server could not answer is asked again, and the run that is still going is kept", async () => {
  const answers: RunLiveness[] = ["unreachable", "unreachable", "live", "over"];
  let asked = 0;
  const watch = watchQuietRun({
    quietMs: 20,
    retryMs: 5,
    ask: async () => {
      asked += 1;
      return answers.shift() ?? "over";
    },
  });
  expect(await watch.over).toBe("over");
  expect(asked).toBe(4);
});

test("a server that answers none of the asks in a row ends the turn as unreachable", async () => {
  let asked = 0;
  const watch = watchQuietRun({
    quietMs: 20,
    retryMs: 5,
    ask: async () => {
      asked += 1;
      return "unreachable";
    },
  });
  expect(await watch.over).toBe("unreachable");
  expect(asked).toBe(3);
});

test("a run that keeps speaking is never asked about, and nothing is asked once it stops being watched", async () => {
  let asked = 0;
  const watch = watchQuietRun({
    quietMs: 30,
    ask: async () => {
      asked += 1;
      return "over";
    },
  });
  for (let index = 0; index < 8; index += 1) {
    await later(10);
    watch.heard();
  }
  expect(asked).toBe(0);
  watch.stop();
  await later(80);
  expect(asked).toBe(0);
});

test("between a turn's runs, with the turn in this browser's hands, no run going is not the end", async () => {
  let asked = 0;
  let settled: string | undefined;
  const watch = watchQuietRun({
    quietMs: 20,
    ask: async () => {
      asked += 1;
      return "over";
    },
  });
  void watch.over.then((outcome) => {
    settled = outcome;
  });
  // The server's run ended on a step the browser takes: quiet here is not a run gone missing, and
  // a server that says it has no run going is still there to take the step.
  watch.rest();
  await later(90);
  expect(asked).toBeGreaterThan(0);
  expect(settled).toBeUndefined();
  // The next run speaks, then goes quiet for good.
  watch.heard();
  expect(await watch.over).toBe("over");
});

/*
 * FOUND ON A PERSON'S 1.1.2 DESKTOP. The server stopped in the middle of a long turn of file saves,
 * while the browser was taking a save itself, and Docker started it again. Resting, the watch asked
 * nothing, so the turn sat on "Thinking" for good with the person's next message queued behind it.
 */
test("a server that stops answering while the browser takes a step ends the turn", async () => {
  const answers: RunLiveness[] = ["over", "unreachable"];
  const watch = watchQuietRun({
    quietMs: 20,
    retryMs: 5,
    ask: async () => answers.shift() ?? "unreachable",
  });
  watch.rest();
  expect(await watch.over).toBe("unreachable");
});

test("an answer about a run that spoke while the runtime was being asked is not taken", async () => {
  let release: (answer: RunLiveness) => void = () => {};
  let asked = 0;
  let settled: string | undefined;
  const watch = watchQuietRun({
    quietMs: 20,
    ask: () => {
      asked += 1;
      return asked === 1
        ? new Promise<RunLiveness>((resolve) => {
            release = resolve;
          })
        : Promise.resolve("live" as const);
    },
  });
  void watch.over.then((outcome) => {
    settled = outcome;
  });
  await later(40);
  expect(asked).toBe(1);
  // It speaks while the first question is still out, and the answer then says it had no run.
  watch.heard();
  release("over");
  await later(10);
  expect(settled).toBeUndefined();
  watch.stop();
});

/*
 * FOUND ON OPENBOT CLOUD, in a phone's web view. The phone slept through the end of a long answer,
 * and woke with the watch's time long up: the server was asked at once, before the socket could
 * connect again and bring the rest, and the turn ended as if the Bot had stopped.
 */
test("a page shown again starts the quiet over, and an answer about the time it slept is not taken", async () => {
  let wake: () => void = () => {};
  let release: (answer: RunLiveness) => void = () => {};
  let asked = 0;
  let settled: string | undefined;
  const watch = watchQuietRun({
    quietMs: 40,
    onWake: (woke) => {
      wake = woke;
      return () => {
        wake = () => {};
      };
    },
    ask: () => {
      asked += 1;
      return new Promise<RunLiveness>((resolve) => {
        release = resolve;
      });
    },
  });
  void watch.over.then((outcome) => {
    settled = outcome;
  });
  // Shown again before the quiet ran out: it starts over, so nothing is asked yet.
  await later(30);
  wake();
  await later(25);
  expect(asked).toBe(0);
  // Asked once the quiet runs out, and shown again while the answer is on its way.
  await later(40);
  expect(asked).toBe(1);
  wake();
  release("over");
  await later(10);
  expect(settled).toBeUndefined();
  // The next quiet asks again, and that answer is taken.
  await later(60);
  expect(asked).toBe(2);
  release("over");
  expect(await watch.over).toBe("over");
});

test("how a run ended is read from the server, and only a run that finished counts as finished", async () => {
  const RUN =
    "/api/v2/organizations/default/conversations/channel_1/runs/run-7";
  const ended = (outcome: string | null) =>
    Response.json({
      run: {
        id: "run-7",
        outcome,
        endedAt: outcome ? "2026-11-25T18:16:00.000Z" : null,
      },
    });
  const asked = server(async () => ended("succeeded"));
  expect(await askRunEnding("channel_1", "run-7")).toBe("finished");
  // Asked through the API's getConversationRun, a read.
  expect(asked[0]?.path).toBe(RUN);
  expect(asked[0]?.method).toBe("GET");

  for (const outcome of ["failed", "cancelled", "interrupted"]) {
    server(async () => ended(outcome));
    expect(await askRunEnding("channel_1", "run-7")).toBe("stopped");
  }
  // A word this app doesn't know yet says nothing it can act on.
  server(async () => ended("paused"));
  expect(await askRunEnding("channel_1", "run-7")).toBe("unknown");

  // Kept no ending yet: asked once more, and the second answer stands.
  const answers = [ended(null), ended("succeeded")];
  const twice = server(async () => answers.shift() ?? ended(null));
  expect(await askRunEnding("channel_1", "run-7", { retryMs: 5 })).toBe(
    "finished",
  );
  expect(twice).toHaveLength(2);
  // Not found twice, as from a server that keeps no endings: it can't say.
  server(async () => problem(404, "CONVERSATION_RUN_NOT_FOUND"));
  expect(await askRunEnding("channel_1", "run-7", { retryMs: 5 })).toBe(
    "unknown",
  );
  server(async () => problem(502, "SERVER_ERROR"));
  expect(await askRunEnding("channel_1", "run-7")).toBe("unknown");
  server(() => new Promise<Response>(() => {}));
  expect(await askRunEnding("channel_1", "run-7", { answerMs: 40 })).toBe(
    "unknown",
  );
});
