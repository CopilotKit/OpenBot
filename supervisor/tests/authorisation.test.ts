import { describe, expect, test } from "bun:test";
import { authorised } from "../src/authorisation";

describe("who may drive the supervisor", () => {
  test("the exact bearer secret is admitted", () => {
    expect(authorised("Bearer s3cret-token", "s3cret-token")).toBe(true);
  });

  test.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["the bare secret without Bearer", "s3cret-token"],
    ["a wrong secret of the same length", "Bearer s3cret-tokeX"],
    ["a prefix of the secret", "Bearer s3cret"],
    ["the secret with something appended", "Bearer s3cret-token2"],
    ["another scheme", "Basic s3cret-token"],
  ])("%s is refused", (_, header) => {
    expect(authorised(header, "s3cret-token")).toBe(false);
  });

  test("an empty configured secret admits nobody, not even an empty bearer", () => {
    expect(authorised("Bearer ", "")).toBe(false);
  });

  test("a multi-byte secret is compared by bytes and still matches only itself", () => {
    expect(authorised("Bearer clé-é", "clé-é")).toBe(true);
    expect(authorised("Bearer clé-e", "clé-é")).toBe(false);
  });
});
