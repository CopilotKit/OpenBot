import { afterEach, expect, spyOn, test } from "bun:test";
import type {
  ComputerControlState,
  HandoffStatus,
} from "../../shared/computer-control";
import {
  awaitHandoff,
  runHelpRequest,
  runNavigation,
} from "../src/lib/computers/handoff";
import { releaseControl, takeControl } from "../src/lib/computers/control";

const fetchSpy = spyOn(globalThis, "fetch");
const requests: { path: string; body: unknown }[] = [];
function state(status: HandoffStatus, id = "request-1"): ComputerControlState {
  return {
    holder: status === "taken" ? "human" : "bot",
    since: "2026-09-26T00:00:00Z",
    requested: status === "waiting",
    transitioning: false,
    resumeSnapshotRequired: status === "completed",
    request: {
      id,
      status,
      reason: "Please sign in",
      source: "model",
      createdAt: "2026-09-26T00:00:00Z",
      updatedAt: "2026-09-26T00:00:00Z",
    },
  };
}
function serve(answer: (path: string, body: unknown) => unknown) {
  fetchSpy.mockImplementation(
    Object.assign(
      async (
        url: Parameters<typeof fetch>[0],
        options?: Parameters<typeof fetch>[1],
      ) => {
        const path = String(url);
        const body: unknown = options?.body
          ? JSON.parse(String(options.body))
          : undefined;
        requests.push({ path, body });
        return Response.json(answer(path, body));
      },
      { preconnect: () => undefined },
    ),
  );
}
afterEach(() => {
  requests.length = 0;
  fetchSpy.mockReset();
});

test("exact request completion takes a fresh snapshot before returning", async () => {
  serve((path) =>
    path.endsWith("/snapshot")
      ? { snapshotId: 42, elements: [{ ref: "fresh" }] }
      : state("completed"),
  );
  const result = await awaitHandoff("bot-1", "request-1");
  expect(result).toMatchObject({
    ok: true,
    handoffStatus: "completed",
    snapshotId: 42,
  });
  expect(requests.map((r) => r.path)).toEqual([
    "/api/computers/bot-1/control?requestId=request-1",
    "/api/computers/bot-1/snapshot",
  ]);
});

test.each(["expired", "cancelled", "interrupted"] as const)(
  "%s never means a person finished",
  async (status) => {
    serve(() => state(status));
    expect(await awaitHandoff("bot-1", "request-1")).toMatchObject({
      ok: false,
      handoffStatus: status,
    });
    expect(requests).toHaveLength(1);
  },
);

test("taken remains pending even past a ten-minute wall-clock jump", async () => {
  const clock = spyOn(Date, "now");
  let polls = 0;
  serve((path) => {
    if (path.endsWith("/snapshot")) return { snapshotId: 2 };
    polls++;
    clock.mockReturnValue(polls === 1 ? 0 : 25 * 60_000);
    return state(polls < 3 ? "taken" : "completed");
  });
  try {
    expect(
      await awaitHandoff("bot-1", "request-1", undefined, 0),
    ).toMatchObject({ ok: true });
    expect(polls).toBe(3);
  } finally {
    clock.mockRestore();
  }
});

test("a mismatched response cannot complete the intended request", async () => {
  serve(() => state("completed", "different-request"));
  expect(await awaitHandoff("bot-1", "request-1")).toMatchObject({ ok: false });
  expect(requests.some((r) => r.path.endsWith("/snapshot"))).toBe(false);
});

test("Stop while taken detaches without cancelling or releasing control", async () => {
  const controller = new AbortController();
  serve(() => {
    controller.abort();
    return state("taken");
  });
  expect(
    await awaitHandoff("bot-1", "request-1", controller.signal, 0),
  ).toMatchObject({ ok: false, stopped: true });
  expect(requests.some((r) => /cancel|release/.test(r.path))).toBe(false);
});

test("navigation challenge joins existing request and preserves challenge metadata", async () => {
  const challenge = {
    kind: "cloudflare",
    reason: "Verify you are human",
    requestId: "request-1",
  };
  serve((path) =>
    path.endsWith("/navigate")
      ? { url: "https://example.com", challenge }
      : path.endsWith("/snapshot")
        ? { snapshotId: 12, url: "https://example.com/welcome" }
        : state("completed"),
  );
  const result = await runNavigation("bot-1", "https://example.com", "tool-1");
  expect(result).toMatchObject({ ok: true, challenge, snapshotId: 12 });
  expect(requests[0]?.body).toEqual({
    url: "https://example.com",
    toolCallId: "tool-1",
  });
  expect(requests.some((r) => r.path.endsWith("/control/request"))).toBe(false);
});

test("help uses the original tool call as its idempotency key", async () => {
  serve((path) =>
    path.endsWith("/snapshot") ? { snapshotId: 12 } : state("completed"),
  );
  expect(
    await runHelpRequest("bot-1", "Please sign in", "tool-1"),
  ).toMatchObject({ ok: true });
  expect(requests[0]?.body).toEqual({
    reason: "Please sign in",
    toolCallId: "tool-1",
  });
});

test("manual takeover first creates a request and take/release name that ID", async () => {
  serve(() => state("taken"));
  await takeControl("bot-1");
  await releaseControl("bot-1", "request-1");
  expect(requests.map((r) => [r.path, r.body])).toEqual([
    [
      "/api/computers/bot-1/control/request",
      { reason: "I want to take control of the browser." },
    ],
    ["/api/computers/bot-1/control/take", { requestId: "request-1" }],
    ["/api/computers/bot-1/control/release", { requestId: "request-1" }],
  ]);
});
