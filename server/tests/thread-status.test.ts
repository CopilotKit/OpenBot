import { describe, expect, test } from "bun:test";
import { createThreadReader } from "../src/channels/thread-status";

/**
 * Turning Intelligence's answer about a thread into the two states a caller can act on.
 *
 * Intelligence has exactly one way to say "I have never heard of this thread": a 404 from
 * `getThread`. Everything else it can throw — a 500, a timeout, a network failure — means the
 * question could not be answered at all, and that is not the same thing. Collapsing the two would
 * make an outage look identical to a thread that genuinely does not exist, and a caller that
 * believed it would discard a remembered thread it should have kept.
 */

describe("reading whether Intelligence still has a thread", () => {
  test("a thread it can produce is known", async () => {
    const reader = createThreadReader({
      getThread: async () => ({ id: "irrelevant" }),
    });
    await expect(reader("thread-1", "user-1")).resolves.toBe("known");
  });

  test("a 404 means the thread is unknown, not a failure", async () => {
    const reader = createThreadReader({
      getThread: async () => {
        throw { status: 404 };
      },
    });
    await expect(reader("thread-1", "user-1")).resolves.toBe("unknown");
  });

  test("a 500 is not swallowed as unknown — the check itself failed", async () => {
    const failure = { status: 500 };
    const reader = createThreadReader({
      getThread: async () => {
        throw failure;
      },
    });
    await expect(reader("thread-1", "user-1")).rejects.toBe(failure);
  });

  test("a plain Error, with no status field to duck-type on, is not swallowed either", async () => {
    const failure = new Error("network unreachable");
    const reader = createThreadReader({
      getThread: async () => {
        throw failure;
      },
    });
    await expect(reader("thread-1", "user-1")).rejects.toBe(failure);
  });

  test("asks Intelligence about the exact thread and user it was given", async () => {
    const calls: Array<{ threadId: string; userId: string }> = [];
    const reader = createThreadReader({
      getThread: async (params) => {
        calls.push(params);
        return { id: params.threadId };
      },
    });
    await reader("thread-77", "user-99");
    expect(calls).toEqual([{ threadId: "thread-77", userId: "user-99" }]);
  });
});
