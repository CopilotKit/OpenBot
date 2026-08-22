import { describe, expect, test } from "bun:test";
import { historyOrEmpty, isMissingThread } from "../src/copilot";

/**
 * Reading history on a thread the platform has never seen.
 *
 * A thread id is minted before the thread exists, so this is the opening move of every new
 * conversation and it was answering 500. The decision is the whole of the change, and it is tested
 * here against the real functions rather than a copy of them: the previous attempt (#71) tested a
 * re-implementation of its own middleware, which passes with the shipped code deleted.
 */

/**
 * A `PlatformRequestError` as the platform client constructs one.
 *
 * Built by hand because the class is not re-exported from `@copilotkit/runtime/v2` and the package's
 * `exports` map reaches nothing that holds it — which is also why the code under test matches on the
 * shape. The constructor sets the message, then `status`, then `name`, so this is the same object.
 */
function platformError(status: number): Error {
  const error = new Error(`Intelligence platform error ${status}`);
  error.name = "PlatformRequestError";
  (error as Error & { status: number }).status = status;
  return error;
}

describe("recognising a thread the platform does not have", () => {
  test("a 404 from the platform is a missing thread", () => {
    expect(isMissingThread(platformError(404))).toBe(true);
  });

  test("a 500 from the platform is not", () => {
    // The one that matters. An outage answered with an empty history tells the browser the
    // conversation is gone and invites somebody to start it over.
    expect(isMissingThread(platformError(500))).toBe(false);
  });

  test("a 403 from the platform is not", () => {
    // A bad key is not an absent thread, and reading it as one would hide a misconfiguration behind
    // a conversation that looks new.
    expect(isMissingThread(platformError(403))).toBe(false);
  });

  test("an unrelated error carrying a 404 is not", () => {
    /*
     * Both halves are checked, so something else with a `status` of 404 on it — a fetch wrapper, a
     * vendor SDK — does not get a thread's history replaced with nothing.
     */
    const other = new Error("some other failure");
    (other as Error & { status: number }).status = 404;
    expect(isMissingThread(other)).toBe(false);
  });

  test("a plain object shaped like one is not", () => {
    expect(isMissingThread({ name: "PlatformRequestError", status: 404 })).toBe(
      false,
    );
  });

  test("nothing thrown at all is not", () => {
    expect(isMissingThread(undefined)).toBe(false);
    expect(isMissingThread(null)).toBe(false);
  });
});

describe("reading a history that may not exist yet", () => {
  const empty = { messages: [] as string[] };

  test("a thread with history returns it", async () => {
    const history = { messages: ["hello"] };
    expect(await historyOrEmpty(async () => history, empty)).toBe(history);
  });

  test("a thread the platform does not have reads as empty", async () => {
    expect(
      await historyOrEmpty(async () => {
        throw platformError(404);
      }, empty),
    ).toEqual({ messages: [] });
  });

  test("a platform outage still throws", async () => {
    // Not swallowed, not turned into an empty conversation. This is the assertion that would fail if
    // the branch were widened to any failure.
    await expect(
      historyOrEmpty(async () => {
        throw platformError(500);
      }, empty),
    ).rejects.toThrow("Intelligence platform error 500");
  });

  test("an error that is not the platform's still throws", async () => {
    await expect(
      historyOrEmpty(async () => {
        throw new Error("the network went away");
      }, empty),
    ).rejects.toThrow("the network went away");
  });
});
