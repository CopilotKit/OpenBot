// server/tests/arcade-verify.test.ts
/**
 * The verifier: a browser coming back from a brokered per-action consent, refused or completed.
 *
 * ALMOST EVERY ASSERTION HERE IS "NOTHING WAS WRITTEN", which is the shape where a broken
 * implementation looks exactly like a passing one. So no case infers that from a status code:
 * each one QUERIES `brokered_connections` for a row belonging to this suite's app, and
 * `audit_events` for the `mcp.account_connected` entry the completion transaction files, and
 * requires both to be empty. The app name is suite-scoped, so a count of zero is a fact about this
 * run.
 *
 * NOR DOES ANY CASE INFER A REFUSAL FROM "IT REDIRECTED". Every exit from this route answers a
 * `Location` — the criterion `/oauth/callback` already holds itself to — so a test that checked the
 * 303 alone would pass for every refusal including the wrong one. Each refusal names the reason code
 * its `?authorized=` parameter has to carry, one for one, and the codes are asserted once AS A SET
 * so a new one cannot appear without this file going red.
 *
 * AND IT DRIVES THROUGH `createApp`, NOT THROUGH `createPluginRoutes`. A route that is built but
 * never mounted answers 404 in production while its own factory test passes — the failure every
 * Shared-app surface had before `shared-wiring.integration.test.ts` was written.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getCookies } from "better-auth/cookies";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { createAuth } from "../src/auth/index";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  brokeredConnections,
  mcpServers,
  pendingAuthorizations,
} from "../src/db/schema";
import type { BrokerProvider } from "../src/plugins/access";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { AUTHORIZATION_REFUSALS } from "../src/plugins/routes";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";
import { removePeople, seedPeople } from "./support/people";

/*
 * SIX CONNECTIONS RATHER THAN THE SHARED `TEST_POOL` OF TWO, because the race below drives two
 * completion TRANSACTIONS at once through two whole apps, and the second blocks on the first's row
 * lock while holding its own connection. `support/database.ts` says a file wanting a different pool
 * asks for one itself.
 */
const database = createDatabase(testDatabaseUrl(), { max: 6 });
const suite = randomUUID().slice(0, 8);
const APP = `arcade-verify-${suite}`;
/**
 * ONE APP PER TEST, because `audit_events` is APPEND-ONLY and cannot be cleaned between them. A
 * fixed name would let a completion's event be counted by the next case's "nothing was written",
 * which is the exact assertion this suite is built on. The app is keyed on its toolkit, so a fresh
 * toolkit per test is a fresh everything.
 */
let TOOLKIT = "";
let apps = 0;
const ACTOR = `verifier-${suite}`;
const STRANGER = `stranger-${suite}`;
const SHARED_IDENTITY = `shared-${suite}`;
const ACTION = "Gmail.ListEmails";
const MINTED = "ar_minted_for_this_attempt";
const APP_URL = "https://app.example";
/** A stand-in for the live `gho_…` the vendor's own status reply carries beside the three fields. */
const TOKEN = `gho_live_access_token_${suite}`;
/** The profile address the same reply carries, which is no more the route's to repeat. */
const EMAIL = "person@example.test";

/** Every call this suite lets reach the seam. A refusal that spends one is a refusal too late. */
let confirmCalls: { handle: string; vendorUserId: string }[] = [];
let statusCalls: string[] = [];
let revokeCalls: { account: AccountRef; toolkit: string }[] = [];
/** What the next `confirmReturn` answers, or throws. Set per test. */
let confirmAnswer: () => Promise<
  { authorizationId: string } | { mismatch: true }
> = async () => ({ authorizationId: MINTED });
/**
 * What the next status read answers. DELIBERATELY WIDER THAN THE SEAM in one case below: the
 * vendor's real reply carries a live access token and a full profile, and the point of that case is
 * that nothing this route touches can carry either anywhere.
 */
let statusAnswer: () => Promise<{
  status: string;
  userId: string | null;
  scopes: string[];
}> = async () => ({
  status: "completed",
  userId: ACTOR,
  scopes: ["gmail.read"],
});
let revokeAnswer: () => Promise<boolean> = async () => true;
/**
 * What auth provider the app's connections are held under. NEVER THE TOOLKIT NAME: the two coincide
 * only where an operator named their provider configuration after the app, so a route deriving one
 * from the other would pass here and be wrong where it shipped.
 */
let authProviderAnswer: (toolkit: string) => Promise<string | null> =
  async () => "google";

/**
 * A broker that DECLARES the correlated authorization flow, which is the only thing this route's
 * gate reads. Every member is declared because the seam requires a broker to SAY what it runs; see
 * `ConnectedAppBroker.authorizations` and `.grantIsLocal`.
 */
const broker: ConnectedAppBroker = {
  grantIsLocal: false,
  /*
   * PER TOOLKIT, because which apps share one connection is the question `(identity, auth
   * provider)` answers and a stub that gave every app the same provider could not pose it: an app
   * on ANOTHER provider, held by the same identity and not ended by this revoke, is the control
   * for the sibling cases below.
   */
  /*
   * NOT `async`, so a case below can make this throw SYNCHRONOUSLY — the shape a broker method
   * that validates its argument before it returns a promise has. Every other case hands back a
   * promise exactly as before.
   */
  authProviderOf: (toolkit) => authProviderAnswer(toolkit),
  authorizations: {
    status: async (id) => {
      statusCalls.push(id);
      return statusAnswer();
    },
    confirmReturn: async (query) => {
      confirmCalls.push(query);
      return confirmAnswer();
    },
  },
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent?secret=bearer-capability",
    authorizationId: MINTED,
  }),
  isConnected: async () => true,
  revoke: async (request) => {
    revokeCalls.push(request);
    return revokeAnswer();
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => null,
};

/**
 * The deployment as `createApp` builds it, with a session for `who` or none at all.
 *
 * Positional, by index rather than by a run of `undefined`s, for the reason
 * `shared-wiring.integration.test.ts` gives: a parameter added in the middle then moves a type error
 * onto the wrong index here rather than shifting an argument silently.
 */
function build(
  who: string | null,
  options: {
    roles?: string[];
    brokerBag?:
      | { broker: ConnectedAppBroker; provider: BrokerProvider }
      | undefined;
    /** A handle whose behaviour one case alters; everything else runs on the suite's own. */
    database?: typeof database;
    /**
     * Makes the ONE store read that happens before the completion throw. Not a broken `database`
     * handle, because that read is a plain `select` the rest of the deployment's boot shares — the
     * case is about this route's own call, so this replaces exactly that method.
     */
    attemptReadThrows?: boolean;
    /** Makes the guard's ROLE read throw, which is a store read outside the handler's own code. */
    roleReadThrows?: boolean;
    /**
     * Hands the route an attempt row whose `(holder, user_id)` pair the TABLE would refuse.
     *
     * Injected at the store rather than inserted, because `pending_authorizations_holder_check`
     * holds that pair in the database and these combinations cannot be written at all — which is
     * the point. The route reads the pair out of a row and aims a REVOCATION with it, so what it
     * does with a pair it should never see is a fact about the route and not about the table, and
     * the only way to ask is to put the row in its hand.
     */
    attemptAs?: { holder?: string; userId?: string | null };
    /**
     * What the COMPLETION does, and the two values are not the same failure.
     *
     * `rolls-back` throws instead of writing — the transaction never ran, so nothing exists.
     * `commits-then-throws` runs the real transaction to completion and THEN rejects, which is a
     * connection lost on the way back from a COMMIT the server already applied: the grant is
     * written down and the caller is told only that something failed. The route may not answer
     * those two the same way, and no broken `database` handle can pose the second — a handle that
     * breaks the transaction rolls it back, which is the first.
     */
    completion?: "rolls-back" | "commits-then-throws";
    /** Makes the read of how an attempt ended throw, which a completion that claimed nothing asks. */
    completedProbeThrows?: boolean;
  } = {},
) {
  const handle = options.database ?? database;
  const auditStore = createAuditStore(handle);
  const pluginStore = createPluginStore({
    brokerProvider: "arcade",
    database: handle,
    auditStore,
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = loadConfig(testEnvironment({ OPENBOT_APP_URL: APP_URL }));
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () =>
        who === null
          ? null
          : { user: { id: who, email: `${who}@example.test`, name: "Person" } },
    },
  } as never;
  args[2] = {
    rolesForUser: async () => {
      if (options.roleReadThrows) throw new Error("injected role read failure");
      return options.roles ?? ["user"];
    },
  } as never;
  args[12] = auditStore;
  args[14] = options.attemptReadThrows
    ? {
        ...pluginStore,
        authorizationAttemptFor: async () => {
          throw new Error("injected attempt read failure");
        },
      }
    : options.attemptAs
      ? {
          ...pluginStore,
          authorizationAttemptFor: async (actorId: string) => {
            const row = await pluginStore.authorizationAttemptFor(actorId);
            return row === null
              ? null
              : ({ ...row, ...options.attemptAs } as typeof row);
          },
        }
      : options.completedProbeThrows
        ? {
            ...pluginStore,
            authorizationAttemptCompleted: async () => {
              throw new Error("injected probe failure");
            },
          }
        : options.completion
          ? {
              ...pluginStore,
              completeAuthorizationAttempt: async (
                input: Parameters<
                  typeof pluginStore.completeAuthorizationAttempt
                >[0],
              ) => {
                if (options.completion === "commits-then-throws") {
                  await pluginStore.completeAuthorizationAttempt(input);
                }
                throw completionFailure();
              },
            }
          : pluginStore;
  args[29] =
    "brokerBag" in options ? options.brokerBag : { broker, provider: "arcade" };
  return createApp(...args);
}

function verify(
  who: string | null,
  query: string,
  options?: Parameters<typeof build>[1],
) {
  return build(who, options).request(
    `http://openbot.test/api/plugins/arcade/verify${query}`,
  );
}

/** Where a refusal lands: the LIST, with the reason as an opaque code and no sentence. */
const refusedTo = (reason: string) =>
  `${APP_URL}/connections?authorized=${reason}`;

/** Where a completion lands: the app's own page, built from the attempt row's `server_id`. */
const LANDING = `${APP_URL}/connections/${APP}?action=${encodeURIComponent(ACTION)}`;

/**
 * A refusal, named by its code and not merely by the fact that something redirected.
 *
 * The transport is the same for all of them, so a check that stopped at the 303 would pass for
 * every one including whichever one is wrong. The code is the whole of the discrimination the
 * status codes used to carry — and `?connected=`, which belongs to the Composio callback, is never
 * along for the ride.
 */
async function expectRefusal(response: Response, reason: string) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(refusedTo(reason));
  expect(response.headers.get("location")).not.toContain("connected=");
}

/** What the completion transaction would have left behind. Queried, never inferred from a status. */
async function written() {
  const connections = await database
    .select()
    .from(brokeredConnections)
    .where(eq(brokeredConnections.app, TOOLKIT));
  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetId, TOOLKIT),
        eq(auditEvents.eventType, "mcp.account_connected"),
      ),
    );
  return { connections, events };
}

async function expectNothingWritten() {
  const { connections, events } = await written();
  expect({
    connections: connections.length,
    successEvents: events.length,
  }).toEqual({ connections: 0, successEvents: 0 });
}

/**
 * EVERY STRING A VALUE CARRIES, however deeply it is buried, and not `String(value)`.
 *
 * A console argument is not a string, an audit row is not a string, and a response is not a string.
 * `String({ token })` is `"[object Object]"`, so a confinement check that flattened each argument
 * that way would read a leaked credential as six harmless characters — and the vendor status reply
 * the D31 case feeds through carries its token inside `context: { token }`, which is exactly the
 * shape that flattening hides. `JSON.stringify` is better but still blind to a `Map`, a `Set`, an
 * `Error`'s message, a key that IS the secret, and anything that renders itself through its own
 * `toString`. So the value is WALKED: array and set members, map keys and values, own property
 * names and their values, an error's message, name, stack and cause, and the rendering of any
 * object that renders as something other than its default tag.
 */
function harvest(value: unknown, into: string[], seen: Set<object>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (typeof value !== "object" && typeof value !== "function") {
    into.push(String(value));
    return;
  }
  const object = value as object;
  if (seen.has(object)) return;
  seen.add(object);
  // Anything with a `toString` of its own: an Error, a URL, a Buffer, a class that renders itself.
  try {
    const rendered = String(object);
    if (rendered !== Object.prototype.toString.call(object))
      into.push(rendered);
  } catch {
    // A value that refuses to render still has its properties walked below.
  }
  if (value instanceof Error) {
    into.push(value.name, value.message, value.stack ?? "");
    harvest((value as { cause?: unknown }).cause, into, seen);
  }
  if (Array.isArray(value) || value instanceof Set) {
    for (const item of value) harvest(item, into, seen);
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      harvest(key, into, seen);
      harvest(item, into, seen);
    }
  }
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key === "string") into.push(key);
    try {
      harvest((object as Record<PropertyKey, unknown>)[key], into, seen);
    } catch {
      // A throwing getter hides nothing the other properties do not already show.
    }
  }
}

/**
 * Where a secret shows up inside a value, as the strings that carry it — EMPTY when it is confined.
 * Returned rather than asserted so a failure names the leaking string instead of saying `false`.
 */
function mentionsOf(value: unknown, secret: string): string[] {
  const found: string[] = [];
  harvest(value, found, new Set());
  return found.filter((text) => text.includes(secret));
}

/** A whole answer as the browser would receive it: every header, and the body, never one field. */
async function asDelivered(response: Response) {
  const copy = response.clone();
  return { headers: [...copy.headers], body: await copy.text() };
}

/** The attempt row itself, which is what every "nothing was written" case is really about. */
async function attemptRow(actorId = ACTOR) {
  const [row] = await database
    .select()
    .from(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, actorId));
  return row ?? null;
}

/**
 * One live attempt for `ACTOR`, written directly so its age and its `auth_id` are the test's to
 * choose. `createdAt` is a JS `Date`, which carries only milliseconds — the same precision
 * `claimAuthorizationAttempt` truncates the column to — so a value read back out compares exactly.
 */
async function giveAttempt(options: {
  authId: string | null;
  ageMinutes: number;
}) {
  const createdAt = new Date(
    Math.floor(Date.now() / 1000) * 1000 - options.ageMinutes * 60_000,
  );
  await database.insert(pendingAuthorizations).values({
    actorId: ACTOR,
    serverId: APP,
    action: ACTION,
    holder: "person",
    userId: ACTOR,
    vendorUserId: ACTOR,
    authId: options.authId,
    createdAt,
  });
  return createdAt;
}

beforeEach(async () => {
  /*
   * The people the attempts below belong to. `pending_authorizations.actor_id` and `.user_id` key
   * to `users` and cascade, so `giveAttempt` cannot write a row for somebody who does not exist.
   * Seeded per case rather than once, because a case that deletes the person to watch the cascade
   * would otherwise leave the rest of the file without one.
   */
  await seedPeople(database, [ACTOR, STRANGER]);
  confirmCalls = [];
  statusCalls = [];
  revokeCalls = [];
  confirmAnswer = async () => ({ authorizationId: MINTED });
  statusAnswer = async () => ({
    status: "completed",
    userId: ACTOR,
    scopes: ["gmail.read"],
  });
  revokeAnswer = async () => true;
  authProviderAnswer = async () => "google";
  apps += 1;
  TOOLKIT = `Gmail-${suite}-${apps}`;
  await database
    .delete(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, ACTOR));
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await database.insert(mcpServers).values({
    id: APP,
    title: "Gmail",
    vendor: "Arcade",
    url: `arcade://${TOOLKIT}`,
    provenance: "arcade",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
});

afterAll(async () => {
  await database
    .delete(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, ACTOR));
  await database
    .delete(brokeredConnections)
    .where(like(brokeredConnections.app, `Gmail-${suite}-%`));
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await removePeople(database, [ACTOR, STRANGER]);
  await database.$client.close();
});

/**
 * THE CLOSED SET, ASSERTED ONCE AND AS A SET.
 *
 * Each refusal below names one of these, so the list and the cases hold each other up: a code added
 * to the route without a case here fails this, and a case naming a code the route cannot send fails
 * its own `Location`.
 */
test("the reasons the verifier can refuse with are a closed set", () => {
  expect([...AUTHORIZATION_REFUSALS]).toEqual([
    "no-broker",
    "not-supported",
    "missing-handle",
    "no-attempt",
    "vendor-unavailable",
    "not-your-authorization",
    "not-finished",
    "authorization-failed",
    "context-changed",
    "not-permitted",
    "cancelled",
    "cancelled-left-live",
    "not-recorded",
  ]);
});

describe("a return leg this deployment will not complete", () => {
  test("an empty flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(await verify(ACTOR, "?flow_id="), "missing-handle");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("a missing flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(await verify(ACTOR, ""), "missing-handle");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("a whitespace-only flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(ACTOR, "?flow_id=%20%20%09"),
      "missing-handle",
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("no attempt at all is refused", async () => {
    await expectRefusal(await verify(ACTOR, "?flow_id=flow-abc"), "no-attempt");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("an attempt past the fifteen-minute TTL is refused", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 20 });
    await expectRefusal(await verify(ACTOR, "?flow_id=flow-abc"), "no-attempt");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("an attempt whose mint never answered an id is refused", async () => {
    await giveAttempt({ authId: null, ageMinutes: 1 });
    await expectRefusal(await verify(ACTOR, "?flow_id=flow-abc"), "no-attempt");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  /**
   * THE LATE CALLBACK. The vendor confirms, honestly, an authorization that is not the one this
   * deployment is holding — the read attempt that expired arriving behind the send attempt that
   * replaced it. The replacement must be left EXACTLY as it was, so the row itself is read back
   * rather than the answer being trusted to imply it.
   */
  test("a confirmation naming a different attempt refuses and leaves the row untouched", async () => {
    const createdAt = await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    confirmAnswer = async () => ({ authorizationId: "ar_some_other_attempt" });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "not-your-authorization",
    );
    expect(confirmCalls).toEqual([{ handle: "flow-abc", vendorUserId: ACTOR }]);
    expect(statusCalls).toEqual([]);

    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    expect(row?.authId).toBe(MINTED);
    expect(row?.createdAt.getTime()).toBe(createdAt.getTime());
    await expectNothingWritten();
  });

  /**
   * The vendor saying the handle is somebody else's. MOCKED-ONLY: the SDK declares no error shape
   * for this, so the adapter's detection is an assumption until a live probe runs. A passing test
   * here is not proof the path works — what it pins is that the route refuses cleanly and writes
   * nothing when the seam DOES answer this way.
   */
  test("a handle the vendor says is somebody else's refuses", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    confirmAnswer = async () => ({ mismatch: true });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "not-your-authorization",
    );

    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });

  /**
   * Somebody else's browser, or the same person signed in as somebody else. The attempt is keyed on
   * the signed-in person and is never found from the handle, so there is nothing to correlate to.
   */
  test("coming back signed in as a different person refuses", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(STRANGER, "?flow_id=flow-abc"),
      "no-attempt",
    );
    expect(confirmCalls).toEqual([]);

    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });

  /**
   * THE VENDOR NOT ANSWERING THE CONFIRMATION AT ALL. Nothing of its reply travels with the
   * refusal — not its sentence, not its body, not the error — because a reply on this leg can carry
   * an authorization url, which is a bearer capability.
   */
  test("a vendor that will not answer the confirmation refuses and writes nothing", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    confirmAnswer = async () => {
      throw new Error("vendor down: https://vendor.example/consent?secret=x");
    };

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc"),
    );
    await expectRefusal(response, "vendor-unavailable");
    expect(response.headers.get("location")).not.toContain("vendor.example");

    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    await expectNothingWritten();

    /*
     * AND AN OPERATOR IS LEFT A LINE. This refusal and the status one share a sentence at the
     * browser, so without this the two are indistinguishable in the only place anybody could tell
     * them apart — and they are not equally serious. This one ran before the confirmation, so no
     * completed consent is implied by reaching it, and the line says so.
     */
    const line = lines(said).find((text) =>
      text.includes("arcade-return-confirmation-unknown"),
    );
    expect(line).toBeDefined();
    expect(line).toContain(`"authorizationId":"${MINTED}"`);
    // The vendor's own words stay out of it, exactly as they stay out of the redirect above.
    expect(line).not.toContain("vendor.example");
  });
});

describe("a return leg with no session", () => {
  /**
   * NOT 401 JSON. The caller is a person's browser on a top-level navigation with a just-completed
   * consent behind it, and the handle has to survive the trip so signing back in as the same person
   * can resume.
   */
  test("is sent to sign-in with its flow_id, not answered with an error object", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(null, "?flow_id=flow%2Fabc");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${APP_URL}/sign?flow_id=flow%2Fabc`,
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });
});

describe("a return leg with a session whose role was removed", () => {
  /**
   * THE ONE EXIT WITH NO `Location`, AND IT IS STATED RATHER THAN INHERITED. The guard that refused
   * here is the guard `/api/me` answers from, so this session cannot reliably load the landing page
   * either: it would be sent to `/sign` or into an error boundary, which is the dead end this
   * branch exists to avoid.
   */
  test("is told so with a 403, not sent to a sign-in that cannot help", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(ACTOR, "?flow_id=flow-abc", { roles: [] });
    expect(response.status).not.toBe(303);
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toHaveProperty("error");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });
});

/**
 * THE CRITERION HELD WHERE IT WAS NOT HELD: a throw BEFORE the completion.
 *
 * The case further down pins a throw INSIDE the completion transaction, and that is the only place
 * anything pinned one — which is how the two awaited reads that happen EARLIER came to sit outside
 * the blanket `try`. A throw from either ended the request as Hono's default bodyless 500, with no
 * `Location` at all, for somebody who had just finished a consent at another company. There is no
 * `app.onError` on this app to turn that into anything else.
 *
 * `not-recorded` IS THE CODE FOR BOTH, because it is what the criterion requires and because it is
 * true: nothing was recorded. Neither case adds an exit, so the closed set above is unchanged.
 */
describe("a store that throws before anything could be written", () => {
  test("the attempt read throwing still answers a Location", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", { attemptReadThrows: true }),
      "not-recorded",
    );
    // The vendor was never asked, and the row is left exactly as it was.
    expect(confirmCalls).toEqual([]);
    expect(statusCalls).toEqual([]);
    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    await expectNothingWritten();
  });

  /**
   * THE GUARD'S OWN READS ARE INSIDE THE `try` TOO, and this does not disturb the 403 above: that
   * branch RETURNS a response, and a `catch` sees throws and not returns.
   */
  test("the guard's role read throwing still answers a Location", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", { roleReadThrows: true }),
      "not-recorded",
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });
});

describe("a deployment whose broker runs no correlated authorization flow", () => {
  test("a broker declaring authorizations: null refuses as not supported", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", {
        brokerBag: {
          broker: { ...broker, authorizations: null },
          provider: "composio",
        },
      }),
      "not-supported",
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("no broker bag at all refuses as no broker", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", { brokerBag: undefined }),
      "no-broker",
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("the gate does not answer before the session is checked", async () => {
    const response = await verify(null, "?flow_id=flow-abc", {
      brokerBag: undefined,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${APP_URL}/sign?flow_id=flow-abc`,
    );
  });
});

describe("what the authorization's own status decides", () => {
  /**
   * A TIMEOUT IS NEITHER A SUCCESS NOR A FAILURE, and the proof is that the attempt is still
   * completable afterwards: the second call below finishes the very same row. A refusal that closed
   * it would leave somebody who came back to the link with nothing to finish.
   */
  test("still pending at the bound refuses and LEAVES THE ATTEMPT STANDING", async () => {
    const createdAt = await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => ({
      status: "pending",
      userId: ACTOR,
      scopes: [],
    });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "not-finished",
    );
    // BOUNDED, and the bound is small: never the SDK's unbounded wait.
    expect(statusCalls.length).toBeGreaterThan(1);
    expect(statusCalls.length).toBeLessThanOrEqual(5);
    expect(statusCalls.every((id) => id === MINTED)).toBe(true);

    const standing = await attemptRow();
    expect(standing?.completedAt).toBeNull();
    expect(standing?.outcome).toBeNull();
    expect(standing?.authId).toBe(MINTED);
    expect(standing?.createdAt.getTime()).toBe(createdAt.getTime());
    await expectNothingWritten();

    // AND IT COMPLETES AFTERWARDS, which is the whole claim.
    statusAnswer = async () => ({
      status: "completed",
      userId: ACTOR,
      scopes: ["gmail.read"],
    });
    const finished = await verify(ACTOR, "?flow_id=flow-abc");
    expect(finished.headers.get("location")).toBe(LANDING);
    const after = await attemptRow();
    expect(after?.outcome).toBe("completed");
    expect(after?.completedAt).not.toBeNull();
    const { connections } = await written();
    expect(connections.length).toBe(1);
  }, 30_000);

  test("a failed authorization refuses and the ROW is marked failed", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => ({
      status: "failed",
      userId: ACTOR,
      scopes: [],
    });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "authorization-failed",
    );
    expect(statusCalls).toEqual([MINTED]);

    const row = await attemptRow();
    expect(row?.outcome).toBe("failed");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });

  test("a status naming a different identity refuses and the ROW is marked failed", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => ({
      status: "completed",
      userId: `somebody-else-${suite}`,
      scopes: ["gmail.read"],
    });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "not-your-authorization",
    );

    const row = await attemptRow();
    expect(row?.outcome).toBe("failed");
    expect(row?.completedAt).not.toBeNull();
    await expectNothingWritten();
  });

  test("a vendor that will not answer the status refuses and leaves the row standing", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => {
      throw new Error(`vendor down, token ${TOKEN}`);
    };

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc"),
    );
    await expectRefusal(response, "vendor-unavailable");
    // THE WHOLE ANSWER: the vendor's failure carries the token in its message, so a check of
    // `Location` alone would miss it riding another header or the body.
    expect(mentionsOf(await asDelivered(response), TOKEN)).toEqual([]);

    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    await expectNothingWritten();

    /*
     * AND THE ONE UNKNOWN THAT CAN SIT OVER A LIVE GRANT IS SAID OUT LOUD.
     *
     * Everything before this point passed: the handle was confirmed and it named this mint, and the
     * person is here because a consent screen sent them. So the likeliest state behind the throw is
     * a consent that COMPLETED at the vendor with nothing here recording it. Silent, that is a live
     * grant nobody knows to look for.
     */
    const line = lines(said).find((text) =>
      text.includes("arcade-completion-status-unknown"),
    );
    expect(line).toBeDefined();
    expect(line).toContain(`"authorizationId":"${MINTED}"`);

    /*
     * AND THE LOG IS HELD TO THE SAME BAR AS THE RESPONSE (D31). A status reply on this leg carries
     * a LIVE PROVIDER ACCESS TOKEN, so a line written about a status failure is exactly where one
     * would escape — and a log is not a lesser destination than a redirect. The refusal above
     * already proves the response is clean; this proves the line beside it is.
     */
    expect(mentionsOf(line ?? "", TOKEN)).toEqual([]);
  });

  /**
   * D5: A VENDOR THAT ACCEPTS AND NEVER ANSWERS. The one above throws, which every bounded loop
   * survives; this one does neither — it takes the call and goes quiet, which is what a hung socket
   * actually looks like.
   *
   * A BOUND ON THE POLL COUNT IS NOT A BOUND. Five unbounded waits are unbounded, so the loop
   * condition is never reached, the handler never returns, and the browser is held open for as long
   * as the vendor cares to hold it — the exact case `settledStatus`'s own docblock claims to
   * prevent. The assertion is therefore not about a status code: it is that the request COMPLETES.
   *
   * AND THE TEST CANNOT HANG THE SUITE EVEN WHEN THE FIX IS GONE. The request is raced against this
   * case's own watchdog and the watchdog ANSWERS rather than throwing, so a regression fails here
   * with "it never answered" instead of running the suite into its timeout with no diagnosis. The
   * watchdog is longer than the route's worst case (five polls at two seconds with four one-second
   * pauses) and shorter than this case's own timeout, which is the whole of what it has to be.
   */
  test("a vendor that ACCEPTS AND NEVER ANSWERS still completes, refusing", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    // Never settles and never rejects: the vendor is holding the connection open.
    statusAnswer = () => new Promise<never>(() => {});

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"never answered">((resolve) => {
      watchdog = setTimeout(() => resolve("never answered"), 20_000);
    });
    const answered = await Promise.race([
      verify(ACTOR, "?flow_id=flow-abc"),
      hung,
    ]).finally(() => {
      if (watchdog !== undefined) clearTimeout(watchdog);
    });

    expect(answered).not.toBe("never answered");
    const response = answered as Response;
    await expectRefusal(response, "vendor-unavailable");
    // The suite-wide promise: nothing of the vendor's rides out on any header or in the body.
    expect(mentionsOf(await asDelivered(response), TOKEN)).toEqual([]);

    /*
     * AND THE ROW IS LEFT STANDING, as it is for every other "we could not read the status" exit.
     * A consent that may well have finished at the vendor must still be finishable by somebody who
     * comes back to the link.
     */
    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  }, 30_000);
});

/**
 * D28: a consent whose account context moved on is not completed into the present.
 *
 * The app is switched to Shared between the mint and the callback, which mints a fresh deployment
 * identity. The attempt names the person's own identity, which is now retired.
 */
describe("a consent whose account context has moved on", () => {
  /** The connection the CURRENT identity already holds, which this refusal must not touch. */
  async function giveCurrentAccountAConnection() {
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app: TOOLKIT,
      holder: "deployment",
      userId: null,
      vendorUserId: SHARED_IDENTITY,
      verified: true,
    });
  }

  async function switchToShared() {
    await database
      .update(mcpServers)
      .set({ accountMode: "shared", sharedVendorUserId: SHARED_IDENTITY })
      .where(eq(mcpServers.id, APP));
  }

  /** A connection this identity holds for one app, as the row this deployment keeps for it. */
  async function hold(app: string, vendorUserId: string) {
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app,
      holder: "person",
      userId: vendorUserId,
      vendorUserId,
    });
  }

  /**
   * Which of these apps this deployment still records a connection for ON ONE IDENTITY, in name
   * order. Keyed on the identity because the whole question here is which identity's rows went:
   * the retired one's, and never the account that is live now.
   */
  const rowsFor = async (names: string[], vendorUserId: string) =>
    (
      await database
        .select({ app: brokeredConnections.app })
        .from(brokeredConnections)
        .where(
          and(
            inArray(brokeredConnections.app, names),
            eq(brokeredConnections.vendorUserId, vendorUserId),
          ),
        )
        .orderBy(asc(brokeredConnections.app))
    ).map((row) => row.app);

  /** What the trail says ended, by app, with the payload a reader would be answered with. */
  const disconnectsFor = (names: string[]) =>
    database
      .select({
        app: auditEvents.targetId,
        payload: sql<Record<string, unknown>>`payload`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.account_disconnected"),
          inArray(auditEvents.targetId, names),
        ),
      )
      .orderBy(asc(auditEvents.targetId));

  test("refuses, withdraws the RETIRED identity's grant and leaves the CURRENT account alone", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    await giveCurrentAccountAConnection();

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "context-changed",
    );

    // THE RETIRED IDENTITY, AND ONLY IT. A connection is keyed on the identity, and the retired one
    // is not the current one, so this cannot reach the account that is live now.
    expect(revokeCalls).toEqual([
      {
        account: { holder: "person", userId: ACTOR, vendorUserId: ACTOR },
        toolkit: TOOLKIT,
      },
    ]);

    // AND THE CURRENT ACCOUNT'S ROW IS STILL THERE, untouched and still the deployment's.
    const { connections, events } = await written();
    expect(connections.length).toBe(1);
    expect(connections[0]?.holder).toBe("deployment");
    expect(connections[0]?.vendorUserId).toBe(SHARED_IDENTITY);
    expect(events.length).toBe(0);

    // THE CONSENT COMPLETED AND THIS DEPLOYMENT ENDED IT: neither a decline nor an unknown.
    const row = await attemptRow();
    expect(row?.outcome).toBe("withdrawn");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.authId).toBe(MINTED);
  });

  /**
   * A RETIRED SHARED IDENTITY IS NOT THE APP'S DEPLOYMENT ROW. An administrator starts a consent
   * on Shared identity A; the app goes Shared → Personal → Shared, which mints B, and B connects;
   * then the administrator comes back. The withdrawal is A's, and the row it clears must be A's:
   * matched on the holder alone, it was B's, and the app read as disconnected while B stood live.
   */
  test("a retired SHARED identity's withdrawal leaves the current Shared identity's row alone", async () => {
    const retired = `retired-${suite}`;
    await database.insert(pendingAuthorizations).values({
      actorId: ACTOR,
      serverId: APP,
      action: ACTION,
      holder: "deployment",
      userId: null,
      vendorUserId: retired,
      authId: MINTED,
      createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    });
    await switchToShared();
    await giveCurrentAccountAConnection();
    statusAnswer = async () => ({
      status: "completed",
      userId: retired,
      scopes: ["gmail.read"],
    });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", { roles: ["admin"] }),
      "context-changed",
    );

    expect(revokeCalls).toEqual([
      {
        account: { holder: "deployment", vendorUserId: retired },
        toolkit: TOOLKIT,
      },
    ]);
    const { connections } = await written();
    expect(connections.map((row) => [row.holder, row.vendorUserId])).toEqual([
      ["deployment", SHARED_IDENTITY],
    ]);
    expect(await disconnectsFor([TOOLKIT])).toEqual([]);
    expect((await attemptRow())?.outcome).toBe("withdrawn");
  });

  test("a revoke that answers false, which an unresolved auth provider does, is not a withdrawal", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    revokeAnswer = async () => false;

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "context-changed",
    );

    // `false` is "nothing found OR could not work out what to withdraw"; a possibly-live grant
    // reads that as "we do not know". Scoped to this test: the row is keyed on ACTOR, which
    // beforeEach clears, and TOOLKIT is unique per test.
    const row = await attemptRow();
    expect(revokeCalls.length).toBe(1);
    expect(row?.outcome).toBe("unreconciled");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });

  test("a withdrawal this deployment could not make keeps the attempt as unreconciled", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    revokeAnswer = async () => {
      throw new Error("the vendor refused the revoke");
    };

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "context-changed",
    );

    // A grant we know about and could not end is worth a row somebody can act on.
    const row = await attemptRow();
    expect(row?.outcome).toBe("unreconciled");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });

  /*
   * G3: THE ONE REVOKE ABOVE ENDS MORE THAN THE APP IT NAMES, AND THE ROWS HERE HAVE TO SAY SO.
   *
   * On Arcade a connection is keyed `(identity, auth provider)`, so withdrawing the retired
   * identity's app ends every app of that identity sharing the provider. A sibling's row left
   * standing is this deployment claiming a live connection for an app the vendor has already
   * disconnected: the person sees it listed as connected and it fails on first use.
   *
   * The apps are named off this test's own suite-scoped toolkit, so the suite's `like` cleanup
   * takes them and no other case can see them.
   */
  const siblingApp = () => `${TOOLKIT}+calendar`;
  const otherProviderApp = () => `${TOOLKIT}+slack`;

  test("the apps the same revoke ended lose their rows too, and the trail names what ended them", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    await giveCurrentAccountAConnection();
    // The retired identity holds the app this consent was for and two more: one on the SAME auth
    // provider, which this revoke ends with it, and one on another, which it cannot reach.
    await hold(TOOLKIT, ACTOR);
    await hold(siblingApp(), ACTOR);
    await hold(otherProviderApp(), ACTOR);
    authProviderAnswer = async (toolkit) =>
      toolkit.endsWith("+slack") ? "slack" : "google";

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "context-changed",
    );

    // STILL ONE ASK, AND STILL ONLY THE RETIRED IDENTITY'S: the siblings are what that ask ends,
    // not more calls to make.
    expect(revokeCalls).toEqual([
      {
        account: { holder: "person", userId: ACTOR, vendorUserId: ACTOR },
        toolkit: TOOLKIT,
      },
    ]);

    // The retired identity's two apps on the ended connection are gone from this deployment's
    // records; the app on another provider is untouched.
    expect(
      await rowsFor([TOOLKIT, siblingApp(), otherProviderApp()], ACTOR),
    ).toEqual([otherProviderApp()]);

    // AND THE CURRENT ACCOUNT'S ROW IS STILL THERE: a connection is keyed on the identity.
    const { connections } = await written();
    expect(connections.length).toBe(1);
    expect(connections[0]?.holder).toBe("deployment");
    expect(connections[0]?.vendorUserId).toBe(SHARED_IDENTITY);

    const trail = await disconnectsFor([
      TOOLKIT,
      siblingApp(),
      otherProviderApp(),
    ]);
    expect(trail.map((event) => event.app)).toEqual(
      [TOOLKIT, siblingApp()].sort(),
    );
    // The sibling's row names the app whose withdrawal ended it, and claims the vendor WAS asked:
    // `vendorRevocationRequested: false` would say nobody asked about an account that is gone.
    expect(
      trail.find((event) => event.app === siblingApp())?.payload,
    ).toMatchObject({
      reason: "context_changed",
      endedWith: TOOLKIT,
      unansweredSiblings: 0,
      vendorRevocationRequested: true,
      owner: ACTOR,
    });
    // The asked app's own row names no other app beside it: it was ended by its own ask.
    const asked = trail.find((event) => event.app === TOOLKIT)?.payload;
    expect(asked).toMatchObject({
      reason: "context_changed",
      vendorRevocationRequested: true,
      owner: ACTOR,
    });
    expect(asked).not.toHaveProperty("endedWith");

    const row = await attemptRow();
    expect(row?.outcome).toBe("withdrawn");
  });

  test("a revoke that answers false clears nothing and claims no collateral", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    await hold(TOOLKIT, ACTOR);
    await hold(siblingApp(), ACTOR);
    revokeAnswer = async () => false;

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "context-changed",
    );

    // "Nothing found, or we could not work out what to withdraw": no row may be cleared and no
    // app claimed ended on the strength of an answer nobody got.
    expect(await rowsFor([TOOLKIT, siblingApp()], ACTOR)).toEqual(
      [TOOLKIT, siblingApp()].sort(),
    );
    expect(await disconnectsFor([TOOLKIT, siblingApp()])).toEqual([]);
    expect((await attemptRow())?.outcome).toBe("unreconciled");
  });

  /*
   * B6a: A REVOKE THAT THROWS IS AN OUTCOME NOBODY KNOWS, NOT AN ANSWER OF `false`.
   *
   * The seam deletes every connection it found and only then throws if any delete failed, so this
   * throw arrives with part of the withdrawal already done at the vendor. The route used to read
   * it as `false` in a bare `catch` and say nothing: the attempt went `unreconciled`, the rows here
   * stood, and an operator had no way to learn that this deployment and the vendor may now
   * disagree about whether the connection exists.
   */
  test("a revoke that withdrew part and then threw clears nothing, and leaves an operator a line", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    await hold(TOOLKIT, ACTOR);
    await hold(siblingApp(), ACTOR);
    revokeAnswer = async () => {
      throw new Error("Arcade revoke failed for 1 of 3 connections.");
    };

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc"),
    );
    await expectRefusal(response, "context-changed");

    // NOT READ AS A WITHDRAWAL: nothing cleared, nothing claimed on the trail, kept as unknown.
    expect(await rowsFor([TOOLKIT, siblingApp()], ACTOR)).toEqual(
      [TOOLKIT, siblingApp()].sort(),
    );
    expect(await disconnectsFor([TOOLKIT, siblingApp()])).toEqual([]);
    expect((await attemptRow())?.outcome).toBe("unreconciled");

    // AND SAID OUT LOUD, with what an operator needs to find the disagreement and settle it.
    const line = lines(said).find((text) =>
      text.includes("arcade-context-withdrawal-unknown"),
    );
    expect(line).toBeDefined();
    expect(line).toContain(`"authorizationId":"${MINTED}"`);
    // Quoted as the field, because the sibling's name carries TOOLKIT as its prefix.
    expect(line).toContain(`"app":"${TOOLKIT}"`);
    // CONTAINED RATHER THAN EQUAL: siblings are read off every row this identity holds, and earlier
    // cases in this file leave theirs until `afterAll`.
    expect(
      (JSON.parse(line ?? "{}") as { siblings?: string[] }).siblings,
    ).toContain(siblingApp());
    expect(line).toContain("Arcade revoke failed for 1 of 3 connections.");
  });

  test("a sibling set this deployment could not resolve stops the revoke rather than widening it", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    await hold(TOOLKIT, ACTOR);
    await hold(siblingApp(), ACTOR);
    authProviderAnswer = async () => {
      throw new Error("the vendor would not say which provider holds this");
    };

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "context-changed",
    );

    // Ending apps this deployment cannot then name is the failure this is about, so nothing is
    // asked of the vendor at all and the grant is left as a row somebody can act on.
    expect(revokeCalls).toEqual([]);
    expect(await rowsFor([TOOLKIT, siblingApp()], ACTOR)).toEqual(
      [TOOLKIT, siblingApp()].sort(),
    );
    expect((await attemptRow())?.outcome).toBe("unreconciled");
  });

  /**
   * AND THE SAME OUTCOME REACHED BY THE OTHER ROAD SAYS SO TOO.
   *
   * `arcade-context-withdrawal-unknown` covers the revoke RAISING. This resolution sits one step in
   * front of it and decides whether that revoke is attempted at all, so an unresolved sibling set
   * closes the attempt `unreconciled` without the revoke ever running — the same row on the trail,
   * reached differently, and for a while with no line against it. An operator saw `unreconciled`
   * and nothing saying why.
   */
  test("a sibling set that could not be resolved leaves an operator a line too", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    await hold(TOOLKIT, ACTOR);
    authProviderAnswer = async () => {
      throw new Error("the vendor would not say which provider holds this");
    };

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc"),
    );
    await expectRefusal(response, "context-changed");

    expect(revokeCalls).toEqual([]);
    expect((await attemptRow())?.outcome).toBe("unreconciled");

    const line = lines(said).find((text) =>
      text.includes("arcade-sibling-resolution-unknown"),
    );
    expect(line).toBeDefined();
    expect(line).toContain(`"authorizationId":"${MINTED}"`);
    expect(line).toContain(`"app":"${TOOLKIT}"`);
    expect(line).toContain(
      "the vendor would not say which provider holds this",
    );
  });
});

/**
 * AN ADMINISTRATOR DEMOTED WHILE THEIR CONSENT WAS OPEN DOES NOT GET TO END THE TEAM'S ACCOUNT.
 *
 * The freshness check re-resolves the app's account through `brokeredAccountFor`, which refuses a
 * Shared app to anybody who is not an administrator. The route used to read that refusal as "the
 * context moved" and withdraw the attempt's account — which, for a Shared app, IS the deployment's
 * live account, the one every person's calls on that app and its siblings go out under. Nothing
 * moved: only the person lost the authority to finish what they started. So nothing is withdrawn,
 * the team's rows stand, and the attempt is closed rather than left for a retry that can only be
 * refused again.
 */
describe("a Shared-app consent finished by somebody who is no longer an administrator", () => {
  const siblingApp = () => `${TOOLKIT}+calendar`;

  test("refuses without withdrawing the deployment's live account or clearing its rows", async () => {
    await database
      .update(mcpServers)
      .set({ accountMode: "shared", sharedVendorUserId: SHARED_IDENTITY })
      .where(eq(mcpServers.id, APP));
    // The team's live connection for this app and for a sibling on the same auth provider.
    for (const app of [TOOLKIT, siblingApp()]) {
      await database.insert(brokeredConnections).values({
        provider: "arcade",
        app,
        holder: "deployment",
        userId: null,
        vendorUserId: SHARED_IDENTITY,
        verified: true,
      });
    }
    // Started while the actor WAS an administrator, so the attempt is the deployment's.
    await database.insert(pendingAuthorizations).values({
      actorId: ACTOR,
      serverId: APP,
      action: ACTION,
      holder: "deployment",
      userId: null,
      vendorUserId: SHARED_IDENTITY,
      authId: MINTED,
      createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    });
    statusAnswer = async () => ({
      status: "completed",
      userId: SHARED_IDENTITY,
      scopes: ["gmail.read"],
    });

    // And finished after the role was taken away.
    const response = await verify(ACTOR, "?flow_id=flow-abc", {
      roles: ["user"],
    });

    // THE WHOLE FINDING, FIRST: the vendor was never asked to end the team's account.
    expect(revokeCalls).toEqual([]);
    await expectRefusal(response, "not-permitted");

    // The team's rows are exactly as they were, and no completion was written over them.
    const live = await database
      .select({ app: brokeredConnections.app })
      .from(brokeredConnections)
      .where(
        and(
          inArray(brokeredConnections.app, [TOOLKIT, siblingApp()]),
          eq(brokeredConnections.vendorUserId, SHARED_IDENTITY),
        ),
      )
      .orderBy(asc(brokeredConnections.app));
    expect(live.map((row) => row.app)).toEqual([TOOLKIT, siblingApp()].sort());
    expect((await written()).events.length).toBe(0);

    // CLOSED, AND NOT AS A WITHDRAWAL: nothing was withdrawn, and the consent is live at the vendor.
    const row = await attemptRow();
    expect(row?.outcome).toBe("unreconciled");
    expect(row?.completedAt).not.toBeNull();
  });
});

/**
 * D4: AN ATTEMPT THAT CANNOT SAY WHOSE ACCOUNT IT IS FOR IS REFUSED, NEVER READ AS THE
 * DEPLOYMENT'S.
 *
 * The holder distinction IS the authorization model: a `person` attempt belongs to one signed-in
 * human and a `deployment` attempt to the installation. The route used to rebuild the attempt's
 * account with a ternary whose else-branch swallowed every pair it did not recognise — so a
 * `person` row carrying no user id came out as `{ holder: "deployment" }` and the D28 withdrawal
 * was then AIMED AT THE DEPLOYMENT'S ACCOUNT. A revoke pointed one holder out is a disconnect
 * somebody asked for that ends the installation's connection, or the installation's connection
 * ended on one person's behalf; from the browser both look exactly like success.
 *
 * EVERY PAIR HERE IS ONE THE DATABASE ALREADY REFUSES — `pending_authorizations_holder_check` is
 * asserted directly in `arcade-attempt-constraints.test.ts` — so these rows reach the route only
 * because the store is replaced. That is deliberate and it is the whole argument: the state is
 * unreachable through the table, and an unreachable state must therefore be a REFUSAL in the code
 * rather than a silent re-reading, because a re-reading is what a corrupt or hand-edited row, a
 * future second writer, or a store that is not this one would turn into a wrong act with no trace.
 *
 * The app is switched to Shared in each case so the run would reach the withdrawal: these tests
 * assert the vendor was never asked at all, which is strictly stronger than asserting it was asked
 * correctly.
 */
describe("an attempt whose holder and user id do not agree", () => {
  async function switchToShared() {
    await database
      .update(mcpServers)
      .set({ accountMode: "shared", sharedVendorUserId: SHARED_IDENTITY })
      .where(eq(mcpServers.id, APP));
  }

  /** The pairs `(holder = 'person' AND user_id IS NOT NULL) OR (deployment AND user_id IS NULL)` excludes. */
  const illegal: [string, { holder?: string; userId?: string | null }][] = [
    ["a person attempt with no user id", { holder: "person", userId: null }],
    [
      "a person attempt whose user id is the empty string",
      { holder: "person", userId: "" },
    ],
    [
      "a deployment attempt carrying a user id",
      { holder: "deployment", userId: ACTOR },
    ],
    ["an attempt whose holder is not one of the two", { holder: "llama" }],
  ];

  for (const [name, attemptAs] of illegal) {
    test(`${name} is refused, and nothing is revoked`, async () => {
      await giveAttempt({ authId: MINTED, ageMinutes: 1 });
      await switchToShared();

      const response = await verify(ACTOR, "?flow_id=flow-abc", { attemptAs });

      /*
       * THE WHOLE FINDING, AND IT IS ASSERTED FIRST ON PURPOSE. The refusal code below is the
       * symptom; what the defect DID was aim a revocation, so a failure here has to name the
       * account that was reached rather than a redirect that was wrong. No account was rebuilt, so
       * no revocation was aimed anywhere — least of all at the deployment's.
       */
      expect(revokeCalls).toEqual([]);
      // Nor was a single vendor call spent on a row that can never complete.
      expect(confirmCalls).toEqual([]);
      expect(statusCalls).toEqual([]);

      await expectRefusal(response, "no-attempt");

      // AND NOTHING WAS WRITTEN OR CLOSED: the row stands until its TTL, as it does for the other
      // attempt that can never complete (a null `auth_id`).
      const row = await attemptRow();
      expect(row?.outcome).toBeNull();
      expect(row?.completedAt).toBeNull();
      await expectNothingWritten();
    });
  }
});

describe("a return leg that completes", () => {
  test("lands on the app's own page, built from the ATTEMPT ROW", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.status).toBe(303);
    /*
     * FROM THE ATTEMPT ROW'S `server_id`, NEVER FROM A `next_uri`: the vendor refuses every value
     * at mint, and what `confirm_user` answers is the vendor's own success page rather than ours.
     * No notice parameter either — the row it comes back to now reads Connected, which is the same
     * news told by the thing it is news about.
     */
    expect(response.headers.get("location")).toBe(LANDING);
    expect(response.headers.get("location")).not.toContain("authorized=");

    const { connections, events } = await written();
    expect(connections.length).toBe(1);
    expect(connections[0]?.userId).toBe(ACTOR);
    expect(connections[0]?.verified).toBe(true);
    expect(events.length).toBe(1);
    // The action the attempt was for and the scopes the vendor granted, which is ALL of the
    // vendor's answer that is written anywhere.
    expect(events[0]?.payload).toMatchObject({
      action: ACTION,
      scope: "gmail.read",
      // THE BROKER'S ANSWER, NOT THE TOOLKIT NAME. The stub answers a provider that is deliberately
      // nothing like `Gmail-…`, so a route deriving one from the other fails here.
      authProvider: "google",
    });

    const row = await attemptRow();
    expect(row?.outcome).toBe("completed");
    expect(row?.completedAt).not.toBeNull();
  });

  /**
   * A DEPLOYMENT-HELD ACCOUNT LANDS ON THE SAME SCREEN, which is the branch that had no test and
   * so shipped pointing at `/admin/plugins/:key` — a route with no `validateSearch` for `action`,
   * no landing notice and no grant list. The whole Shared-app flow, the one case whose Authorize
   * is admin-only, finished a consent at the vendor and came back to a page that said nothing
   * about it. The destination is asserted CHARACTER FOR CHARACTER against the settings landing,
   * including the single `?`, because that is the only address any screen reads `?action=` off.
   */
  test("a consent the DEPLOYMENT holds lands on the same settings page, not on admin", async () => {
    await database
      .update(mcpServers)
      .set({ accountMode: "shared", sharedVendorUserId: SHARED_IDENTITY })
      .where(eq(mcpServers.id, APP));
    await database.insert(pendingAuthorizations).values({
      actorId: ACTOR,
      serverId: APP,
      action: ACTION,
      holder: "deployment",
      userId: null,
      vendorUserId: SHARED_IDENTITY,
      authId: MINTED,
      createdAt: new Date(Math.floor(Date.now() / 1000) * 1000),
    });
    statusAnswer = async () => ({
      status: "completed",
      userId: SHARED_IDENTITY,
      scopes: ["gmail.read"],
    });

    const response = await verify(ACTOR, "?flow_id=flow-abc", {
      roles: ["admin"],
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(LANDING);
    expect(response.headers.get("location")).not.toContain("/admin/");
    // One query parameter, so the appended `?action=` cannot have met a path that already had one.
    expect(response.headers.get("location")?.split("?").length).toBe(2);

    // AND IT IS THE DEPLOYMENT'S GRANT THAT WAS WRITTEN, so this is the holder whose landing is
    // being asserted and not a personal one dressed up as it.
    const { connections } = await written();
    expect(connections.length).toBe(1);
    expect(connections[0]?.holder).toBe("deployment");
    expect(connections[0]?.userId).toBeNull();
    expect(connections[0]?.vendorUserId).toBe(SHARED_IDENTITY);

    const row = await attemptRow();
    expect(row?.outcome).toBe("completed");
  });

  /**
   * A VENDOR THAT DOES NOT SAY WHICH AUTH PROVIDER IT IS records that it did not say, and the
   * consent still completes: the grant is already live at the vendor, and an audit label is not
   * worth refusing it over. Guessing the toolkit name here is the thing the seam forbids.
   */
  test("an auth provider the vendor will not name is recorded as unnamed, and still completes", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    authProviderAnswer = async () => null;

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.headers.get("location")).toBe(LANDING);

    const { connections, events } = await written();
    expect(connections.length).toBe(1);
    expect(events[0]?.payload).toMatchObject({ authProvider: "" });
  });

  /**
   * AND ONE THAT THROWS BEFORE IT EVEN ANSWERS IS THE SAME ANSWER. The route reads the provider as
   * `withVendorDeadline(...).catch(() => null)`, and a synchronous throw used to leave the helper
   * before its promise existed — so the `.catch` was never reached, the throw took the whole
   * completion down with it, and the deadline's timer was left armed behind it. An audit label is
   * no more worth refusing a live consent over when the vendor fails fast than when it fails slow.
   */
  test("an auth provider lookup that throws synchronously is recorded as unnamed, and still completes", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    authProviderAnswer = () => {
      throw new Error("refused before it asked");
    };

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.headers.get("location")).toBe(LANDING);

    const { connections, events } = await written();
    expect(connections.length).toBe(1);
    expect(events.length).toBe(1);
    expect(events[0]?.payload).toMatchObject({ authProvider: "" });
    expect((await attemptRow())?.outcome).toBe("completed");
  });

  /**
   * TWO CALLBACKS AT ONCE, with `Promise.all` and never a sequential replay: a replay proves only
   * that the row was already consumed, while the race is what the conditional UPDATE exists for.
   * The loser answers exactly as the winner does, so a duplicate is a no-op rather than an error
   * somebody has to explain.
   */
  test("two CONCURRENT callbacks write exactly one connection and one audit event", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const [first, second] = await Promise.all([
      verify(ACTOR, "?flow_id=flow-abc"),
      verify(ACTOR, "?flow_id=flow-abc"),
    ]);

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(first.headers.get("location")).toBe(LANDING);
    expect(second.headers.get("location")).toBe(LANDING);

    const { connections, events } = await written();
    expect({ connections: connections.length, events: events.length }).toEqual({
      connections: 1,
      events: 1,
    });
  });

  /**
   * A FAILURE BETWEEN THE CONNECTION WRITE AND THE AUDIT WRITE PERSISTS NEITHER.
   *
   * Injected at the DATABASE HANDLE rather than at the store's `auditStore` option, because the
   * audit write that has to be atomic with the connection write is the one bound to the
   * transaction — the same reason `arcade-completion-transaction.integration.test.ts` gives. And it
   * is driven through the route, so the route's own promise — no exit without a `Location` — is
   * held to on the path where its own store throws.
   */
  test("a failure between the two writes persists NEITHER, and still answers a Location", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const brokenAuditDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "transaction") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (work: (tx: unknown) => Promise<unknown>) =>
          target.transaction((transaction) =>
            work(
              new Proxy(transaction, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty === "insert") {
                    return (table: unknown) => {
                      if (table === auditEvents)
                        throw new Error("injected audit failure");
                      return txTarget.insert(table as never);
                    };
                  }
                  const value = Reflect.get(txTarget, txProperty, txReceiver);
                  return typeof value === "function"
                    ? value.bind(txTarget)
                    : value;
                },
              }),
            ),
          );
      },
    }) as typeof database;

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", {
        database: brokenAuditDatabase,
      }),
      "not-recorded",
    );

    // BOTH TABLES, because "it answered" is not evidence that nothing was written.
    await expectNothingWritten();

    // And the attempt is still claimable, because its UPDATE was in the same transaction.
    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
  });

  /**
   * SPEC D31. The vendor's own status reply carries a LIVE PROVIDER ACCESS TOKEN and the person's
   * full profile beside the three fields the seam narrows it to. A status response LOOKS LIKE
   * METADATA, which is how the throwaway harness that proved this flow came to write the token to a
   * file on its first run. So this case hands the route a reply carrying one and requires that it
   * reaches no log line, no audit payload, no connection row and no `Location`.
   */
  test("nothing the status answered reaches a log line or an audit row", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () =>
      ({
        status: "completed",
        userId: ACTOR,
        scopes: ["gmail.read"],
        token: TOKEN,
        context: { token: TOKEN },
        user_info: { email: EMAIL },
      }) as never;

    /**
     * THE ARGUMENTS THEMSELVES, not a rendering of them: a token logged inside an object is the
     * case this test constructs, and it is the case any flattening would hide. See `harvest`.
     */
    const said: unknown[][] = [];
    const before = globalThis.console;
    const hear = (...args: unknown[]) => said.push(args);
    globalThis.console = {
      ...before,
      log: hear,
      info: hear,
      warn: hear,
      error: hear,
      debug: hear,
    } as typeof console;
    let response: Response;
    try {
      response = await verify(ACTOR, "?flow_id=flow-abc");
    } finally {
      globalThis.console = before;
    }

    expect(response.status).toBe(303);
    expect(mentionsOf(said, TOKEN)).toEqual([]);
    expect(mentionsOf(said, EMAIL)).toEqual([]);

    // THE WHOLE ANSWER, because a credential that misses `Location` can still ride another header
    // or the body the browser is handed on the way to it.
    const delivered = await asDelivered(response);
    expect(mentionsOf(delivered, TOKEN)).toEqual([]);
    expect(mentionsOf(delivered, EMAIL)).toEqual([]);

    const { connections, events } = await written();
    expect(mentionsOf(events, TOKEN)).toEqual([]);
    expect(mentionsOf(events, EMAIL)).toEqual([]);
    expect(mentionsOf(connections, TOKEN)).toEqual([]);
    expect(mentionsOf(connections, EMAIL)).toEqual([]);
  });
});

/**
 * THE THROW A COMPLETION REALLY FAILS WITH, SHAPED AS DRIZZLE SHAPES IT.
 *
 * Not a bare `new Error("boom")`, because the thing the log line has to be careful about is exactly
 * what a bare error does not carry. drizzle wraps a failed statement as an error whose OWN message
 * is `Failed query: <the statement>` plus `params: <every bound value>`, with the driver's
 * complaint on `cause` — and the values bound by this particular statement are the granted scopes
 * and the account. This one carries the suite's live access token and the person's address in the
 * same places, so a log line that quoted `.message` would print both, and `reasonWithoutStatement`
 * is the only reason it does not.
 */
function completionFailure(): Error {
  return Object.assign(
    new Error(
      `Failed query: insert into "brokered_connections" ... params: ${TOKEN}, ${EMAIL}`,
    ),
    {
      query: 'insert into "brokered_connections" ...',
      params: [TOKEN, EMAIL],
      cause: new Error("canceling statement due to statement timeout"),
    },
  );
}

/**
 * Everything the deployment said while the request ran, AS THE ARGUMENTS THEMSELVES.
 *
 * Not `args.map(String).join(" ")`, for the reason `harvest` gives at length: a value logged inside
 * an object flattens to `[object Object]`, which is the shape a leak hides in.
 */
async function heard<T>(work: () => T | Promise<T>): Promise<[T, unknown[][]]> {
  const said: unknown[][] = [];
  const before = globalThis.console;
  const hear = (...args: unknown[]) => said.push(args);
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

/** Every line the run produced, as the JSON each one is written as. */
const lines = (said: unknown[][]): string[] =>
  said.map((args) => args.map((arg) => String(arg)).join(" "));

/**
 * A COMPLETION THAT COULD NOT REPORT ITSELF, WHICH IS TWO DIFFERENT FACTS AND WAS ONE ANSWER.
 *
 * This leg is the only one in this file where a grant can be LIVE AT THE VENDOR while this
 * deployment holds nothing — the person consented at the vendor before anything here was asked.
 * The handler's blanket `catch` answered `not-recorded` for every throw inside it and logged
 * nothing at all, so the two halves of that were both wrong at once: a completion that HAD
 * committed was reported to the person as not recorded, and a completion that had genuinely been
 * lost left an operator no trace to act on.
 */
/**
 * A CANCEL THAT LANDS WHILE THE RETURN LEG IS RUNNING, AND IT IS THE CANCEL THAT WINS.
 *
 * The person's Cancel deletes the attempt row. Landing after the vendor confirmed the return and
 * before the completion's conditional UPDATE, it leaves that UPDATE nothing to claim — and the
 * completion used to return quietly over zero rows, so the route sent the person to the page that
 * says they are connected while the trail said cancelled and the grant was live at the vendor.
 *
 * The cancel is landed from inside the status read, which is the last vendor call before the
 * completion: the DELETE below is the one `discardAuthorizationAttempt` issues.
 */
describe("a cancel that lands between the confirmation and the completion", () => {
  const leftLiveEvents = async () =>
    (
      await database
        .select({ payload: sql<Record<string, unknown>>`payload` })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetId, TOOLKIT),
            eq(auditEvents.eventType, "mcp.cancelled_grant_left_live"),
          ),
        )
    ).map((row) => row.payload);

  function cancelDuringTheReturnLeg() {
    statusAnswer = async () => {
      await database
        .delete(pendingAuthorizations)
        .where(eq(pendingAuthorizations.actorId, ACTOR));
      return { status: "completed", userId: ACTOR, scopes: ["gmail.read"] };
    };
  }

  test("is refused rather than reported connected, and the grant is withdrawn at the vendor", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    cancelDuringTheReturnLeg();
    // A provider of its own, so rows earlier cases leave on this identity are not siblings of it.
    authProviderAnswer = async (toolkit) =>
      toolkit === TOOLKIT ? `alone-${suite}` : "google";

    const response = await verify(ACTOR, "?flow_id=flow-abc");

    expect(response.headers.get("location")).not.toBe(LANDING);
    await expectRefusal(response, "cancelled");
    // The consent this person retracted is ended where it lives.
    expect(revokeCalls).toEqual([
      {
        account: { holder: "person", userId: ACTOR, vendorUserId: ACTOR },
        toolkit: TOOLKIT,
      },
    ]);
    await expectNothingWritten();
    expect(await leftLiveEvents()).toEqual([]);
    // The cancel's deletion stands: nothing here re-created or re-settled the attempt.
    expect(await attemptRow()).toBeNull();
  });

  /**
   * AND A WITHDRAWAL THAT WOULD END MORE THAN THE CANCELLED CONSENT IS NOT MADE. On Arcade a revoke
   * ends the whole `(identity, auth provider)` connection, so where this account already held the
   * app before this consent, withdrawing would take away a connection the person never asked to
   * end. That is left live and said out loud instead.
   */
  test("leaves a connection that predates the consent alone, and says so", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app: TOOLKIT,
      holder: "person",
      userId: ACTOR,
      vendorUserId: ACTOR,
      verified: true,
    });
    cancelDuringTheReturnLeg();
    // A provider of its own, so THIS guard is the only one that can stop the revoke: on the
    // default provider, rows earlier cases left on this identity are siblings, and the sibling
    // guard would stop it first and pass this case with the already-held check removed.
    authProviderAnswer = async (toolkit) =>
      toolkit === TOOLKIT ? `alone-${TOOLKIT}` : "google";

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc"),
    );

    await expectRefusal(response, "cancelled-left-live");
    expect(revokeCalls).toEqual([]);
    const { connections, events } = await written();
    expect(connections.length).toBe(1);
    expect(events.length).toBe(0);
    const line = lines(said).find((text) =>
      text.includes("arcade-cancelled-grant-left-live"),
    );
    expect(line).toBeDefined();
    expect(line).toContain(`"authorizationId":"${MINTED}"`);
    expect(line).toContain("already held this app");
    // AND THE TRAIL: the cancel's own row would otherwise read as a clean withdrawal.
    expect(await leftLiveEvents()).toEqual([
      expect.objectContaining({ action: ACTION, actor: ACTOR }),
    ]);
  });

  /**
   * THE SIBLING GUARD, ON ITS OWN. The account does not hold this app, so the already-held check
   * passes; it holds another app on the SAME auth provider, which a revoke would end with it. For a
   * Shared app that is the team's connection.
   */
  test("leaves a connection a sibling app shares alone, and says so", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const sibling = `${TOOLKIT}+calendar`;
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app: sibling,
      holder: "person",
      userId: ACTOR,
      vendorUserId: ACTOR,
      verified: true,
    });
    cancelDuringTheReturnLeg();
    authProviderAnswer = async (toolkit) =>
      toolkit === TOOLKIT || toolkit === sibling
        ? `alone-${TOOLKIT}`
        : "google";

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc"),
    );

    await expectRefusal(response, "cancelled-left-live");
    expect(revokeCalls).toEqual([]);
    await expectNothingWritten();
    const line = lines(said).find((text) =>
      text.includes("arcade-cancelled-grant-left-live"),
    );
    expect(line).toBeDefined();
    expect(line).toContain("other apps share this connection");
    // AND THE TRAIL: the cancel's own row would otherwise read as a clean withdrawal.
    expect(await leftLiveEvents()).toEqual([
      expect.objectContaining({ action: ACTION, actor: ACTOR }),
    ]);
  });
});

describe("a cancel whose ending could not be read", () => {
  test("withdraws nothing, refuses as not-recorded, and leaves an operator a line", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => {
      await database
        .delete(pendingAuthorizations)
        .where(eq(pendingAuthorizations.actorId, ACTOR));
      return { status: "completed", userId: ACTOR, scopes: ["gmail.read"] };
    };

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc", { completedProbeThrows: true }),
    );

    await expectRefusal(response, "not-recorded");
    expect(revokeCalls).toEqual([]);
    const line = lines(said).find((text) =>
      text.includes("arcade-cancelled-grant-left-live"),
    );
    expect(line).toBeDefined();
    expect(line).toContain(`"authorizationId":"${MINTED}"`);
    expect(line).toContain("injected probe failure");
  });
});

describe("a completion the deployment could not report", () => {
  test("one that rolled back refuses as not-recorded AND leaves an operator a line", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc", { completion: "rolls-back" }),
    );

    await expectRefusal(response, "not-recorded");
    // The sentence is true, and these two are what make it so.
    await expectNothingWritten();
    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();

    /*
     * AND IT WAS SAID OUT LOUD. The vendor's grant is live with nothing here recording it, and the
     * `ar_…` is what lets an operator find that flow at the vendor and end it — the same thing
     * `arcade-mint-not-recorded` carries at the other end of this lifecycle.
     */
    const line = lines(said).find((text) =>
      text.includes("arcade-completion-not-recorded"),
    );
    expect(line).toBeDefined();
    expect(line).toContain(MINTED);
    expect(line).toContain(ACTION);
    expect(line).toContain(APP);
    // The driver's complaint, which is the useful half and names nothing anybody sent.
    expect(line).toContain("canceling statement due to statement timeout");
  });

  /**
   * AND NOT ONE WORD OF THE VENDOR'S IN IT. The error this completion fails with carries the live
   * access token and the person's address where drizzle puts them, which is the one shape this
   * route's logging has to survive; the status reply behind it carries them too.
   */
  test("the line it leaves carries no token, no address and no scope list", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () =>
      ({
        status: "completed",
        userId: ACTOR,
        scopes: ["gmail.read"],
        token: TOKEN,
        context: { token: TOKEN },
        user_info: { email: EMAIL },
      }) as never;

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc", { completion: "rolls-back" }),
    );

    await expectRefusal(response, "not-recorded");
    expect(
      lines(said).find((text) =>
        text.includes("arcade-completion-not-recorded"),
      ),
    ).toBeDefined();
    expect(mentionsOf(said, TOKEN)).toEqual([]);
    expect(mentionsOf(said, EMAIL)).toEqual([]);
    expect(mentionsOf(await asDelivered(response), TOKEN)).toEqual([]);
  });

  /**
   * THE FALSE NEGATIVE, WHICH IS THE HALF THAT COSTS THE PERSON SOMETHING.
   *
   * The transaction committed and the call rejected anyway — a connection lost on the way back
   * from a COMMIT the server had already applied. The grant is live at the vendor AND written down
   * here. Told `not-recorded`, this person starts over and mints a second consent at the vendor
   * against a connection they already hold; the route has to ask the row the completion serializes
   * on instead of reading the throw as a verdict.
   */
  test("one that committed and then threw lands the person, and never says not-recorded", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc", { completion: "commits-then-throws" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(LANDING);
    expect(response.headers.get("location")).not.toContain("authorized=");

    // Because it IS recorded, which is the whole of why the sentence above would have been a lie.
    const { connections, events } = await written();
    expect({ connections: connections.length, events: events.length }).toEqual({
      connections: 1,
      events: 1,
    });
    const row = await attemptRow();
    expect(row?.outcome).toBe("completed");

    // And an operator is told, because a write that cannot report itself is still worth knowing.
    const line = lines(said).find((text) =>
      text.includes("arcade-completion-unacknowledged"),
    );
    expect(line).toBeDefined();
    expect(line).toContain(MINTED);
    expect(mentionsOf(said, TOKEN)).toEqual([]);
  });

  /**
   * AND THE BLANKET `catch` SPEAKS TOO. It stands over the reads that happen before the completion,
   * and it used to swallow every one of them in silence — a `Location` for the person and nothing
   * whatever for whoever has to work out why this route started refusing everybody. Its line says
   * which side of the completion it came from, because that is the one thing the person's refusal
   * code cannot distinguish.
   */
  test("a throw before the completion is logged as well as answered", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const [response, said] = await heard(() =>
      verify(ACTOR, "?flow_id=flow-abc", { attemptReadThrows: true }),
    );

    await expectRefusal(response, "not-recorded");
    const line = lines(said).find((text) =>
      text.includes("arcade-verify-failed"),
    );
    expect(line).toBeDefined();
    expect(line).toContain('"recorded":false');
    await expectNothingWritten();
  });
});

/**
 * THE COOKIE POLICY THIS ROUTE DEPENDS ON, AND NOTHING ELSE IN THE SUITE WOULD REPORT IT.
 *
 * `SameSite=Lax` is the one value that lets the session cookie travel on a top-level cross-site GET
 * navigation, which is exactly the leg a person makes coming back from the broker's consent screen.
 * `Strict` withholds it there and nowhere else: the verifier would find no session and send
 * everybody to sign-in, every other route would keep working, and no other test would fail. So the
 * policy is asserted through the deployment's OWN auth configuration — `getCookies` is what Better
 * Auth itself uses to build the attributes, so an override added under `advanced` is read here the
 * same way the browser would read it.
 */
test("the session cookie is SameSite=Lax, which is what lets it survive the return leg", () => {
  const config = loadConfig(testEnvironment({ OPENBOT_APP_URL: APP_URL }));
  const auth = createAuth(config, database);
  expect(getCookies(auth.options).sessionToken.attributes.sameSite).toBe("lax");
});
