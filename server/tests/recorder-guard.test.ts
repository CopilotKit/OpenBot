import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AuditEventInput } from "../src/audit";
import { DEV_ACTOR } from "../src/auth/dev-actor";
import type { AuthenticatedActor } from "../src/auth/guards";
import { AuthorityUnavailable } from "../src/auth/organization";
import type { OpenBotRole } from "../src/auth/roles";
import {
  createRecorderResolver,
  createRequireRecorder,
  type OrganizationVerdictCache,
  RECORDER_BEARER,
  type RecorderMode,
  type RecorderRefusalSink,
} from "../src/recorder/guard";
import { createRecorderRefusalAudit } from "../src/recorder/refusal-audit";
import type { RecorderVariables } from "../src/recorder/variables";

const TOKEN = `obr_${"a".repeat(43)}`;
const SECOND_TOKEN = `obr_${"b".repeat(43)}`;
const STRANGER_TOKEN = `obr_${"c".repeat(43)}`;
const SIGNED_OUT_SENTENCE =
  "This browser is no longer connected to OpenBot. Connect it again.";
const ORGANIZATION_SENTENCE =
  "Your organization sign-in ended. Connect this browser to OpenBot again.";

type Refusal = Parameters<RecorderRefusalSink>[0];
type UserRow = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
};
type Connection = {
  connectionId: string;
  userId: string;
  organizationSession: string | null;
};

const owner: UserRow = {
  id: "owner",
  email: "owner@openbot.test",
  name: "Owner Person",
  image: "https://example.test/owner.png",
};

function betterAuth(
  overrides: Partial<Extract<RecorderMode, { kind: "better-auth" }>> = {},
): RecorderMode {
  return {
    kind: "better-auth",
    roles: { rolesForUser: async () => ["user"] },
    isRevoked: async () => false,
    allowedEmailDomains: [],
    ...overrides,
  };
}

function fixture(
  mode: RecorderMode,
  options: {
    connections?: Record<string, Connection>;
    users?: UserRow[];
    verdicts?: OrganizationVerdictCache;
  } = {},
) {
  const connections = new Map(
    Object.entries(
      options.connections ?? {
        [TOKEN]: {
          connectionId: "connection-1",
          userId: owner.id,
          organizationSession: null,
        },
      },
    ),
  );
  const users = new Map(
    (options.users ?? [owner]).map((user) => [user.id, user]),
  );
  const refusals: Refusal[] = [];
  const clock = { now: 1_000_000 };
  const resolve = createRecorderResolver({
    connections: { resolve: async (token) => connections.get(token) ?? null },
    mode,
    user: async (userId) => users.get(userId) ?? null,
    now: () => clock.now,
    ...(options.verdicts ? { verdicts: options.verdicts } : {}),
  });
  const onRefused: RecorderRefusalSink = (refusal) => {
    refusals.push(refusal);
  };
  const app = new Hono<{ Variables: RecorderVariables }>();
  app.get("/x", createRequireRecorder(resolve, onRefused), (c) =>
    c.json(c.var.actor),
  );
  app.get("/connection", createRequireRecorder(resolve, onRefused), (c) =>
    c.json({ connectionId: c.var.recorderConnectionId }),
  );
  const call = (headers: Record<string, string> = {}, path = "/x") =>
    app.request(`http://openbot.test${path}`, { headers });
  const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
  return { app, call, bearer, refusals, clock, connections, users, resolve };
}

const digestOf = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

describe("the recorder bearer guard", () => {
  test("a valid bearer is answered as its person", async () => {
    const { call, bearer, refusals } = fixture(betterAuth());

    const response = await call(bearer());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: owner.id,
      email: owner.email,
      name: owner.name,
      image: owner.image,
      role: "user",
    });
    expect(refusals).toEqual([]);
  });

  test("the guard sets the connection the bearer belongs to", async () => {
    const { call, bearer } = fixture(betterAuth());

    const response = await call(bearer(), "/connection");

    expect(await response.json()).toEqual({ connectionId: "connection-1" });
  });

  test("an administrator role beats a user role, as the session guard decides", async () => {
    const { call, bearer } = fixture(
      betterAuth({ roles: { rolesForUser: async () => ["user", "admin"] } }),
    );

    const response = await call(bearer());

    expect((await response.json()).role).toBe("admin");
  });

  test("a malformed bearer is signed out and reported as malformed", async () => {
    const { call, refusals } = fixture(betterAuth());

    const response = await call({ authorization: "Bearer obr_short" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: SIGNED_OUT_SENTENCE,
      code: "RECORDER_SIGNED_OUT",
      reason: "revoked",
    });
    expect(refusals).toEqual([
      { reason: "malformed", path: "/x", tokenDigest: digestOf("obr_short") },
    ]);
  });

  test("an unknown token is signed out with the connect-again sentence", async () => {
    const { call, bearer, refusals } = fixture(betterAuth());

    const response = await call(bearer(STRANGER_TOKEN));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: SIGNED_OUT_SENTENCE,
      code: "RECORDER_SIGNED_OUT",
      reason: "revoked",
    });
    expect(refusals).toEqual([
      { reason: "unknown", path: "/x", tokenDigest: digestOf(STRANGER_TOKEN) },
    ]);
  });

  test("the sink is handed a short digest, never the token", async () => {
    const { call, bearer, refusals } = fixture(betterAuth());

    await call(bearer(STRANGER_TOKEN));

    const [refusal] = refusals;
    expect(refusal?.tokenDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(refusals)).not.toContain(STRANGER_TOKEN);
  });

  test("a token whose person no longer has a user row is unknown", async () => {
    const { call, bearer, refusals } = fixture(betterAuth(), { users: [] });

    const response = await call(bearer());

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("revoked");
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["unknown"]);
  });

  test("no Authorization header on a recorder-only route is signed out with no digest", async () => {
    const { call, refusals } = fixture(betterAuth());

    const response = await call();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: SIGNED_OUT_SENTENCE,
      code: "RECORDER_SIGNED_OUT",
      reason: "revoked",
    });
    expect(refusals).toEqual([
      { reason: "unknown", path: "/x", tokenDigest: null },
    ]);
  });

  test("a person removed from the deployment is signed out as removed", async () => {
    const asked: string[] = [];
    const { call, bearer, refusals } = fixture(
      betterAuth({
        isRevoked: async (email) => {
          asked.push(email);
          return email === owner.email;
        },
      }),
    );

    const response = await call(bearer());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: SIGNED_OUT_SENTENCE,
      code: "RECORDER_SIGNED_OUT",
      reason: "removed",
    });
    expect(asked).toEqual([owner.email]);
    expect(refusals).toEqual([
      {
        reason: "removed",
        path: "/x",
        tokenDigest: digestOf(TOKEN),
        userId: owner.id,
      },
    ]);
  });

  test("a person whose email domain is no longer allowed is signed out as removed", async () => {
    const { call, bearer, refusals } = fixture(
      betterAuth({ allowedEmailDomains: ["company.test"] }),
    );

    const response = await call(bearer());

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("removed");
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["removed"]);
  });

  test("a person in an allowed email domain is admitted", async () => {
    const { call, bearer } = fixture(
      betterAuth({ allowedEmailDomains: ["openbot.test"] }),
    );

    expect((await call(bearer())).status).toBe(200);
  });

  test("a person with no role is forbidden", async () => {
    const { call, bearer, refusals } = fixture(
      betterAuth({ roles: { rolesForUser: async () => [] } }),
    );

    const response = await call(bearer());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Authorization required." });
    expect(refusals).toEqual([
      {
        reason: "forbidden",
        path: "/x",
        tokenDigest: digestOf(TOKEN),
        userId: owner.id,
      },
    ]);
  });

  test("the actor's name is the email when the user row's name is null or blank", async () => {
    const unnamed = { ...owner, id: "unnamed", name: null };
    const blank = {
      ...owner,
      id: "blank",
      email: "blank@openbot.test",
      name: "   ",
    };
    const { call, bearer } = fixture(betterAuth(), {
      users: [unnamed, blank],
      connections: {
        [TOKEN]: {
          connectionId: "connection-1",
          userId: unnamed.id,
          organizationSession: null,
        },
        [SECOND_TOKEN]: {
          connectionId: "connection-2",
          userId: blank.id,
          organizationSession: null,
        },
      },
    });

    expect((await (await call(bearer())).json()).name).toBe(unnamed.email);
    expect((await (await call(bearer(SECOND_TOKEN))).json()).name).toBe(
      blank.email,
    );
  });

  test("the resolver answers null when the request carries no recorder bearer", async () => {
    const { resolve } = fixture(betterAuth());

    expect(await resolve(new Request("http://openbot.test/x"))).toBeNull();
    expect(
      await resolve(
        new Request("http://openbot.test/x", {
          headers: { authorization: "Bearer someone-elses-token" },
        }),
      ),
    ).toBeNull();
  });

  test("the bearer pattern takes exactly a recorder token", () => {
    expect(RECORDER_BEARER.exec(`Bearer ${TOKEN}`)?.[1]).toBe(TOKEN);
    expect(RECORDER_BEARER.test(`Bearer ${TOKEN}x`)).toBe(false);
    expect(RECORDER_BEARER.test("Bearer obr_short")).toBe(false);
  });
});

describe("single-user mode", () => {
  const devUser: UserRow = {
    id: DEV_ACTOR.id,
    email: DEV_ACTOR.email,
    name: DEV_ACTOR.email,
    image: null,
  };

  test("admits a token whose person is the local person as DEV_ACTOR", async () => {
    const { call, bearer } = fixture(
      { kind: "single-user" },
      {
        users: [devUser],
        connections: {
          [TOKEN]: {
            connectionId: "connection-1",
            userId: DEV_ACTOR.id,
            organizationSession: null,
          },
        },
      },
    );

    const response = await call(bearer());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...DEV_ACTOR,
      name: DEV_ACTOR.email,
    });
  });

  test("refuses a token for any other person as unknown", async () => {
    const { call, bearer, refusals } = fixture({ kind: "single-user" });

    const response = await call(bearer());

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("revoked");
    expect(refusals).toEqual([
      {
        reason: "unknown",
        path: "/x",
        tokenDigest: digestOf(TOKEN),
        userId: owner.id,
      },
    ]);
  });
});

describe("organization mode", () => {
  function organization(
    answer: (cookie: string) => Promise<AuthenticatedActor | null>,
    verdicts?: OrganizationVerdictCache,
  ) {
    const asked: string[] = [];
    const unsealed: string[] = [];
    const mode: RecorderMode = {
      kind: "organization",
      session: async (cookie) => {
        asked.push(cookie);
        return answer(cookie);
      },
      unseal: async (value) => {
        unsealed.push(value);
        return value.replace("sealed-", "");
      },
    };
    const built = fixture(mode, {
      connections: {
        [TOKEN]: {
          connectionId: "connection-1",
          userId: owner.id,
          organizationSession: "sealed-session-one",
        },
        [SECOND_TOKEN]: {
          connectionId: "connection-2",
          userId: owner.id,
          organizationSession: "sealed-session-two",
        },
      },
      ...(verdicts ? { verdicts } : {}),
    });
    return { ...built, asked, unsealed };
  }

  const signedIn =
    (role: OpenBotRole = "user") =>
    async () => ({
      id: owner.id,
      email: owner.email,
      name: "Name At The Authority",
      role,
    });

  test("unseals the stored session and asks with the organization session cookie", async () => {
    const { call, bearer, asked, unsealed } = organization(signedIn("admin"));

    const response = await call(bearer());

    expect(response.status).toBe(200);
    expect(unsealed).toEqual(["sealed-session-one"]);
    expect(asked).toEqual(["openbot.organization-session=session-one"]);
    expect(await response.json()).toEqual({
      id: owner.id,
      email: owner.email,
      name: owner.name,
      image: owner.image,
      role: "admin",
    });
  });

  test("a session the organization no longer knows is signed out as organization", async () => {
    const { call, bearer, refusals } = organization(async () => null);

    const response = await call(bearer());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: ORGANIZATION_SENTENCE,
      code: "RECORDER_SIGNED_OUT",
      reason: "organization",
    });
    expect(refusals).toEqual([
      {
        reason: "organization",
        path: "/x",
        tokenDigest: digestOf(TOKEN),
        userId: owner.id,
      },
    ]);
  });

  test("a connection with no stored organization session is signed out as organization", async () => {
    const { call, bearer, connections, asked } = organization(signedIn());
    connections.set(TOKEN, {
      connectionId: "connection-1",
      userId: owner.id,
      organizationSession: null,
    });

    const response = await call(bearer());

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("organization");
    expect(asked).toEqual([]);
  });

  test("a session that belongs to somebody else is signed out as organization", async () => {
    const { call, bearer } = organization(async () => ({
      id: "somebody-else",
      email: "else@openbot.test",
      role: "admin",
    }));

    const response = await call(bearer());

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("organization");
  });

  test("an organization that cannot answer is a 503 the Recorder retries, never cached and never reported", async () => {
    let unavailable = true;
    const { call, bearer, refusals, asked } = organization(async () => {
      if (unavailable) throw new AuthorityUnavailable("down");
      return signedIn()();
    });

    const first = await call(bearer());

    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({
      error: "Your organization could not answer. Try again in a moment.",
      code: "RECORDER_AUTHORITY_UNAVAILABLE",
    });
    expect(refusals).toEqual([]);

    unavailable = false;
    const second = await call(bearer());

    expect(second.status).toBe(200);
    expect(asked).toHaveLength(2);
  });

  test("an error that is not the organization being unavailable is not hidden as one", async () => {
    const { call, bearer, refusals } = organization(async () => {
      throw new Error("materialize failed");
    });
    const original = console.error;
    console.error = () => {};
    try {
      const response = await call(bearer());

      expect(response.status).toBe(500);
      expect(refusals).toEqual([]);
    } finally {
      console.error = original;
    }
  });

  test("an actor is cached for 60 s per connection", async () => {
    const { call, bearer, asked, clock } = organization(signedIn());

    await call(bearer());
    clock.now += 59_000;
    expect((await call(bearer())).status).toBe(200);
    expect(asked).toHaveLength(1);

    await call(bearer(SECOND_TOKEN));
    expect(asked).toEqual([
      "openbot.organization-session=session-one",
      "openbot.organization-session=session-two",
    ]);

    clock.now += 2_000;
    expect((await call(bearer())).status).toBe(200);
    expect(asked).toHaveLength(3);
  });

  test("a refusal is cached for 60 s per connection", async () => {
    let signedOut = true;
    const { call, bearer, asked, clock } = organization(async () =>
      signedOut ? null : signedIn()(),
    );

    expect((await call(bearer())).status).toBe(401);
    signedOut = false;
    clock.now += 30_000;
    expect((await call(bearer())).status).toBe(401);
    expect(asked).toHaveLength(1);

    clock.now += 31_000;
    expect((await call(bearer())).status).toBe(200);
    expect(asked).toHaveLength(2);
  });

  test("a verdict past its 60 s is dropped when the next one is kept, so the cache does not grow", async () => {
    const verdicts: OrganizationVerdictCache = new Map();
    const { call, bearer, clock } = organization(signedIn(), verdicts);

    await call(bearer());
    expect([...verdicts.keys()]).toEqual(["connection-1"]);
    clock.now += 61_000;
    await call(bearer(SECOND_TOKEN));
    expect([...verdicts.keys()]).toEqual(["connection-2"]);

    // A verdict asked for again moves to the end, so the oldest stays first and the expired ones are a prefix.
    clock.now += 30_000;
    await call(bearer());
    expect([...verdicts.keys()]).toEqual(["connection-2", "connection-1"]);
    clock.now += 31_000;
    await call(bearer(SECOND_TOKEN));
    expect([...verdicts.keys()]).toEqual(["connection-1", "connection-2"]);
    clock.now += 61_000;
    await call(bearer());
    expect([...verdicts.keys()]).toEqual(["connection-1"]);
  });

  test("a revoked connection is refused at once, whatever the cache holds", async () => {
    const { call, bearer, connections, refusals } = organization(signedIn());

    expect((await call(bearer())).status).toBe(200);
    connections.delete(TOKEN);

    const response = await call(bearer());

    expect(response.status).toBe(401);
    expect(refusals.map((refusal) => refusal.reason)).toEqual(["unknown"]);
  });
});

describe("the refusal audit", () => {
  function audit() {
    const rows: AuditEventInput[] = [];
    const clock = { now: 5_000_000 };
    const sink = createRecorderRefusalAudit(
      {
        insert: async (event) => {
          rows.push(event);
        },
      },
      { now: () => clock.now },
    );
    return { rows, clock, sink };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const refusal = (overrides: Partial<Refusal> = {}): Refusal => ({
    reason: "unknown",
    path: "/api/recorder/me",
    tokenDigest: "0123456789abcdef",
    ...overrides,
  });

  test("two refusals for one token digest and reason within a minute write one row", async () => {
    const { rows, clock, sink } = audit();

    sink(refusal());
    clock.now += 30_000;
    sink(refusal());
    await settle();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "recorder.bearer_refused",
      targetId: "0123456789abcdef",
      payload: { reason: "unknown", path: "/api/recorder/me" },
    });
  });

  test("a different reason writes a second row", async () => {
    const { rows, sink } = audit();

    sink(refusal({ reason: "unknown" }));
    sink(refusal({ reason: "removed", userId: owner.id }));
    await settle();

    expect(rows.map((row) => row.payload.reason)).toEqual([
      "unknown",
      "removed",
    ]);
    expect(rows[1]?.actorUserId).toBe(owner.id);
  });

  test("another token digest writes its own row", async () => {
    const { rows, sink } = audit();

    sink(refusal());
    sink(refusal({ tokenDigest: "fedcba9876543210" }));
    await settle();

    expect(rows.map((row) => row.targetId)).toEqual([
      "0123456789abcdef",
      "fedcba9876543210",
    ]);
  });

  test("the same refusal writes again once its minute has passed", async () => {
    const { rows, clock, sink } = audit();

    sink(refusal());
    clock.now += 61_000;
    sink(refusal());
    await settle();

    expect(rows).toHaveLength(2);
  });

  test("a failed write is logged and never thrown at the request", async () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const sink = createRecorderRefusalAudit({
        insert: async () => {
          throw new Error("trail unavailable");
        },
      });

      expect(() => sink(refusal())).not.toThrow();
      await settle();

      expect(JSON.stringify(logged)).toContain("trail unavailable");
    } finally {
      console.error = original;
    }
  });

  test("with no audit store nothing is written and nothing throws", () => {
    const sink = createRecorderRefusalAudit(undefined);

    expect(() => sink(refusal())).not.toThrow();
  });
});
