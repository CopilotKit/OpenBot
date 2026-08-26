import { describe, expect, test } from "bun:test";
import {
  claimOidcLoopbackCookies,
  stashOidcLoopbackCookies,
} from "../src/auth/oidc-loopback-claim";

describe("oidc loopback claim", () => {
  test("hands session cookies over once", () => {
    expect(
      stashOidcLoopbackCookies([
        "better-auth.session_token=abc; Path=/; HttpOnly",
        "better-auth.session_data=xyz; Path=/",
      ]),
    ).toBe(true);

    const first = claimOidcLoopbackCookies();
    expect(first?.some((cookie) => cookie.includes("session_token=abc"))).toBe(
      true,
    );
    expect(claimOidcLoopbackCookies()).toBeNull();
  });

  test("ignores responses with no session cookie", () => {
    expect(stashOidcLoopbackCookies(["unrelated=1"])).toBe(false);
    expect(claimOidcLoopbackCookies()).toBeNull();
  });
});
