import { describe, expect, test } from "bun:test";
import {
  isChannelSocketMessage,
  isResync,
  parseChannelSocketMessage,
} from "../src/lib/channels/use-channel-events";

const activity = {
  channelId: "a",
  lastMessage: "Said something.",
  lastMessageAt: "2024-04-01T00:00:00.000Z",
  lastMessageAgentId: null,
};

describe("isResync", () => {
  test("matches a resync event", () => {
    expect(isResync({ resync: true })).toBe(true);
  });

  test("rejects an activity event", () => {
    expect(isResync(activity)).toBe(false);
  });

  for (const value of [null, undefined, 5, "x", [], {}, { resync: false }]) {
    test(`does not throw for ${String(JSON.stringify(value))}`, () => {
      expect(isResync(value)).toBe(false);
    });
  }
});

describe("isChannelSocketMessage", () => {
  test.each([{ resync: true }, activity, { channelId: "a" }])(
    "accepts %p",
    (value) => {
      expect(isChannelSocketMessage(value)).toBe(true);
    },
  );

  for (const value of [null, undefined, 5, "x", [], [activity]]) {
    test(`rejects ${String(JSON.stringify(value))}`, () => {
      expect(isChannelSocketMessage(value)).toBe(false);
    });
  }
});

describe("parseChannelSocketMessage", () => {
  test("parses a resync event", () => {
    expect(parseChannelSocketMessage('{"resync":true}')).toEqual({
      resync: true,
    });
  });

  test("parses an activity event", () => {
    expect(parseChannelSocketMessage(JSON.stringify(activity))).toEqual(
      activity,
    );
  });

  for (const raw of ["null", "5", '"x"', "[1]", ""]) {
    test(`drops JSON payload ${raw}`, () => {
      expect(parseChannelSocketMessage(raw)).toBeNull();
    });
  }

  test("drops unparseable text", () => {
    expect(parseChannelSocketMessage("not json {")).toBeNull();
  });

  test("drops an activity event with no channel id", () => {
    expect(
      parseChannelSocketMessage(JSON.stringify({ lastMessage: "hi" })),
    ).toBeNull();
  });

  for (const data of [null, undefined, 5, {}, []]) {
    test(`drops non-string frame ${String(JSON.stringify(data))}`, () => {
      expect(parseChannelSocketMessage(data)).toBeNull();
    });
  }
});
