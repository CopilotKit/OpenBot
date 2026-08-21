import { describe, expect, test } from "bun:test";
import { botThreadKey, threadToUse } from "../src/lib/copilot/bot-thread";

/**
 * The two decisions `useBotThread` makes that do not need a browser to test: which localStorage
 * key belongs to which Bot, and whether a remembered thread id is still safe to use once
 * Intelligence has said whether it knows about it.
 */

describe("botThreadKey", () => {
  test("is the same key for the same agent every time", () => {
    expect(botThreadKey("bot-a")).toBe(botThreadKey("bot-a"));
  });

  test("is namespaced rather than the bare agent id", () => {
    // A raw agent id used directly as a localStorage key would collide with anything else in the
    // app that happens to key storage by agent id.
    const key = botThreadKey("bot-a");
    expect(key).not.toBe("bot-a");
    expect(key).toContain("bot-a");
  });

  test("two agents never collide", () => {
    expect(botThreadKey("bot-a")).not.toBe(botThreadKey("bot-b"));
  });
});

describe("threadToUse", () => {
  test("a remembered thread Intelligence confirms it has is kept", () => {
    expect(threadToUse({ remembered: "t1", known: true })).toBe("remembered");
  });

  test("a remembered thread Intelligence says it does not have is replaced", () => {
    expect(threadToUse({ remembered: "t1", known: false })).toBe("fresh");
  });

  test("a remembered thread is kept when the check itself could not be completed", () => {
    // known: undefined means the lookup failed, not that the thread is gone. Discarding a
    // perfectly good thread id because Intelligence was briefly unreachable would be worse than
    // the failure it was reacting to.
    expect(threadToUse({ remembered: "t1", known: undefined })).toBe(
      "remembered",
    );
  });

  test("with nothing remembered, every outcome of the check starts fresh", () => {
    expect(threadToUse({ remembered: null, known: true })).toBe("fresh");
    expect(threadToUse({ remembered: null, known: false })).toBe("fresh");
    expect(threadToUse({ remembered: null, known: undefined })).toBe("fresh");
  });
});
