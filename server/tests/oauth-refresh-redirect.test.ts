import { describe, expect, test } from "bun:test";
import { exchangeRefreshTokenOverHttp } from "../src/plugins/store";

/**
 * The renewal carries the deployment's client secret and somebody's refresh token to a
 * catalogue-pinned address. Following a redirect would hand both to whatever address the answer
 * named, so the request goes out with `redirect: "manual"` and a 3xx lands in the refusal branch
 * instead of being followed.
 *
 * The authorization-code redemption and the dynamic-client registration in `oauth.ts` already guard
 * the same way; this covers the third path that carries secrets, which previously followed
 * redirects by default.
 */
describe("renewing an access token", () => {
  test("a redirecting token endpoint is a refusal and is never followed", async () => {
    const seen: { url: unknown; redirect: RequestRedirect | undefined }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url, redirect: init?.redirect });
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/token" },
      });
    }) as unknown as typeof fetch;
    try {
      await expect(
        exchangeRefreshTokenOverHttp({
          tokenUrl: "https://vendor.example/token",
          client: { clientId: "c-1", clientSecret: "s-1" },
          refreshToken: "rt-1",
        }),
      ).rejects.toThrow("The vendor would not renew this access (302).");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://vendor.example/token");
    expect(seen[0]?.redirect).toBe("manual");
  });

  test("a successful renewal still sends the secret to the pinned endpoint only", async () => {
    const seen: { url: unknown; redirect: RequestRedirect | undefined }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url, redirect: init?.redirect });
      return new Response(
        JSON.stringify({ access_token: "at-1", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const token = await exchangeRefreshTokenOverHttp({
        tokenUrl: "https://vendor.example/token",
        client: { clientId: "c-1", clientSecret: "s-1" },
        refreshToken: "rt-1",
      });
      expect(token.accessToken).toBe("at-1");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe("manual");
  });
});
