import { describe, expect, test } from "bun:test";
import { authorizationHeader } from "../src/plugins/mcp";

describe("authorizationHeader", () => {
  test("a bare token is sent as Bearer", () => {
    expect(authorizationHeader("abc123")).toBe("Bearer abc123");
  });
  test("a token that names Basic is sent as written", () => {
    expect(authorizationHeader("Basic dXNlcjpwYXNz")).toBe(
      "Basic dXNlcjpwYXNz",
    );
  });
  test("a token that names Bearer is not doubled", () => {
    expect(authorizationHeader("Bearer abc123")).toBe("Bearer abc123");
  });
  test("the scheme is matched without regard to case, and whitespace is trimmed", () => {
    expect(authorizationHeader("  basic dXNlcjpwYXNz  ")).toBe(
      "basic dXNlcjpwYXNz",
    );
  });
  test("a scheme word with nothing after it is treated as a bare token", () => {
    expect(authorizationHeader("Basic")).toBe("Bearer Basic");
  });
});
