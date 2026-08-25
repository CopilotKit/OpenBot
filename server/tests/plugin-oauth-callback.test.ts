import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { challengeFor, sealConnectState } from "../src/plugins/oauth";
import { createPluginRoutes } from "../src/plugins/routes";

/**
 * `GET /oauth/callback`: the request the vendor sends somebody back on.
 *
 * It has no session by design — whose connection this is comes from the state, not from whatever
 * cookie the browser happens to be carrying. That is what makes the state the only thing standing
 * between a consent screen and a live refresh token in this deployment's vault, and it is why what
 * the state says has to be checked against the deployment as it is when the callback LANDS rather
 * than as it was when the flow started ten minutes earlier.
 *
 * So these tests are mostly about what must not be written: a grant for a state this deployment did
 * not seal, for a state old enough to have expired, or for somebody who no longer has access.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const CALLBACK = "http://t/api/plugins/oauth/callback";

const FAILED =
  "https://app.example/settings/connected-accounts?connected=failed";

function signedIn(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "user-1",
      email: "person@openbot.test",
      role: "user",
    } as never);
    await next();
  };
}

/** What `recordConnection` was asked to write, which is the row this endpoint can create. */
type Recorded = {
  serverId: string;
  userId: string;
  refreshToken: string;
  scope: string;
};

function app(input: {
  recorded: Recorded[];
  /** Whether the person named by the state still has access. Present by default. */
  personHasAccess?: (userId: string) => Promise<boolean>;
}) {
  const store = {
    oauthClientFor: async () => ({ clientId: "dyn-1", clientSecret: "" }),
    ensureOAuthClient: async () => ({ clientId: "dyn-1", clientSecret: "" }),
    recordConnection: async (connection: Recorded) => {
      input.recorded.push(connection);
    },
  };
  const routes = createPluginRoutes(
    store as never,
    signedIn(),
    async () => true,
    {
      publicUrl: "https://openbot.example",
      appUrl: "https://app.example",
      encryptionKey: KEY,
      personHasAccess: input.personHasAccess ?? (async () => true),
    },
  );
  return new Hono().route("/api/plugins", routes);
}

/** A vendor that would happily hand over a refresh token, so only our own checks can refuse. */
async function withWillingVendor<T>(
  run: (asked: { params: URLSearchParams }[]) => Promise<T>,
): Promise<T> {
  const asked: { params: URLSearchParams }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    asked.push({ params: new URLSearchParams(String(init?.body)) });
    return new Response(
      JSON.stringify({ refresh_token: "rt-1", scope: "read" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function callbackUrl(state: string): string {
  return `${CALLBACK}?code=code-1&state=${encodeURIComponent(state)}`;
}

describe("a consent that came back the way it left", () => {
  test("the state minted by connect is the state the callback reads", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });

    const started = await hono.request(
      "http://t/api/plugins/servers/notion/connect",
      { method: "POST" },
    );
    const { authorizationUrl } = (await started.json()) as {
      authorizationUrl: string;
    };
    const authorization = new URL(authorizationUrl);
    const state = authorization.searchParams.get("state") ?? "";

    const asked = await withWillingVendor(async (asked) => {
      const response = await hono.request(callbackUrl(state));
      expect(response.headers.get("location")).toBe(
        "https://app.example/settings/connected-accounts/notion",
      );
      return asked;
    });

    expect(recorded).toEqual([
      {
        serverId: "notion",
        userId: "user-1",
        refreshToken: "rt-1",
        scope: "read",
      },
    ]);
    /*
     * The verifier survived the round trip, and it survived it INSIDE the state rather than beside
     * it: the code challenge the vendor was shown is the S256 of the verifier the callback redeemed
     * with. That is the property the sealed state has to keep — it is unreadable, not lossy.
     */
    const verifier = asked[0]?.params.get("code_verifier") ?? "";
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challengeFor(verifier)).toBe(
      authorization.searchParams.get("code_challenge"),
    );
    // And it was never on the callback URL in a form anybody reading that URL could use.
    expect(state).not.toContain(verifier);
  });
});

describe("a consent that outlived the person's access", () => {
  /*
   * THE HOLE THIS CLOSES. Removing somebody deny-lists their address, deletes their sessions and
   * retires the credentials they had already granted — and none of that reaches a consent already in
   * flight at the vendor, because a state is good for ten minutes and the callback has no session to
   * check. Completed, that consent used to write a fresh, live refresh token belonging to somebody
   * who no longer has access, which nothing downstream would ever revoke because nothing knew it
   * existed.
   */
  test("writes nothing, and does not even ask the vendor", async () => {
    const recorded: Recorded[] = [];
    const asked: string[] = [];
    const hono = app({
      recorded,
      personHasAccess: async (userId) => {
        asked.push(userId);
        return false;
      },
    });
    const state = await sealConnectState(
      { userId: "removed-user", serverId: "notion", verifier: "v-1" },
      KEY,
    );

    const requests = await withWillingVendor(async (requests) => {
      const response = await hono.request(callbackUrl(state));
      expect(response.headers.get("location")).toBe(FAILED);
      return requests;
    });

    expect(recorded).toEqual([]);
    expect(asked).toEqual(["removed-user"]);
    // Refused before the code was redeemed, so the deployment never even holds the token it would
    // have had to throw away.
    expect(requests).toEqual([]);
  });

  test("a user id that names nobody is the same refusal", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded, personHasAccess: async () => false });
    const state = await sealConnectState(
      { userId: "never-existed", serverId: "notion", verifier: "v-1" },
      KEY,
    );

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(state));
      expect(response.headers.get("location")).toBe(FAILED);
    });
    expect(recorded).toEqual([]);
  });
});

describe("a consent this deployment did not start", () => {
  test("a state altered on the way back is refused, and nothing is written", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });
    const sealed = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
    );
    const at = Math.floor(sealed.length / 2);
    const tampered = `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`;

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(tampered));
      expect(response.headers.get("location")).toBe(FAILED);
    });
    expect(recorded).toEqual([]);
  });

  test("a state left in a tab too long is refused, and nothing is written", async () => {
    const recorded: Recorded[] = [];
    const hono = app({ recorded });
    // Sealed as if the flow had started half an hour ago: the expiry rides inside the state, so this
    // is the same value the browser would still be holding.
    const stale = await sealConnectState(
      { userId: "user-1", serverId: "notion", verifier: "v-1" },
      KEY,
      Date.now() - 30 * 60_000,
    );

    await withWillingVendor(async () => {
      const response = await hono.request(callbackUrl(stale));
      expect(response.headers.get("location")).toBe(FAILED);
    });
    expect(recorded).toEqual([]);
  });
});
