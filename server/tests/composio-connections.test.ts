import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import type {
  CredentialSecretReader,
  CredentialStore,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agents,
  composioConnections,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import type { ComposioActions, ComposioResult } from "../src/plugins/composio";
import { useComposioClient } from "../src/plugins/composio";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * What ends a brokered connection, and what the trail says when nobody was asking.
 *
 * `composio_connections` is the sole gate on a brokered call: the row `(toolkit, user_id)` is the
 * whole of the permission, it points at no vault secret, and it references neither `users` nor
 * `mcp_servers`. Nothing therefore cascades it away, which is deliberate — the row has to outlive
 * the person so offboarding can still find it — and it means an explicit retirement is the ONLY
 * thing that can ever end one. This file is about the two acts that must perform that retirement
 * and about the trail they leave.
 *
 * WHY THIS FILE OWNS ITS IDS OUTRIGHT, AND SO NEEDS NO REFUSE-TO-RUN GUARD.
 * `plugin-store.integration.test.ts` inserts at `gmail`, `notion` and `bot_helper` and refuses to
 * run when a database already holds them: it asserts things about a real vendor's own action
 * classification, so its ids are forced to be the spellings production uses, and a fixture at a
 * forced id cannot coexist with a real row at that id. Nothing here asserts anything about a real
 * vendor — `accessFor` answers `brokered` for ANY row whose provenance column says composio, and
 * reads the app slug straight off the url — so every id below carries a run-unique suffix and every
 * delete is keyed on one. That makes each row this file removes provably one it inserted, which is
 * the property that guard buys the other way round, and it also lets this file run beside that one.
 *
 * The production deletes under test are keyed the same way: `removeServer` deletes by toolkit and
 * `retireConnectionsFor` by user id, and both of those values are suite-scoped here, so neither can
 * reach another run's rows either.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
/** The app: its `mcp_servers.id`, and the slug in its url, which is what a connection is keyed on. */
const toolkit = `revocable-${suite}`;
const actionName = "APP_FETCH_ITEMS";
const ref = `${toolkit}/${actionName}`;
const botId = `agent_revoke_${suite}`;
/** Somebody who connected the app. */
const askerId = `user_asker_${suite}`;
/** Somebody who connected it and whose `users` row is then deleted out from under the connection. */
const leaverId = `user_leaver_${suite}`;
/**
 * The same app under a display id that is NOT its slug, which is a legal row and an ordinary one.
 *
 * `mcp_servers.id` is what an operator sees and what a grant is written against; the slug in the
 * url is what the broker is asked about. Nothing holds the two equal, and every fixture above
 * spells them the same — which is exactly why a defect that only shows when they differ survived.
 */
const renamedId = `renamed-${suite}`;
const admin = "admin@openbot.local";

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/**
 * The vault, and every method loud.
 *
 * A brokered call reaches no credential at all — the deployment's Composio key belongs to the
 * transport and never travels through the store — and neither of the removals under test has a
 * secret of this suite's to retire, because no `mcp_user_token` is ever minted here. So any call to
 * any of these means this file has started exercising something it does not claim to, and a silent
 * stub would hide that.
 *
 * Typed as the interface rather than left to inference, so a method added to the vault fails here
 * instead of at the assignment further down. This file is not covered by `tsc` today — `tests` is
 * outside `server/tsconfig.json`'s `include` — which is exactly why the shape is stated rather than
 * assumed.
 */
const credentialsStub: CredentialSecretReader & CredentialStore = {
  readSecret: async () => {
    throw new Error("a brokered call reads no credential");
  },
  create: async () => {
    throw new Error("this suite does not write credentials");
  },
  updateSecret: async () => {
    throw new Error("this suite does not write credentials");
  },
  rotate: async () => {
    throw new Error("this suite does not write credentials");
  },
  revoke: async () => {
    throw new Error("this suite mints no credential to revoke");
  },
  isLive: async () => {
    throw new Error("this suite holds no credential to ask about");
  },
  findLiveByKey: async () => {
    throw new Error("this suite holds no credential to ask about");
  },
};

/**
 * A store over the real database, keeping every event it writes.
 *
 * Recorded ALONGSIDE the real insert rather than instead of it: the payloads are what these tests
 * assert about, and a store whose audit insert never touched the database would not be exercising
 * the one it has.
 */
const events: Parameters<ReturnType<typeof createAuditStore>["insert"]>[0][] =
  [];
const persisting = createAuditStore(database);
const auditStore = {
  insert: async (event: (typeof events)[number]) => {
    events.push(event);
    await persisting.insert(event);
  },
};

const store = createPluginStore({
  database,
  auditStore,
  credentials: credentialsStub,
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

/** Every action Composio was asked to run, so "was this call made" is an assertion and not a guess. */
const reached: string[] = [];

const answered: ComposioResult = { data: {}, error: null, successful: true };

/**
 * A client that answers everything, so a refusal in these tests is always this deployment's.
 *
 * The vendor is a process-wide registry, so `afterEach` takes it back out: a stub outliving its test
 * would be answering another file's calls.
 */
function useAnsweringClient(actions: Partial<ComposioActions> = {}) {
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return answered;
    },
    ...actions,
  });
}

/** Only this run's rows, and every one of them keyed on an id this run invented. */
async function clean() {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, botId));
  await database.delete(agents).where(eq(agents.id, botId));
  await database
    .delete(mcpTools)
    .where(inArray(mcpTools.serverId, [toolkit, renamedId]));
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [toolkit, renamedId]));
  await database
    .delete(composioConnections)
    .where(eq(composioConnections.toolkit, toolkit));
  await database.delete(users).where(inArray(users.id, [askerId, leaverId]));
}

/** The app's row and its one granted action. Separated from the Bot, so a re-add can reuse the Bot. */
async function addApp() {
  await database.insert(mcpServers).values({
    id: toolkit,
    title: "Revocable App",
    vendor: "Composio",
    url: `composio://${toolkit}`,
    provenance: "composio",
  });
  await database.insert(mcpTools).values({
    serverId: toolkit,
    name: actionName,
    description: "Fetch some items.",
    effect: "read",
    version: "20260903_00",
  });
  await store.grant("mcp", ref, botId, admin);
}

/** The app, a Bot holding its one action, and optionally somebody who has connected it. */
async function seedApp(options: { connect?: boolean } = {}) {
  await database.insert(agents).values({
    id: botId,
    name: "Helper",
    type: "built_in",
    configuration: {},
  });
  await addApp();
  if (options.connect !== false) {
    await database
      .insert(composioConnections)
      .values({ toolkit, userId: askerId });
  }
}

/** What this deployment still believes somebody has connected. */
async function connectedToolkitsFor(userId: string): Promise<string[]> {
  const rows = await database
    .select({ toolkit: composioConnections.toolkit })
    .from(composioConnections)
    .where(eq(composioConnections.userId, userId));
  return rows.map((row) => row.toolkit);
}

function recordedOfType(eventType: string) {
  return events.filter((event) => event.eventType === eventType);
}

// Cleaning BEFORE each test as well as after the run, so a run that dies halfway leaves the next
// one nothing to trip over.
beforeEach(async () => {
  await clean();
  events.length = 0;
  reached.length = 0;
});

afterEach(() => useComposioClient(null));

afterAll(async () => {
  await clean();
});

/**
 * OFFBOARDING. The act an administrator is told removes somebody's access.
 *
 * The call is made first, so what follows is an assertion about the retirement rather than about the
 * fixture. Reaching the vendor a second time would be the person's mailbox being opened after they
 * were removed.
 */
test("offboarding somebody retires the app they connected, and the next call is refused", async () => {
  await seedApp();
  useAnsweringClient();

  await store.callTool({ ref, args: {}, botId, actorId: askerId });
  expect(reached).toEqual([actionName]);

  const { retired } = await store.retireConnectionsFor(askerId, admin);

  // Counted, because the number is what "we removed their access" claims. Reporting the vault's
  // tally alone would say nothing was retired for somebody whose only connector was brokered.
  expect(retired).toBe(1);
  expect(await connectedToolkitsFor(askerId)).toEqual([]);

  await expect(
    store.callTool({ ref, args: {}, botId, actorId: askerId }),
  ).rejects.toThrow(/have not connected/i);
  expect(reached).toEqual([actionName]);

  const disconnected = recordedOfType("mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0].payload).toMatchObject({
    actor: admin,
    server: toolkit,
    owner: askerId,
    // An administrator removing somebody, never somebody changing their own mind. And the account
    // at the broker is still connected: this closed the gate, it did not revoke anything at
    // Composio.
    reason: "person_removed",
    vendorRevoked: false,
  });
});

/**
 * THE GATE, AFTER THE PERSON IS GONE.
 *
 * `composio_connections.user_id` carries no foreign key by design, so deleting somebody's `users`
 * row leaves their connection standing — and the gate reads nothing but `(toolkit, user_id)`, so it
 * goes on passing for an id no person answers to. That is the state offboarding exists to end, and
 * it is the one the vault-based retirement cannot reach: there is no secret here to scan for,
 * because Composio holds the account.
 */
test("a connection whose person is already deleted is retired, and stops passing the gate", async () => {
  await seedApp({ connect: false });
  useAnsweringClient();

  await database
    .insert(users)
    .values({ id: leaverId, email: `${leaverId}@example.com`, name: "Leaver" });
  await database
    .insert(composioConnections)
    .values({ toolkit, userId: leaverId });
  await database.delete(users).where(eq(users.id, leaverId));

  // The design fact this rests on: the row outlives the person, which is what leaves anything to
  // find. Asserted rather than assumed, because the retirement below is pointless without it.
  expect(await connectedToolkitsFor(leaverId)).toEqual([toolkit]);

  const { retired } = await store.retireConnectionsFor(leaverId, admin);
  expect(retired).toBe(1);
  expect(await connectedToolkitsFor(leaverId)).toEqual([]);

  await expect(
    store.callTool({ ref, args: {}, botId, actorId: leaverId }),
  ).rejects.toThrow(/have not connected/i);
  expect(reached).toEqual([]);
});

/** Retiring twice is something an administrator may legitimately do, and the second time is quiet. */
test("retiring the same person twice retires nothing the second time", async () => {
  await seedApp();
  useAnsweringClient();

  expect((await store.retireConnectionsFor(askerId, admin)).retired).toBe(1);
  expect((await store.retireConnectionsFor(askerId, admin)).retired).toBe(0);
});

/**
 * THE ANONYMOUS ACTOR OWNS NOTHING, and `notNull` does not exclude the empty string, so a row at
 * `(toolkit, "")` is legal. Retiring "nobody" must not be what deletes it — that would be an
 * unattributed offboarding reaching a row it cannot possibly own.
 *
 * WHOSE ROW THIS IS, since the actor half of the key names nobody. The app half does: {@link
 * toolkit} carries this run's suffix, so the sweep in `clean` takes this row by the same clause it
 * takes the asker's by, and no other file can arrive at the pair by guessing. That is the whole of
 * the ownership — a delete keyed on `user_id = ''` alone would reach every app's anonymous row at
 * once, which is how this fixture came to be removed mid-run by another file, and how a run of
 * this file that died before its cleanup came to refuse every test in that one.
 */
test("retiring nobody retires nothing and leaves the anonymous row alone", async () => {
  await seedApp({ connect: false });
  await database.insert(composioConnections).values({ toolkit, userId: "" });

  expect((await store.retireConnectionsFor("", admin)).retired).toBe(0);
  expect(await connectedToolkitsFor("")).toEqual([toolkit]);
});

/**
 * The fixture above is taken back by the same sweep every other row here is, and by nothing wider.
 *
 * CRITERION. After the sweep, this run holds no `composio_connections` row at all — the one at the
 * anonymous actor included, which none of the person ids that sweep names would reach.
 *
 * REASON. Brokered connections are removed here by toolkit, so the anonymous row is already
 * covered and needs no second, broader delete to reach it. Asserted rather than read off the code,
 * because the tempting spelling for "take the anonymous row too" is `user_id = ''`, which is every
 * app at once: the sweep that lands on another file's fixture. A test that reddens the moment this
 * file needs a wider delete is what keeps that spelling out.
 */
test("the sweep takes this run's anonymous row without reaching by actor", async () => {
  await seedApp({ connect: false });
  await database.insert(composioConnections).values({ toolkit, userId: "" });
  expect(await connectedToolkitsFor("")).toEqual([toolkit]);

  await clean();

  expect(
    await database
      .select({ userId: composioConnections.userId })
      .from(composioConnections)
      .where(eq(composioConnections.toolkit, toolkit)),
  ).toEqual([]);
});

/**
 * REMOVING THE APP. The second act that has to end a brokered connection.
 *
 * Nothing else can: the table references `mcp_servers` no more than it references `users`, so the
 * rows simply stand there once the app's row is gone.
 */
test("removing the app takes every brokered connection to it", async () => {
  await seedApp();
  useAnsweringClient();

  await store.callTool({ ref, args: {}, botId, actorId: askerId });

  await store.removeServer(toolkit, admin);

  expect(await connectedToolkitsFor(askerId)).toEqual([]);

  const disconnected = recordedOfType("mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0].payload).toMatchObject({
    actor: admin,
    server: toolkit,
    owner: askerId,
    // An administrator took the whole app away and the person did nothing. Distinct from both
    // "they disconnected" and "they were removed", which is what an auditor is trying to tell apart.
    reason: "mcp_server_removed",
    vendorRevoked: false,
  });
});

/**
 * ONE KEY FOR "WHAT HAPPENED TO THIS PERSON'S ACCESS", across both acts that can end it.
 *
 * CRITERION. Every `mcp.account_disconnected` row a brokered connection produces names the APP at
 * the broker — in `targetId` and in `payload.server` — whichever act produced it.
 *
 * REASON. The two acts were written in different waves and keyed differently. Offboarding files
 * under `connection.toolkit`, which is all a connection row records and all that is left once the
 * server row is gone. Removing the app filed under the `mcp_servers` id. Where the two spellings
 * agree — which they do in every other fixture in this file, and in the product whenever nobody
 * renamed anything — the disagreement is invisible; where they differ, no single query answers
 * what happened to one person's access, because half the rows are filed under a name the other
 * half never mentions.
 *
 * THE APP IS THE RIGHT KEY, not the row id. A brokered connection is consent to an app: the gate
 * is `(toolkit, user_id)`, `removeServer` clears it by toolkit, and the row outlives the
 * `mcp_servers` row entirely — so the id is not always available and is never what was consented
 * to. Which server row was removed is not lost either: the `configuration.changed` row written in
 * the same call names it.
 */
test("both acts that end a brokered connection file it under the app", async () => {
  await database.insert(agents).values({
    id: botId,
    name: "Helper",
    type: "built_in",
    configuration: {},
  });
  // The row id and the app slug deliberately different, which is the only shape that can tell the
  // two keys apart.
  await database.insert(mcpServers).values({
    id: renamedId,
    title: "Revocable App",
    vendor: "Composio",
    url: `composio://${toolkit}`,
    provenance: "composio",
  });
  await database.insert(composioConnections).values([
    { toolkit, userId: askerId },
    { toolkit, userId: leaverId },
  ]);

  // Offboarding one person, then removing the app out from under the other.
  expect((await store.retireConnectionsFor(leaverId, admin)).retired).toBe(1);
  await store.removeServer(renamedId, admin);

  const disconnected = recordedOfType("mcp.account_disconnected");
  expect(disconnected).toHaveLength(2);
  // Both rows, under one key. Asked as the set of keys rather than row by row, because what the
  // criterion is about is a query finding all of them at once.
  expect(new Set(disconnected.map((event) => event.targetId))).toEqual(
    new Set([toolkit]),
  );
  expect(
    new Set(
      disconnected.map((event) => (event.payload as { server: string }).server),
    ),
  ).toEqual(new Set([toolkit]));

  // And each still says which person and which of the three things happened to them, which is the
  // other half of the question and was never the part that was wrong.
  expect(
    disconnected
      .map((event) => event.payload as { owner: string; reason: string })
      .map(({ owner, reason }) => ({ owner, reason }))
      .sort((left, right) => left.owner.localeCompare(right.owner)),
  ).toEqual([
    { owner: askerId, reason: "mcp_server_removed" },
    { owner: leaverId, reason: "person_removed" },
  ]);
});

/**
 * CONSENT MUST NOT REATTACH.
 *
 * Removing an app and adding it back is two ordinary administrative acts. If the connection rows
 * survive them, the second act silently restores everybody's brokered access without anybody being
 * asked again — and the only visible difference between an app nobody has connected and an app
 * everybody is still connected to is whether a call goes out.
 */
test("adding the app back does not restore a connection nobody re-granted", async () => {
  await seedApp();
  useAnsweringClient();

  await store.callTool({ ref, args: {}, botId, actorId: askerId });
  expect(reached).toEqual([actionName]);

  await store.removeServer(toolkit, admin);
  // The same app at the same id, added again. Only the server and its action: the Bot's grant
  // survived the removal on its own, which is a separate defect about `plugin_grants` and not this
  // one.
  await addApp();

  await expect(
    store.callTool({ ref, args: {}, botId, actorId: askerId }),
  ).rejects.toThrow(/have not connected/i);
  expect(reached).toEqual([actionName]);
});

/**
 * THE TRAIL, WHERE NOBODY WAS ASKING.
 *
 * An empty string in a field whose purpose is to name who did something is worse than an absent
 * field: it reads as a value, and a reader counting rows by actor gets a person called "".
 *
 * `reachedAs` and `actor` are the two on this row, and both are the run's actor verbatim. A brokered
 * app is reached AS THE PERSON, so a run nobody could be attributed to has no name to put in either
 * — and the refusal is recorded, which is exactly when the trail matters.
 */
test("an unattributed run is recorded as unattributed rather than as a blank", async () => {
  await seedApp();
  useAnsweringClient();

  await expect(
    store.callTool({ ref, args: {}, botId, actorId: "" }),
  ).rejects.toThrow(/not attributed to anybody/i);
  expect(reached).toEqual([]);

  const failed = recordedOfType("mcp.call_failed");
  expect(failed).toHaveLength(1);
  expect(failed[0].payload).toMatchObject({
    actor: "unattributed",
    reachedAs: "unattributed",
  });
  // Not "deployment" either: this call did not go out on a shared credential, it did not go out at
  // all, and saying the deployment reached the app would assert an attribution that never happened.
  expect(failed[0].payload.reachedAs).not.toBe("deployment");
});

/**
 * THE TRAIL, WHERE THE DEPLOYMENT WAS THE ONE ACTING.
 *
 * `refreshTools` defaults its actor to the empty string, and `addServer` and `addCustomServer` both
 * take that default — deliberately, because that argument doubles as the credential to list with and
 * nobody can have connected an app in the moment it is added. So the absence is real and permanent,
 * and what the trail owes a reader is the distinction: not a person, and not nobody either, but the
 * deployment refreshing on its own behalf. `reachedAs` already spells that "deployment".
 */
test("the refresh that follows an add is attributed to the deployment", async () => {
  await seedApp();
  // A different action, so the granted one is left held and not advertised — which is the audit row
  // under test.
  useAnsweringClient({
    listActions: async () => [
      {
        slug: "APP_SOMETHING_ELSE",
        description: "Not the one anybody holds.",
        version: "20260903_00",
      },
    ],
  });

  // No actor, which is exactly what the add path passes.
  await store.refreshTools(toolkit);

  const stranded = events.filter(
    (event) =>
      (event.payload as { change?: string }).change === "grants_not_advertised",
  );
  expect(stranded).toHaveLength(1);
  expect(stranded[0].payload).toMatchObject({
    actor: "deployment",
    refs: [ref],
  });
});
