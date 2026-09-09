import { describe, expect, test } from "bun:test";
import {
  continueHandoffOnce,
  HANDOFF_CONTINUATION_MESSAGE,
} from "../src/lib/copilot/handoff-continuation";

describe("one-click handoff continuation", () => {
  test("clears the URL trigger before starting one visible user turn", async () => {
    const calls: string[] = [];
    const claimed = { current: false };

    expect(
      await continueHandoffOnce({
        claimed,
        clear: () => {
          calls.push("clear");
        },
        requested: true,
        send: async (message) => {
          calls.push(`send:${message}`);
        },
      }),
    ).toBe(true);
    expect(calls).toEqual(["clear", `send:${HANDOFF_CONTINUATION_MESSAGE}`]);

    expect(
      await continueHandoffOnce({
        claimed,
        clear: () => {
          calls.push("clear-again");
        },
        requested: true,
        send: async () => {
          calls.push("send-again");
        },
      }),
    ).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("does nothing on an ordinary channel visit", async () => {
    const calls: string[] = [];

    expect(
      await continueHandoffOnce({
        claimed: { current: false },
        clear: () => {
          calls.push("clear");
        },
        requested: false,
        send: async () => {
          calls.push("send");
        },
      }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});
