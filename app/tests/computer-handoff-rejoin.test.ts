import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  awaitHandoff,
  pendingHandoff,
  rememberHandoff,
  runHelpRequest,
  runNavigation,
} from "../src/lib/computers/handoff";
import { callComputer } from "../src/lib/computers/call";

const realFetch = globalThis.fetch;
const paths: string[] = [];
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  globalThis.fetch = realFetch;
  sessionStorage.clear();
  paths.length = 0;
});
afterAll(() => GlobalRegistrator.unregister());
function serve(answer: (path: string) => Response) {
  globalThis.fetch = Object.assign(
    async (url: Parameters<typeof fetch>[0]) => {
      const path = String(url);
      paths.push(path);
      return answer(path);
    },
    { preconnect: () => undefined },
  );
}
function state(id: string, status: string) {
  return Response.json({
    holder: status === "taken" ? "human" : "bot",
    requested: status === "waiting",
    request: { id, status },
  });
}

test("replayed navigation after reload rejoins stored identity without navigating again", async () => {
  rememberHandoff("bot-1", "request-1", "tool-1");
  serve((path) =>
    path.endsWith("/snapshot")
      ? Response.json({ snapshotId: 8 })
      : state("request-1", "completed"),
  );
  expect(
    await runNavigation("bot-1", "https://example.com", "tool-1"),
  ).toMatchObject({ ok: true, snapshotId: 8 });
  expect(paths.some((path) => path.endsWith("/navigate"))).toBe(false);
  expect(pendingHandoff("bot-1")).toEqual({
    requestId: "request-1",
    toolCallId: "tool-1",
  });
});

test("replayed help call does not create another request", async () => {
  rememberHandoff("bot-1", "request-1", "tool-1");
  serve(() => state("request-1", "expired"));
  expect(await runHelpRequest("bot-1", "Sign in", "tool-1")).toMatchObject({
    ok: false,
    handoffStatus: "expired",
  });
  expect(paths).toEqual(["/api/computers/bot-1/control?requestId=request-1"]);
});

test("a challenge still present in the fresh snapshot joins its new request before resuming", async () => {
  rememberHandoff("bot-1", "request-1", "tool-1");
  let snapshots = 0;
  serve((path) => {
    if (path.endsWith("/snapshot"))
      return Response.json(
        ++snapshots === 1
          ? {
              snapshotId: 8,
              challenge: {
                kind: "visible-challenge",
                reason: "Please finish verification",
                requestId: "request-2",
              },
            }
          : { snapshotId: 9 },
      );
    return state(
      path.endsWith("request-2") ? "request-2" : "request-1",
      "completed",
    );
  });
  expect(await awaitHandoff("bot-1", "request-1")).toMatchObject({
    ok: true,
    requestId: "request-2",
    snapshotId: 9,
  });
  expect(pendingHandoff("bot-1")?.requestId).toBe("request-2");
  expect(paths).toContain("/api/computers/bot-1/control?requestId=request-2");
});

test("Stop cancels a still-waiting request by ID", async () => {
  const controller = new AbortController();
  controller.abort();
  serve((path) =>
    state("request-1", path.endsWith("/cancel") ? "cancelled" : "waiting"),
  );
  expect(
    await awaitHandoff("bot-1", "request-1", controller.signal),
  ).toMatchObject({ stopped: true, ok: false });
  expect(paths).toEqual([
    "/api/computers/bot-1/control?requestId=request-1",
    "/api/computers/bot-1/control/cancel",
  ]);
});

test("an abort wakes a long polling delay without waiting for that delay", async () => {
  const controller = new AbortController();
  serve(() => state("request-1", "taken"));
  const result = awaitHandoff("bot-1", "request-1", controller.signal, 30_000);
  setTimeout(() => controller.abort(), 10);
  expect(await result).toMatchObject({ stopped: true, ok: false });
  expect(paths.some((path) => path.endsWith("/cancel"))).toBe(false);
}, 250);

test("snapshot-required and request identity survive tool refusal shaping", async () => {
  serve(() =>
    Response.json(
      { error: "Take a fresh snapshot", snapshotRequired: true },
      { status: 409 },
    ),
  );
  expect(await callComputer("bot-1", "/click")).toMatchObject({
    ok: false,
    snapshotRequired: true,
  });
  serve(() =>
    Response.json(
      {
        error: "Help is pending",
        humanHasControl: true,
        requestId: "request-1",
        handoff: { id: "request-1", status: "waiting" },
      },
      { status: 409 },
    ),
  );
  expect(await callComputer("bot-1", "/click")).toMatchObject({
    ok: false,
    requestId: "request-1",
    handoff: { id: "request-1" },
  });
});
