import { describe, expect, test } from "bun:test";
import type { CatalogueAuth } from "../src/plugins/catalogue";
import {
  authorizationUrlFor,
  challengeFor,
  createVerifier,
  readConnectState,
  redeemAuthorizationCode,
  redirectUriFor,
  registerDynamicClient,
  connectedAccountsUrlFor,
  signConnectState,
} from "../src/plugins/oauth";

/**
 * The half of the connect flow that leaves this deployment and comes back.
 *
 * Everything here exists because the browser is in the middle of it. An authorization code arrives
 * on a URL somebody else's server sent the person to, so nothing on that request can be believed on
 * its own: not who is connecting, not which server they meant, and not that they ever asked. The
 * signed state is what carries those facts across, and the PKCE verifier is what proves the code
 * being redeemed belongs to the request that started it.
 *
 * So these tests are almost entirely about refusal. A state that was tampered with, replayed after
 * expiry, or minted for another purpose has to come back as nothing, because the alternative is
 * attaching somebody else's Google account to this person's row.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const NOW = 1_770_000_000_000;

describe("the state that travels through the vendor", () => {
  test("carries who, which server, and the verifier, and reads back exactly", () => {
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
      NOW,
    );
    expect(readConnectState(signed, KEY, NOW)).toEqual({
      userId: "user-1",
      serverId: "google-drive",
      verifier: "v-1",
      // Absent on the way in, and a definite answer on the way out: a state written before this
      // field existed still reads as the destination every flow used to have.
      returnTo: "settings",
    });
  });

  test("the screen to return to survives the round trip", () => {
    const signed = signConnectState(
      {
        userId: "user-1",
        serverId: "google-drive",
        verifier: "v-1",
        returnTo: "admin",
      },
      KEY,
      NOW,
    );
    expect(readConnectState(signed, KEY, NOW)?.returnTo).toBe("admin");
  });

  /*
   * THE OPEN REDIRECT THIS CANNOT BECOME. A destination carried through an OAuth flow is the classic
   * shape of one: the callback arrives with a fresh consent behind it, and anything it is willing to
   * redirect to is somewhere an attacker can send a person from a link that looked legitimate.
   *
   * The defence is that the field cannot express another origin at all. Only "admin" is recognised;
   * everything else — a URL, a protocol-relative host, a path traversal — reads back as the default.
   * Asserted through a SIGNED state, because a valid signature is exactly what an attacker would not
   * have, and the point is that the narrowing does not depend on the signature to hold.
   */
  test("a destination that names anywhere else reads back as the default", () => {
    for (const hostile of [
      "https://evil.test",
      "//evil.test",
      "/admin/plugins/../../evil",
      "ADMIN",
    ]) {
      const signed = signConnectState(
        {
          userId: "user-1",
          serverId: "google-drive",
          verifier: "v-1",
          returnTo: hostile as "admin",
        },
        KEY,
        NOW,
      );
      expect(readConnectState(signed, KEY, NOW)?.returnTo).toBe("settings");
    }
  });

  test("is refused once a character of it changes", () => {
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
      NOW,
    );
    // The payload is base64url, so flipping a character inside it is the realistic tamper: somebody
    // trying to have the callback attach their Google account to another person's row.
    const tampered = `${signed.slice(0, 4)}${signed[4] === "A" ? "B" : "A"}${signed.slice(5)}`;
    expect(readConnectState(tampered, KEY, NOW)).toBeNull();
  });

  test("is refused when signed with a different key", () => {
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      NOW,
    );
    expect(readConnectState(signed, KEY, NOW)).toBeNull();
  });

  test("expires, so a stale consent screen cannot be redeemed later", () => {
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
      NOW,
    );
    expect(readConnectState(signed, KEY, NOW + 60_000)).not.toBeNull();
    expect(readConnectState(signed, KEY, NOW + 60 * 60_000)).toBeNull();
  });

  test("cannot be a run assertion wearing a different hat", () => {
    // Signed under its own label, so a signature valid for one kind of statement is not valid as
    // another. Without that, any signed value this deployment ever hands out is a candidate state.
    const signed = signConnectState(
      { userId: "user-1", serverId: "google-drive", verifier: "v-1" },
      KEY,
      NOW,
    );
    const [payload] = signed.split(".");
    expect(readConnectState(payload ?? "", KEY, NOW)).toBeNull();
  });

  test("is refused when it is not a state at all", () => {
    expect(readConnectState("", KEY, NOW)).toBeNull();
    expect(readConnectState("nonsense", KEY, NOW)).toBeNull();
    expect(readConnectState("a.b", KEY, NOW)).toBeNull();
  });
});

describe("PKCE", () => {
  test("a verifier is long enough and URL-safe", () => {
    const verifier = createVerifier();
    // RFC 7636 puts the floor at 43 characters, and the alphabet is unreserved characters only.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  test("two verifiers are not the same", () => {
    expect(createVerifier()).not.toBe(createVerifier());
  });

  test("a challenge is the S256 of the verifier, not the verifier", () => {
    // `plain` would make the challenge worthless: anybody who intercepted the authorization request
    // would hold the value needed to redeem the code.
    const verifier = "a".repeat(43);
    const challenge = challengeFor(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challengeFor(verifier)).toBe(challenge);
  });
});

describe("the address the person is sent to", () => {
  // A literal fixture, not the live Google Drive entry: this pins Google's behavior through the
  // params-from-the-entry refactor without the test depending on the catalogue's own shape.
  const googleAuth: Extract<CatalogueAuth, { kind: "user-oauth" }> = {
    kind: "user-oauth",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    authorizationParams: { access_type: "offline", prompt: "consent" },
  };

  const url = new URL(
    authorizationUrlFor({
      auth: googleAuth,
      clientId: "client-id",
      redirectUri: "https://openbot.example/api/plugins/oauth/callback",
      state: "signed-state",
      codeChallenge: "challenge",
    }),
  );

  test("is the vendor's own, from the catalogue", () => {
    expect(`${url.origin}${url.pathname}`).toBe(googleAuth.authorizationUrl);
  });

  test("asks for a refresh token that consent is granted for once", () => {
    // Without `offline`, Google returns an access token and no refresh token, and the connection
    // would silently stop working an hour later. `consent` is what makes it re-issue a refresh token
    // rather than returning nothing on a second connect.
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  test("asks only for the scopes the entry pins", () => {
    expect(url.searchParams.get("scope")).toBe(googleAuth.scopes.join(" "));
  });

  test("carries the state and the challenge, and names the method", () => {
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("a vendor with no authorization params and no scopes sends neither, nor an empty scope", () => {
    // Notion's shape: no authorizationParams, and scopes: [] because the consent screen itself is
    // the scoping. An empty `scope=` would be a malformed request to some vendors, so the key must
    // be entirely absent, not present-and-empty.
    const notionAuth: Extract<CatalogueAuth, { kind: "user-oauth" }> = {
      kind: "user-oauth",
      authorizationUrl: "https://mcp.notion.com/authorize",
      tokenUrl: "https://mcp.notion.com/token",
      revokeUrl: "https://mcp.notion.com/revoke",
      scopes: [],
    };
    const bare = new URL(
      authorizationUrlFor({
        auth: notionAuth,
        clientId: "client-id",
        redirectUri: "https://openbot.example/api/plugins/oauth/callback",
        state: "signed-state",
        codeChallenge: "challenge",
      }),
    );
    expect(bare.searchParams.has("access_type")).toBe(false);
    expect(bare.searchParams.has("prompt")).toBe(false);
    expect(bare.searchParams.has("scope")).toBe(false);
  });

  /*
   * DEFENSE IN DEPTH, NOT REACHABILITY TODAY. The catalogue is frozen, reviewed code, so nothing in
   * it can set this now — but `authorizationParams` is applied LAST, after the six keys that carry
   * this flow's own security (who is asking, where the vendor answers, and the PKCE proof). An entry
   * that names one of them would quietly win, and a future entry setting `code_challenge_method:
   * "plain"` would defeat PKCE with no test catching it. Throwing at URL-build time turns that into a
   * fail-at-first-connect instead of a silent downgrade.
   */
  test("an entry that names one of the flow's own keys throws rather than winning", () => {
    const hostileAuth: Extract<CatalogueAuth, { kind: "user-oauth" }> = {
      kind: "user-oauth",
      authorizationUrl: "https://vendor.example/authorize",
      tokenUrl: "https://vendor.example/token",
      revokeUrl: "https://vendor.example/revoke",
      scopes: [],
      authorizationParams: { code_challenge_method: "plain" },
    };
    expect(() =>
      authorizationUrlFor({
        auth: hostileAuth,
        clientId: "client-id",
        redirectUri: "https://openbot.example/api/plugins/oauth/callback",
        state: "signed-state",
        codeChallenge: "challenge",
      }),
    ).toThrow(/code_challenge_method/);
  });

  test("an entry's harmless extra parameter still passes through", () => {
    const audienceAuth: Extract<CatalogueAuth, { kind: "user-oauth" }> = {
      kind: "user-oauth",
      authorizationUrl: "https://vendor.example/authorize",
      tokenUrl: "https://vendor.example/token",
      revokeUrl: "https://vendor.example/revoke",
      scopes: [],
      authorizationParams: { audience: "x" },
    };
    const withAudience = new URL(
      authorizationUrlFor({
        auth: audienceAuth,
        clientId: "client-id",
        redirectUri: "https://openbot.example/api/plugins/oauth/callback",
        state: "signed-state",
        codeChallenge: "challenge",
      }),
    );
    expect(withAudience.searchParams.get("audience")).toBe("x");
  });
});

describe("the address the vendor sends them back to", () => {
  test("is one path, built from the deployment's own public URL", () => {
    expect(redirectUriFor("https://openbot.example")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
  });

  test("does not double a slash when the public URL has a trailing one", () => {
    // A redirect URI has to match what was registered with the vendor character for character, so a
    // stray slash is not cosmetic: it fails at the vendor, with a message that does not name us.
    expect(redirectUriFor("https://openbot.example/")).toBe(
      "https://openbot.example/api/plugins/oauth/callback",
    );
  });
});

describe("where the callback sends somebody afterwards", () => {
  /*
   * The bug this exists to prevent, found by trying to run the thing rather than by reading it.
   *
   * The app and the API are two processes on two ports: Vite on 3010, this server on 3001. The
   * callback lands on the API, so a relative redirect resolved against the API's origin and ended on
   * a 404 — after the consent had succeeded and the grant was already stored. Nothing about that
   * looks like a failure of the connect flow, which is why it needs a test and not a comment.
   */
  test("success returns to the account, on the app's origin", () => {
    expect(
      connectedAccountsUrlFor("http://localhost:3010", {
        serverId: "google-drive",
      }),
    ).toBe("http://localhost:3010/settings/connected-accounts/google-drive");
  });

  test("success carries no outcome, because the account already says it", () => {
    const url = connectedAccountsUrlFor("http://localhost:3010", {
      serverId: "google-drive",
    });
    expect(url).not.toContain("?");
  });

  test("a server id is escaped rather than trusted into a path", () => {
    // It comes off a signed state, so it is ours — but it lands in a URL, and a value that reaches a
    // URL unescaped is one path traversal away from meaning something else.
    expect(
      connectedAccountsUrlFor("http://localhost:3010", {
        serverId: "../../admin",
      }),
    ).toBe("http://localhost:3010/settings/connected-accounts/..%2F..%2Fadmin");
  });

  test("failure goes to the list, which is the screen that says so", () => {
    /*
     * The list, not an account page: the notice is drawn there, and on the paths where the state
     * could not be read there is no server id to return to anyway. One outcome for every failure,
     * because telling a forged state apart from an expired one only tells somebody probing this
     * endpoint how far they got.
     */
    expect(
      connectedAccountsUrlFor("http://localhost:3010", { failed: true }),
    ).toBe(
      "http://localhost:3010/settings/connected-accounts?connected=failed",
    );
  });

  test("still points somewhere when no app URL is configured", () => {
    // Relative is wrong on a split-port deployment and right on a single-origin one, which is the
    // only case where `appUrl` can be absent and the deployment still works.
    expect(
      connectedAccountsUrlFor(undefined, { serverId: "google-drive" }),
    ).toBe("/settings/connected-accounts/google-drive");
  });

  test("a connect started on the admin page returns to the admin page", () => {
    // The round trip this removes: an administrator who connected from the connector's setup screen
    // used to be put down on their personal settings page, mid-task, on another part of the app.
    expect(
      connectedAccountsUrlFor(
        "http://localhost:3010",
        { serverId: "google-drive" },
        "admin",
      ),
    ).toBe("http://localhost:3010/admin/plugins/google-drive");
  });

  test("a failure goes to the list even when it began on the admin page", () => {
    /*
     * The admin route takes the server key in its path, and a failed state has no key to build one
     * from — the whole reason a failure is anonymous is that the state could not be read. The list is
     * also the only screen that draws the notice, so it is the honest destination either way.
     */
    expect(
      connectedAccountsUrlFor(
        "http://localhost:3010",
        { failed: true },
        "admin",
      ),
    ).toBe(
      "http://localhost:3010/settings/connected-accounts?connected=failed",
    );
  });
});

describe("registering this deployment as an OAuth client", () => {
  test("registers a dynamic client with the redirect URI and no secret", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ client_id: "dyn-123" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const client = await registerDynamicClient({
        registrationUrl: "https://vendor.example/register",
        redirectUri: "https://openbot.example/api/plugins/oauth/callback",
      });
      expect(client).toEqual({ clientId: "dyn-123", clientSecret: "" });
      expect(seen[0]?.url).toBe("https://vendor.example/register");
      expect(seen[0]?.body).toEqual({
        redirect_uris: ["https://openbot.example/api/plugins/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_name: "OpenBot",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a refused registration returns null rather than a client", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("no", { status: 400 })) as unknown as typeof fetch;
    try {
      expect(
        await registerDynamicClient({
          registrationUrl: "https://vendor.example/register",
          redirectUri: "https://openbot.example/cb",
        }),
      ).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * A 200 carrying something that is not JSON.
   *
   * A CDN interstitial, a captive portal, a load balancer's maintenance page: all of them answer 200
   * with HTML, and this function's contract is that a vendor which will not register us reads back
   * as null. An unguarded `response.json()` breaks that contract in the worst available way — it
   * throws a SyntaxError, which escapes the whole request as a 500, and the parser's message quotes
   * the vendor's body into whatever logs it.
   */
  test("a 200 that is not JSON is a refusal, not a thrown parse error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>Attention Required!</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    try {
      expect(
        await registerDynamicClient({
          registrationUrl: "https://vendor.example/register",
          redirectUri: "https://openbot.example/cb",
        }),
      ).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * A redirect is a refusal, and is never followed.
   *
   * This request carries nothing secret, but where it goes is a reviewed decision: the registration
   * endpoint is pinned in the catalogue, and a 302 is somebody else deciding for us. Followed, it
   * would have this deployment register itself at whatever address the answer named — and believe
   * the client id that came back.
   */
  test("a redirect is not followed, and reads back as a refusal", async () => {
    const seen: { redirect: RequestRedirect | undefined }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ redirect: init?.redirect });
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/register" },
      });
    }) as unknown as typeof fetch;
    try {
      expect(
        await registerDynamicClient({
          registrationUrl: "https://vendor.example/register",
          redirectUri: "https://openbot.example/cb",
        }),
      ).toBeNull();
      expect(seen[0]?.redirect).toBe("manual");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("redeeming an authorization code", () => {
  test("an empty client secret sends no client_secret field", async () => {
    const seen: { params: URLSearchParams }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ params: new URLSearchParams(String(init?.body)) });
      return new Response(
        JSON.stringify({ refresh_token: "rt-1", scope: "" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      await redeemAuthorizationCode({
        tokenUrl: "https://vendor.example/token",
        clientId: "client-id",
        clientSecret: "",
        code: "code-1",
        redirectUri: "https://openbot.example/api/plugins/oauth/callback",
        verifier: "verifier-1",
      });
      expect(seen[0]?.params.has("client_secret")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a non-empty client secret still sends the field", async () => {
    const seen: { params: URLSearchParams }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ params: new URLSearchParams(String(init?.body)) });
      return new Response(
        JSON.stringify({ refresh_token: "rt-1", scope: "" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      await redeemAuthorizationCode({
        tokenUrl: "https://vendor.example/token",
        clientId: "client-id",
        clientSecret: "secret-1",
        code: "code-1",
        redirectUri: "https://openbot.example/api/plugins/oauth/callback",
        verifier: "verifier-1",
      });
      expect(seen[0]?.params.get("client_secret")).toBe("secret-1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * A 200 carrying something that is not JSON.
   *
   * The documented contract is a refusal — "a refusal rather than an exception when the vendor
   * declines" — and a CDN interstitial answering 200 with HTML is exactly the case where the
   * unguarded parse turned that refusal into a 500. The person had consented by then, so the failure
   * lands on the callback: it must redirect them back to Settings with a notice, not crash.
   */
  test("a 200 that is not JSON is a refusal, not a thrown parse error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>checking your browser</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    try {
      expect(
        await redeemAuthorizationCode({
          tokenUrl: "https://vendor.example/token",
          clientId: "client-id",
          clientSecret: "",
          code: "code-1",
          redirectUri: "https://openbot.example/api/plugins/oauth/callback",
          verifier: "verifier-1",
        }),
      ).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /** A redirect from the token endpoint is a refusal too, and is never followed. */
  test("a redirect is not followed, and reads back as a refusal", async () => {
    const seen: { redirect: RequestRedirect | undefined }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ redirect: init?.redirect });
      return new Response(null, {
        status: 307,
        headers: { location: "https://elsewhere.example/token" },
      });
    }) as unknown as typeof fetch;
    try {
      expect(
        await redeemAuthorizationCode({
          tokenUrl: "https://vendor.example/token",
          clientId: "client-id",
          clientSecret: "",
          code: "code-1",
          redirectUri: "https://openbot.example/api/plugins/oauth/callback",
          verifier: "verifier-1",
        }),
      ).toBeNull();
      expect(seen[0]?.redirect).toBe("manual");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /**
   * The scope is capped where it is read.
   *
   * It is a short string in the protocol and vendor-controlled in fact, and everything downstream
   * shows it to somebody: the connected-accounts page, an `mcp.account_connected` payload, the
   * `mcp_user_credentials.scope` column. None of those is a promise about length, and a vendor
   * answering with a megabyte of it should cost a truncated line rather than a stored megabyte.
   */
  test("a vendor's scope is capped rather than stored whole", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ refresh_token: "rt-1", scope: "s".repeat(2_000) }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const grant = await redeemAuthorizationCode({
        tokenUrl: "https://vendor.example/token",
        clientId: "client-id",
        clientSecret: "",
        code: "code-1",
        redirectUri: "https://openbot.example/api/plugins/oauth/callback",
        verifier: "verifier-1",
      });
      expect(grant?.scope.length).toBe(512);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
