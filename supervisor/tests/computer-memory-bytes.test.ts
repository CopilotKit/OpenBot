import { describe, expect, test } from "bun:test";
import { computerMemoryBytes } from "../src/computer-memory-bytes";

describe("supervisor computer memory bytes", () => {
  test("unset and empty string mean no cap", () => {
    expect(computerMemoryBytes(undefined)).toEqual({
      ok: true,
      bytes: undefined,
    });
    expect(computerMemoryBytes("")).toEqual({ ok: true, bytes: undefined });
    expect(computerMemoryBytes("   ")).toEqual({ ok: true, bytes: undefined });
  });

  test("a whole number of bytes is accepted", () => {
    expect(computerMemoryBytes("1073741824")).toEqual({
      ok: true,
      bytes: 1_073_741_824,
    });
    expect(computerMemoryBytes("1")).toEqual({ ok: true, bytes: 1 });
  });

  test("suffix units and non-digits are refused instead of parseInt prefixes", () => {
    expect(computerMemoryBytes("512m").ok).toBe(false);
    expect(computerMemoryBytes("1e9").ok).toBe(false);
    expect(computerMemoryBytes("0").ok).toBe(false);
    expect(computerMemoryBytes("-1").ok).toBe(false);
    expect(computerMemoryBytes("1.5").ok).toBe(false);
  });
});
