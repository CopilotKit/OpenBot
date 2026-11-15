import { afterEach, describe, expect, test } from "bun:test";
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

describe("a computer still starting", () => {
  /*
   * A cold start that outlasted the server's wait. The model has to be told the call did nothing and
   * is worth repeating; read as an ordinary failure it apologised and gave up on a computer that was
   * seconds from ready.
   */
  test("is reported as starting and not performed, in the server's own words", async () => {
    serverAnswering(503, {
      code: "COMPUTER_STARTING",
      detail:
        "The computer is still starting. This call was not performed. Try it again in a moment.",
    });

    const outcome = await click();

    expect(outcome).toEqual({
      ok: false,
      starting: true,
      notPerformed: true,
      reason:
        "The computer is still starting. This call was not performed. Try it again in a moment.",
    });
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
