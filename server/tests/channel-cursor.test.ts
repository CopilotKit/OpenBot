import { describe, expect, test } from "bun:test";
import {
  decodeChannelCursor,
  encodeChannelCursor,
} from "../src/channels/routes";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("decodeChannelCursor", () => {
  test("round-trips a cursor to the microsecond", () => {
    const cursor = {
      pinned: true,
      recency: "2026-09-01T00:00:00.123456Z",
      id: "channel-1",
    };
    expect(decodeChannelCursor(encodeChannelCursor(cursor))).toEqual(cursor);
  });

  test("still reads a cursor minted to the millisecond", () => {
    const cursor = {
      pinned: false,
      recency: "2026-09-01T00:00:00.123Z",
      id: "channel-1",
    };
    expect(decodeChannelCursor(encode(cursor))).toEqual(cursor);
  });

  test.each([
    "not-a-date",
    "",
    "2026-13-45T00:00:00Z",
    "1",
    "2026-09-01 00:00:00",
    "2026-09-01T00:00:00+02:00",
  ])("reads a recency of %p as the first page", (recency) => {
    expect(
      decodeChannelCursor(encode({ pinned: false, recency, id: "channel-1" })),
    ).toBeUndefined();
  });

  test("reads garbage and a missing cursor as the first page", () => {
    expect(decodeChannelCursor("%%%")).toBeUndefined();
    expect(decodeChannelCursor(undefined)).toBeUndefined();
  });
});
