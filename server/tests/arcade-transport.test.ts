import { describe, expect, test } from "bun:test";
import { listNeedsCredential, toolkitOf } from "../src/plugins/arcade";

/** The Arcade transport's boundary, asserted with no network and no database. */
describe("toolkitOf", () => {
  test("case is preserved: Gmail and gmail are distinct apps", () => {
    expect(toolkitOf("arcade://Gmail")).toBe("Gmail");
    expect(toolkitOf("arcade://gmail")).toBe("gmail");
    expect(toolkitOf("arcade://Gmail")).not.toBe(toolkitOf("arcade://gmail"));
  });

  test("a url that is not arcade:// answers null", () => {
    expect(toolkitOf("composio://gmail")).toBeNull();
    expect(toolkitOf("https://arcade.dev")).toBeNull();
    expect(toolkitOf("")).toBeNull();
  });

  test("padding and trailing slashes answer the bare toolkit", () => {
    expect(toolkitOf("arcade://Gmail/")).toBe("Gmail");
    expect(toolkitOf("arcade://Gmail//")).toBe("Gmail");
    expect(toolkitOf("arcade://Gmail/ ")).toBe("Gmail");
    expect(toolkitOf("arcade:// Gmail ")).toBe("Gmail");
  });

  test("a path segment is not an app", () => {
    expect(toolkitOf("arcade://Gmail/messages")).toBeNull();
    expect(toolkitOf("arcade://")).toBeNull();
  });
});

describe("listNeedsCredential", () => {
  test("a listing is the deployment's, not somebody's", () => {
    expect(listNeedsCredential).toBe(false);
  });
});
