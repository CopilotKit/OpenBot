// server/tests/arcade-authorize-route.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { APIConnectionError, APIError } from "@arcadeai/arcadejs";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { mcpServers, mcpTools, pendingAuthorizations } from "../src/db/schema";
import type { BrokerProvider } from "../src/plugins/access";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore, type PluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { removePeople, seedPeople } from "./support/people";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const personalApp = `arcade-p-${suite}`;
const sharedApp = `arcade-s-${suite}`;
const composioApp = `composio-p-${suite}`;
const SHARED_VENDOR_ID = `openbot-deployment:acme-${suite}:R`;
const ACTION = "Gmail.SendEmail";
const SECRET_URL = "https://vendor.example/consent?secret=bearer-capability";

let mints: { vendorUserId: string; action?: string; toolkit: string }[] = [];
let nextAuthId: string | null = "ar_minted_1";
// What the next mint does before answering; a test sets it to throw, or to hold the mint open.
let beforeMint: (() => Promise<void>) | null = null;

const arcadeBroker: ConnectedAppBroker = {
  grantIsLocal: false,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  authorizations: {
    status: async () => {
      throw new Error("nothing here polls an authorization");
    },
    confirmReturn: async () => {
      throw new Error("nothing here confirms a return leg");
    },
  },
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async ({ account, toolkit, action }) => {
    mints.push({ vendorUserId: account.vendorUserId, action, toolkit });
    await beforeMint?.();
    return { redirectUrl: SECRET_URL, authorizationId: nextAuthId };
  },
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const composioBroker: ConnectedAppBroker = {
  ...arcadeBroker,
  grantIsLocal: true,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  authorizations: null,
  authorize: async ({ account, toolkit, action }) => {
    mints.push({ vendorUserId: account.vendorUserId, action, toolkit });
    return { redirectUrl: SECRET_URL, authorizationId: null };
  },
};

function appAs(
  role: "admin" | "user",
  id: string,
  provider: BrokerProvider = "arcade",
  // What this app's store does differently. One test makes the local write after a SUCCESSFUL mint
  // fail, which is the only way to reach the route's record-after-the-fact branch.
  override: Partial<PluginStore> = {},
) {
  const broker = provider === "arcade" ? arcadeBroker : composioBroker;
  const store = createPluginStore({
    brokerProvider: provider,
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id, email: `${id}@example.test`, role } as never);
    await next();
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      { ...store, ...override },
      signedIn,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, provider },
    ),
  );
}

/**
 * An actor id for this suite, AND THE `users` ROW BEHIND IT.
 *
 * `pending_authorizations.actor_id` keys to `users` and cascades (`.user_id` must equal it), so the
 * attempt a mint writes cannot name somebody who does not exist.
 */
const actors: string[] = [];
const person = async (name: string) => {
  const id = `${name}-${suite}`;
  actors.push(id);
  await seedPeople(database, [id]);
  return id;
};

const authorize = (
  app: Hono,
  serverId: string,
  body: unknown = { action: ACTION },
) =>
  app.request(`/api/plugins/servers/${serverId}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * Every line the deployment wrote while `work` ran, each as the text it would have printed. The
 * arguments are joined rather than mapped through one `String()`, so an object logged beside a
 * string still shows up as `[object Object]`, which is the shape a leak hides in.
 */
async function heard<T>(work: () => T | Promise<T>): Promise<[T, string[]]> {
  const said: string[] = [];
  const before = globalThis.console;
  const hear = (...args: unknown[]) =>
    said.push(args.map((arg) => String(arg)).join(" "));
  globalThis.console = {
    ...before,
    log: hear,
    info: hear,
    warn: hear,
    error: hear,
    debug: hear,
  } as typeof console;
  try {
    return [await work(), said];
  } finally {
    globalThis.console = before;
  }
}

const attemptsFor = (actorId: string) =>
  database
    .select()
    .from(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, actorId));

beforeAll(async () => {
  await database.insert(mcpServers).values([
    {
      id: personalApp,
      title: "Gmail",
      vendor: "Arcade",
      url: `arcade://P${suite}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "personal",
    },
    {
      id: sharedApp,
      title: "Team Gmail",
      vendor: "Arcade",
      url: `arcade://S${suite}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "shared",
      sharedVendorUserId: SHARED_VENDOR_ID,
    },
    {
      id: composioApp,
      title: "Composio Gmail",
      vendor: "Composio",
      url: `composio://c${suite}`,
      provenance: "composio",
      authScheme: "OAUTH2",
    },
  ]);
  await database.insert(mcpTools).values(
    [personalApp, sharedApp, composioApp].map((serverId) => ({
      serverId,
      name: ACTION,
      vendorName: ACTION,
    })),
  );
});

afterAll(async () => {
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [personalApp, sharedApp, composioApp]));
  if (actors.length) {
    await database
      .delete(pendingAuthorizations)
      .where(inArray(pendingAuthorizations.actorId, actors));
  }
  await removePeople(database, actors);
  await database.$client.close();
});

beforeEach(() => {
  mints = [];
  nextAuthId = "ar_minted_1";
  beforeMint = null;
});

describe("POST /servers/:id/authorize", () => {
  test("mints for the named action and the row records the exact account and the authorization id", async () => {
    const actor = await person("mint");
    const response = await authorize(appAs("user", actor), personalApp);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorizationUrl: SECRET_URL });
    expect(mints).toEqual([
      { vendorUserId: actor, action: ACTION, toolkit: `P${suite}` },
    ]);
    const [row] = await attemptsFor(actor);
    expect(row).toMatchObject({
      actorId: actor,
      serverId: personalApp,
      action: ACTION,
      holder: "person",
      userId: actor,
      vendorUserId: actor,
      authId: "ar_minted_1",
      completedAt: null,
      outcome: null,
    });
    // created_at round-trips through a JS Date: the mint matched on it, and the stored value is
    // exactly millisecond-precise.
    const created = row?.createdAt as Date;
    expect(new Date(created.getTime()).getTime()).toBe(created.getTime());
    const [exact] = (await database.execute(
      sql`select (created_at = date_trunc('milliseconds', created_at)) as exact
          from pending_authorizations where actor_id = ${actor}`,
    )) as unknown as { exact: boolean }[];
    expect(exact?.exact).toBe(true);
  });

  test("a null authorization id is recorded as NULL, never collapsed", async () => {
    const actor = await person("nullid");
    nextAuthId = null;
    const response = await authorize(appAs("user", actor), personalApp);
    expect(response.status).toBe(200);
    const [row] = await attemptsFor(actor);
    expect(row?.authId).toBeNull();
    expect(row?.completedAt).toBeNull();
  });

  test("an action the app does not publish is a 400 with no attempt and no mint", async () => {
    const actor = await person("unpublished");
    const response = await authorize(appAs("user", actor), personalApp, {
      action: "Gmail.DeleteEverything",
    });
    expect(response.status).toBe(400);
    expect(mints).toEqual([]);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  test("a differently-cased action is not accepted", async () => {
    const actor = await person("cased");
    const response = await authorize(appAs("user", actor), personalApp, {
      action: ACTION.toLowerCase(),
    });
    expect(response.status).toBe(400);
    expect(mints).toEqual([]);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  test("a non-admin on a Shared app is a 403 with no attempt", async () => {
    const actor = await person("shared-user");
    const response = await authorize(appAs("user", actor), sharedApp);
    expect(response.status).toBe(403);
    expect(mints).toEqual([]);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  test("an admin on a Shared app records the deployment's account on the row", async () => {
    const actor = await person("shared-admin");
    const response = await authorize(appAs("admin", actor), sharedApp);
    expect(response.status).toBe(200);
    const [row] = await attemptsFor(actor);
    expect(row).toMatchObject({
      holder: "deployment",
      userId: null,
      vendorUserId: SHARED_VENDOR_ID,
      authId: "ar_minted_1",
    });
  });

  test("a second authorization while one is live is a 409 naming the first", async () => {
    const actor = await person("live");
    const app = appAs("user", actor);
    expect((await authorize(app, personalApp)).status).toBe(200);
    const [first] = await attemptsFor(actor);
    mints = [];
    const second = await authorize(app, personalApp);
    expect(second.status).toBe(409);
    expect(JSON.stringify(await second.json())).toContain(ACTION);
    expect(mints).toEqual([]);
    const [after] = await attemptsFor(actor);
    expect(after?.createdAt.getTime()).toBe(
      first?.createdAt.getTime() as number,
    );
    expect(after?.authId).toBe("ar_minted_1");
  });

  test("an authorization after the first expired succeeds, replacing it", async () => {
    const actor = await person("expired");
    const app = appAs("user", actor);
    expect((await authorize(app, personalApp)).status).toBe(200);
    await database.execute(
      sql`update pending_authorizations set created_at = created_at - interval '16 minutes' where actor_id = ${actor}`,
    );
    const [old] = await attemptsFor(actor);
    nextAuthId = "ar_minted_2";
    expect((await authorize(app, personalApp)).status).toBe(200);
    const rows = await attemptsFor(actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authId).toBe("ar_minted_2");
    expect(rows[0]?.createdAt.getTime()).toBeGreaterThan(
      old?.createdAt.getTime() as number,
    );
  });

  test("the authorization url appears in no audit row", async () => {
    const actor = await person("audit");
    expect((await authorize(appAs("user", actor), personalApp)).status).toBe(
      200,
    );
    const leaked = await database.execute(
      sql`select id from audit_events
          where payload::text like ${"%bearer-capability%"}
             or target_id like ${"%bearer-capability%"}`,
    );
    expect(leaked.length).toBe(0);
  });

  test("a deployment whose broker runs no authorization flow answers 503 and writes no attempt", async () => {
    const actor = await person("composio");
    const response = await authorize(
      appAs("user", actor, "composio"),
      composioApp,
    );
    expect(response.status).toBe(503);
    expect(mints).toEqual([]);
    expect(await attemptsFor(actor)).toEqual([]);
    expect(JSON.stringify(await response.json())).not.toContain(
      "vendor.example",
    );
  });

  test("the gate answers before whose account it is: a non-admin on a Shared app of such a deployment is a 503, not a 403", async () => {
    const actor = await person("composio-shared");
    const response = await authorize(
      appAs("user", actor, "composio"),
      sharedApp,
    );
    expect(response.status).toBe(503);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  describe("a mint that fails", () => {
    const refuse = async () => {
      throw new APIError(
        500,
        { name: "boom", message: "vendor-body-secret" },
        "500",
        new Headers(),
      );
    };

    test("a definite vendor refusal deletes the attempt, and a late cleanup can never delete a newer one", async () => {
      const actor = await person("definite");
      beforeMint = refuse;
      const response = await authorize(appAs("user", actor), personalApp);
      expect(response.status).toBe(502);
      expect(JSON.stringify(await response.json())).not.toContain(
        "vendor-body-secret",
      );
      expect(await attemptsFor(actor)).toEqual([]);

      // The actor starts again; the first attempt's cleanup then arrives late.
      beforeMint = null;
      nextAuthId = "ar_newer";
      expect((await authorize(appAs("user", actor), personalApp)).status).toBe(
        200,
      );
      const [newer] = await attemptsFor(actor);
      const store = createPluginStore({
        brokerProvider: "arcade",
        database,
        auditStore: createAuditStore(database),
        credentials: {} as never,
        encryptionKey: "x".repeat(44),
        policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
        broker: arcadeBroker,
        deploymentId: `acme-${suite}`,
      });
      const staleCreatedAt = new Date(
        (newer?.createdAt.getTime() as number) - 5,
      );
      expect(
        await store.discardAuthorizationAttempt({
          actorId: actor,
          createdAt: staleCreatedAt,
        }),
      ).toBe(false);
      const [survivor] = await attemptsFor(actor);
      expect(survivor).toMatchObject({
        authId: "ar_newer",
        completedAt: null,
        outcome: null,
      });
      expect(survivor?.createdAt.getTime()).toBe(newer?.createdAt.getTime());
    });

    test("a definite refusal whose clean-up also fails still answers the refusal, not a bodyless 500", async () => {
      const actor = await person("definite-stuck");
      beforeMint = refuse;
      const response = await authorize(
        appAs("user", actor, "arcade", {
          discardAuthorizationAttempt: async () => {
            throw new Error("Failed query: delete from pending_authorizations");
          },
        }),
        personalApp,
      );
      // The refusal the handler worked out, not the generic 500 a thrown clean-up produces.
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      expect(JSON.stringify(body)).not.toContain("vendor-body-secret");
      expect(JSON.stringify(body)).not.toContain("Failed query");
      // Nothing cleared it, so the row stands and expires on its own.
      const [row] = await attemptsFor(actor);
      expect(row).toMatchObject({ authId: null, completedAt: null });
    });

    test("an authored refusal is definite: nothing reached the vendor, so the attempt is deleted", async () => {
      const actor = await person("authored");
      const { BrokerRefusalError } = await import("../src/plugins/broker");
      beforeMint = async () => {
        throw new BrokerRefusalError("Arcade needs an action.");
      };
      const response = await authorize(appAs("user", actor), personalApp);
      expect(response.status).toBe(503);
      expect(await attemptsFor(actor)).toEqual([]);
    });

    test("an uncertain failure (status undefined) leaves the attempt standing with a null auth_id", async () => {
      const actor = await person("uncertain");
      beforeMint = async () => {
        throw new APIConnectionError({ message: "socket dropped" });
      };
      const response = await authorize(appAs("user", actor), personalApp);
      expect(response.status).toBe(502);
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain("bearer-capability");
      const rows = await attemptsFor(actor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        authId: null,
        completedAt: null,
        outcome: null,
      });
      const created = rows[0]?.createdAt as Date;
      expect(new Date(created.getTime()).getTime()).toBe(created.getTime());
      // ...and it still holds the actor: a second start is a 409, not a second flow.
      beforeMint = null;
      expect((await authorize(appAs("user", actor), personalApp)).status).toBe(
        409,
      );
    });

    /*
     * L4-a: THE UNCERTAIN BRANCH LEAVES THE CLAIM STANDING, AND IT USED TO LEAVE NOTHING ELSE.
     *
     * The outcome assertions here already passed before the fix: the row stands with a NULL
     * `auth_id` and holds the actor. What was missing is the trace. A flow the vendor may have
     * started went unrecorded everywhere, so nobody who could end it at the vendor could find it.
     */
    test("an uncertain mint leaves the claim standing AND leaves an operator a line naming it", async () => {
      const actor = await person("uncertain-line");
      beforeMint = async () => {
        throw new APIConnectionError({ message: "socket dropped" });
      };
      const [response, said] = await heard(() =>
        authorize(appAs("user", actor), personalApp),
      );
      expect(response.status).toBe(502);

      // NOT ENDED ON A GUESS: the claim stands, with no id, holding the actor.
      const [row] = await attemptsFor(actor);
      expect(row).toMatchObject({
        authId: null,
        completedAt: null,
        outcome: null,
      });

      // AND SAID OUT LOUD, with what an operator needs to find the attempt and the flow.
      const line = said.find((text) =>
        text.includes("arcade-mint-outcome-unknown"),
      );
      expect(line).toBeDefined();
      const logged = JSON.parse(line ?? "{}") as Record<string, unknown>;
      expect(logged.server).toBe(personalApp);
      expect(logged.action).toBe(ACTION);
      expect(logged.attemptStartedAt).toBe(row?.createdAt.toISOString());
      expect(logged.error).toBe("socket dropped");
      // Nothing that is not ours: no bearer url, no vendor user id, no authorization id field.
      expect(line).not.toContain("bearer-capability");
      expect(line).not.toContain(actor);
      expect(Object.keys(logged)).not.toContain("authorizationId");

      /*
       * L4a-b: AND THE SENTENCE THE PERSON GETS NAMES ONLY STEPS THIS BRANCH CAN DELIVER.
       *
       * It used to end "finish it if you were sent to a consent screen", while the line asserted
       * just above says of the same branch that nobody was sent to one — and the line is the one
       * that is true, because reaching here means the mint never answered a url. Somebody acting on
       * the old sentence searched their tabs for a consent screen that was never opened.
       *
       * ASSERTED AS THE ABSENCE OF THE INSTRUCTION, not as the presence of a replacement: the words
       * may be reworded, and what must not come back is a step nobody can take. The bounded wait is
       * checked too, because it is the one thing here that IS actionable.
       */
      const { error: said502 } = (await response.json()) as { error: string };
      expect(said502).not.toContain("consent screen, before starting another");
      expect(said502).toContain("nobody was sent to a consent screen");
      expect(said502).toContain("expires within fifteen minutes");
    });

    test("the missing-id mint is uncertain and leaves the same line, carrying the adapter's sentence", async () => {
      const actor = await person("noid-line");
      beforeMint = async () => {
        throw new Error("Arcade answered an authorization with no id.");
      };
      const [response, said] = await heard(() =>
        authorize(appAs("user", actor), personalApp),
      );
      expect(response.status).toBe(502);
      const line = said.find((text) =>
        text.includes("arcade-mint-outcome-unknown"),
      );
      expect(line).toBeDefined();
      expect(line).toContain("Arcade answered an authorization with no id.");
      expect(line).not.toContain("bearer-capability");
    });

    test("a definite refusal is not an unknown outcome, so it leaves no such line", async () => {
      const actor = await person("definite-no-line");
      beforeMint = refuse;
      const [response, said] = await heard(() =>
        authorize(appAs("user", actor), personalApp),
      );
      expect(response.status).toBe(502);
      expect(await attemptsFor(actor)).toEqual([]);
      expect(
        said.filter((text) => text.includes("arcade-mint-outcome-unknown")),
      ).toEqual([]);
    });

    test("a non-SDK throw (the adapter's missing-id Error) is uncertain too: the attempt stands", async () => {
      const actor = await person("noid");
      beforeMint = async () => {
        throw new Error("Arcade answered an authorization with no id.");
      };
      const response = await authorize(appAs("user", actor), personalApp);
      expect(response.status).toBe(502);
      const [row] = await attemptsFor(actor);
      expect(row).toMatchObject({
        authId: null,
        completedAt: null,
        outcome: null,
      });
    });
  });

  describe("a mint that succeeded and could not be recorded", () => {
    // The local UPDATE after the vendor said yes. `DrizzleQueryError`'s own message is the
    // statement and its bound values, which is the shape this route must not pass on.
    const failWrite = {
      recordAuthorizationMint: async () => {
        throw new Error(
          'Failed query: update "pending_authorizations" set "auth_id" = $1 -- params: ["ar_minted_1"]',
        );
      },
    } as Partial<PluginStore>;

    test("the person is told, is not sent to the consent screen, and the url does not travel", async () => {
      const actor = await person("unrecorded");
      const response = await authorize(
        appAs("user", actor, "arcade", failWrite),
        personalApp,
      );
      // Not a bodyless 500: a sentence, and nothing of the vendor's answer in it.
      expect(response.status).toBe(500);
      const body = (await response.json()) as {
        error?: string;
        authorizationUrl?: string;
      };
      expect(typeof body.error).toBe("string");
      expect(body.authorizationUrl).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("bearer-capability");
      expect(JSON.stringify(body)).not.toContain("Failed query");
      // The mint really did happen at the vendor.
      expect(mints).toHaveLength(1);
    });

    test("the actor is not blocked: the dead attempt is cleared and a second start mints again", async () => {
      const actor = await person("unrecorded-retry");
      expect(
        (
          await authorize(
            appAs("user", actor, "arcade", failWrite),
            personalApp,
          )
        ).status,
      ).toBe(500);
      // A row holding a null auth_id can never complete and would hold the actor for the TTL.
      expect(await attemptsFor(actor)).toEqual([]);
      mints = [];
      nextAuthId = "ar_after_retry";
      const second = await authorize(appAs("user", actor), personalApp);
      expect(second.status).toBe(200);
      expect(mints).toHaveLength(1);
      const [row] = await attemptsFor(actor);
      expect(row).toMatchObject({ authId: "ar_after_retry", outcome: null });
    });

    test("a failed clean-up still answers a sentence rather than throwing past the handler", async () => {
      const actor = await person("unrecorded-stuck");
      const response = await authorize(
        appAs("user", actor, "arcade", {
          ...failWrite,
          discardAuthorizationAttempt: async () => {
            throw new Error("Failed query: delete from pending_authorizations");
          },
        }),
        personalApp,
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      expect(JSON.stringify(body)).not.toContain("Failed query");
      // Nothing cleared it, so the row stands and expires on its own.
      const [row] = await attemptsFor(actor);
      expect(row).toMatchObject({ authId: null, completedAt: null });
    });
  });

  test("two concurrent starts by one actor yield exactly one 200 and one 409", async () => {
    const actor = await person("race");
    // Hold the winner's mint open so the loser's claim runs while it is in flight.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeMint = () => held;
    const app = appAs("user", actor);
    const first = authorize(app, personalApp);
    const second = authorize(app, personalApp);
    const settled = Promise.all([first, second]);
    setTimeout(release, 150);
    const responses = await settled;
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mints).toHaveLength(1);
    const rows = await attemptsFor(actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      authId: "ar_minted_1",
      completedAt: null,
      outcome: null,
    });
  });

  test("a Shared app is authorized under the SESSION SUBJECT, not the deployment's credential account", async () => {
    const actor = await person("team-bot");
    expect((await authorize(appAs("admin", actor), sharedApp)).status).toBe(
      200,
    );
    const rows = await attemptsFor(actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: actor,
      holder: "deployment",
      vendorUserId: SHARED_VENDOR_ID,
      completedAt: null,
      outcome: null,
    });
    expect(rows[0]?.actorId).not.toBe(SHARED_VENDOR_ID);
    const stray = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, SHARED_VENDOR_ID));
    expect(stray).toEqual([]);
  });

  describe("a mint that the store declines to record", () => {
    const cancel = (app: Hono, serverId: string) =>
      app.request(`/api/plugins/servers/${serverId}/authorize`, {
        method: "DELETE",
      });

    /*
     * B5d. The mint is held open at the vendor, the person cancels, and only then does the vendor
     * answer. `recordAuthorizationMint` finds no attempt under `(actor_id, created_at)` and writes
     * nothing. The consent url the vendor answered is a bearer capability for a flow that this
     * deployment no longer has any record of, so it must not be handed out.
     */
    test("a cancel that lands while the mint is in flight: no consent url, no attempt, a 409 that says why", async () => {
      const actor = await person("cancel-mid-mint");
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => {};
      const minting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      beforeMint = () => {
        entered();
        return held;
      };
      const app = appAs("user", actor);
      const started = authorize(app, personalApp);
      await minting;
      // The attempt is standing with no auth_id while the vendor has not answered yet.
      expect(await attemptsFor(actor)).toMatchObject([{ authId: null }]);
      const cancelled = await cancel(app, personalApp);
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toEqual({ cancelled: true });
      release();
      const response = await started;
      const text = await response.text();
      // The vendor did mint, and nothing stands behind it here.
      expect(mints).toHaveLength(1);
      expect(await attemptsFor(actor)).toEqual([]);
      expect(text).not.toContain("bearer-capability");
      expect(text).not.toContain("ar_minted_1");
      expect(response.status).toBe(409);
      const body = JSON.parse(text) as {
        error?: string;
        authorizationUrl?: string;
      };
      expect(body.authorizationUrl).toBeUndefined();
      expect(body.error).toContain("cancelled");
      // Nothing holds the actor: starting over mints again and binds the new attempt.
      beforeMint = null;
      mints = [];
      nextAuthId = "ar_after_cancel";
      const again = await authorize(app, personalApp);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ authorizationUrl: SECRET_URL });
      expect(await attemptsFor(actor)).toMatchObject([
        { authId: "ar_after_cancel", completedAt: null },
      ]);
    });

    test("whatever the reason the write declined, the consent url is not handed out", async () => {
      const actor = await person("mint-declined");
      const response = await authorize(
        appAs("user", actor, "arcade", {
          recordAuthorizationMint: async () => false,
        }),
        personalApp,
      );
      const text = await response.text();
      expect(mints).toHaveLength(1);
      expect(text).not.toContain("bearer-capability");
      expect(text).not.toContain("ar_minted_1");
      expect(response.status).toBe(409);
      expect(
        (JSON.parse(text) as { authorizationUrl?: string }).authorizationUrl,
      ).toBeUndefined();
    });
  });
});
