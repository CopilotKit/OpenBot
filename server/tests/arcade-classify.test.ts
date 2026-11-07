import { describe, expect, test } from "bun:test";
import { classify } from "../src/plugins/arcade";

/**
 * What an Arcade tool does, read from `metadata.behavior`. `destructive` is read FIRST: a reading
 * that checked `read_only` first would record a both-flagged tool as a read, the one direction
 * nothing downstream recovers from. Anything that cannot be read is an unclassified write: a write,
 * never a read, and not destructive, because Arcade never said so. Destructive is what makes a call
 * always ask; unclassified is what keeps a background read away from it.
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

  test("absent metadata is an unclassified write, not a destructive one", () => {
    expect(classify(undefined)).toEqual({
      effect: "write",
      destructive: false,
      unclassified: true,
    });
    expect(classify({ metadata: null })).toEqual({
      effect: "write",
      destructive: false,
      unclassified: true,
    });
  });

  test("a string-valued flag is unclassified rather than coerced", () => {
    expect(classify({ behavior: { read_only: "true" } })).toEqual({
      effect: "write",
      destructive: false,
      unclassified: true,
    });
  });
});
