import { describe, expect, test } from "bun:test";
import { isOpenPath, matchesToken, offeredToken } from "../src/authorisation";

/**
 * The check that stands in front of a Bot's browser.
 *
 * Every case here is one that was reachable before it existed: taking the wheel, navigating a live
 * page, listing the Bot's files, with no sign-in and no audit row.
 */

const SECRET = "a-long-development-secret";

describe("matching the secret", () => {
  test("the right secret is accepted", () => {
    expect(matchesToken(SECRET, SECRET)).toBeTrue();
  });

  test("a wrong secret of the same length is refused", () => {
    const wrong = `${SECRET.slice(0, -1)}X`;
    expect(wrong).toHaveLength(SECRET.length);
    expect(matchesToken(SECRET, wrong)).toBeFalse();
  });

  test("a correct prefix is refused", () => {
    // The case the constant-time comparison exists for: guessing forwards must not get warmer.
    expect(matchesToken(SECRET, SECRET.slice(0, 5))).toBeFalse();
  });

  test("an empty offer is refused", () => {
    expect(matchesToken(SECRET, "")).toBeFalse();
  });

  test("an empty EXPECTED secret refuses everything, including an empty offer", () => {
    // A computer that came up without a secret must be unreachable rather than open to anybody who
    // also sends nothing, which is what a plain equality check would have done.
    expect(matchesToken("", "")).toBeFalse();
    expect(matchesToken("", "anything")).toBeFalse();
  });
});

describe("finding the secret a caller offered", () => {
  const url = (path: string) => new URL(`http://computer.test${path}`);

  test("a header", () => {
    const headers = new Headers({ "x-openbot-computer-token": SECRET });
    expect(offeredToken(headers, url("/snapshot"))).toBe(SECRET);
  });

  test("a bearer token", () => {
    const headers = new Headers({ authorization: `Bearer ${SECRET}` });
    expect(offeredToken(headers, url("/snapshot"))).toBe(SECRET);
  });

  test("the stream takes it from the query, because an upgrade carries no headers", () => {
    const headers = new Headers();
    expect(offeredToken(headers, url(`/stream?bot=b&token=${SECRET}`))).toBe(
      SECRET,
    );
  });

  test("the stream does NOT accept a header instead", () => {
    // Not a restriction that matters for security, both are checked against the same secret, but
    // the socket has one way in, and a surface that sent the header would fail loudly rather than
    // appearing to work until somebody looked.
    const headers = new Headers({ "x-openbot-computer-token": SECRET });
    expect(offeredToken(headers, url("/stream?bot=b"))).toBe("");
  });

  test("nothing offered is an empty string, not a crash", () => {
    expect(offeredToken(new Headers(), url("/snapshot"))).toBe("");
  });
});

describe("what an unauthenticated caller may reach", () => {
  test("health, and nothing else", () => {
    expect(isOpenPath("/health")).toBeTrue();
    for (const path of [
      "/control/take",
      "/navigate",
      "/snapshot",
      "/files/list",
      "/files/read",
      "/stream",
      "/live",
      "/",
    ]) {
      expect(isOpenPath(path)).toBeFalse();
    }
  });
});
