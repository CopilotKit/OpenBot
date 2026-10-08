import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { seal } from "../src/auth/signed-value";
import { decryptSecret } from "../src/credentials";
import { githubCallbackRoutes } from "../src/identity/github-callback";
import { sealGithubState } from "../src/identity/github-oauth";
import { IdentityConflictError } from "../src/identity/types";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const now = new Date("2026-01-01T00:00:00.000Z");
const clientSecret = "client-secret-value";
const OK = "https://app.test/settings/connected-accounts?linked=github";
const FAILED = "https://app.test/settings/connected-accounts?linked=failed";

type Harness = ReturnType<typeof build>;

function build(
  options: {
    actorId?: string | null;
    active?: boolean;
    live?: { id: string } | null;
    tokenFails?: boolean;
    linkError?: Error;
    revokeError?: Error;
    nowAt?: Date;
  } = {},
) {
  const fetchCalls: string[] = [];
  const created: unknown[] = [];
  const rotated: unknown[] = [];
  const revoked: string[] = [];
  const linked: unknown[][] = [];
  const audits: AuditEventInput[] = [];
  let activeChecks = 0;

  const fetchImpl = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    if (String(url).includes("access_token")) {
      if (options.tokenFails) return new Response("{}", { status: 400 });
      return Response.json({
        access_token: "gho_secret",
        refresh_token: "ghr_secret",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      });
    }
    return Response.json({ id: 42, login: "dana" });
  }) as unknown as typeof fetch;

  const routes = githubCallbackRoutes({
    clientId: "client-id",
    clientSecret,
    publicUrl: "https://o.test",
    appUrl: "https://app.test/",
    encryptionKey: key,
    personIsActive: async () => {
      activeChecks += 1;
      return options.active ?? true;
    },
    credentials: {
      create: async (value) => {
        created.push(value);
        return { id: "cred-new", revokedAt: null };
      },
      rotate: async (value) => {
        rotated.push(value);
        return { id: "cred-new", revokedAt: null };
      },
      revoke: async (id) => {
        revoked.push(id);
        if (options.revokeError) throw options.revokeError;
        return new Date();
      },
      findLiveByKey: async () => options.live ?? null,
    },
    identity: {
      linkVerified: async (...args: unknown[]) => {
        linked.push(args);
        if (options.linkError) throw options.linkError;
        return { id: "link-1", userId: "person" } as never;
      },
    },
    auditStore: { insert: async (event) => void audits.push(event) },
    fetchImpl,
    now: () => options.nowAt ?? now,
  });

  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    const id = options.actorId === undefined ? "person" : options.actorId;
    if (id !== null) {
      context.set("actor", { id, email: "x@y.z", role: "user" } as never);
    }
    await next();
  });
  app.route("/", routes);

  return {
    app,
    fetchCalls,
    created,
    rotated,
    revoked,
    linked,
    audits,
    activeChecks: () => activeChecks,
  };
}

async function call(harness: Harness, query: string) {
  const response = await harness.app.request(`/?${query}`);
  return response.headers.get("location");
}

async function validState(userId = "person") {
  return encodeURIComponent(await sealGithubState(userId, key, now));
}

let errors: ReturnType<typeof spyOn>;
let warns: ReturnType<typeof spyOn>;
let logs: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  warns = spyOn(console, "warn").mockImplementation(() => {});
  logs = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
  warns.mockRestore();
  logs.mockRestore();
});

function output() {
  return [errors, warns, logs]
    .flatMap((spy) => spy.mock.calls)
    .map((args: unknown[]) => args.map(String).join(" "))
    .join("\n");
}

describe("GitHub sign-in callback", () => {
  test("links the account, stores the token and audits", async () => {
    const harness = build();
    const response = await harness.app.request(
      `/?code=the-code&state=${await validState()}`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(OK);

    expect(harness.created).toHaveLength(1);
    const stored = harness.created[0] as {
      kind: string;
      provider: string;
      keyId: string;
      metadata: unknown;
      encryptedValue: string;
    };
    expect(stored).toMatchObject({
      kind: "connector",
      provider: "github-user-token",
      keyId: "person:42",
      metadata: { login: "dana" },
    });
    expect(JSON.parse(await decryptSecret(key, stored.encryptedValue))).toEqual(
      {
        accessToken: "gho_secret",
        refreshToken: "ghr_secret",
        expiresAt: "2026-01-01T08:00:00.000Z",
        refreshTokenExpiresAt: new Date(
          now.getTime() + 15897600 * 1000,
        ).toISOString(),
      },
    );

    expect(harness.linked).toEqual([
      [
        { provider: "github", realm: "github.com", subject: "42" },
        "person",
        { method: "oauth", handle: "dana", credentialId: "cred-new" },
      ],
    ]);
    expect(harness.audits).toEqual([
      {
        eventType: "identity.linked",
        targetType: "identity_link",
        targetId: "link-1",
        actorUserId: "person",
        payload: { actor: "person", provider: "github" },
      },
    ]);
  });

  test("a reconnect rotates the live credential instead of inserting", async () => {
    const harness = build({ live: { id: "cred-old" } });
    expect(
      await call(harness, `code=the-code&state=${await validState()}`),
    ).toBe(OK);
    expect(harness.created).toHaveLength(0);
    expect(harness.rotated).toHaveLength(1);
    expect(harness.rotated[0]).toMatchObject({
      previousCredentialId: "cred-old",
      keyId: "person:42",
    });
  });

  test("a denied authorization fails without calling GitHub", async () => {
    const harness = build();
    expect(
      await call(harness, `error=access_denied&state=${await validState()}`),
    ).toBe(FAILED);
    expect(harness.fetchCalls).toHaveLength(0);
  });

  test("no code fails", async () => {
    const harness = build();
    expect(await call(harness, `state=${await validState()}`)).toBe(FAILED);
    expect(harness.fetchCalls).toHaveLength(0);
  });

  test("missing, expired and foreign-label states fail without a fetch", async () => {
    const missing = build();
    expect(await call(missing, "code=the-code")).toBe(FAILED);
    expect(missing.fetchCalls).toHaveLength(0);

    const expired = build({ nowAt: new Date(now.getTime() + 11 * 60_000) });
    expect(
      await call(expired, `code=the-code&state=${await validState()}`),
    ).toBe(FAILED);
    expect(expired.fetchCalls).toHaveLength(0);

    const foreign = build();
    const state = encodeURIComponent(
      await seal(
        JSON.stringify({ userId: "person", issuedAt: now.toISOString() }),
        key,
        "some-other-label",
      ),
    );
    expect(await call(foreign, `code=the-code&state=${state}`)).toBe(FAILED);
    expect(foreign.fetchCalls).toHaveLength(0);
  });

  test("a session belonging to another person fails before anything else", async () => {
    const harness = build({ actorId: "someone-else" });
    expect(
      await call(harness, `code=the-code&state=${await validState()}`),
    ).toBe(FAILED);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.activeChecks()).toBe(0);
    expect(harness.created).toHaveLength(0);
  });

  test("no session fails", async () => {
    const harness = build({ actorId: null });
    expect(
      await call(harness, `code=the-code&state=${await validState()}`),
    ).toBe(FAILED);
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.activeChecks()).toBe(0);
  });

  test("an inactive person fails without a fetch", async () => {
    const harness = build({ active: false });
    expect(
      await call(harness, `code=the-code&state=${await validState()}`),
    ).toBe(FAILED);
    expect(harness.fetchCalls).toHaveLength(0);
  });

  test("a refused token exchange stores nothing", async () => {
    const harness = build({ tokenFails: true });
    expect(
      await call(harness, `code=the-code&state=${await validState()}`),
    ).toBe(FAILED);
    expect(harness.created).toHaveLength(0);
    expect(harness.rotated).toHaveLength(0);
    expect(harness.linked).toHaveLength(0);
  });

  test("an identity conflict revokes the new credential and does not audit", async () => {
    const harness = build({
      linkError: new IdentityConflictError(),
    });
    expect(
      await call(harness, `code=the-code&state=${await validState()}`),
    ).toBe(FAILED);
    expect(harness.revoked).toEqual(["cred-new"]);
    expect(harness.audits).toHaveLength(0);
  });

  test("a revoke that throws still redirects failed", async () => {
    const harness = build({
      linkError: new IdentityConflictError(),
      revokeError: new Error("already revoked"),
    });
    expect(
      await call(harness, `code=the-code&state=${await validState()}`),
    ).toBe(FAILED);
    expect(harness.audits).toHaveLength(0);
  });

  test("nothing secret is ever logged", async () => {
    const state = await validState();
    for (const harness of [
      build(),
      build({ tokenFails: true }),
      build({ linkError: new IdentityConflictError() }),
      build({
        linkError: new Error("boom gho_secret"),
        revokeError: new Error("x"),
      }),
    ]) {
      await call(harness, `code=the-code&state=${state}`);
    }
    const text = output();
    for (const secret of [
      "the-code",
      "gho_secret",
      "ghr_secret",
      clientSecret,
      decodeURIComponent(state),
      state,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});
