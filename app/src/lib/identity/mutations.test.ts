import { describe, expect, test } from "bun:test";
import { githubAuthorizationUrl } from "./mutations";

const FRIENDLY = "Could not start connecting GitHub. Try again.";
const VALID =
  "https://github.com/login/oauth/authorize?client_id=abc&state=xyz";

describe("githubAuthorizationUrl", () => {
  test("passes a github.com authorize URL through unchanged", () => {
    expect(githubAuthorizationUrl({ authorizationUrl: VALID })).toBe(VALID);
  });

  test.each([
    ["a missing envelope", undefined],
    ["null", null],
    ["a string", VALID],
    ["a missing field", {}],
    ["a non-string field", { authorizationUrl: 42 }],
    ["a javascript: URL", { authorizationUrl: "javascript:alert(1)" }],
    [
      "an http URL",
      { authorizationUrl: "http://github.com/login/oauth/authorize" },
    ],
    [
      "another host",
      { authorizationUrl: "https://evil.example/login/oauth/authorize" },
    ],
    [
      "a lookalike host",
      {
        authorizationUrl:
          "https://github.com.evil.example/login/oauth/authorize",
      },
    ],
    [
      "another path",
      { authorizationUrl: "https://github.com/settings/tokens" },
    ],
    ["an unparseable string", { authorizationUrl: "not a url" }],
  ])("rejects %s with the friendly message", (_name, value) => {
    expect(() => githubAuthorizationUrl(value)).toThrow(FRIENDLY);
  });
});
