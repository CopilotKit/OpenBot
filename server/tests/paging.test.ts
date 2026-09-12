import { describe, expect, test } from "bun:test";
import { PAGE_LIMIT_ERROR, parsePageLimit } from "../src/paging";

/**
 * `?limit=` used to be read with `Number.parseInt`, which coerces: `"12abc"` arrived as 12,
 * `"3.9"` as 3, `"0x10"` as 0, and every one of them answered 200 with a silently coerced page.
 * The parser requires a run of digits and answers 400 otherwise; well-formed values are clamped
 * into range the same way the stores already clamp them.
 */
describe("parsePageLimit", () => {
  test("leaves an absent or blank limit to the store default", () => {
    expect(parsePageLimit(null, 200)).toEqual({ ok: true });
    expect(parsePageLimit("", 200)).toEqual({ ok: true });
    expect(parsePageLimit("   ", 200)).toEqual({ ok: true });
  });

  test.each([
    ["10", 10],
    ["1", 1],
    ["200", 200],
    ["  25  ", 25],
  ])("passes a well-formed limit through: %p", (raw, limit) => {
    expect(parsePageLimit(raw, 200)).toEqual({ ok: true, limit });
  });

  test.each([
    ["0", 1],
    ["999999", 200],
  ])("clamps a well-formed limit into range: %p", (raw, limit) => {
    expect(parsePageLimit(raw, 200)).toEqual({ ok: true, limit });
  });

  test.each([["12abc"], ["3.9"], ["-5"], ["0x10"], ["+5"], ["1e3"], ["NaN"]])(
    "refuses a coerced limit with 400: %p",
    (raw) => {
      expect(parsePageLimit(raw, 200)).toEqual({
        ok: false,
        error: PAGE_LIMIT_ERROR,
      });
    },
  );
});
