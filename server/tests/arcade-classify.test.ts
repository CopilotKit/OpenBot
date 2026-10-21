import { describe, expect, test } from "bun:test";
import { classify } from "../src/plugins/arcade";

/**
 * What an Arcade tool does, read from `metadata.behavior`. `destructive` is read FIRST: a reading
 * that checked `read_only` first would record a both-flagged tool as a read, the one direction
 * nothing downstream recovers from. Anything that cannot be read fails closed to a destructive
 * write, which costs an approval in front of a read rather than a deletion let through unannounced.
 */
describe("classify", () => {
  test("destructive is a destructive write", () => {
    expect(classify({ behavior: { destructive: true } })).toEqual({
      effect: "write",
      destructive: true,
    });
  });

  test("read_only alone is a read", () => {
    expect(classify({ behavior: { read_only: true } })).toEqual({
      effect: "read",
      destructive: false,
    });
  });

  test("both flags true is a destructive write, never a read", () => {
    expect(
      classify({ behavior: { destructive: true, read_only: true } }),
    ).toEqual({ effect: "write", destructive: true });
  });

  test("neither flag true is a plain write", () => {
    expect(
      classify({ behavior: { destructive: false, read_only: false } }),
    ).toEqual({ effect: "write", destructive: false });
  });

  test("absent metadata fails closed", () => {
    expect(classify(undefined)).toEqual({ effect: "write", destructive: true });
  });

  test("a string-valued flag fails closed rather than coercing", () => {
    expect(classify({ behavior: { read_only: "true" } })).toEqual({
      effect: "write",
      destructive: true,
    });
  });
});
