import { describe, expect, test } from "bun:test";
import { githubAutorizaçãoUrl } from "./mutations";

const FRIENDLY = "Could not start connecting GitHub. Tentar novamente.";
const VALID =
  "https://github.com/login/oauth/authorize?client_id=abc&state=xyz";

describe("githubAutorizaçãoUrl", () => {
  test("passes a github.com authorize URL through unchanged", () => {
    expect(githubAutorizaçãoUrl({ authorizationUrl: VALID })).toBe(VALID);
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
      "another Host",
      { authorizationUrl: "https://evil.example/login/oauth/authorize" },
    ],
    [
      "a lookalike Host",
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
    expect(() => githubAutorizaçãoUrl(value)).toThrow(FRIENDLY);
  });
});
