import { describe, expect, test } from "bun:test";
import { MAX_TIMESTAMP_MS } from "@openbot/shared/recorder-masking";
import {
  parseContentMessage,
  parseExternalMessage,
  parseOffscreenSignedOut,
  parsePageConnectDecide,
} from "../src/protocol/messages";

const event = (value: unknown, timestamp = 1_700_000_000_000) => ({
  type: "CUSTOM" as const,
  name: "page",
  timestamp,
  value,
});

describe("parseContentMessage", () => {
  test("returns a valid content.event", () => {
    const message = { type: "content.event", event: event({ x: 1 }) };
    expect(parseContentMessage(message)).toEqual(message as never);
  });

  test("returns null for a content.step: steps are no longer recorded", () => {
    const message = {
      type: "content.step",
      action: {
        kind: "click",
        url: "https://shop.example.test/cart",
        target: { role: "button", name: "Checkout", sensitive: false },
      },
    };
    expect(parseContentMessage(message)).toBeNull();
  });

  test("returns null for an unknown type", () => {
    expect(parseContentMessage({ type: "content.unknown" })).toBeNull();
  });

  test("returns null for a content.event over 64 KiB", () => {
    const message = {
      type: "content.event",
      event: event("x".repeat(70 * 1024)),
    };
    expect(parseContentMessage(message)).toBeNull();
  });

  test("returns null for a content.event with a timestamp of 253,402,300,800,000", () => {
    const message = {
      type: "content.event",
      event: event("v", 253_402_300_800_000),
    };
    expect(parseContentMessage(message)).toBeNull();
    const last = { type: "content.event", event: event("v", MAX_TIMESTAMP_MS) };
    expect(parseContentMessage(last)).not.toBeNull();
  });

  test("returns null for a content.sensitive with a non-hex digest", () => {
    expect(
      parseContentMessage({ type: "content.sensitive", digest: "zz" }),
    ).toBeNull();
    expect(
      parseContentMessage({
        type: "content.sensitive",
        digest: "a".repeat(64),
      }),
    ).not.toBeNull();
  });

  test("returns null for something that is not JSON-serialisable", () => {
    expect(parseContentMessage(undefined)).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(parseContentMessage(cyclic)).toBeNull();
  });
});

describe("parseExternalMessage", () => {
  test("accepts a ping and a connect code", () => {
    expect(parseExternalMessage({ type: "openbot.ping" })).toEqual({
      type: "openbot.ping",
    });
    expect(
      parseExternalMessage({ type: "openbot.connect", code: "obc_x" }),
    ).toEqual({
      type: "openbot.connect",
      code: "obc_x",
    });
  });

  test("never accepts an origin in the body", () => {
    expect(
      parseExternalMessage({
        type: "openbot.connect",
        code: "obc_x",
        origin: "https://evil",
      }),
    ).toBeNull();
  });

  test("returns null for an openbot.connect over 64 KiB", () => {
    expect(
      parseExternalMessage({
        type: "openbot.connect",
        code: `obc_${"x".repeat(70 * 1024)}`,
      }),
    ).toBeNull();
  });

  test("a recorder.page-network that fits one event parses, and one over 64 KiB returns null", () => {
    const ok = {
      type: "recorder.page-network",
      event: event({ response: { body: "x".repeat(15 * 1024) } }),
    };
    expect(parseExternalMessage(ok)).not.toBeNull();
    const tooBig = {
      type: "recorder.page-network",
      event: event({ response: { body: "x".repeat(64 * 1024) } }),
    };
    expect(parseExternalMessage(tooBig)).toBeNull();
  });
});

describe("parsePageConnectDecide", () => {
  const decide = {
    type: "page.connect.decide",
    approve: true,
    label: "Chrome on macOS",
    origin: "https://openbot.example.test",
  };

  test("returns a decide naming the origin its connect tab shows", () => {
    expect(parsePageConnectDecide(decide)).toEqual(decide as never);
    const desktop = { ...decide, approve: false, origin: "http://[::1]:7470" };
    expect(parsePageConnectDecide(desktop)).toEqual(desktop as never);
  });

  test("returns null for a decide without an origin", () => {
    const { origin: _, ...withoutOrigin } = decide;
    expect(parsePageConnectDecide(withoutOrigin)).toBeNull();
  });

  test("returns null for an origin not in the form a pending connect stores", () => {
    for (const origin of [
      "",
      "https://openbot.example.test/",
      "https://openbot.example.test/path",
      "http://openbot.example.test",
      "HTTPS://OpenBot.example.test",
      "not an address",
    ])
      expect(parsePageConnectDecide({ ...decide, origin })).toBeNull();
  });
});

describe("parseOffscreenSignedOut", () => {
  const signedOut = {
    type: "offscreen.signed-out",
    reason: "organization",
    token: "obr_one",
  };

  test("returns a sign-out naming the token its pass used", () => {
    expect(parseOffscreenSignedOut(signedOut)).toEqual(signedOut as never);
  });

  test("returns null for a sign-out without a token", () => {
    const { token: _, ...withoutToken } = signedOut;
    expect(parseOffscreenSignedOut(withoutToken)).toBeNull();
  });

  test("returns null for a token that is not a string, or an unknown reason", () => {
    for (const token of [null, 7, { value: "obr_one" }])
      expect(parseOffscreenSignedOut({ ...signedOut, token })).toBeNull();
    expect(
      parseOffscreenSignedOut({ ...signedOut, reason: "expired" }),
    ).toBeNull();
  });
});
