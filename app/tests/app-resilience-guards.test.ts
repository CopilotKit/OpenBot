import { afterEach, describe, expect, test } from "bun:test";
import { socketUrl } from "../src/lib/socket-url";
import { relativeTime } from "../src/lib/relative-time";

const at = (protocol: string, hostname: string, host: string) => ({
  protocol,
  hostname,
  host,
});

/**
 * `__OPENBOT_WS_PORT__` was interpolated into the WebSocket authority unchecked, so `"   "`,
 * `"abc"` or `"99999"` produced `ws://host:abc/path` and `new WebSocket()` threw synchronously
 * inside the effects that open it. Only whole digits in range override same-origin now.
 */
describe("socketUrl port validation", () => {
  test.each([
    ["whitespace", "   "],
    ["letters", "abc"],
    ["too large", "99999"],
    ["zero", "0"],
  ])("falls back to same-origin on %s", (_n, port) => {
    expect(
      socketUrl("/api/channels/events", at("http:", "h", "h:3010"), port),
    ).toBe("ws://h:3010/api/channels/events");
  });

  test("keeps a valid override", () => {
    expect(
      socketUrl("/api/channels/events", at("http:", "h", "h:3010"), "3001"),
    ).toBe("ws://h:3001/api/channels/events");
  });
});

/**
 * An invalid date used to flow into `Math.abs(NaN)` comparisons and `format(-NaN)`, answering
 * "NaN weeks ago" or throwing depending on ICU. The input is returned unchanged instead.
 */
describe("relativeTime", () => {
  test("returns the input for an invalid date", () => {
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });

  test("still formats a valid date", () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(relativeTime(iso)).toMatch(/second/);
  });
});

describe("control/screen/client guards", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("readControl answers null on a malformed body", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([1, 2]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const { readControl } = await import("../src/lib/computers/control");
    await expect(readControl("bot-1")).resolves.toBeNull();
  });

  test("client throws the fallback on a malformed envelope", async () => {
    globalThis.fetch = (async () =>
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const { client } = await import("../src/lib/client");
    await expect(
      client("http://x.test/thing", "thing", { fallback: "Nope." }),
    ).rejects.toThrow("Nope.");
  });

  test("readScreenshot reports unavailable on a mistyped frame", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ base64: 42, width: "x", height: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const { readScreenshot } = await import("../src/lib/computers/screen");
    const result = await readScreenshot("bot-1");
    expect(result.frame).toBeUndefined();
    expect(typeof result.error).toBe("string");
  });

  test("readPageFrame answers null on an array frame", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ frame: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const { readPageFrame } = await import("../src/lib/computers/screen");
    await expect(readPageFrame("bot-1", "turn-1")).resolves.toBeNull();
  });
});
