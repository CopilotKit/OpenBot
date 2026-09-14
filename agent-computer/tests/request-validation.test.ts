import { describe, expect, test } from "bun:test";
import {
  parseExecTimeout,
  parseInputMessage,
  parseNavigateUrl,
  parseScrollDelta,
} from "../src/request-validation";

/**
 * The shape of a call, checked before it reaches the browser or the shell.
 *
 * A malformed navigation used to travel into `page.goto` and come back as a 502 "Navigation
 * failed", which reads as a broken computer rather than a caller error. A non-finite timeout used
 * to travel into `Math.max` as `NaN`, so `setTimeout` fired immediately and the answer said the
 * command had timed out before it did anything.
 */
describe("navigating the browser", () => {
  test("a plain https URL passes through trimmed", () => {
    expect(parseNavigateUrl("  https://example.com/a  ")).toEqual({
      ok: true,
      url: "https://example.com/a",
    });
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["a number", 42],
    ["empty", ""],
    ["whitespace-only", "   "],
    ["not a URL", "not a url"],
    ["a bare path", "/etc/passwd"],
    ["javascript:", "javascript:alert(1)"],
    ["file:", "file:///etc/passwd"],
    ["data:", "data:text/html,<h1>hi</h1>"],
    ["ftp:", "ftp://example.com/file"],
  ])("rejects %s with a 400 message", (_name, input) => {
    const parsed = parseNavigateUrl(input);
    expect(parsed.ok).toBe(false);
    expect((parsed as { error: string }).error).toBeString();
  });
});

describe("a shell timeout", () => {
  test("absent stays absent: the shell default applies", () => {
    expect(parseExecTimeout(undefined)).toEqual({
      ok: true,
      timeoutMs: undefined,
    });
  });

  test("a valid timeout passes through", () => {
    expect(parseExecTimeout(5000)).toEqual({ ok: true, timeoutMs: 5000 });
    expect(parseExecTimeout(1000)).toEqual({ ok: true, timeoutMs: 1000 });
    expect(parseExecTimeout(600_000)).toEqual({
      ok: true,
      timeoutMs: 600_000,
    });
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a negative", -1],
    ["zero", 0],
    ["below the floor", 999],
    ["above the ceiling", 600_001],
    ["a fraction", 1500.5],
    ["a string", "3000"],
    ["null", null],
    ["an object", { ms: 3000 }],
  ])("rejects %s with a 400 message", (_name, input) => {
    expect(parseExecTimeout(input)).toEqual({
      ok: false,
      error:
        "timeoutMs must be a whole number of milliseconds between 1000 and 600000.",
    });
  });
});

describe("a wheel delta", () => {
  test("absent stays absent: the endpoint default applies", () => {
    expect(parseScrollDelta(undefined)).toEqual({
      ok: true,
      deltaY: undefined,
    });
  });

  test("a finite delta passes through", () => {
    expect(parseScrollDelta(400)).toEqual({ ok: true, deltaY: 400 });
    expect(parseScrollDelta(-300)).toEqual({ ok: true, deltaY: -300 });
    expect(parseScrollDelta(0)).toEqual({ ok: true, deltaY: 0 });
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY],
    ["a string", "400"],
    ["null", null],
    ["a boolean", true],
    ["an object", { deltaY: 400 }],
  ])("rejects %s with a 400 message", (_name, input) => {
    expect(parseScrollDelta(input)).toEqual({
      ok: false,
      error: "deltaY must be a finite number of pixels.",
    });
  });
});

describe("a live-screen input message", () => {
  test("a well-formed mouse message passes through", () => {
    expect(
      parseInputMessage({ type: "mouse", event: "moved", x: 10, y: 20 }),
    ).toEqual({
      ok: true,
      message: { type: "mouse", event: "moved", x: 10, y: 20 },
    });
  });

  test.each([
    ["unknown type", { type: "bogus" }],
    ["missing type", {}],
    ["null", null],
    ["a string", "mouse"],
    ["mouse without event", { type: "mouse", x: 1, y: 2 }],
    [
      "mouse with string coords",
      { type: "mouse", event: "moved", x: "1", y: 2 },
    ],
    [
      "mouse with infinite x",
      {
        type: "mouse",
        event: "moved",
        // `1e999` is valid JSON and parses to `Infinity`, which is what the socket carries.
        x: JSON.parse("1e999"),
        y: 2,
      },
    ],
    ["wheel without delta", { type: "wheel", x: 1, y: 2, deltaX: 0 }],
    ["key without code", { type: "key", event: "down", key: "a" }],
    ["text without text", { type: "text" }],
  ])("rejects %s with a 400 message", (_name, input) => {
    const parsed = parseInputMessage(input);
    expect(parsed.ok).toBe(false);
    expect((parsed as { error: string }).error).toBeString();
  });
});
