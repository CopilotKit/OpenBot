import { afterEach, describe, expect, test } from "bun:test";
import { COMPUTER_START_WAIT_MS } from "@openbot/shared/computer-start";
import type { StartClock } from "../src/lib/computers/call";
import { callComputer } from "../src/lib/copilot/computer-tools";

/**
 * What a Bot is told when its action did not happen.
 *
 * Every refusal reaches the model as this object, and the fields decide what it does next: `staleRefs`
 * is the one its own tool description turns into "the page changed, call this again with the new
 * refs", so labelling a takeover with it sends the Bot back round the same action against the person
 * who just took the browser. The server carries `humanHasControl` for exactly that reason; this is
 * the end of that wire, and the only place the two conditions are told apart for the model.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The click's address in the API. Anything asked anywhere else is not found, as a slip back would be. */
const CLICK = "/api/v2/organizations/default/computers/bot-1/click";

/** The API refusing the click with a problem (RFC 9457), as the server answers one. */
function serverAnswering(
  status: number,
  problem: { code: string; detail: string } & Record<string, unknown>,
) {
  globalThis.fetch = (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const headers = new Headers(init?.headers);
    if (
      String(url) !== CLICK ||
      init?.method !== "POST" ||
      !headers.get("idempotency-key")
    )
      return Response.json({ error: "Not found." }, { status: 404 });
    return new Response(
      JSON.stringify({
        type: `https://open.bot/errors/${problem.code.toLowerCase().replaceAll("_", "-")}`,
        title: problem.detail,
        status,
        requestId: "req_test",
        traceId: "trace_test",
        ...problem,
      }),
      { status, headers: { "content-type": "application/problem+json" } },
    );
  }) as unknown as typeof fetch;
}

/** The click a Bot made, as its tool sends it. */
const click = () =>
  callComputer("bot-1", "/click", {
    method: "POST",
    body: { ref: "e1", snapshotId: 1 },
  });

/**
 * Time the start wait reads, moved on by hand: a pause moves it by the pause, and the server's own
 * wait on a cold computer moves it by that wait (`serverWaits`).
 */
function fakeClock(): StartClock & { at: number } {
  const clock = {
    at: 0,
    now: () => clock.at,
    pause: async (ms: number) => {
      clock.at += ms;
    },
  };
  return clock;
}

/** What the server says about a computer still starting, as it says it. */
const STILL_STARTING =
  "The computer is still starting. This call was not performed. Try it again in a moment.";

/**
 * The API in front of a computer that comes up `readyAt` ms after the first ask. Each ask before
 * then is held for the server's own wait (45 s) and answered "still starting", as the server answers
 * one; an ask once it is up is done. Counts the asks, and the clicks that reached the computer.
 */
function coldComputer(clock: StartClock & { at: number }, readyAt: number) {
  const seen = { asks: 0, done: 0, keys: new Set<string>() };
  globalThis.fetch = (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    if (String(url) !== CLICK || init?.method !== "POST")
      return Response.json({ error: "Not found." }, { status: 404 });
    seen.asks += 1;
    seen.keys.add(new Headers(init.headers).get("idempotency-key") ?? "");
    if (clock.at < readyAt) {
      clock.at = Math.min(clock.at + 45_000, readyAt);
      if (clock.at < readyAt)
        return new Response(
          JSON.stringify({
            type: "https://open.bot/errors/computer-starting",
            title: "The computer is still starting.",
            status: 503,
            code: "COMPUTER_STARTING",
            detail: STILL_STARTING,
          }),
          {
            status: 503,
            headers: { "content-type": "application/problem+json" },
          },
        );
    }
    seen.done += 1;
    return Response.json({ ok: true, clicked: "e1" });
  }) as unknown as typeof fetch;
  return seen;
}

describe("a computer still starting", () => {
  /*
   * A cold start that outlasted the server's wait for one request. The call asks again while the
   * computer comes up, for as long as a Bot's call waits for a start; the model is told the call did
   * nothing only once that is spent, and never as an ordinary failure, which it read as a computer
   * that was broken.
   */
  test("a computer that comes up after 100 s lets the call go through", async () => {
    const clock = fakeClock();
    const seen = coldComputer(clock, 100_000);

    const outcome = await callComputer(
      "bot-1",
      "/click",
      { method: "POST", body: { ref: "e1", snapshotId: 1 } },
      undefined,
      clock,
    );

    expect(outcome).toEqual({ ok: true, clicked: "e1" });
    // Asked again while it started, each time as a new request, and done once.
    expect(seen.asks).toBe(3);
    expect(seen.keys.size).toBe(3);
    expect(seen.done).toBe(1);
    expect(clock.at).toBeGreaterThanOrEqual(100_000);
  });

  test("one that never comes up is reported as starting and not performed once the wait is spent", async () => {
    const clock = fakeClock();
    const seen = coldComputer(clock, Number.POSITIVE_INFINITY);

    const outcome = await callComputer(
      "bot-1",
      "/click",
      { method: "POST", body: { ref: "e1", snapshotId: 1 } },
      undefined,
      clock,
    );

    expect(outcome).toEqual({
      ok: false,
      starting: true,
      notPerformed: true,
      reason: STILL_STARTING,
    });
    expect(seen.done).toBe(0);
    // Not before the wait, and not long past it: the last ask is one request's wait.
    expect(clock.at).toBeGreaterThanOrEqual(COMPUTER_START_WAIT_MS);
    expect(clock.at).toBeLessThanOrEqual(COMPUTER_START_WAIT_MS + 45_000);
  });

  test("a Stop while it waits stops the call", async () => {
    const clock = fakeClock();
    coldComputer(clock, Number.POSITIVE_INFINITY);
    const stop = new AbortController();
    clock.pause = async () => {
      stop.abort();
    };

    const outcome = await callComputer(
      "bot-1",
      "/click",
      { method: "POST", body: { ref: "e1", snapshotId: 1 } },
      stop.signal,
      clock,
    );

    expect(outcome).toEqual({ ok: false, reason: "Stopped.", stopped: true });
  });

  test("an ordinary unavailable computer is not mistaken for one starting", async () => {
    serverAnswering(503, {
      code: "SERVICE_UNAVAILABLE",
      detail: "The computer did not respond.",
    });

    const outcome = await click();

    expect(outcome.starting).toBeUndefined();
    expect(outcome.reason).toBe("The computer did not respond.");
  });
});

describe("a call the network sent twice", () => {
  /*
   * A command's output or a file's text is never kept to answer a retry with, so the second arrival
   * of the same call is told it was already done. Read as a failure, the Bot apologised for a step
   * that had worked; shown as an error, a person saw one for nothing they did.
   */
  test("is told it was already done and its result is gone, not that it failed", async () => {
    serverAnswering(409, {
      code: "ANSWER_NOT_KEPT",
      detail:
        "That was already done, and what it answered is never kept. Use a new Idempotency-Key to do it again.",
    });

    const outcome = await click();

    expect(outcome).toEqual({
      ok: true,
      alreadyDone: true,
      resultUnavailable: true,
      note: "This was already done. Its result is no longer available: do it again only if you need the result.",
    });
  });

  test("another key conflict is still a failure", async () => {
    serverAnswering(409, {
      code: "IDEMPOTENCY_KEY_CONFLICT",
      detail:
        "That Idempotency-Key was used for a different request. Use a new key for a new write.",
    });

    expect((await click()).ok).toBe(false);
  });
});

describe("a computer call the server refused", () => {
  test("a person holding the wheel is reported as that, not as stale refs", async () => {
    serverAnswering(409, {
      code: "COMPUTER_PERSON_HAS_CONTROL",
      detail: "A person has taken control of this computer.",
      controlRequestId: "request-1",
      handoff: { id: "request-1", status: "taken" },
    });

    const outcome = await click();

    expect(outcome.ok).toBe(false);
    expect(outcome.humanHasControl).toBe(true);
    // The request the person holds it under, which the Bot waits on.
    expect(outcome.requestId).toBe("request-1");
    expect(outcome.handoff).toEqual({ id: "request-1", status: "taken" });
    // The instruction that must not be attached: it would send the Bot round again.
    expect(outcome.staleRefs).toBeUndefined();
    expect(outcome.reason).toBe("A person has taken control of this computer.");
  });

  test("a stale snapshot is still reported as stale refs", async () => {
    // The half that must not move. Losing this would park a Bot with genuinely stale refs waiting for
    // a person who is not coming.
    serverAnswering(409, {
      code: "COMPUTER_SNAPSHOT_STALE",
      detail: "Snapshot 3 is not the current one.",
    });

    const outcome = await click();

    expect(outcome.ok).toBe(false);
    expect(outcome.staleRefs).toBe(true);
    expect(outcome.humanHasControl).toBeUndefined();
  });

  test("a policy refusal is neither", async () => {
    serverAnswering(403, {
      code: "COMPUTER_ACTION_REFUSED",
      detail: "That is not allowed here.",
      rule: 'url.host == "example.com"',
    });

    const outcome = await click();

    expect(outcome.refused).toBe(true);
    expect(outcome.rule).toBe('url.host == "example.com"');
    expect(outcome.reason).toBe("That is not allowed here.");
    expect(outcome.staleRefs).toBeUndefined();
    expect(outcome.humanHasControl).toBeUndefined();
  });

  test("a snapshot the Bot must take again says so", async () => {
    serverAnswering(409, {
      code: "COMPUTER_SNAPSHOT_STALE",
      detail: "Take a new snapshot before you act again.",
      snapshotRequired: true,
    });

    const outcome = await click();

    expect(outcome).toMatchObject({ staleRefs: true, snapshotRequired: true });
  });

  test("a call that needs its conversation is not performed, and says so", async () => {
    serverAnswering(409, {
      code: "COMPUTER_NEEDS_CONVERSATION",
      detail: "This action needs your approval in a chat with this Bot.",
    });

    expect(await click()).toEqual({
      ok: false,
      needsConversation: true,
      notPerformed: true,
      reason: "This action needs your approval in a chat with this Bot.",
    });
  });
});
