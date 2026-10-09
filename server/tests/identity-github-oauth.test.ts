import { describe, expect, test } from "bun:test";
import { seal } from "../src/auth/signed-value";
import {
  exchangeGithubCode,
  fetchGithubUser,
  GithubOAuthError,
  githubAuthorizationUrl,
  githubRedirectUri,
  openGithubState,
  sealGithubState,
} from "../src/identity/github-oauth";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const now = new Date("2026-01-01T00:00:00.000Z");

type Call = { url: string; init: RequestInit };

function stub(response: () => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const input = {
  clientId: "client-id",
  clientSecret: "super-secret-value",
  code: "one-time-code-123",
  redirectUri: "https://o.test/api/identity/github/callback",
};

describe("GitHub authorize URL and redirect URI", () => {
  test("authorize URL carries exactly client_id, redirect_uri and state", () => {
    const url = new URL(
      githubAuthorizationUrl({
        clientId: "cid",
        redirectUri: "https://o.test/cb",
        state: "st",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "redirect_uri",
      "state",
    ]);
    expect(url.searchParams.get("redirect_uri")).toBe("https://o.test/cb");
  });

  test("redirect URI strips trailing slashes", () => {
    expect(githubRedirectUri("https://o.test")).toBe(
      "https://o.test/api/identity/github/callback",
    );
    expect(githubRedirectUri("https://o.test//")).toBe(
      "https://o.test/api/identity/github/callback",
    );
  });
});

describe("GitHub state", () => {
  test("round-trips to the user", async () => {
    const sealed = await sealGithubState("u1", key, now);
    expect(await openGithubState(sealed, key, now)).toEqual({ userId: "u1" });
  });

  test("expires after ten minutes", async () => {
    const sealed = await sealGithubState("u1", key, now);
    const later = new Date(now.getTime() + 11 * 60_000);
    expect(await openGithubState(sealed, key, later)).toBeNull();
  });

  test("is rejected from the future", async () => {
    const sealed = await sealGithubState("u1", key, now);
    const earlier = new Date(now.getTime() - 60_000);
    expect(await openGithubState(sealed, key, earlier)).toBeNull();
  });

  test("missing and garbage values are null", async () => {
    expect(await openGithubState(undefined, key, now)).toBeNull();
    expect(await openGithubState("garbage", key, now)).toBeNull();
  });

  test("another label is null", async () => {
    const sealed = await seal(
      JSON.stringify({ userId: "u", issuedAt: now.toISOString() }),
      key,
      "other-label",
    );
    expect(await openGithubState(sealed, key, now)).toBeNull();
  });

  test("wrong shape is null", async () => {
    const sealed = await seal(
      JSON.stringify({ userId: "", issuedAt: now.toISOString() }),
      key,
      "identity-github-connect",
    );
    expect(await openGithubState(sealed, key, now)).toBeNull();
  });
});

describe("exchangeGithubCode", () => {
  test("posts JSON and maps expiries from now", async () => {
    const { calls, fetchImpl } = stub(() =>
      Response.json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 28800,
        refresh_token_expires_in: 15811200,
      }),
    );
    const tokens = await exchangeGithubCode(input, fetchImpl, now);
    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: new Date(now.getTime() + 28800_000).toISOString(),
      refreshTokenExpiresAt: new Date(
        now.getTime() + 15811200_000,
      ).toISOString(),
    });
    const call = calls[0];
    expect(call.url).toBe("https://github.com/login/oauth/access_token");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    const headers = new Headers(call.init.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({
      client_id: "client-id",
      client_secret: "super-secret-value",
      code: "one-time-code-123",
      redirect_uri: input.redirectUri,
    });
  });

  test("absent expiries and refresh token become null", async () => {
    const { fetchImpl } = stub(() => Response.json({ access_token: "at" }));
    expect(await exchangeGithubCode(input, fetchImpl, now)).toEqual({
      accessToken: "at",
      refreshToken: null,
      expiresAt: null,
      refreshTokenExpiresAt: null,
    });
  });

  test("a 200 error body throws without echoing secrets", async () => {
    const { fetchImpl } = stub(() =>
      Response.json({ error: "bad_verification_code" }),
    );
    const error = await exchangeGithubCode(input, fetchImpl, now).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(GithubOAuthError);
    expect(error.message).not.toContain(input.code);
    expect(error.message).not.toContain(input.clientSecret);
    expect(error.message).not.toContain("bad_verification_code");
  });

  test("non-ok status throws", async () => {
    const { fetchImpl } = stub(() => new Response("nope", { status: 500 }));
    await expect(exchangeGithubCode(input, fetchImpl, now)).rejects.toThrow(
      GithubOAuthError,
    );
  });

  test("transport failure throws GithubOAuthError", async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect failed ${input.clientSecret}`);
    }) as unknown as typeof fetch;
    const error = await exchangeGithubCode(input, fetchImpl, now).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(GithubOAuthError);
    expect(error.message).not.toContain(input.clientSecret);
  });
});

describe("fetchGithubUser", () => {
  test("sends bearer headers and returns id and login", async () => {
    const { calls, fetchImpl } = stub(() =>
      Response.json({ id: 42, login: "octocat", email: "x@y.z" }),
    );
    expect(await fetchGithubUser("tok", fetchImpl)).toEqual({
      id: 42,
      login: "octocat",
    });
    const headers = new Headers(calls[0].init.headers);
    expect(calls[0].url).toBe("https://api.github.com/user");
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(calls[0].init.redirect).toBe("manual");
  });

  test.each([
    ["non-integer id", () => Response.json({ id: 1.5, login: "a" })],
    ["string id", () => Response.json({ id: "1", login: "a" })],
    ["empty login", () => Response.json({ id: 1, login: "" })],
    ["non-ok", () => new Response("x", { status: 401 })],
  ])("%s throws", async (_name, response) => {
    const { fetchImpl } = stub(response);
    await expect(fetchGithubUser("tok", fetchImpl)).rejects.toThrow(
      GithubOAuthError,
    );
  });
});
