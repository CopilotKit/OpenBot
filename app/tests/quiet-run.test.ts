import { expect, test } from "bun:test";
import {
  askRunLiveness,
  type RunLiveness,
  watchQuietRun,
} from "@/lib/copilot/quiet-run";

/*
 * FOUND IN TESTING, with the service that carries a conversation's events frozen mid-run. The reply
 * stopped half written and the step said "Running", with Stop up, for as long as anybody watched:
 * the server had given the run up, and nothing could tell this browser. A quiet run is now asked
 * about, and ended on the runtime's answer, never on the quiet alone.
 */

const later = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The runtime's connect call, answering as it does. */
function runtime(answer: () => Promise<Response>) {
  const asked: { path: string; threadId: unknown }[] = [];
  return {
    asked,
    request: async (path: string, options: { body?: unknown }) => {
      asked.push({
        path,
        threadId: (options.body as { threadId?: unknown }).threadId,
      });
      return answer();
    },
  };
}

test("the runtime's answer says whether a conversation still has a run going", async () => {
  const live = runtime(async () =>
    Response.json({ threadId: "t1", runId: "run-7", joinToken: "j" }),
  );
  expect(
    await askRunLiveness("personal-assistant", "t1", { request: live.request }),
  ).toBe("live");
  expect(live.asked).toEqual([
    {
      path: "/api/copilotkit/agent/personal-assistant/connect",
      threadId: "t1",
    },
  ]);

  // Joined, with no run named: the conversation has none going.
  const idle = runtime(async () =>
    Response.json({ threadId: "t1", joinToken: "j" }),
  );
  expect(
    await askRunLiveness("personal-assistant", "t1", { request: idle.request }),
  ).toBe("over");
  const nothing = runtime(async () => new Response(null, { status: 204 }));
  expect(
    await askRunLiveness("personal-assistant", "t1", {
      request: nothing.request,
    }),
  ).toBe("over");

  // It failed, as it did while the service behind it answered 500.
  const failing = runtime(async () =>
    Response.json({ error: "Connect request failed" }, { status: 500 }),
  );
  expect(
    await askRunLiveness("personal-assistant", "t1", {
      request: failing.request,
    }),
  ).toBe("unreachable");
});

test("a runtime that never answers, as with the service behind it frozen, has not answered", async () => {
  const frozen = runtime(() => new Promise<Response>(() => {}));
  const started = Date.now();
  expect(
    await askRunLiveness("personal-assistant", "t1", {
      request: frozen.request,
      answerMs: 40,
    }),
  ).toBe("unreachable");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a quiet run is asked about, kept while the runtime says it is going, and ended when it says it is not", async () => {
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

test("between a turn's runs, with the turn in this browser's hands, nothing is asked until the next run speaks", async () => {
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
  // The server's run ended on a step the browser takes: quiet here is not a run gone missing.
  watch.rest();
  await later(90);
  expect(asked).toBe(0);
  expect(settled).toBeUndefined();
  // The next run speaks, then goes quiet for good.
  watch.heard();
  expect(await watch.over).toBe("over");
  expect(asked).toBe(1);
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
