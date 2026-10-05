import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCPMock, type MCPToolDefinition } from "@copilotkit/aimock/mcp";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import {
  type CredentialStoreValue,
  createCredentialStore,
  decryptSecret,
  encryptSecret,
} from "../src/credentials";
import { createDatabase, type Database } from "../src/db/client";
import {
  agents,
  auditEvents,
  composioConnections,
  credentials as credentialRows,
  credentials,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import {
  accessFor,
  CatalogueTransportUnroutableError,
  ServerRowAmbiguousError,
} from "../src/plugins/access";
import type { BrokerConnection, ComposioBroker } from "../src/plugins/broker";
import type { CatalogueEntry } from "../src/plugins/catalogue";
import { catalogueEntry } from "../src/plugins/catalogue";
import {
  type ComposioResult,
  useComposioClient,
} from "../src/plugins/composio";
import { redirectUriFor } from "../src/plugins/oauth";
import {
  type AccessToken,
  CustomServerRefusedError,
  createPluginStore,
  exchangeRefreshTokenOverHttp,
  INVALID_CLIENT,
  isDeploymentFault,
  type OAuthClient,
  PluginInvariantError,
  PluginRefusedError,
  type PluginStore,
  TokenRefusedError,
  unlistedAdvertisedTools,
} from "../src/plugins/store";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The two questions a tool call has to pass, and the row each answer leaves behind.
 *
 * The refusals are the property under test. A call that succeeds proves the plumbing works; a call
 * that is refused proves the governance does. Both refusals here stop before any network call, which
 * is itself the property being asserted: a tool a Bot was never given must not reach the vault or
 * the vendor, so there is nothing to stub.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

const suite = randomUUID().slice(0, 8);
const holderId = `agent_plugin_holder_${suite}`;
const strangerId = `agent_plugin_stranger_${suite}`;
const serverId = "google-drive";
const toolName = "search_files";
const ref = `${serverId}/${toolName}`;
/** A tool on the same server that nobody is granted. Suite-scoped, so it is never a real one. */
const siblingToolName = `not_granted_${suite}`;

let policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/**
 * Whether THIS RUN is what put the server row there, and so is what should take it away.
 *
 * The id is a real catalogue key rather than a suite-scoped one, because what is under test includes
 * the vendor's own read/write classification. On a database somebody is using, that key is their
 * configured server, so it is removed only when the test is what created it.
 *
 * Which is why the flag counts creations rather than the absences it used to. `afterAll` runs even
 * when a `beforeAll` above it has thrown, and every flag is then still sitting at its initialiser —
 * so a teardown must not be authorised by a setup that never completed. Only a capture that ran and
 * found the row missing can write the value the delete needs; `false` covers both "the deployment
 * already had it" and "nobody ever looked", and neither of those is this suite's row to remove.
 */
let suiteCreatedServerRow = false;
/**
 * Whether THIS RUN is what advertised the tool, and so is what should stop advertising it.
 *
 * The vendor really does advertise `search_files`, so the row may be a refreshed fact about the
 * vendor rather than the suite's fixture. Deleting by name regardless would take a real one; leaving
 * it always would leave a fixture that reads on screen as a tool the vendor offers.
 *
 * Set the same way round as {@link suiteCreatedServerRow} and for the same reason: the delete waits
 * on evidence that this run inserted the row, not on the mere absence of evidence that somebody else
 * did.
 */
let suiteCreatedToolRow = false;

const revokedCredentialIds: string[] = [];
const issuedCredentialIds: string[] = [];
/*
 * The exact fixtures a removal test attempted, so `afterAll` can take them away without going
 * back through `removeServer` — which is itself under test, and so cannot be what teardown
 * depends on. Written at the attempt rather than at the success, because a setup that failed
 * partway leaves rows behind too.
 */
const removalServerIds = new Set<string>();
const removalUserIds = new Set<string>();

/**
 * The vault, stubbed, shared by every store in this file that does not need a real one.
 *
 * Named rather than inlined into the store below so that {@link freshStore} passes the SAME stub:
 * a second copy would be a second place for "no credential is read here" to stop being true, and the
 * refusals below are what make that claim worth anything.
 */
const credentialsStub = {
  // No credential is ever read in these tests, because every call is refused before the vault.
  readSecret: async () => null,
  // Nor written in place. Loud rather than absent: a call reaching either of these would mean
  // this file had started exercising something it does not claim to, and a silent no-op would
  // hide that.
  create: async () => {
    throw new Error("this suite does not write credentials");
  },
  updateSecret: async () => {
    throw new Error("this suite does not write credentials");
  },
  // `removeServer` does revoke: it retires the token the server was configured with so a re-add
  // does not collide on `credentials_active_key_idx`. The stamp goes to the real row, because
  // `removeServer` reads liveness from the table before deciding whether to revoke at all.
  revoke: async (id: string) => {
    const revokedAt = new Date();
    await database
      .update(credentialRows)
      .set({ revokedAt, updatedAt: revokedAt })
      .where(eq(credentialRows.id, id));
    revokedCredentialIds.push(id);
    return revokedAt;
  },
};

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: credentialsStub,
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

/**
 * When this run began, by the DATABASE's clock, so every audit query can exclude what came before.
 *
 * The trail is the one table this file cannot tidy up after itself: `audit_events` is append-only,
 * and 0012 closed the last way around that, so every row every previous run wrote is still there and
 * still matches. The refusals are recorded against `google-drive/search_files` and named by rules
 * about `google-drive` — production spellings, forced for the same reason the fixtures are — so a
 * query narrowed only by target and rule matches nine hundred rows this run had nothing to do with,
 * and an assertion that one exists is answered by a run that finished yesterday. That is a test
 * which cannot fail: deleting the code that writes the row would leave it green.
 *
 * Postgres's clock rather than this process's, because the two are not the same clock and the
 * comparison happens against a column the server stamps.
 *
 * Read through {@link sinceThisRun}, which refuses rather than defaulting: a bound of "the beginning
 * of time" is the unscoped query back again, silently.
 */
let runStartedAt: Date | null = null;

function sinceThisRun() {
  if (!runStartedAt) {
    throw new Error(
      "the run's start was never recorded, so no audit query can be narrowed to it",
    );
  }
  return gte(auditEvents.createdAt, runStartedAt);
}

async function auditRowsFor(targetId: string, botId: string, actorId: string) {
  return database
    .select({
      eventType: auditEvents.eventType,
      payload: auditEvents.payload,
      initiatorKind: auditEvents.initiatorKind,
      initiatorId: auditEvents.initiatorId,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "mcp_tool"),
        eq(auditEvents.targetId, targetId),
        sinceThisRun(),
        eq(sql<string>`${auditEvents.payload} ->> 'bot'`, botId),
        eq(sql<string>`${auditEvents.payload} ->> 'actor'`, actorId),
      ),
    );
}

/**
 * Whether the guard below cleared this run to own the ids the Composio fixtures insert at.
 *
 * Read by the `afterAll` that removes those rows. A run the guard refused must not delete the rows
 * it refused over, and `afterAll` still runs after a `beforeAll` has thrown.
 */
let ownsFixtureIds = false;

/*
 * Refuse to run at all against a database that already holds the ids this suite inserts at.
 *
 * The suites above own suite-scoped ids and only ever READ the deployment's own rows, so skipping a
 * delete is enough for them — that is what `suiteCreatedServerRow` and its siblings are for.
 * The fixtures in this file cannot do that: they INSERT at `gmail`, `notion`, `bot_helper` and
 * `user_asker`, and those ids are not a choice. `gmail` is the toolkit slug that gets sent to
 * Composio. `notion` is fixed twice over: the dynamic-registration suite pins `dynamicServerId` to
 * it because that is the catalogue entry which registers its own client, and the test for an action
 * listed before the effect columns existed inserts a `notion` server row directly, because a
 * first-party row is what it is about. A fixture that inserts at an id cannot coexist with a real
 * row at that id: skipping the delete would only turn the collision into a primary-key conflict,
 * and capture-and-restore would be a lot of machinery whose failure mode is destroying the thing
 * it protects, because the cascade has already run by the time it restores.
 *
 * What the cascade takes is why this is a refusal rather than a warning. `mcp_user_credentials`
 * references `mcp_servers.id`, so removing a real `notion` row takes every person's per-user
 * credential row with it and leaves their encrypted vault rows referenced by nothing — unreachable
 * from any screen and invisible to `retireConnectionsFor`, which exists to stop exactly that state.
 * Removing a real Bot takes six tables: its channel memberships, its agent profile, everyone's
 * preferences for it, its routines and all of their run history, its component exclusions and its
 * plugin grants. Removing a real PERSON takes ten: their sign-in accounts and live sessions, their
 * roles, their channel memberships and intelligence mappings, their per-Bot preferences and written
 * instructions, their skills, their routines, and every per-user connector credential they hold —
 * and nulls the owner off their agent profiles and SSO provider besides. The fixtures then re-insert
 * byte-identical look-alikes, so nothing on screen would say it happened.
 *
 * The list below is every table this file deletes from at an id it did not invent — an id spelled
 * the way production spells it, so a row already sitting at it belongs to somebody else. Each of
 * `mcp_servers`, `agents`, `composio_connections` and `users` is asked about here, and nothing else
 * needs to be: `mcp_tools` and `plugin_grants` are the two remaining unconditional deletes and both
 * are reached only by a key that references one of these four — `mcp_tools.server_id` names a
 * server, `plugin_grants.agent_id` names a Bot — so a row at either could not exist without the
 * guard having already refused over its parent. Every other delete in this file names an id
 * carrying {@link suite}, and the reads that touch the deployment's own `google-drive` row skip
 * their delete instead, on the {@link suiteCreatedServerRow} flags above.
 *
 * So the deletes in {@link freshDatabase} are authorised by {@link ownsFixtureIds} and this is what
 * makes them safe.
 */
/**
 * Every `composio_connections` row this file may claim, as one clause used by all three sites.
 *
 * CRITERION. The pair set is an app crossed with a person: `gmail` or `linear`, held by
 * `user_asker`, by `user_leaver` or by the anonymous actor. The refuse-to-run guard, the per-test
 * sweep and the teardown ask exactly that question and nothing wider, and a fixture written at a
 * pair outside the cross has to widen one clause rather than three.
 *
 * A CROSS RATHER THAN A LIST, so it is a little wider than what the fixtures actually write — no
 * test here connects `user_asker` to `linear`. That is deliberate and it is safe in this one
 * direction: the guard runs first and has already established that no row sits anywhere in the
 * cross, so every pair the sweep and the teardown delete is a pair this run put there.
 *
 * REASON. They disagreed. The guard and the sweep asked by person across every app; one test's
 * cleanup asked by the anonymous actor across every app; the pair `("gmail", "")` was in none of
 * them. So the file refused to run on rows it does not create, deleted rows it did not create, and
 * left behind one that it did — three faces of one confusion about what makes a row this file's.
 * The app is half the answer: every row here is at a real app, because a Composio app IS its
 * toolkit slug and this file asserts things about the real ones — so naming the person alone
 * claims that person's rows at every other app as well.
 */
function ownedConnections() {
  return and(
    inArray(composioConnections.toolkit, ["gmail", "linear"]),
    inArray(composioConnections.userId, ["user_asker", "user_leaver", ""]),
  );
}

beforeAll(async () => {
  /*
   * Stamped here, in the first hook the file registers, so no row this run writes is older than it
   * and no row an earlier run wrote is newer.
   */
  const [clock] = await database.execute<{ now: Date }>(
    sql`select now() as now`,
  );
  if (!clock) throw new Error("the database would not say what time it is");
  runStartedAt = clock.now;

  /*
   * ONE AT A TIME RATHER THAN `Promise.all`, and the reason is the driver rather than the queries.
   *
   * {@link TEST_POOL} holds two connections, so four reads issued together are pipelined two to a
   * connection, and Bun's postgres client names its prepared statements from the query text it is
   * given. Two of these four collide on that name: the five-parameter `composio_connections` read
   * binds against the statement prepared for the one-parameter `agents` read and Postgres refuses
   * with `bind message supplies 5 parameters, but prepared statement ... requires 1`. The guard
   * then throws out of the file's first hook, which takes every test in the file with it and
   * reports as one unnamed failure with no test name in it.
   *
   * Nothing here is waiting on anything else and four sequential reads of four empty tables cost
   * milliseconds, so there was never anything to win by issuing them together.
   */
  const configuredServers = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(inArray(mcpServers.id, ["gmail", "notion"]));

  const existingBots = await database
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, "bot_helper"));

  /*
   * Brokered connections, keyed on the PAIR rather than on the person.
   *
   * CRITERION. This guard refuses on {@link ownedConnections} — two real apps crossed with
   * three people — and on no other `composio_connections` row, because every pair this file
   * inserts and every pair it deletes is inside that cross.
   *
   * REASON. Every connection row this file writes is at a real app, `gmail` or `linear` — the
   * two people it invents and the anonymous actor alike — so the app is half of what makes a
   * row this file's, and asking by person alone claims rows at every other app as well. Both
   * spellings of that over-reach have already cost something. `user_id = ''` caught the
   * anonymous row `composio-connections.test.ts` writes against its own run-suffixed app, so a
   * run of that file killed before its cleanup refused every test here for good; `user_id IN
   * (asker, leaver)` claims a `("slack", "user_asker")` row the same way, and `freshDatabase`
   * would then DELETE it — a `composio_connections` row is the entire gate on a brokered
   * call, and nothing else can find it again.
   *
   * The anonymous actor is one of the three people because `user_id` is notNull and notNull
   * does not exclude the empty string, so `("gmail", "")` is a row a deployment can legally
   * hold, which is the whole point of the test that inserts one.
   */
  const existingConnections = await database
    .select({
      toolkit: composioConnections.toolkit,
      userId: composioConnections.userId,
    })
    .from(composioConnections)
    .where(ownedConnections());

  /*
   * The person, who was missing from this guard entirely.
   *
   * `user_leaver` is inserted at and deleted at by the Composio fixtures, and the delete used to
   * run whatever the guard had decided — so a real row at that id was removed, with the ten
   * cascades above behind it, on a run the guard had already refused.
   */
  const existingPeople = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, "user_leaver"));

  const found = [
    ...configuredServers.map((row) => `the mcp_servers row '${row.id}'`),
    ...existingBots.map((row) => `the Bot '${row.id}'`),
    ...existingConnections.map(
      (row) =>
        `the composio_connections row ('${row.toolkit}', '${row.userId}')`,
    ),
    ...existingPeople.map((row) => `the person '${row.id}'`),
  ];

  if (found.length > 0) {
    throw new Error(
      `This suite owns ${found.join(", ")} outright — it inserts at those exact ids and deletes ` +
        "them before every test — and refuses to run against a database that already has them, " +
        "because deleting a real server row takes every person's per-user credentials with it, " +
        "deleting a real Bot takes the six tables behind it, and deleting a real person takes the " +
        "ten behind them. Point TEST_DATABASE_URL at a scratch database.",
    );
  }

  ownsFixtureIds = true;
});

beforeAll(async () => {
  for (const id of [holderId, strangerId]) {
    await database
      .insert(agents)
      .values({
        id,
        name: id,
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();
  }

  suiteCreatedServerRow =
    (
      await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
    ).length === 0;

  suiteCreatedToolRow =
    (
      await database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        )
    ).length === 0;

  // The server row is written directly rather than through addServer, so the test needs no vendor
  // to be reachable. What is under test is the decision, not the listing.
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Google Drive",
      vendor: "Google",
      url: "https://www.googleapis.com/drive/v3",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({ serverId, name: toolName, description: "Search files." })
    .onConflictDoNothing();
  /*
   * A second tool on the SAME server, granted to nobody.
   *
   * `listForAgent` narrows to the servers a Bot holds something from and then matches the exact ref,
   * and this is what makes the second half load-bearing: without it, holding one tool from a server
   * would offer every tool that server has. Suite-scoped, so it is unambiguously a fixture and
   * cannot collide with a name the vendor really advertises.
   */
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: siblingToolName,
      description: "A tool on the same server that nobody was granted.",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  // removeServer is under test, so teardown must not depend on it succeeding. Delete the exact
  // attempted fixtures before their credentials, including when setup failed partway through.
  if (removalServerIds.size > 0) {
    await database
      .delete(mcpServers)
      .where(inArray(mcpServers.id, [...removalServerIds]));
  }
  if (removalUserIds.size > 0) {
    await database.delete(users).where(inArray(users.id, [...removalUserIds]));
  }
  /*
   * Scoped to this suite's own Bots, never to the ref alone.
   *
   * `ref` names a REAL server and a real tool — `google-drive/search_files` — so a delete by ref
   * matches every grant in the deployment, including the ones an administrator made for a Bot people
   * use. This suite did exactly that once: it ran, and a Bot silently stopped being able to search
   * Drive, with an audit row showing the grant had been made and nothing showing it removed.
   *
   * The primary key is (kind, ref, agent_id). Two of the three are not a row.
   */
  await database
    .delete(pluginGrants)
    .where(
      and(
        eq(pluginGrants.ref, ref),
        inArray(pluginGrants.agentId, [holderId, strangerId]),
      ),
    );
  // Suite-scoped, so it is this suite's whatever else is true of the server.
  await database
    .delete(mcpTools)
    .where(
      and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, siblingToolName)),
    );
  // A server row is deployment configuration, so it belongs to the deployment rather than here.
  // The fixture tool goes whether or not this suite owns the server, but only if it put it there.
  if (suiteCreatedToolRow) {
    await database
      .delete(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
  }
  if (suiteCreatedServerRow) {
    await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
  await database.delete(agents).where(eq(agents.id, holderId));
  await database.delete(agents).where(eq(agents.id, strangerId));
  for (const id of issuedCredentialIds) {
    await database.delete(credentialRows).where(eq(credentialRows.id, id));
  }
});

describe("a grant is the permission", () => {
  test("a Bot that was never granted a tool is refused, and the refusal is recorded", async () => {
    const actorId = `audit-call-${randomUUID()}@openbot.local`;
    await expect(
      store.callTool({
        ref,
        args: {},
        botId: strangerId,
        actorId,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const rows = await auditRowsFor(ref, strangerId, actorId);
    const rejected = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { bot?: string }).bot === strangerId,
    );
    expect(rejected.length).toBe(1);
    expect((rejected[0].payload as { refusal?: string }).refusal).toBe(
      "not_granted",
    );
  });

  test("a refusal names the routine that asked, not only the person it ran as", async () => {
    const actorId = `audit-call-${randomUUID()}@openbot.local`;
    await expect(
      store.callTool({
        ref,
        args: {},
        botId: strangerId,
        actorId,
        initiator: { kind: "routine", id: "routine_standup" },
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const rows = await auditRowsFor(ref, strangerId, actorId);
    const rejected = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { bot?: string }).bot === strangerId &&
        row.initiatorKind === "routine",
    );
    expect(rejected.length).toBe(1);
    expect(rejected[0].initiatorId).toBe("routine_standup");
  });

  test("a call nobody said anything about is still filed as a person's", async () => {
    const actorId = `audit-call-${randomUUID()}@openbot.local`;
    await expect(
      store.callTool({
        ref,
        args: {},
        botId: strangerId,
        actorId,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const rows = await auditRowsFor(ref, strangerId, actorId);
    expect(
      rows.filter(
        (row) =>
          row.eventType === "mcp.call_rejected" &&
          row.initiatorKind === "person" &&
          row.initiatorId === null,
      ),
    ).toHaveLength(1);
  });

  test("granting lets the same Bot past the grant check", async () => {
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    const decision = await store.decide("mcp", ref, holderId);
    expect(decision.allowed).toBe(true);
  });

  test("revoking takes it away again", async () => {
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    await store.revoke("mcp", ref, holderId, "admin@openbot.local");
    const decision = await store.decide("mcp", ref, holderId);
    expect(decision.allowed).toBe(false);
  });

  test("a Bot is offered exactly what it holds", async () => {
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    const held = await store.listForAgent(holderId);
    expect(held.tools.map((tool) => tool.ref)).toEqual([ref]);
    // The name the model is offered, which may not contain a slash.
    expect(held.tools[0].toolName).toBe("mcp__google-drive__search_files");

    const nothing = await store.listForAgent(strangerId);
    expect(nothing.tools).toEqual([]);
    expect(nothing.skills).toEqual([]);
  });

  test("holding one tool from a server does not offer that server's others", async () => {
    /*
     * The property the exact-ref match protects, now that the query narrows by server rather than
     * reading the whole catalogue. Widening this to "every tool on a server you hold anything from"
     * would pass every other test in this file: the Bot would still be offered what it holds, and the
     * stranger would still be offered nothing.
     */
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    const held = await store.listForAgent(holderId);

    expect(held.tools.map((tool) => tool.ref)).toEqual([ref]);
    expect(held.tools.map((tool) => tool.ref)).not.toContain(
      `${serverId}/${siblingToolName}`,
    );
  });
});

describe("the policy is asked as well as the grant", () => {
  test("credential material is refused and never copied into the audit trail", async () => {
    const actorId = `audit-call-${randomUUID()}@openbot.local`;
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    const secret = `sk-${"z".repeat(32)}`;

    await expect(
      store.callTool({
        ref,
        args: { query: "quarterly report", nested: { apiKey: secret } },
        botId: holderId,
        actorId,
      }),
    ).rejects.toThrow("credential material");

    const rows = await auditRowsFor(ref, holderId, actorId);
    const rejected = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { bot?: string }).bot === holderId &&
        (row.payload as { refusal?: string }).refusal ===
          "sensitive_tool_arguments",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload).toMatchObject({
      bot: holderId,
      decision: { carriedOut: false },
      contentInspection: {
        reason: "sensitive_content",
        findings: [{ category: "credential_field", path: "$.nested.apiKey" }],
      },
    });
    expect(JSON.stringify(rejected)).not.toContain(secret);
  });

  test("a granted tool is still refused by a deny rule, and the rule is named", async () => {
    const actorId = `audit-call-${randomUUID()}@openbot.local`;
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    policy = {
      mode: "enforce",
      deny: ['mcp.server == "google-drive"'],
      allow: ["true"],
    };

    let thrown: unknown;
    try {
      await store.callTool({
        ref,
        args: {},
        botId: holderId,
        actorId,
      });
    } catch (error) {
      thrown = error;
    } finally {
      policy = { mode: "enforce", deny: [], allow: ["true"] };
    }

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    // The rule that decided it, so an operator reading the refusal knows what to edit.
    expect((thrown as PluginRefusedError).rule).toBe(
      'mcp.server == "google-drive"',
    );

    const rows = await auditRowsFor(ref, holderId, actorId);
    const refusedByPolicy = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { decision?: { rule?: string } }).decision?.rule ===
          'mcp.server == "google-drive"',
    );
    expect(refusedByPolicy.length).toBe(1);
  });

  test("a rule can speak about effect rather than about tool names", async () => {
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    // `search_files` is advertised and is not in the vendor's write list, so it is a read and
    // this deny rule must NOT catch it. The assertion is that the call gets past the policy, which
    // it proves by failing at the network instead of as a refusal.
    policy = {
      mode: "enforce",
      deny: ['intent == "write_tool"'],
      allow: ["true"],
    };

    let thrown: unknown;
    try {
      await store.callTool({
        ref,
        args: {},
        botId: holderId,
        actorId: "someone@openbot.local",
      });
    } catch (error) {
      thrown = error;
    } finally {
      policy = { mode: "enforce", deny: [], allow: ["true"] };
    }

    /*
     * NOT REFUSED BY THE RULE. The call is still refused, because this vendor is reached as the
     * person asking and nobody has connected — but `rule` is null, which is the assertion: no
     * expression decided this. Asserting the absence of a refusal outright would only prove the
     * vendor was unreachable, which was always the weaker claim.
     */
    expect(thrown).toBeInstanceOf(PluginRefusedError);
    expect((thrown as PluginRefusedError).rule).toBeNull();
    expect((thrown as PluginRefusedError).message).toContain("connected");
  });

  test("a dry-run refusal is recorded, even though the call is let through", async () => {
    const actorId = `audit-call-${randomUUID()}@openbot.local`;
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    /*
     * The mode an operator switches on to size a rule before enforcing it, and the only mode in
     * which the policy refuses and the call still goes out. Its whole value is the row: without one
     * the report reads "this rule would refuse nothing" about traffic it would refuse.
     */
    const rule = `mcp.tool == "${toolName}"`;
    policy = { mode: "dry-run", deny: [rule], allow: ["true"] };

    try {
      await store
        .callTool({
          ref,
          args: {},
          botId: holderId,
          actorId,
        })
        // Forwarded past the policy, so what happens next is the vendor's business and not this
        // test's: nobody has connected an account, so it fails there. Swallowed deliberately.
        .catch(() => undefined);
    } finally {
      policy = { mode: "enforce", deny: [], allow: ["true"] };
    }

    const rows = await auditRowsFor(ref, holderId, actorId);
    const recorded = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { decision?: { rule?: string } }).decision?.rule ===
          rule,
    );
    // The one this call wrote. Exact, because the reads below are of `recorded[0]` and the list is
    // in no order: with the rows of every previous run in it, that index was whichever the planner
    // returned first, which is a row this code did not write.
    expect(recorded).toHaveLength(1);
    /*
     * What tells this row apart from a call this deployment actually stopped. `allowed` is the
     * policy's answer and `carriedOut` is what the mode did with it, so a reader counting what a
     * rule would have refused finds this one, and a reader counting what was refused does not.
     */
    const decision = (
      recorded[0].payload as {
        decision?: { allowed?: boolean; mode?: string; carriedOut?: boolean };
      }
    ).decision;
    expect(decision?.allowed).toBe(false);
    expect(decision?.mode).toBe("dry-run");
    expect(decision?.carriedOut).toBe(true);
  });
});

describe("the trail says what happened, not what was permitted", () => {
  /*
   * THE REGRESSION THIS EXISTS FOR. `mcp.call_succeeded` used to be written before the credential
   * was selected and before the network call, so a call that passed the grant and the policy and
   * then failed left a row asserting it had succeeded — and nothing at all saying it had not.
   *
   * That is the worst arrangement available. A trail with a gap makes somebody go and look; a trail
   * that is confidently wrong is used to rule the connector out and send the search elsewhere. It
   * did exactly that: a Bot that could not read Drive at all had `call_succeeded` rows behind it.
   *
   * `search_files` on `google-drive` is reached as the asker, and nobody here has connected, so this
   * call is permitted and then cannot be made — which is the shape of failure the row must show.
   */
  test("a call that is permitted and then fails is recorded as failed, not as succeeded", async () => {
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    const actorId = `audit-call-${randomUUID()}@openbot.local`;

    await expect(
      store.callTool({ ref, args: {}, botId: holderId, actorId }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const mine = await auditRowsFor(ref, holderId, actorId);

    const failed = mine.filter((row) => row.eventType === "mcp.call_failed");
    expect(failed.length).toBe(1);
    // The reason travels with the row. For a 403 this is where the vendor names the API that is not
    // enabled, which is the sentence that turns a guess into a fix.
    expect((failed[0].payload as { failure?: string }).failure).toContain(
      "connected",
    );

    // The point of the whole test: nothing claims this worked.
    expect(
      mine.filter((row) => row.eventType === "mcp.call_succeeded"),
    ).toEqual([]);
  });
});

describe("a boundary written about the browser does not refuse tool calls", () => {
  test("an unguarded rule about a page element does not refuse a tool call", async () => {
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    /**
     * This engine treats an expression it cannot evaluate as a MATCH, which is right for a browser
     * action on an element the server could not resolve and catastrophic for a tool call: with
     * `element` absent from the context, ANY deny rule naming it is unevaluable, so it matches, so
     * every MCP call is refused for a reason about a submit button.
     *
     * The preset in `.env.example` happens to survive that, because it guards each clause with
     * `tool.name == "computer_click"` and CEL short-circuits before ever reaching `element`. That is
     * luck, not design, and a rule an operator writes by hand has no such guard. So the rule under
     * test is the unguarded one.
     */
    policy = {
      mode: "enforce",
      deny: ['contains(element.name, "submit")'],
      allow: ["true"],
    };

    let thrown: unknown;
    try {
      await store.callTool({
        ref,
        args: {},
        botId: holderId,
        actorId: "someone@openbot.local",
      });
    } catch (error) {
      thrown = error;
    } finally {
      policy = { mode: "enforce", deny: [], allow: ["true"] };
    }

    // The rule did not decide this: `rule` is null. What refuses it is the missing connection for a
    // vendor reached as the person asking, which is a different sentence and a different cause.
    expect((thrown as PluginRefusedError).rule).toBeNull();
    expect((thrown as PluginRefusedError).message).toContain("connected");
  });
});

describe("removing an MCP server", () => {
  test("revokes the credential the server was configured with", async () => {
    // Without this, the credential row stays live after the server row is
    // gone, and re-adding the same server would unique-violate on
    // `credentials_active_key_idx`. The audit trail also carries the
    // revocation with `reason: mcp_server_removed`.
    const removalServerId = `removal-target-${suite}`;
    removalServerIds.add(removalServerId);
    revokedCredentialIds.length = 0;
    const [credentialRow] = await database
      .insert(credentialRows)
      .values({
        kind: "mcp",
        provider: removalServerId,
        keyId: `mcp-${removalServerId}`,
        encryptedValue: "{}",
        metadata: {},
      })
      .returning({ id: credentialRows.id });
    const credentialId = credentialRow?.id;
    if (!credentialId) throw new Error("credential row was not created");
    issuedCredentialIds.push(credentialId);
    await database.insert(mcpServers).values({
      id: removalServerId,
      title: "removal target",
      vendor: "test",
      url: "https://example.invalid/mcp",
      credentialId,
      provenance: "custom",
    });

    await store.removeServer(removalServerId, "admin@openbot.local");

    expect(revokedCredentialIds).toEqual([credentialId]);
    const [row] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, removalServerId));
    expect(row).toBeUndefined();
    const audit = await database
      .select({
        eventType: auditEvents.eventType,
        payload: auditEvents.payload,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "credential"),
          eq(auditEvents.targetId, credentialId),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.eventType).toBe("credential.revoked");
    expect((audit[0]?.payload as { reason?: string })?.reason).toBe(
      "mcp_server_removed",
    );
    // Audit is append-only in Postgres; leaving the row is fine because
    // `credentialId` is suite-scoped, so re-runs never collide.
  });

  /**
   * The people's grants go too, not only the server's own token.
   *
   * `mcp_user_credentials` cascades on the server row, so removing a `user-oauth` connector used to
   * delete every pointer and leave every refresh token in the vault live and unreferenced: reachable
   * from no screen, revoked by no operation, and still a usable grant at the vendor. "We removed the
   * connector" has to be true of the thing that matters, which is the token sitting at Notion.
   */
  test("revokes every person's grant for the server it removes", async () => {
    const removalServerId = `removal-target-people-${suite}`;
    const connectedUserId = `user_removal_${suite}`;
    removalServerIds.add(removalServerId);
    removalUserIds.add(connectedUserId);
    revokedCredentialIds.length = 0;

    await database
      .insert(users)
      .values({
        id: connectedUserId,
        email: `${connectedUserId}@openbot.test`,
        name: connectedUserId,
        emailVerified: false,
      })
      .onConflictDoNothing();

    const [grant] = await database
      .insert(credentialRows)
      .values({
        kind: "mcp_user_token",
        provider: removalServerId,
        keyId: connectedUserId,
        encryptedValue: "{}",
        metadata: {},
      })
      .returning({ id: credentialRows.id });
    const grantId = grant?.id;
    if (!grantId) throw new Error("grant row was not created");
    issuedCredentialIds.push(grantId);

    await database.insert(mcpServers).values({
      id: removalServerId,
      title: "removal target with people",
      vendor: "test",
      url: "https://example.invalid/mcp",
      provenance: "custom",
    });
    await database.insert(mcpUserCredentials).values({
      serverId: removalServerId,
      userId: connectedUserId,
      credentialId: grantId,
      scope: "",
    });

    try {
      await store.removeServer(removalServerId, "admin@openbot.local");

      expect(revokedCredentialIds).toEqual([grantId]);
      const [row] = await database
        .select({ revokedAt: credentialRows.revokedAt })
        .from(credentialRows)
        .where(eq(credentialRows.id, grantId));
      expect(row?.revokedAt).not.toBeNull();

      // And the trail says whose access ended and why, which is the row an auditor reaches for.
      const trail = await database
        .select({
          eventType: auditEvents.eventType,
          owner: sql<string>`payload ->> 'owner'`,
          reason: sql<string>`payload ->> 'reason'`,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetType, "mcp_server"),
            eq(auditEvents.targetId, removalServerId),
            eq(auditEvents.eventType, "mcp.account_disconnected"),
          ),
        );
      expect(trail).toHaveLength(1);
      expect(trail[0]?.owner).toBe(connectedUserId);
      expect(trail[0]?.reason).toBe("mcp_server_removed");
    } finally {
      await database.delete(users).where(eq(users.id, connectedUserId));
    }
  });

  /**
   * A credential that was already retired, and the read that decides whether to retire it again.
   *
   * CRITERION. `removeServer` must not ask the vault to revoke a credential whose row already
   * carries a `revoked_at`, and must still remove the server row.
   *
   * REASON. It reads liveness from the table before deciding, and nothing asserted that. The test
   * above inserts a LIVE row and so takes the true branch; the one below has no credential at all
   * and so never runs the query. So `isNull(revoked_at)` could be dropped with the whole suite
   * green — and in production `credentials.revoke` throws "not found or already revoked", which
   * propagates before `delete(mcpServers)` and leaves a server row that cannot be removed by any
   * number of attempts, on a route with no `catch`. Two ordinary states produce the row: a
   * previous removal that failed after the revoke, and a key rotated by hand.
   *
   * ASSERTED AS "revoke was not called", not as the absence of a throw. The vault here is a stub
   * that is deliberately forgiving — it stamps whatever id it is handed — so a test waiting for it
   * to complain would pass with the clause gone. What the read decides is whether the call is made
   * at all, and that is what {@link revokedCredentialIds} records.
   */
  test("does not ask the vault to revoke a credential already revoked", async () => {
    const removalServerId = `removal-target-retired-${suite}`;
    revokedCredentialIds.length = 0;
    const revokedAt = new Date();
    const [credentialRow] = await database
      .insert(credentialRows)
      .values({
        kind: "mcp",
        provider: removalServerId,
        keyId: `mcp-${removalServerId}`,
        encryptedValue: "{}",
        metadata: {},
        revokedAt,
        updatedAt: revokedAt,
      })
      .returning({ id: credentialRows.id });
    const credentialId = credentialRow?.id;
    if (!credentialId) throw new Error("credential row was not created");
    issuedCredentialIds.push(credentialId);
    await database.insert(mcpServers).values({
      id: removalServerId,
      title: "removal target with a retired credential",
      vendor: "test",
      url: "https://example.invalid/mcp",
      credentialId,
      provenance: "custom",
    });

    await store.removeServer(removalServerId, "admin@openbot.local");

    // Not asked, because the row already says it is retired.
    expect(revokedCredentialIds).toEqual([]);
    // And the server row is gone, which is the act an administrator asked for and the thing a
    // throw from the vault would have prevented.
    expect(
      await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, removalServerId)),
    ).toEqual([]);
    // No second revocation in the trail either: a row saying access ended twice is a row an
    // auditor has to reconcile against nothing having happened.
    expect(
      await database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "credential.revoked"),
            eq(auditEvents.targetId, credentialId),
          ),
        ),
    ).toEqual([]);
  });

  test("does not call revoke when the server had no credential", async () => {
    const removalServerId = `removal-target-nocred-${suite}`;
    removalServerIds.add(removalServerId);
    revokedCredentialIds.length = 0;
    await database.insert(mcpServers).values({
      id: removalServerId,
      title: "removal target no cred",
      vendor: "test",
      url: "https://example.invalid/mcp",
      provenance: "custom",
    });

    await store.removeServer(removalServerId, "admin@openbot.local");

    expect(revokedCredentialIds).toEqual([]);
  });
});

describe("the trail can be read by a second reader", () => {
  test("a refusal names the bot, the server and the tool in queryable JSON", async () => {
    const actorId = `audit-payload-${randomUUID()}@openbot.local`;
    await expect(
      store.callTool({
        ref,
        args: {},
        botId: strangerId,
        actorId,
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const rows = await database
      .select({
        bot: sql<string>`payload ->> 'bot'`,
        server: sql<string>`payload ->> 'server'`,
        tool: sql<string>`payload ->> 'tool'`,
        refusal: sql<string>`payload ->> 'refusal'`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "mcp_tool"),
          eq(auditEvents.eventType, "mcp.call_rejected"),
          eq(auditEvents.targetId, ref),
          sinceThisRun(),
          // The catalogue ref is shared; only this call used this actor and suite-owned Bot.
          eq(sql<string>`payload ->> 'actor'`, actorId),
          eq(sql<string>`payload ->> 'bot'`, strangerId),
        ),
      );

    // Asserted in SQL rather than through the application, because the stored payload shape is the
    // property under test.
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.server).toBe(serverId);
    expect(row?.tool).toBe(toolName);
    expect(row?.bot).toBe(strangerId);
    expect(row?.refusal).toBe("not_granted");
  });
});

/**
 * A grant outliving the tool it names.
 *
 * The runtime already handles it: `listForAgent` reads the grant against the tool list, so a tool the
 * vendor has stopped advertising reaches no model. What was missing is that nothing said so — the
 * plugins page derives its grant list from the advertised refs, so a grant on a withdrawn tool was
 * invisible on the one screen an administrator reads to answer "what may this Bot do".
 */
describe("a grant on a tool the vendor no longer lists", () => {
  const withdrawnName = `withdrawn_${suite}`;
  const withdrawnRef = `${serverId}/${withdrawnName}`;

  afterAll(async () => {
    await database
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.ref, withdrawnRef),
          eq(pluginGrants.agentId, holderId),
        ),
      );
    await database
      .delete(mcpTools)
      .where(
        and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, withdrawnName)),
      );
  });

  test("is reported as held and not offered, and still reaches no model", async () => {
    // Advertised once, which is how a grant comes to exist against it.
    await database
      .insert(mcpTools)
      .values({
        serverId,
        name: withdrawnName,
        description: "Listed by the vendor when the grant was made.",
      })
      .onConflictDoNothing();
    await store.grant("mcp", withdrawnRef, holderId, "admin@openbot.local");

    // Then withdrawn. A refresh replaces the tool list wholesale, so this is what one does to a name
    // the vendor has stopped offering.
    await database
      .delete(mcpTools)
      .where(
        and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, withdrawnName)),
      );

    const drive = (await store.listServers()).find(
      (server) => server.id === serverId,
    );

    // Not a tool: it is not in the list the vendor gave, so it must not be counted as one.
    expect(drive?.tools.map((tool) => tool.ref)).not.toContain(withdrawnRef);
    // But it is reported, with who holds it, which is the whole point.
    expect(drive?.withdrawn.map((held) => held.ref)).toContain(withdrawnRef);
    const held = drive?.withdrawn.find((row) => row.ref === withdrawnRef);
    expect(held?.name).toBe(withdrawnName);
    expect(held?.grantedTo).toContain(holderId);

    // And the property that made it inert in the first place is unchanged. This is the assertion that
    // would fail if reporting a grant had turned into honouring one.
    const offered = await store.listForAgent(holderId);
    expect(offered.tools.map((tool) => tool.ref)).not.toContain(withdrawnRef);
  });

  test("a healthy connector reports nothing withdrawn", async () => {
    // The empty case, because a field that is only ever exercised non-empty is a field whose empty
    // shape nobody has checked — and this one is read by a screen that hides itself when it is empty.
    const drive = (await store.listServers()).find(
      (server) => server.id === serverId,
    );
    expect(drive?.withdrawn.map((row) => row.ref)).not.toContain(ref);
  });
});

/**
 * A vendor that hands back a new refresh token every time it is asked for access.
 *
 * Notion does. The token it was shown is dead the moment it answers, so a deployment that keeps the
 * old one has spent somebody's connection on a single call: the next one presents a token the vendor
 * has already invalidated, and the person is told to connect again for no reason they can see. That
 * makes persisting the new token part of the exchange rather than bookkeeping after it, and it makes
 * two concurrent calls a problem — both would present the same token, and one of them would lose.
 *
 * This suite needs a REAL vault, unlike the store fixture above: rotation re-encrypts the row the
 * connection already points at, and a stub that throws cannot show that happening — nor show that
 * nothing else was written. So it builds its own store, with the vendor and its token endpoint
 * injected and everything else genuine.
 */
describe("refresh token rotation", () => {
  const rotationBotId = `agent_rotation_bot_${suite}`;
  const rotationUserId = `user_rotation_${suite}`;
  /** Notion, because it is the entry whose vendor actually rotates. */
  const rotationServerId = "notion";
  /** Suite-scoped, so it cannot collide with a name Notion really advertises. */
  const rotationToolName = `search_${suite}`;
  const rotationRef = `${rotationServerId}/${rotationToolName}`;
  /**
   * 32 zero bytes in base64.
   *
   * A real AES-256 key length, unlike the `"x".repeat(44)` the fixture above gets away with: every
   * call there is refused before the vault is opened, and every call here goes through it.
   */
  const ROTATION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const CLIENT = { clientId: "notion-client", clientSecret: "notion-secret" };
  /** Notion has no scope strings; the connection stores what the vendor said, which is nothing. */
  const SCOPE = "";

  /** Every vault row this suite created, so the cleanup can take exactly those. */
  const vaultRows: string[] = [];
  /** Every access token the store was about to send to the vendor, in order. */
  const sent: string[] = [];
  /**
   * The exchange, as a sequence of the moments it entered and left.
   *
   * Recorded as a log rather than as a count because the property under test is an ORDERING: two
   * exchanges for one connection must not overlap. A log makes an overlap visible without the test
   * having to guess when to look.
   */
  const log: string[] = [];
  /** What each exchange received and what it rotated to, which is the pairing rotation is about. */
  const exchanges: { received: string; returned?: string }[] = [];
  /** What the vendor's token endpoint does, installed per test. */
  let mint: (refreshToken: string) => Promise<AccessToken> = async () => {
    throw new Error("no exchange was installed for this test");
  };

  /**
   * The vault, wired once and shared by every store this describe builds.
   *
   * Shared deliberately: a second replica of this deployment reads and writes the same rows through
   * the same code, and a per-store copy of the wiring would be a second place for the fixture to
   * drift from what production does.
   */
  const vault = {
    readSecret: async (id: string) => {
      const [row] = await database
        .select({
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(eq(credentials.id, id));
      return row ?? null;
    },
    create: async (value: CredentialStoreValue) => {
      const [row] = await database
        .insert(credentials)
        .values(value)
        .returning({ id: credentials.id, revokedAt: credentials.revokedAt });
      if (!row) throw new Error("credential was not stored");
      vaultRows.push(row.id);
      return row;
    },
    /*
     * The vault's own in-place update, not a stand-in for it.
     *
     * This is the write rotation now performs, and the suite asserts the ROW it leaves behind: the
     * same id, re-encrypted, nothing added. A hand-rolled copy of the statement here would assert
     * the copy rather than the vault — and would not join the caller's transaction, which is the
     * whole of what keeps two replicas from spending one refresh token twice.
     */
    updateSecret: createCredentialStore(database).updateSecret,
    /*
     * The real swap and the real key lookup too: `credentials_active_key_idx` holds one live row
     * per key, so a reconnect in this suite replaces its previous token through the same
     * transaction production uses. A stand-in would dodge the index the test data must obey.
     */
    rotate: async (
      value: CredentialStoreValue & { previousCredentialId: string },
    ) => {
      const stored = await createCredentialStore(database).rotate(value);
      vaultRows.push(stored.id);
      return stored;
    },
    findLiveByKey: createCredentialStore(database).findLiveByKey,
    isLive: createCredentialStore(database).isLive,
    revoke: async (id: string) => {
      const [row] = await database
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(eq(credentials.id, id))
        .returning({ revokedAt: credentials.revokedAt });
      if (!row?.revokedAt) throw new Error("credential was not revoked");
      return row.revokedAt;
    },
  };

  const rotationStore = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: vault,
    encryptionKey: ROTATION_KEY,
    policy: () => policy,
    // Stops before the network, and records what the call would have gone out with.
    callVendor: async (connection) => {
      sent.push(connection.token ?? "<none>");
      return { text: "[vendor not reached in tests]", isError: false };
    },
    exchangeRefreshToken: async ({ client, refreshToken }) => {
      expect(client).toEqual(CLIENT);
      log.push(`start:${refreshToken}`);
      const minted = await mint(refreshToken);
      log.push(`end:${refreshToken}`);
      exchanges.push({ received: refreshToken, returned: minted.refreshToken });
      return minted;
    },
  });

  /**
   * A second replica of this deployment, over the same database.
   *
   * The point of building the store again rather than calling the same one twice is what is NOT
   * shared: the in-process map that queues one connection's exchanges belongs to a store instance,
   * so two instances are as unserialised as two containers behind a load balancer. Whatever keeps
   * them from spending one refresh token twice has to live in the database.
   */
  function replica(exchange: (refreshToken: string) => Promise<AccessToken>) {
    return createPluginStore({
      database,
      auditStore: createAuditStore(database),
      credentials: vault,
      encryptionKey: ROTATION_KEY,
      policy: () => policy,
      callVendor: async () => ({
        text: "[vendor not reached in tests]",
        isError: false,
      }),
      exchangeRefreshToken: async ({ refreshToken }) => exchange(refreshToken),
    });
  }

  /** The deployment's OAuth client, which is what `mcp_servers.credential_id` holds. */
  async function registerClient() {
    const [credential] = await database
      .insert(credentials)
      .values({
        kind: "mcp_oauth_client",
        provider: rotationServerId,
        keyId: "oauth-client",
        metadata: { clientId: CLIENT.clientId },
        encryptedValue: await encryptSecret(
          ROTATION_KEY,
          JSON.stringify(CLIENT),
        ),
      })
      .returning({ id: credentials.id });
    if (!credential) throw new Error("client was not stored");
    vaultRows.push(credential.id);
    await database
      .update(mcpServers)
      .set({ credentialId: credential.id })
      .where(eq(mcpServers.id, rotationServerId));
  }

  /** Which vault row this person's connection points at, so a swap is observable. */
  async function connectionCredential() {
    const [row] = await database
      .select({ credentialId: mcpUserCredentials.credentialId })
      .from(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, rotationServerId),
          eq(mcpUserCredentials.userId, rotationUserId),
        ),
      );
    return row?.credentialId ?? null;
  }

  /**
   * Every vault row this person's connection has ever had, live or revoked.
   *
   * The count is the point. A rotating vendor issues a new refresh token on every exchange, so a
   * rotation that minted a row would leave one row per tool call here — which is invisible to any
   * assertion that only looks at where the connection currently points.
   */
  async function connectionVaultRows() {
    return (
      database
        .select({
          id: credentials.id,
          encryptedValue: credentials.encryptedValue,
          revokedAt: credentials.revokedAt,
        })
        .from(credentials)
        .where(
          and(
            eq(credentials.kind, "mcp_user_token"),
            eq(credentials.provider, rotationServerId),
            eq(credentials.keyId, rotationUserId),
          ),
        )
        // Ordered, so that comparing the whole list before and after is comparing the rows rather
        // than whatever order the database felt like returning them in.
        .orderBy(credentials.id)
    );
  }

  /** How many times this person is recorded as having connected their account. */
  async function connectedRows() {
    return (
      await database
        .select({ actor: sql<string>`payload ->> 'actor'` })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.account_connected"),
            eq(auditEvents.targetId, rotationServerId),
            sql`payload ->> 'actor' = ${rotationUserId}`,
          ),
        )
    ).length;
  }

  /** Waiting for something the other call does, rather than for a duration. */
  async function waitUntil(condition: () => boolean, what: string) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** A connection holding `rt-1`, written through the store so the vault is exercised. */
  async function connect() {
    await rotationStore.recordConnection({
      serverId: rotationServerId,
      userId: rotationUserId,
      refreshToken: "rt-1",
      scope: SCOPE,
    });
    log.length = 0;
    exchanges.length = 0;
    sent.length = 0;
  }

  /**
   * Whether THIS RUN is what put the `notion` row there, and so is what should take it away.
   *
   * Counting creations rather than absences, the same way round as {@link suiteCreatedServerRow} and
   * for the same reason: `afterAll` runs even when the `beforeAll` below it has thrown, and a flag
   * still sitting at its initialiser then authorised the delete. Only a capture that ran and found
   * the row missing can write the value the delete needs.
   */
  let suiteCreatedNotionRow = false;
  /**
   * The OAuth client this deployment had before the suite ran, restored afterwards.
   *
   * `mcp_servers.credential_id` is live configuration, and this suite repoints it. `undefined` is
   * "nobody looked", which is what the value is until the capture below runs and is what it is still
   * sitting at if that `beforeAll` threw first — and a restore that treated it as `null` would not be
   * restoring anything, it would be blanking a real deployment's client on the way out.
   */
  let clientBefore: string | null | undefined;

  beforeAll(async () => {
    await database
      .insert(agents)
      .values({
        id: rotationBotId,
        name: rotationBotId,
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();
    await database
      .insert(users)
      .values({
        id: rotationUserId,
        email: `${rotationUserId}@openbot.test`,
        name: rotationUserId,
        emailVerified: false,
      })
      .onConflictDoNothing();

    const [existing] = await database
      .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, rotationServerId));
    suiteCreatedNotionRow = existing === undefined;
    clientBefore = existing?.credentialId ?? null;

    // Written directly, so the test needs no vendor to be reachable. What is under test is which
    // refresh token the next exchange presents, not the listing.
    await database
      .insert(mcpServers)
      .values({
        id: rotationServerId,
        title: "Notion",
        vendor: "Notion",
        url: "https://mcp.notion.com/mcp",
        provenance: "first-party",
      })
      .onConflictDoNothing();
    await database
      .insert(mcpTools)
      .values({
        serverId: rotationServerId,
        name: rotationToolName,
        description: "Search pages.",
      })
      .onConflictDoNothing();
    await rotationStore.grant(
      "mcp",
      rotationRef,
      rotationBotId,
      "admin@openbot.local",
    );
    await registerClient();
  });

  afterAll(async () => {
    // This suite's own person, never every row for this vendor: the id carries the run's suffix.
    await database
      .delete(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, rotationServerId),
          eq(mcpUserCredentials.userId, rotationUserId),
        ),
      );
    // Before the deletes, because the column addresses one of the rows they remove. Only when the
    // capture actually ran: `undefined` is nobody having looked, and writing that back as null is
    // not a restore.
    if (clientBefore !== undefined) {
      await database
        .update(mcpServers)
        .set({ credentialId: clientBefore })
        .where(eq(mcpServers.id, rotationServerId));
    }
    for (const id of vaultRows) {
      await database.delete(credentials).where(eq(credentials.id, id));
    }
    await database
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.ref, rotationRef),
          eq(pluginGrants.agentId, rotationBotId),
        ),
      );
    await database
      .delete(mcpTools)
      .where(
        and(
          eq(mcpTools.serverId, rotationServerId),
          eq(mcpTools.name, rotationToolName),
        ),
      );
    // A server row is deployment configuration, so it goes only if this suite is what added it.
    if (suiteCreatedNotionRow) {
      await database
        .delete(mcpTools)
        .where(eq(mcpTools.serverId, rotationServerId));
      await database
        .delete(mcpServers)
        .where(eq(mcpServers.id, rotationServerId));
    }
    await database.delete(agents).where(eq(agents.id, rotationBotId));
    await database.delete(users).where(eq(users.id, rotationUserId));
  });

  test("the list says which servers register their own OAuth client", async () => {
    // Notion is dynamic (RFC 7591, registered by this deployment on first connect); Google Drive
    // is not — an administrator pastes its client in, so the paste-a-client form still has a job
    // to do there. The field distinguishes the two so the admin screen can hide the form only
    // where it would otherwise be filled in with nothing to type.
    const servers = await store.listServers();
    const notion = servers.find((server) => server.id === rotationServerId);
    const drive = servers.find((server) => server.id === serverId);
    expect(notion?.dynamicClient).toBe(true);
    expect(drive?.dynamicClient).toBe(false);
  });

  test("the token the vendor rotated to is the one the next call presents", async () => {
    await connect();
    const before = await connectionCredential();
    const rowsBefore = await connectionVaultRows();
    const connectedBefore = await connectedRows();
    mint = async () => ({ accessToken: "at-1", refreshToken: "rt-2" });

    await rotationStore.callTool({
      ref: rotationRef,
      args: {},
      botId: rotationBotId,
      actorId: rotationUserId,
    });
    await rotationStore.callTool({
      ref: rotationRef,
      args: {},
      botId: rotationBotId,
      actorId: rotationUserId,
    });

    // The whole property: the second exchange presented what the first was given back.
    expect(exchanges.map((exchange) => exchange.received)).toEqual([
      "rt-1",
      "rt-2",
    ]);
    // Both calls went out with an access token, so neither was refused on the way.
    expect(sent).toEqual(["at-1", "at-1"]);

    /*
     * Two rotations, and the vault holds exactly what it held before: the same row, still live,
     * carrying the latest token.
     *
     * This is the whole reason rotation is in place rather than a swap. Every single call to a
     * rotating vendor rotates, so minting a row per rotation would grow the vault without bound on
     * the hottest path there is — and would revoke a grant the vendor had already killed itself the
     * moment it handed the new token back.
     */
    const after = await connectionCredential();
    expect(after).toBe(before);
    const rowsAfter = await connectionVaultRows();
    expect(rowsAfter.map((row) => row.id)).toEqual(
      rowsBefore.map((row) => row.id),
    );
    const live = rowsAfter.filter((row) => row.revokedAt === null);
    expect(live.map((row) => row.id)).toEqual([before]);
    // And the row that stayed is the one the vendor rotated to, not the one it replaced.
    expect(
      await decryptSecret(ROTATION_KEY, live[0]?.encryptedValue ?? ""),
    ).toBe("rt-2");

    // And nothing claims the person connected an account again. Rotation is the vendor's plumbing,
    // not somebody's act, and a trail that says otherwise is read as a re-consent that never
    // happened.
    expect(await connectedRows()).toBe(connectedBefore);
  });

  test("a vendor that does not rotate leaves the connection alone", async () => {
    await connect();
    const before = await connectionCredential();
    // Google's reply: an access token and nothing else. Repointing anything here would be inventing
    // a rotation the vendor did not perform.
    mint = async () => ({ accessToken: "at-1" });

    await rotationStore.callTool({
      ref: rotationRef,
      args: {},
      botId: rotationBotId,
      actorId: rotationUserId,
    });
    await rotationStore.callTool({
      ref: rotationRef,
      args: {},
      botId: rotationBotId,
      actorId: rotationUserId,
    });

    expect(exchanges.map((exchange) => exchange.received)).toEqual([
      "rt-1",
      "rt-1",
    ]);
    // Said explicitly, because it is the condition the store branches on: no refresh token came
    // back at all. A test that only checked the connection was untouched would pass just as well
    // against a store that rotated to the token it already held.
    expect(exchanges.map((exchange) => exchange.returned)).toEqual([
      undefined,
      undefined,
    ]);
    expect(await connectionCredential()).toBe(before);
  });

  test("a vendor that hands the same token back writes nothing", async () => {
    await connect();
    const before = await connectionVaultRows();
    // Notion's reply when the grant did not move: a fresh access token and the refresh token we
    // presented. Nothing rotated, so there is nothing to persist.
    mint = async () => ({ accessToken: "at-1", refreshToken: "rt-1" });

    await rotationStore.callTool({
      ref: rotationRef,
      args: {},
      botId: rotationBotId,
      actorId: rotationUserId,
    });

    /*
     * Byte-identical, which is a stronger claim than "same row".
     *
     * Encryption draws a fresh IV every time, so re-encrypting the very same token would leave a
     * different envelope in the same row. An untouched envelope is the only evidence that the write
     * did not happen at all.
     */
    expect(await connectionVaultRows()).toEqual(before);
    expect(sent).toEqual(["at-1"]);
  });

  test("two calls at once take turns, and the second spends what the first was given", async () => {
    await connect();
    let release: (minted: AccessToken) => void = () => {};
    const parked = new Promise<AccessToken>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    mint = async () => {
      asked += 1;
      // The first exchange hangs until this test lets it finish. The second must not have started.
      return asked === 1
        ? parked
        : { accessToken: "at-2", refreshToken: "rt-3" };
    };

    const both = Promise.allSettled([
      rotationStore.callTool({
        ref: rotationRef,
        args: {},
        botId: rotationBotId,
        actorId: rotationUserId,
      }),
      rotationStore.callTool({
        ref: rotationRef,
        args: {},
        botId: rotationBotId,
        actorId: rotationUserId,
      }),
    ]);

    try {
      await waitUntil(() => log.length > 0, "the first exchange to start");
      /*
       * Long enough for a second, unserialised call to reach the vendor on its own. Its queries are
       * a few milliseconds against a local database, so an overlapping exchange would be in the log
       * by now — and with the exchanges serialised, waiting changes nothing at all.
       */
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(log).toEqual(["start:rt-1"]);
    } finally {
      release({ accessToken: "at-1", refreshToken: "rt-2" });
    }

    const results = await both;
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    // One after another, never interleaved, and the second presented the first's rotated token —
    // which is only possible because the first persisted it before answering.
    expect(log).toEqual(["start:rt-1", "end:rt-1", "start:rt-2", "end:rt-2"]);
    expect(exchanges).toEqual([
      { received: "rt-1", returned: "rt-2" },
      { received: "rt-2", returned: "rt-3" },
    ]);
  });

  /**
   * Two replicas, one connection, and the vendor shown each refresh token exactly once.
   *
   * This is the case the in-process queue cannot reach. Each replica has its own map, so both read
   * the stored token, both present it, and a vendor with refresh-token-reuse detection reads the
   * second presentation as a stolen token and revokes the whole family — bricking a connection that
   * nobody did anything wrong with. The row lock is what makes the second replica wait and then read
   * what the first rotated to.
   */
  test("two replicas take turns at the row, and neither spends a token twice", async () => {
    await connect();
    /** Every refresh token the vendor was shown, by either replica, in order. */
    const presented: string[] = [];
    let issued = 1;
    const exchange = async (refreshToken: string) => {
      presented.push(refreshToken);
      /*
       * Long enough that an unlocked second replica has read the vault and presented what it found
       * there before this exchange answers. With the lock held it changes nothing except how long
       * the other replica waits for its turn.
       */
      await new Promise((resolve) => setTimeout(resolve, 50));
      issued += 1;
      return { accessToken: `at-${issued}`, refreshToken: `rt-${issued}` };
    };
    const first = replica(exchange);
    const second = replica(exchange);

    const call = (store: ReturnType<typeof replica>) =>
      store.callTool({
        ref: rotationRef,
        args: {},
        botId: rotationBotId,
        actorId: rotationUserId,
      });
    const results = await Promise.all([call(first), call(second)]);

    expect(results.map((result) => result.isError)).toEqual([false, false]);
    // The whole property. `["rt-1", "rt-1"]` is the double-spend: two replicas presenting one token.
    expect(presented).toEqual(["rt-1", "rt-2"]);
    // And the row the connection points at carries the last token issued, so a third call would
    // present that rather than something either replica had already spent.
    const live = (await connectionVaultRows()).filter(
      (row) => row.revokedAt === null,
    );
    expect(
      await decryptSecret(ROTATION_KEY, live[0]?.encryptedValue ?? ""),
    ).toBe("rt-3");
  });

  /**
   * A stored OAuth client whose decrypted bytes are not a client at all.
   *
   * CRITERION: neither the decrypted plaintext nor a parser's account of it may reach
   * `audit_events` or `mcp_servers.last_error`. REASON: that plaintext IS the deployment's OAuth
   * client secret, and `JSON.parse` reports failure by quoting the input it choked on — so an
   * unguarded parse writes a fragment of the secret into two durable stores, both of which the
   * Plugins page draws for an administrator.
   *
   * A corrupted row is not hypothetical: a partially written value, a row encrypted under a key
   * this deployment no longer holds, or a hand-edited vault all produce bytes that decrypt and are
   * not JSON.
   *
   * The refusal is asserted alongside the absence, because an unreadable client that produced
   * nothing at all would be its own bug: the operator would see a connector failing with no reason
   * given, and the credential is the reason.
   */
  describe("a stored OAuth client that does not read back as one", () => {
    /*
     * A bare secret where a client object belongs — the shape a wrongly encrypted row really has,
     * and the worst case for the leak. It decrypts, so the vault is happy; it is not JSON, so the
     * parse fails; and it is a single identifier token, which is what the parser quotes back
     * WHOLE. Distinctive, so an assertion can look for the plaintext itself rather than a shape.
     */
    const UNREADABLE_PLAINTEXT = `secret_notJsonClient${suite}`;
    /** What the person and the trail are told instead, which is the operator's signal. */
    const UNUSABLE = "Notion has no usable OAuth client for this deployment.";

    /** The client the suite registered, restored after each test repoints the server. */
    let registeredClientId: string | null = null;

    /** Point the server at a vault row that decrypts to something that is not a client. */
    async function pointAtUnreadableClient() {
      const [server] = await database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, rotationServerId));
      registeredClientId = server?.credentialId ?? null;

      const [credential] = await database
        .insert(credentials)
        .values({
          kind: "mcp_oauth_client",
          provider: rotationServerId,
          // Fresh per call, because `credentials_active_key_idx` holds one live row per
          // (kind, provider, key_id) and the row this leaves behind is never revoked.
          keyId: `oauth-client-unreadable-${randomUUID().slice(0, 8)}`,
          metadata: {},
          encryptedValue: await encryptSecret(
            ROTATION_KEY,
            UNREADABLE_PLAINTEXT,
          ),
        })
        .returning({ id: credentials.id });
      if (!credential) throw new Error("unreadable client was not stored");
      vaultRows.push(credential.id);

      await database
        .update(mcpServers)
        .set({ credentialId: credential.id })
        .where(eq(mcpServers.id, rotationServerId));
    }

    /** Put the readable client back, so the tests after this one still have one. */
    async function restoreClient() {
      await database
        .update(mcpServers)
        .set({ credentialId: registeredClientId })
        .where(eq(mcpServers.id, rotationServerId));
    }

    test("the trail of a refused call carries neither the plaintext nor the parser", async () => {
      await connect();
      await pointAtUnreadableClient();
      try {
        /*
         * The throw is held rather than asserted on first, because what this test is about is the
         * ROW. Asserting the thrown type up front would fail on the unguarded code before any
         * durable store had been read, and report the wrong thing.
         */
        const refusal = await rotationStore
          .callTool({
            ref: rotationRef,
            args: {},
            botId: rotationBotId,
            actorId: rotationUserId,
          })
          .then(
            () => null,
            (error: unknown) => error,
          );

        const failures = (
          await auditRowsFor(rotationRef, rotationBotId, rotationUserId)
        ).filter((row) => row.eventType === "mcp.call_failed");
        const written = JSON.stringify(failures);
        expect(written).not.toContain(UNREADABLE_PLAINTEXT);
        /*
         * The parser's vocabulary as well as the plaintext. A parser quotes only a window of its
         * input — how wide is the runtime's business, not ours — so a message could carry a
         * fragment the assertion above would miss, and any of these words reaching the trail means
         * a parse wrote it.
         */
        expect(written).not.toContain("JSON Parse error");
        expect(written).not.toContain("SyntaxError");
        expect(written).not.toContain("Unexpected");
        // And the operator is still told which thing is broken, in the trail and to the caller.
        expect(written).toContain(UNUSABLE);
        expect(refusal).toBeInstanceOf(PluginRefusedError);
      } finally {
        await restoreClient();
      }
    });

    test("a refresh leaves the same absence in the server's last error", async () => {
      await connect();
      const [before] = await database
        .select({ lastError: mcpServers.lastError })
        .from(mcpServers)
        .where(eq(mcpServers.id, rotationServerId));
      await pointAtUnreadableClient();
      try {
        // Refuses before the vendor is asked, so nothing here needs a reachable Notion.
        expect(
          await rotationStore.refreshTools(rotationServerId, rotationUserId),
        ).toEqual({ tools: 0 });

        const [after] = await database
          .select({ lastError: mcpServers.lastError })
          .from(mcpServers)
          .where(eq(mcpServers.id, rotationServerId));
        const written = after?.lastError ?? "";
        expect(written).not.toContain(UNREADABLE_PLAINTEXT);
        expect(written).not.toContain("JSON Parse error");
        expect(written).not.toContain("SyntaxError");
        expect(written).not.toContain("Unexpected");
        expect(written).toContain(UNUSABLE);
      } finally {
        await restoreClient();
        await database
          .update(mcpServers)
          .set({ lastError: before?.lastError ?? null })
          .where(eq(mcpServers.id, rotationServerId));
      }
    });
  });
});

/** Borrow a catalogue client's slot, then restore it after removing exactly our own vault rows. */
function oauthClientFixture(serverId: string) {
  const realVault = createCredentialStore(database);
  const owned = new Set<string>();
  const clientKey = and(
    eq(credentials.kind, "mcp_oauth_client"),
    eq(credentials.provider, serverId),
    eq(credentials.keyId, `oauth-client-${serverId}`),
  );
  let before:
    | {
        credentialId: string | null;
        updatedAt: string;
        clients: { id: string; revokedAt: string | null; updatedAt: string }[];
      }
    | undefined;

  return {
    track: (id: string) => owned.add(id),
    vault: {
      ...realVault,
      // Forward the caller's transaction: the credential and its pointer must commit together.
      create: async (
        value: Parameters<typeof realVault.create>[0],
        executor?: Parameters<typeof realVault.create>[1],
      ) => {
        const row = await realVault.create(value, executor);
        owned.add(row.id);
        return row;
      },
      // rotate inserts directly; wrapping create alone misses every replacement it mints.
      rotate: async (
        value: Parameters<typeof realVault.rotate>[0],
        executor?: Parameters<typeof realVault.rotate>[1],
      ) => {
        const row = await realVault.rotate(value, executor);
        owned.add(row.id);
        return row;
      },
    },
    start: async () => {
      before = await database.transaction(async (transaction) => {
        const [server] = await transaction
          .select({
            credentialId: mcpServers.credentialId,
            updatedAt: sql<string>`${mcpServers.updatedAt}::text`,
          })
          .from(mcpServers)
          .where(eq(mcpServers.id, serverId))
          .for("update");
        if (!server) throw new Error("fixture server was not stored");
        // Dates round PostgreSQL microseconds to milliseconds. Keep the exact stamps as text.
        const clients = await transaction
          .select({
            id: credentials.id,
            revokedAt: sql<string | null>`${credentials.revokedAt}::text`,
            updatedAt: sql<string>`${credentials.updatedAt}::text`,
          })
          .from(credentials)
          .where(and(clientKey, sql`${credentials.revokedAt} IS NULL`))
          .for("update");
        await transaction
          .update(mcpServers)
          .set({ credentialId: null })
          .where(eq(mcpServers.id, serverId));
        if (clients.length > 0) {
          await transaction
            .update(credentials)
            .set({ revokedAt: new Date(), updatedAt: new Date() })
            .where(
              inArray(
                credentials.id,
                clients.map((row) => row.id),
              ),
            );
        }
        return { ...server, clients };
      });
    },
    retireClients: async () => {
      if (owned.size === 0) return;
      await database
        .update(credentials)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            clientKey,
            inArray(credentials.id, [...owned]),
            sql`${credentials.revokedAt} IS NULL`,
          ),
        );
    },
    restore: async () => {
      const snapshot = before;
      if (!snapshot) return;
      await database.transaction(async (transaction) => {
        await transaction
          .update(mcpServers)
          .set({ credentialId: null })
          .where(eq(mcpServers.id, serverId));
        if (owned.size > 0) {
          await transaction
            .delete(credentials)
            .where(inArray(credentials.id, [...owned]));
        }
        // Free the active key before reviving its original row, then restore the pointer atomically.
        for (const row of snapshot.clients) {
          await transaction
            .update(credentials)
            .set({
              revokedAt: sql`${row.revokedAt}::timestamptz`,
              updatedAt: sql`${row.updatedAt}::timestamptz`,
            })
            .where(eq(credentials.id, row.id));
        }
        await transaction
          .update(mcpServers)
          .set({
            credentialId: snapshot.credentialId,
            updatedAt: sql`${snapshot.updatedAt}::timestamptz`,
          })
          .where(eq(mcpServers.id, serverId));
      });
      before = undefined;
      owned.clear();
    },
  };
}

test.each(["success", "failure"])(
  "OAuth client fixture restores exact state after %s following create and rotate",
  async (outcome) => {
    const fixtureServerId = `oauth-fixture-${suite}-${outcome}`;
    const originalId = randomUUID();
    const sentinelId = randomUUID();
    const fixture = oauthClientFixture(fixtureServerId);
    const value: CredentialStoreValue = {
      kind: "mcp_oauth_client",
      provider: fixtureServerId,
      keyId: `oauth-client-${fixtureServerId}`,
      metadata: {},
      encryptedValue: "synthetic-fixture-value",
    };
    const state = async () => ({
      credentials: await database
        .select({ row: sql`to_jsonb(${credentials})` })
        .from(credentials)
        .where(
          inArray(credentials.provider, [
            fixtureServerId,
            `${fixtureServerId}-unrelated`,
          ]),
        )
        .orderBy(credentials.id),
      server: await database
        .select({ row: sql`to_jsonb(${mcpServers})` })
        .from(mcpServers)
        .where(eq(mcpServers.id, fixtureServerId)),
    });
    try {
      await database.insert(credentials).values([
        {
          ...value,
          id: originalId,
          updatedAt: sql`'2020-01-02 03:04:05.123456+00'::timestamptz`,
        },
        { ...value, id: sentinelId, provider: `${fixtureServerId}-unrelated` },
      ]);
      await database.insert(mcpServers).values({
        id: fixtureServerId,
        title: fixtureServerId,
        vendor: "Synthetic fixture",
        url: "https://fixture.invalid/mcp",
        credentialId: originalId,
      });
      const before = await state();
      const exercise = async () => {
        try {
          await fixture.start();
          await fixture.retireClients();
          const created = await database.transaction((transaction) =>
            fixture.vault.create(value, transaction),
          );
          const rotated = await database.transaction(async (transaction) => {
            const row = await fixture.vault.rotate(
              { ...value, previousCredentialId: created.id },
              transaction,
            );
            await transaction
              .update(mcpServers)
              .set({ credentialId: row.id })
              .where(eq(mcpServers.id, fixtureServerId));
            return row;
          });
          expect(await fixture.vault.isLive(created.id)).toBe(false);
          expect(await fixture.vault.isLive(rotated.id)).toBe(true);
          if (outcome === "failure") {
            throw new Error("fixture operation failed after rotation");
          }
        } finally {
          await fixture.restore();
        }
      };
      if (outcome === "failure") {
        await expect(exercise()).rejects.toThrow(
          "fixture operation failed after rotation",
        );
      } else {
        await exercise();
      }
      // Full PostgreSQL rows catch timestamp rounding, leaked replacements and sentinel damage.
      expect(await state()).toEqual(before);
      expect(await fixture.vault.isLive(originalId)).toBe(true);
    } finally {
      await fixture.restore();
      await database
        .delete(mcpServers)
        .where(eq(mcpServers.id, fixtureServerId));
      await database
        .delete(credentials)
        .where(inArray(credentials.id, [originalId, sentinelId]));
    }
  },
);

/**
 * A real MCP server on localhost answering as the pinned Notion host, and everything a refresh
 * against it overwrites put back afterwards.
 *
 * The seam is `fetch`: the host is pinned and nothing in the store will take a URL from a caller, so
 * pointing the pinned host at the mock is what lets a real listing over the real protocol happen.
 * What a refresh then overwrites is the deployment's own row — it replaces the advertised tool list
 * wholesale and stamps `toolsRefreshedAt` and `lastError` — so the list and both stamps are read
 * first and put back in a `finally`.
 *
 * A `finally` rather than a paragraph copied per test, because a restore is the part that a test
 * still passes without: skip it and the cost lands on whatever runs next, reading a tool list this
 * test invented.
 */
async function withMockedNotionListing(
  notionServerId: string,
  /*
   * The mock's own tool shape, plus the annotations a real server publishes.
   *
   * `MCPToolDefinition` names only name, description and schema, and the mock hands whatever it was
   * given straight back in its `tools/list` answer — so an annotation travels at runtime and is
   * simply unspellable in the type. Widened here rather than cast at each fixture, because the
   * hints are what `listTools` reads to decide an action's recorded effect, and a test about that
   * decision should not be the one place a cast hides a shape drifting.
   */
  tools: (MCPToolDefinition & { annotations?: ToolAnnotations })[],
  body: () => Promise<void>,
) {
  const mock = new MCPMock();
  for (const tool of tools) mock.addTool(tool);
  const mockUrl = await mock.start();

  const advertisedBefore = await database
    .select()
    .from(mcpTools)
    .where(eq(mcpTools.serverId, notionServerId));
  const [stampBefore] = await database
    .select({
      toolsRefreshedAt: mcpServers.toolsRefreshedAt,
      lastError: mcpServers.lastError,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, notionServerId));

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    return realFetch(
      target.startsWith("https://mcp.notion.com") ? mockUrl : input,
      init,
    );
  }) as typeof fetch;

  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    await mock.stop?.();
    await database
      .delete(mcpTools)
      .where(eq(mcpTools.serverId, notionServerId));
    if (advertisedBefore.length > 0) {
      await database.insert(mcpTools).values(advertisedBefore);
    }
    await database
      .update(mcpServers)
      .set({
        toolsRefreshedAt: stampBefore?.toolsRefreshedAt ?? null,
        lastError: stampBefore?.lastError ?? null,
      })
      .where(eq(mcpServers.id, notionServerId));
  }
}

/**
 * A client this deployment registered for itself, which the vendor has since forgotten.
 *
 * A dynamically registered client is nobody's paperwork: there is no console entry an administrator
 * could go and re-create, so a vendor that evicts one — a pruned test client, an expired
 * registration — would otherwise strand every connection to that server behind a refusal nobody in
 * the deployment can act on. The one thing the deployment CAN do is introduce itself again, which is
 * exactly what it did the first time, so it does that once and retries.
 *
 * Once, and only once. A retry that re-registered on every refusal would answer a vendor outage by
 * minting clients in a loop, and the second refusal is the honest signal that the problem is not the
 * client at all.
 */
describe("a dynamic client the vendor has evicted", () => {
  const dynamicBotId = `agent_dynamic_bot_${suite}`;
  const dynamicUserId = `user_dynamic_${suite}`;
  /** Notion, because it is the entry that registers itself. */
  const dynamicServerId = "notion";
  /** Suite-scoped, so it cannot collide with a name Notion really advertises. */
  const dynamicToolName = `search_dyn_${suite}`;
  const dynamicRef = `${dynamicServerId}/${dynamicToolName}`;
  /** 32 zero bytes in base64: a real AES-256 key, because every call here opens the vault. */
  const DYNAMIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  /** The client the deployment registered once and the vendor has stopped honouring. */
  const EVICTED: OAuthClient = { clientId: "dyn-1", clientSecret: "" };
  /** What registering again gets. No secret: a DCR client proves itself with PKCE. */
  const FRESH: OAuthClient = { clientId: "dyn-2", clientSecret: "" };
  /** Built the way the callback route builds it, so the vendor is offered the real thing. */
  const REDIRECT_URI = redirectUriFor("https://openbot.test");
  /** The pinned endpoint, read from the entry rather than copied, so the two cannot drift. */
  const REGISTRATION_URL = (() => {
    const entry = catalogueEntry(dynamicServerId);
    if (entry?.auth.kind !== "user-oauth" || !entry.auth.registrationUrl) {
      throw new Error(
        "notion is not a dynamically registered user-oauth entry",
      );
    }
    return entry.auth.registrationUrl;
  })();
  const SCOPE = "";

  const clientFixture = oauthClientFixture(dynamicServerId);
  const vault = clientFixture.vault;
  /** Which client each exchange was offered, in order. One entry per call, never two. */
  const offered: string[] = [];
  /**
   * Every exchange as the pair it really is: which client presented which grant.
   *
   * The pair is the property, not either half. A refresh token belongs to the client it was issued
   * to — RFC 6749 §6 has the token endpoint check exactly that, and §10.4 says why — so a pair
   * naming a token under a client it was never issued to is this deployment attempting to spend one
   * client's grant as another's. No call may ever produce one.
   */
  const exchanges: { clientId: string; refreshToken: string }[] = [];
  /** Which client the vendor issued each refresh token to, so the stub can enforce the binding. */
  const issuedTo = new Map<string, string>();
  /** Every registration the store asked the vendor for, with what it asked with. */
  const registrations: { registrationUrl: string; redirectUri: string }[] = [];
  /** Which client ids the vendor still honours. Anything else is answered `invalid_client`. */
  let accepted = new Set<string>();
  /** What the vendor's registration endpoint hands back, installed per test. */
  let issue: () => OAuthClient | null = () => {
    throw new Error("no registration was installed for this test");
  };

  /**
   * How the vendor refuses a client it no longer honours.
   *
   * Both halves of what `exchangeRefreshTokenOverHttp` builds for a reply carrying an `error` code:
   * the sentence a person reads, and the code as a FIELD. The field is the half the retry
   * reads, which is why it is set structurally here rather than spelled into the prose — two tests
   * below vary each half independently to prove which one is load-bearing.
   */
  const evictionRefusal = () =>
    new TokenRefusedError(
      "The vendor would not renew this access (401). (invalid_client)",
      INVALID_CLIENT,
    );
  /** The refusal in force, so a test can vary the sentence or the code. Reset before each. */
  let refuse: () => Error = evictionRefusal;

  /*
   * The exchange, standing in for the vendor's token endpoint.
   */
  const seams = {
    exchangeRefreshToken: async ({
      client,
      refreshToken,
    }: {
      tokenUrl: string;
      client: OAuthClient;
      refreshToken: string;
    }): Promise<AccessToken> => {
      offered.push(client.clientId);
      exchanges.push({ clientId: client.clientId, refreshToken });
      if (!accepted.has(client.clientId)) {
        throw refuse();
      }
      /*
       * A grant belongs to one client, and this stub enforces it.
       *
       * It did not, and that omission is what made the old "register again and re-present the same
       * refresh token" retry look like it worked. It only ever worked against a vendor that skipped
       * the check RFC 6749 §6 requires — so the mechanism was pinned by a fixture whose behaviour
       * would itself have been the vulnerability.
       */
      const owner = issuedTo.get(refreshToken);
      if (owner !== undefined && owner !== client.clientId) {
        throw new TokenRefusedError(
          "The vendor would not renew this access (400). (invalid_grant)",
          "invalid_grant",
        );
      }
      // The same token back, so nothing rotates: what this suite is about is the client.
      return { accessToken: `at-${client.clientId}`, refreshToken };
    },
    registerClient: async (input: {
      registrationUrl: string;
      redirectUri: string;
    }) => {
      registrations.push(input);
      return issue();
    },
  };

  const dynamicStore = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: vault,
    encryptionKey: DYNAMIC_KEY,
    policy: () => policy,
    callVendor: async () => ({
      text: "[vendor not reached in tests]",
      isError: false,
    }),
    ...seams,
    redirectUri: REDIRECT_URI,
  });

  /**
   * The same store, for a deployment with no public URL.
   *
   * There is nowhere for the vendor to send anybody back to, so there is nothing honest to register
   * — and registering a redirect URI that does not resolve would leave a client that can never
   * complete a consent flow.
   */
  const storeWithNoRedirect = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: vault,
    encryptionKey: DYNAMIC_KEY,
    policy: () => policy,
    ...seams,
  });

  /**
   * Point the server at a client, the way a registration does, without going through one.
   *
   * Aged an hour by default, because that is the client these tests are about: one the deployment
   * has been using for a while and the vendor has since evicted. A row written a moment ago is
   * inside the re-registration window and is deliberately not registered around, which is its own
   * test below rather than the state every other test starts from.
   */
  async function putClient(
    client: OAuthClient,
    registeredAt = new Date(Date.now() - 60 * 60 * 1000),
  ) {
    /*
     * One live client per key is law (`credentials_active_key_idx`), so planting a client the way a
     * registration would means retiring whatever live row the key still holds from an earlier test.
     */
    await clientFixture.retireClients();
    const [row] = await database
      .insert(credentials)
      .values({
        kind: "mcp_oauth_client",
        provider: dynamicServerId,
        keyId: `oauth-client-${dynamicServerId}`,
        metadata: { clientId: client.clientId },
        encryptedValue: await encryptSecret(
          DYNAMIC_KEY,
          JSON.stringify(client),
        ),
        createdAt: registeredAt,
      })
      .returning({ id: credentials.id });
    if (!row) throw new Error("client was not stored");
    clientFixture.track(row.id);
    await database
      .update(mcpServers)
      .set({ credentialId: row.id })
      .where(eq(mcpServers.id, dynamicServerId));
  }

  /** A deployment that holds no client for this server at all. */
  async function clearClient(serverId = dynamicServerId) {
    await database
      .update(mcpServers)
      .set({ credentialId: null })
      .where(eq(mcpServers.id, serverId));
  }

  /**
   * How many of those rows say a particular actor registered a particular client.
   *
   * Counted rather than "the most recent row", because these rows have no ordering finer than the
   * second they were written in and this suite writes several of them.
   */
  const registeredBy = (
    rows: { actor: string; clientId: string }[],
    actor: string,
    clientId: string,
  ) =>
    rows.filter((row) => row.actor === actor && row.clientId === clientId)
      .length;

  /** What the trail says about clients registered for this server, and by whom. */
  async function registeredRows() {
    return database
      .select({
        actor: sql<string>`payload ->> 'actor'`,
        clientId: sql<string>`payload ->> 'clientId'`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.oauth_client_registered"),
          eq(auditEvents.targetId, dynamicServerId),
          // `notion` and `dyn-1` are fixed spellings, so without this the count is every run's.
          sinceThisRun(),
        ),
      );
  }

  /**
   * A connection holding `rt-1`, written through the store so the vault is exercised.
   *
   * `issuedBy` is which client the vendor issued that grant to, which is the fact the stub above
   * enforces. It is the evicted one in every test here, because that is what an eviction means: the
   * grant somebody holds was obtained under the client the vendor has since stopped honouring.
   */
  async function connect(issuedBy: OAuthClient = EVICTED) {
    await dynamicStore.recordConnection({
      serverId: dynamicServerId,
      userId: dynamicUserId,
      refreshToken: "rt-1",
      scope: SCOPE,
    });
    issuedTo.set("rt-1", issuedBy.clientId);
    offered.length = 0;
    exchanges.length = 0;
    registrations.length = 0;
  }

  /** One tool call by the connected person, which is every call this suite makes. */
  const call = () =>
    dynamicStore.callTool({
      ref: dynamicRef,
      args: {},
      botId: dynamicBotId,
      actorId: dynamicUserId,
    });

  /** Whether THIS RUN put the `notion` row there. Counted, never inferred from an absence. */
  let suiteCreatedNotionRow = false;

  // The vendor refuses the ordinary way unless a test says otherwise, so a test that varies the
  // refusal cannot leave the next one asserting against somebody else's setup.
  beforeEach(() => {
    refuse = evictionRefusal;
  });

  beforeAll(async () => {
    await database
      .insert(agents)
      .values({
        id: dynamicBotId,
        name: dynamicBotId,
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();
    await database
      .insert(users)
      .values({
        id: dynamicUserId,
        email: `${dynamicUserId}@openbot.test`,
        name: dynamicUserId,
        emailVerified: false,
      })
      .onConflictDoNothing();

    const [existing] = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, dynamicServerId));
    suiteCreatedNotionRow = existing === undefined;

    await database
      .insert(mcpServers)
      .values({
        id: dynamicServerId,
        title: "Notion",
        vendor: "Notion",
        url: "https://mcp.notion.com/mcp",
        provenance: "first-party",
      })
      .onConflictDoNothing();
    await clientFixture.start();
    await database
      .insert(mcpTools)
      .values({
        serverId: dynamicServerId,
        name: dynamicToolName,
        description: "Search pages.",
      })
      .onConflictDoNothing();
    await dynamicStore.grant(
      "mcp",
      dynamicRef,
      dynamicBotId,
      "admin@openbot.local",
    );
  });

  afterAll(async () => {
    await database
      .delete(mcpUserCredentials)
      .where(
        and(
          eq(mcpUserCredentials.serverId, dynamicServerId),
          eq(mcpUserCredentials.userId, dynamicUserId),
        ),
      );
    await clientFixture.restore();
    await database
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.ref, dynamicRef),
          eq(pluginGrants.agentId, dynamicBotId),
        ),
      );
    await database
      .delete(mcpTools)
      .where(
        and(
          eq(mcpTools.serverId, dynamicServerId),
          eq(mcpTools.name, dynamicToolName),
        ),
      );
    if (suiteCreatedNotionRow) {
      await database
        .delete(mcpTools)
        .where(eq(mcpTools.serverId, dynamicServerId));
      await database
        .delete(mcpServers)
        .where(eq(mcpServers.id, dynamicServerId));
    }
    await database.delete(agents).where(eq(agents.id, dynamicBotId));
    await database.delete(users).where(eq(users.id, dynamicUserId));
  });

  test("the deployment registers again, once, and refuses this call", async () => {
    await putClient(EVICTED);
    await connect();
    const registeredBefore = await registeredRows();
    // The vendor honours the fresh client, so a retry under it is exactly what would have LOOKED
    // like a recovery. The point of this test is that it is not attempted.
    accepted = new Set([FRESH.clientId]);
    issue = () => FRESH;

    /*
     * The person is told to connect again, because that is the only thing that can help them.
     *
     * Their refresh token was issued to the client the vendor has forgotten, and a grant belongs to
     * the client it was issued to. There is no arrangement of stored secrets that turns it into a
     * usable one — only a new consent under the client that now exists.
     */
    await expect(call()).rejects.toThrow(
      "Notion no longer recognises this deployment's OAuth client",
    );

    /*
     * One exchange, on the client the deployment held. The old grant is never presented to the new
     * client: a conforming vendor refuses that (RFC 6749 §6), so the retry that used to be here
     * could only ever have succeeded against a vendor whose acceptance was itself the bug.
     */
    expect(offered).toEqual([EVICTED.clientId]);
    expect(exchanges).toEqual([
      { clientId: EVICTED.clientId, refreshToken: "rt-1" },
    ]);

    // Registered exactly once, with the pinned endpoint and the deployment's own redirect URI —
    // never a URL from the request, which is the property `redirectUriFor` exists for.
    expect(registrations).toEqual([
      { registrationUrl: REGISTRATION_URL, redirectUri: REDIRECT_URI },
    ]);

    // And kept, so the connect this refusal sends somebody to uses the client that works.
    expect(await dynamicStore.oauthClientFor(dynamicServerId)).toEqual(FRESH);

    /*
     * With a row in the trail saying the deployment did it to itself.
     *
     * `deployment` rather than the person whose call triggered it: they consented to nothing here,
     * and a trail naming them would read as an administrator having registered a client.
     */
    const registered = await registeredRows();
    expect(registered.length).toBe(registeredBefore.length + 1);
    expect(registeredBy(registered, "deployment", FRESH.clientId)).toBe(
      registeredBy(registeredBefore, "deployment", FRESH.clientId) + 1,
    );
  });

  test("a vendor refusing everything costs one registration, not one per call", async () => {
    await putClient(EVICTED);
    await connect();
    // The vendor honours nothing, which is what an outage looks like from here.
    accepted = new Set<string>();
    issue = () => ({ clientId: "dyn-3", clientSecret: "" });

    await expect(call()).rejects.toThrow(
      "Notion no longer recognises this deployment's OAuth client",
    );
    expect(registrations.length).toBe(1);
    expect(exchanges).toEqual([
      { clientId: EVICTED.clientId, refreshToken: "rt-1" },
    ]);

    /*
     * The next call is a NEW call, not a retry: it reads the client the deployment now holds, offers
     * it once, and is refused. What it must not do is register a second one — dyn-3 was stored
     * moments ago, so it is inside the re-registration window and is left alone. That is the
     * difference between an outage costing one client and costing one per tool call.
     */
    exchanges.length = 0;
    await expect(call()).rejects.toThrow("invalid_client");
    expect(registrations.length).toBe(1);
    expect(exchanges).toEqual([{ clientId: "dyn-3", refreshToken: "rt-1" }]);
  });

  /**
   * A client minted moments ago is not registered around again.
   *
   * Once per call is right for one call and wrong for a deployment: a vendor answering every
   * exchange `invalid_client` — an outage, not an eviction — has every tool call anywhere in the
   * deployment mint a client of its own, because each of them is the first refusal it has seen.
   * The age of the stored client is the one piece of shared state that says otherwise, and a client
   * younger than the window is already the product of somebody's re-registration.
   */
  test("a client registered moments ago is refused rather than replaced", async () => {
    // Written now, the way a re-registration would have written it a moment ago.
    await putClient(EVICTED, new Date());
    await connect();
    accepted = new Set<string>();
    issue = () => FRESH;

    // The vendor's own refusal, surfaced as it stands: nothing here can improve on it.
    await expect(call()).rejects.toThrow("invalid_client");

    expect(registrations).toEqual([]);
    expect(offered).toEqual([EVICTED.clientId]);
    expect(exchanges).toEqual([
      { clientId: EVICTED.clientId, refreshToken: "rt-1" },
    ]);
  });

  /**
   * The code decides, not the sentence.
   *
   * The sentence is written for a person and will be reworded — shortened, translated, given a
   * different parenthesis. When the recovery hung on a substring of it, any of those edits would
   * have switched self-registration off with every test in this file still passing, and the symptom
   * would have been every Notion connection in the deployment stranded behind a refusal.
   */
  test("a refusal that words it differently still re-registers", async () => {
    await putClient(EVICTED);
    await connect();
    accepted = new Set([FRESH.clientId]);
    issue = () => FRESH;
    // Not one character of the code anywhere in the prose.
    refuse = () =>
      new TokenRefusedError(
        "Le fournisseur a refusé de renouveler cet accès (401).",
        INVALID_CLIENT,
      );

    await expect(call()).rejects.toThrow(
      "Notion no longer recognises this deployment's OAuth client",
    );

    expect(offered).toEqual([EVICTED.clientId]);
    expect(registrations.length).toBe(1);
    expect(await dynamicStore.oauthClientFor(dynamicServerId)).toEqual(FRESH);
  });

  /** And the other way round: prose that says the word, over a code that does not. */
  test("a refusal whose code is another one is not registered around", async () => {
    await putClient(EVICTED);
    await connect();
    accepted = new Set<string>();
    issue = () => FRESH;
    refuse = () =>
      new TokenRefusedError(
        "The vendor would not renew this access (400). (invalid_grant, not an invalid_client problem)",
        "invalid_grant",
      );

    await expect(call()).rejects.toThrow("invalid_grant");

    // A withdrawn grant is the person's to fix by connecting again. Minting a client for it would
    // leave a spare client behind and still refuse.
    expect(registrations).toEqual([]);
    expect(offered).toEqual([EVICTED.clientId]);
  });

  /**
   * Two calls queued on one connection, and one registration between them.
   *
   * The client is read INSIDE the per-connection critical section, so the second call reads it after
   * the first has replaced it. Read before the queue instead, both calls would carry the evicted
   * client in, both would be refused, and both would register — a client minted per queued call, on
   * a deployment whose client the first call already replaced.
   *
   * Both calls fail, and they fail differently, which is the honest outcome. The first found the
   * client evicted; the second offered the client that now exists and was refused because the grant
   * it holds was issued to the old one. Only a new consent fixes that, and both refusals say so.
   */
  test("two calls queued on one connection register once between them", async () => {
    await putClient(EVICTED);
    await connect();
    accepted = new Set([FRESH.clientId]);
    issue = () => FRESH;

    const results = await Promise.allSettled([call(), call()]);

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    // One exchange per call, and never a token offered twice inside one of them.
    expect(offered).toEqual([EVICTED.clientId, FRESH.clientId]);
    expect(registrations.length).toBe(1);
  });

  test("a client the deployment already holds is handed back untouched", async () => {
    await putClient(EVICTED);
    registrations.length = 0;

    expect(
      await dynamicStore.ensureOAuthClient(
        dynamicServerId,
        "someone@openbot.test",
      ),
    ).toEqual(EVICTED);
    // Nothing was asked of the vendor: this is the path every connect takes once, and it must not
    // mint a client on top of the working one.
    expect(registrations).toEqual([]);
  });

  test("a dynamic entry with no client gets one, kept and recorded", async () => {
    await clearClient();
    registrations.length = 0;
    const registeredBefore = await registeredRows();
    issue = () => FRESH;

    expect(
      await dynamicStore.ensureOAuthClient(
        dynamicServerId,
        "someone@openbot.test",
      ),
    ).toEqual(FRESH);
    expect(registrations).toEqual([
      { registrationUrl: REGISTRATION_URL, redirectUri: REDIRECT_URI },
    ]);
    expect(await dynamicStore.oauthClientFor(dynamicServerId)).toEqual(FRESH);

    const registered = await registeredRows();
    expect(registered.length).toBe(registeredBefore.length + 1);
    // Whoever pressed Connect, because for a first registration that IS the act that caused it.
    expect(
      registeredBy(registered, "someone@openbot.test", FRESH.clientId),
    ).toBe(
      registeredBy(registeredBefore, "someone@openbot.test", FRESH.clientId) +
        1,
    );
  });

  /**
   * The registration nothing stands in for.
   *
   * Every other test here injects `registerClient`, which is right for asserting what the store does
   * with an answer but means the real function is never the one answering. What it returns when the
   * vendor cannot be reached at all is exactly what the store's `null` branches were written for, so
   * once that path exists it is worth one test that lets the real code produce the value rather than
   * a stub asserting the value the real code is assumed to produce.
   */
  const storeWithRealRegistration = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: vault,
    encryptionKey: DYNAMIC_KEY,
    policy: () => policy,
    callVendor: async () => ({
      text: "[vendor not reached in tests]",
      isError: false,
    }),
    exchangeRefreshToken: seams.exchangeRefreshToken,
    redirectUri: REDIRECT_URI,
  });

  test("an unreachable registration endpoint leaves no client and no trail", async () => {
    await clearClient();
    const registeredBefore = await registeredRows();
    const said: string[] = [];
    const realError = console.error;
    const realFetch = globalThis.fetch;
    console.error = (...args: unknown[]) => {
      said.push(args.map(String).join(" "));
    };
    globalThis.fetch = (async () => {
      throw new TypeError("Unable to connect.");
    }) as unknown as typeof fetch;

    try {
      expect(
        await storeWithRealRegistration.ensureOAuthClient(
          dynamicServerId,
          "someone@openbot.test",
        ),
      ).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      console.error = realError;
    }

    // Nothing kept, and nothing claimed. A trail row here would say this deployment registered
    // itself with a vendor that never answered.
    expect(
      await storeWithRealRegistration.oauthClientFor(dynamicServerId),
    ).toBe(null);
    expect((await registeredRows()).length).toBe(registeredBefore.length);
    expect(
      said.find((line) =>
        line.includes("oauth-registration-endpoint-unreachable"),
      ),
    ).toBeDefined();
  });

  test("an entry an administrator registers by hand is left alone", async () => {
    /*
     * Drive, whose client is pasted in from Google's console. Registering one for it would be
     * inventing a client at a vendor that never offered to issue one — the honest answer is none,
     * and the 409 an administrator sees is the instruction to go and paste one.
     */
    const [before] = await database
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    await clearClient(serverId);
    registrations.length = 0;

    try {
      expect(
        await dynamicStore.ensureOAuthClient(serverId, "someone@openbot.test"),
      ).toBeNull();
      expect(registrations).toEqual([]);
    } finally {
      await database
        .update(mcpServers)
        .set({ credentialId: before?.credentialId ?? null })
        .where(eq(mcpServers.id, serverId));
    }
  });

  test("a deployment with no public URL registers nothing", async () => {
    await clearClient();
    registrations.length = 0;

    expect(
      await storeWithNoRedirect.ensureOAuthClient(
        dynamicServerId,
        "someone@openbot.test",
      ),
    ).toBeNull();
    expect(registrations).toEqual([]);
  });

  /**
   * Two people pressing Connect at the same moment, on a deployment holding no client yet.
   *
   * `POST /connect` is `requireUser`, not `requireAdmin`, so this is not a rare interleaving — it is
   * the ordinary first hour of a connector nobody has used. Unserialised, the two runs read "no live
   * client" and then both write one: the second `create` meets the first on
   * `credentials_active_key_idx` as a raw 23505, which reaches the person as a 500 where a consent
   * URL belonged, and a `rotate` racing the same way fails with "Previous credential is already
   * revoked" instead.
   *
   * One client, not two, and that part is not only about the error. Two clients means one of the two
   * consent screens names a client the vault no longer holds, so that person consents and their
   * callback then redeems the code against the other client — a connect that fails after the vendor
   * said yes, which is the hardest possible place to fail.
   */
  test("two first connects race to one client, and both callers get it", async () => {
    await clearClient();
    // No live row for the key either, so this really is a deployment holding nothing: `clearClient`
    // only drops the pointer, and it is the KEY the index constrains.
    await clientFixture.retireClients();
    registrations.length = 0;
    // A distinct client per registration, so two registrations cannot be mistaken for one.
    let issued = 0;
    issue = () => {
      issued += 1;
      return { clientId: `dyn-race-${issued}`, clientSecret: "" };
    };

    const [first, second] = await Promise.all([
      dynamicStore.ensureOAuthClient(dynamicServerId, "one@openbot.test"),
      dynamicStore.ensureOAuthClient(dynamicServerId, "two@openbot.test"),
    ]);

    // Neither raised, and neither got null: both people can be sent to consent.
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The same client, so both consent screens name the client the deployment actually holds.
    expect(first).toEqual(second);
    expect(registrations.length).toBe(1);

    /*
     * One live row for the key, and the server row naming exactly it.
     *
     * The pair is the assertion, not either half: the vault write and the pointer write are one
     * transaction now, so a reader can never see a live client the server row does not name, nor a
     * server row naming a client the vault retired.
     */
    const live = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_oauth_client"),
          eq(credentials.provider, dynamicServerId),
          eq(credentials.keyId, `oauth-client-${dynamicServerId}`),
          sql`${credentials.revokedAt} IS NULL`,
        ),
      );
    expect(live.length).toBe(1);
    const [server] = await database
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, dynamicServerId));
    expect(server?.credentialId).toBe(live[0]?.id);
  });

  /**
   * A refresh naming the advertised tools this deployment's write list does not cover.
   *
   * Notion has no scope strings and no read-only scope: access is per-page, chosen on the consent
   * screen, so `writeTools` plus the action policy are the ENTIRE write barrier. The entry's own
   * comment says reconciling that list against the live tool list "is required, not cosmetic" — and
   * until this row existed, nothing mechanical did it. An advertised tool missing from the list
   * classifies as a READ ({@link classifyTool}), so under-inclusion is the failure mode and it is
   * silent.
   *
   * The vendor here is a real MCP server on localhost, reached by pointing the pinned host at it for
   * the length of this test — see {@link withMockedNotionListing}, which also puts back what the
   * refresh overwrites. What is under test is what a real listing over the real protocol produces.
   */
  test("a refresh names the advertised tools no write list covers", async () => {
    await putClient(EVICTED);
    await connect();
    accepted = new Set([EVICTED.clientId]);

    /** Suite-scoped, so it cannot be a name Notion really advertises, nor a name in `writeTools`. */
    const unlistedName = `notion-invent-${suite}`;

    await withMockedNotionListing(
      dynamicServerId,
      [
        {
          name: "notion-create-pages",
          description: "A write the list already names.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: unlistedName,
          description: "Advertised, and named by no write list.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      async () => {
        expect(
          await dynamicStore.refreshTools(dynamicServerId, dynamicUserId),
        ).toEqual({ tools: 2 });
      },
    );

    // Read after the restore, because the audit trail is what the refresh leaves that the restore
    // does not take back.
    const named = (
      await database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "configuration.changed"),
            eq(auditEvents.targetId, dynamicServerId),
            sql`payload ->> 'change' = 'unlisted_tools_advertised'`,
            /*
             * `named` is what THIS refresh recorded, not the union over every refresh there has
             * ever been. `notion` and `notion-create-pages` are both fixed spellings, so both
             * assertions below were being answered partly by rows older code wrote: the negative
             * one would report today's classification as wrong on the strength of a row from
             * before the write list covered that name.
             */
            sinceThisRun(),
          ),
        )
    ).flatMap((row) => (row.payload as { tools?: string[] }).tools ?? []);

    // The one the list does not name, and never the one it does.
    expect(named).toContain(unlistedName);
    expect(named).not.toContain("notion-create-pages");
  });

  /**
   * The classification an MCP server has always had, over a real listing that really happened.
   *
   * The three columns the refresh writes are the transports' to fill in, and an MCP server that
   * annotates nothing fills in none of them — which is what every fixture in THIS test does, and
   * so what it is about. It is no longer true of the transport in general: `listTools` reads
   * `annotations.destructiveHint` and writes both `effect` and `destructive` from it, which the
   * test below this one covers. `classifyTool` consults the reviewed `writeTools`
   * list BEFORE the recorded `effect` column, on the criterion that a recorded value may narrow what
   * a Bot is allowed and may never widen it — so a name the list covers stays a write whatever the
   * column says, and a value appearing here can no longer turn one of Notion's reviewed writes into a
   * read. The other direction is still open, which is what this test is for: a name the list does not
   * cover falls through to the column, where PRESENCE rather than truthiness decides, so an effect
   * recorded for Notion would silently reclassify every one of its reads as a write, on a connector
   * nobody touched. Only `null` and `undefined` are silence. Asserted on the rows AND on what the
   * Plugins page derives from them, because it is the second one that an administrator reads.
   *
   * It lives in this suite because this is the only place a `user-oauth` listing can actually be
   * made to happen: the refresh runs on the grant of whoever pressed the button, so a Notion row with
   * nobody connected records a refusal in `lastError` and writes no tools at all — which is a test
   * that passes by having nothing to check.
   */
  test("a refreshed MCP server records no effect, no marker and no version", async () => {
    await putClient(EVICTED);
    await connect();
    accepted = new Set([EVICTED.clientId]);

    await withMockedNotionListing(
      dynamicServerId,
      [
        {
          name: "notion-fetch",
          description: "A read no write list names.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "notion-create-pages",
          description: "A write the list already names.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      async () => {
        // Two tools listed, so the assertions below have something to be about: `every` over an
        // empty list is true, and a refusal recorded in `lastError` would leave exactly that.
        expect(
          await dynamicStore.refreshTools(dynamicServerId, dynamicUserId),
        ).toEqual({ tools: 2 });

        const rows = await database
          .select({
            name: mcpTools.name,
            effect: mcpTools.effect,
            destructive: mcpTools.destructive,
            version: mcpTools.version,
          })
          .from(mcpTools)
          .where(eq(mcpTools.serverId, dynamicServerId))
          .orderBy(asc(mcpTools.name));

        expect(rows).toEqual([
          {
            name: "notion-create-pages",
            effect: null,
            destructive: false,
            version: null,
          },
          {
            name: "notion-fetch",
            effect: null,
            destructive: false,
            version: null,
          },
        ]);

        const listed = (await dynamicStore.listServers()).find(
          (server) => server.id === dynamicServerId,
        );

        // The reviewed write list, still deciding: the name it covers is a write and the name it
        // does not is a read. A recorded effect on either row is what would take this over.
        expect(
          listed?.tools.map((tool) => ({
            name: tool.name,
            effect: tool.effect,
          })),
        ).toEqual([
          { name: "notion-create-pages", effect: "write" },
          { name: "notion-fetch", effect: "read" },
        ]);
      },
    );
  });

  /**
   * The one annotation this deployment believes, and the two it declines to.
   *
   * CRITERION. `destructiveHint === true` is recorded as `effect: "write"` and `destructive: true`.
   * `readOnlyHint` is recorded as NOTHING AT ALL — not as `read`, not as a value overridden further
   * down — whether or not the reviewed write list already covers the name.
   *
   * REASON. The SDK warns where it declares these hints that a client must not make tool-use
   * decisions from annotations an untrusted server supplied, and the two hints are not symmetrical
   * against that warning. `destructiveHint` can only move an action from read to write, so a server
   * that lies with it restricts itself. `readOnlyHint` moves an action the other way, and it would
   * buy nothing in the two curated cases — a name on `writeTools` never reaches the column, and a
   * name absent from it already reads as a read — while opening the third: a server an
   * administrator added by URL has no reviewed list, and `classifyTool` returns on the recorded
   * column BEFORE its `if (!entry) return "write"`, so believing the hint would let an arbitrary
   * server declare its whole surface harmless and turn "no reviewed list means everything is a
   * write" into an opt-out.
   *
   * WHY NULL IS THE ASSERTION rather than a classification. Both `readOnlyHint` fixtures come out
   * of `listServers` correctly whatever the column holds — one is on the write list, the other is
   * not — so a classification assertion alone would pass with the hint written down and overruled
   * downstream. NULL in the column is what says it was never read.
   */
  test("a refresh records the effect an MCP server declares, and only the narrowing one", async () => {
    await putClient(EVICTED);
    await connect();
    accepted = new Set([EVICTED.clientId]);

    /** Suite-scoped, so it is not a name Notion really advertises nor one `writeTools` covers. */
    const destructiveName = `notion-destroy-${suite}`;

    await withMockedNotionListing(
      dynamicServerId,
      [
        {
          name: "notion-fetch",
          description:
            "A read no write list names, declaring itself read-only.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "notion-create-pages",
          description: "A reviewed write, declaring itself read-only.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: destructiveName,
          description: "Advertised, on no write list, declared destructive.",
          inputSchema: { type: "object", properties: {} },
          annotations: { destructiveHint: true },
        },
      ],
      async () => {
        expect(
          await dynamicStore.refreshTools(dynamicServerId, dynamicUserId),
        ).toEqual({ tools: 3 });

        const rows = await database
          .select({
            name: mcpTools.name,
            effect: mcpTools.effect,
            destructive: mcpTools.destructive,
          })
          .from(mcpTools)
          .where(eq(mcpTools.serverId, dynamicServerId))
          .orderBy(asc(mcpTools.name));

        expect(rows).toEqual([
          // The reviewed write, which said it was read-only. Nothing recorded, so nothing to
          // overrule: the write list is still the only thing that answers for this name.
          { name: "notion-create-pages", effect: null, destructive: false },
          // The declaration that narrows, taken at its word.
          { name: destructiveName, effect: "write", destructive: true },
          // The unreviewed read, which also said it was read-only, and is believed about nothing.
          { name: "notion-fetch", effect: null, destructive: false },
        ]);

        const listed = (await dynamicStore.listServers()).find(
          (server) => server.id === dynamicServerId,
        );

        // What the Plugins page derives, which is what an administrator actually reads: the
        // reviewed name is a write because review says so, the declared one is a write because the
        // vendor narrowed it, and the third is the read it was already classified as.
        expect(
          listed?.tools.map((tool) => ({
            name: tool.name,
            effect: tool.effect,
          })),
        ).toEqual([
          { name: "notion-create-pages", effect: "write" },
          { name: destructiveName, effect: "write" },
          { name: "notion-fetch", effect: "read" },
        ]);
      },
    );
  });

  /**
   * What a failed refresh writes into `lastError`, and how much of it.
   *
   * The column is drawn on the admin page and parts of the sentence come from a vendor, so it is not
   * a promise about length — the same reasoning `callTool` already applies to the failure it records.
   * Capped at the same 400 characters, so the two agree.
   */
  test("a refusal written to lastError is capped like every other vendor sentence", async () => {
    await putClient(EVICTED);
    await connect();
    // A refusal the retry cannot act on — no code at all — so it arrives unedited and long.
    accepted = new Set<string>();
    refuse = () => new Error(`vendor said: ${"y".repeat(1_000)}`);

    const [before] = await database
      .select({ lastError: mcpServers.lastError })
      .from(mcpServers)
      .where(eq(mcpServers.id, dynamicServerId));

    try {
      // Zero tools and no throw: a refresh records its failure rather than raising it.
      expect(
        await dynamicStore.refreshTools(dynamicServerId, dynamicUserId),
      ).toEqual({ tools: 0 });

      const [row] = await database
        .select({ lastError: mcpServers.lastError })
        .from(mcpServers)
        .where(eq(mcpServers.id, dynamicServerId));
      expect(row?.lastError?.length).toBe(400);
      expect(row?.lastError?.startsWith("vendor said: ")).toBe(true);
    } finally {
      // The column is live configuration an operator reads, so this suite puts back what it found.
      await database
        .update(mcpServers)
        .set({ lastError: before?.lastError ?? null })
        .where(eq(mcpServers.id, dynamicServerId));
    }
  });

  /**
   * A stored client that parses cleanly and is not a client.
   *
   * The sibling of the unparseable row, and its worse half. Guarding the parse answers for SYNTAX
   * only, and the `as OAuthClient` cast behind it answers for nothing — so a row holding
   * snake_case keys, which is what a hand-repair or a half-written row leaves, yields a client
   * whose `clientId` is `undefined` and is handed on as usable.
   *
   * WHAT MAKES IT WORSE THAN A SYNTAX ERROR is where it ends. The unparseable row is refused before
   * the transaction; this one is not refused at all, so the `undefined` id goes to the vendor, the
   * vendor answers `invalid_client`, and {@link refuseAndReplaceEvictedClient} reads that as the
   * vendor having disowned this deployment's registration. A corrupt LOCAL row then buys a
   * DEPLOYMENT-WIDE remedy: the client every existing consent was granted against is replaced, and
   * the operator is told the vendor forgot us rather than which credential actually broke.
   */
  describe("a stored OAuth client whose shape is not a client's", () => {
    /** Snake_case where the type is camelCase, with a secret distinctive enough to search for. */
    const MISSHAPEN = JSON.stringify({
      client_id: "dyn-snake",
      client_secret: `shh_notAClient_${suite}`,
    });
    /** What the operator must be told instead: the credential named, and nothing else claimed. */
    const UNUSABLE =
      "Notion has no usable OAuth client for this deployment. Connect Notion again in Settings: the deployment registers itself with the vendor on the next connect.";

    /**
     * Plant arbitrary stored bytes as this server's client, the way {@link putClient} plants a real
     * one — aged an hour, so the re-registration window is not what refuses the call. A row younger
     * than the window would pass these tests for the wrong reason.
     */
    async function putStoredBytes(plaintext: string) {
      await database
        .update(credentials)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(credentials.kind, "mcp_oauth_client"),
            eq(credentials.provider, dynamicServerId),
            eq(credentials.keyId, `oauth-client-${dynamicServerId}`),
            sql`${credentials.revokedAt} IS NULL`,
          ),
        );
      const [row] = await database
        .insert(credentials)
        .values({
          kind: "mcp_oauth_client",
          provider: dynamicServerId,
          keyId: `oauth-client-${dynamicServerId}`,
          metadata: {},
          encryptedValue: await encryptSecret(DYNAMIC_KEY, plaintext),
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        })
        .returning({ id: credentials.id });
      if (!row) throw new Error("misshapen client was not stored");
      clientFixture.track(row.id);
      await database
        .update(mcpServers)
        .set({ credentialId: row.id })
        .where(eq(mcpServers.id, dynamicServerId));
      return row.id;
    }

    /**
     * This tool's failure rows with their ids, so one call's can be told from the suite's.
     *
     * Every test in this describe calls the SAME tool, and the ones above this deliberately produce
     * the eviction sentence — so an assertion that no failure row anywhere mentions it would be
     * about its siblings rather than about this call. The ids are what separate them; there is no
     * ordering finer than the millisecond these rows are written in.
     */
    async function failureRows() {
      return database
        .select({ id: auditEvents.id, payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.eventType, "mcp.call_failed"),
            eq(auditEvents.targetType, "mcp_tool"),
            eq(auditEvents.targetId, dynamicRef),
          ),
        );
    }

    /** Which credential the server row names, which is the thing a re-registration replaces. */
    async function pointedAt() {
      const [row] = await database
        .select({ credentialId: mcpServers.credentialId })
        .from(mcpServers)
        .where(eq(mcpServers.id, dynamicServerId));
      return row?.credentialId ?? null;
    }

    test("a call is refused, and the deployment's client is not replaced", async () => {
      const planted = await putStoredBytes(MISSHAPEN);
      await connect();
      const registeredBefore = await registeredRows();
      // The vendor would honour a fresh client, so registering is available here and would look
      // like a recovery. The point is that it is never reached: there is nothing in this row for a
      // vendor to refuse, so there is nothing to read as an eviction.
      accepted = new Set([FRESH.clientId]);
      issue = () => FRESH;

      await expect(call()).rejects.toThrow(UNUSABLE);

      // Refused before the exchange, so the vendor is never offered an `undefined` client id and
      // never gets to answer `invalid_client` about it.
      expect(offered).toEqual([]);
      // And so the destructive remedy never runs. These are the property: a corrupt local row costs
      // this one call, not every consent in the deployment.
      expect(registrations).toEqual([]);
      expect(await pointedAt()).toBe(planted);
      expect((await registeredRows()).length).toBe(registeredBefore.length);
    });

    test("the refusal names the credential rather than carrying it", async () => {
      await putStoredBytes(MISSHAPEN);
      await connect();
      accepted = new Set([FRESH.clientId]);
      issue = () => FRESH;

      const before = new Set((await failureRows()).map((row) => row.id));
      const refusal = await call().then(
        () => null,
        (error: unknown) => error,
      );
      const written = JSON.stringify(
        (await failureRows()).filter((row) => !before.has(row.id)),
      );
      // The same absence the unparseable row is held to: a misshapen value is still the decrypted
      // client, and half of this one IS a client secret.
      expect(written).not.toContain(`shh_notAClient_${suite}`);
      // Never the eviction sentence either. It would claim a re-registration that did not happen
      // and point the operator at the vendor instead of at the row.
      expect(written).not.toContain("no longer recognises");
      expect(written).toContain(UNUSABLE);
      expect(refusal).toBeInstanceOf(PluginRefusedError);
    });

    /**
     * The readers answer none, which is their existing contract for a value they cannot read.
     *
     * `ensureOAuthClient` consults the stored client first and then again under the lock, so both
     * reads are on this path. Unguarded, the first hands back the misshapen object and a consent
     * URL is built with an `undefined` client id — the person reaches a vendor screen for a client
     * that does not exist. None is the answer that instead gets them a client that works.
     */
    test("the consent flow reads it as none and obtains one that works", async () => {
      await putStoredBytes(MISSHAPEN);
      issue = () => FRESH;

      expect(await dynamicStore.oauthClientFor(dynamicServerId)).toBeNull();
      expect(
        await dynamicStore.ensureOAuthClient(
          dynamicServerId,
          "admin@openbot.test",
        ),
      ).toEqual(FRESH);
    });
  });

  /**
   * The vault row and the pointer that names it commit together, or neither does.
   *
   * They were two transactions, so a failure between them left `mcp_user_credentials` naming a
   * credential that had just been revoked — a connection that reads as live on the settings page and
   * refuses every call. The pointer write is the one that can fail on its own: `user_id` is a real
   * foreign key, so a person who is no longer in `users` is a genuine 23503 at exactly that
   * statement, which is the injection this test uses rather than a spy.
   */
  test("a pointer write that fails leaves no live grant behind", async () => {
    const ghost = `user_ghost_${suite}`;

    await expect(
      dynamicStore.recordConnection({
        serverId: dynamicServerId,
        userId: ghost,
        refreshToken: "rt-ghost",
        scope: SCOPE,
      }),
    ).rejects.toThrow();

    // Nothing in the vault, live or otherwise: the insert that minted it was rolled back with the
    // pointer write that failed. Asked of the key, because that is what a later connect collides on.
    const rows = await database
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.kind, "mcp_user_token"),
          eq(credentials.provider, dynamicServerId),
          eq(credentials.keyId, ghost),
        ),
      );
    expect(rows).toEqual([]);
  });
});

/**
 * A custom server may not take a name the app directory already answers to.
 *
 * `/admin/plugins/composio` is a static route and `/admin/plugins/$key` is the one every server is
 * opened through, and a static route wins. So a server whose id is literally `composio` would be
 * listed, saved, refreshed and then never openable: the row for it would send the operator to the
 * Composio screen instead. Brokered ids are `composio-<slug>`, so this is only reachable by typing
 * the id into the custom-server form, which the id pattern otherwise allows.
 */
describe("a custom server may not be named after one of the app's own screens", () => {
  test("the id composio is refused, and no server is written", async () => {
    await expect(
      store.addCustomServer({
        id: "composio",
        title: "Collector",
        url: "https://collector.example/mcp",
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    // Written-and-unopenable is the whole harm, so the refusal has to stop the write rather than
    // report on it afterwards.
    const rows = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, "composio"));
    expect(rows).toHaveLength(0);
  });
});

/**
 * Which credential a custom server is allowed to be pointed at.
 *
 * `addCustomServer` takes the pointer from the request body, and the add itself dereferences it: the
 * refresh that follows decrypts whatever it names and sends it to the URL from the same request. So
 * the pointer is the whole control. An administrator naming somebody's `mcp_user_token` was enough
 * to have that person's decrypted token delivered to an address the administrator chose, before any
 * grant, policy check or Bot existed.
 *
 * `POST /api/admin/credentials` already refuses to *mint* a `mcp_user_token` by hand, and says why:
 * it would be "creating a credential attributed to a person who never agreed to it". Pointing at one
 * spends that credential on the same person's behalf, which is the same objection.
 */
describe("a custom server may only be pointed at its own kind of credential", () => {
  const suffix = randomUUID().slice(0, 8);
  const deploymentCredentialId = randomUUID();
  const personalCredentialId = randomUUID();
  const oauthClientCredentialId = randomUUID();
  /**
   * The upsert case gets its own token, because a credential names the server it was minted for and
   * that case adds a second server id. Sharing one row across two ids is a shape `storeMcpToken`
   * cannot produce: it sets the provider to the server it is minting for, every time.
   */
  const upsertCredentialId = randomUUID();
  const customServerId = `custom-cred-${suffix}`;
  const attemptedServerIds = new Set<string>();

  function addCustomFixture(
    input: Parameters<typeof store.addCustomServer>[0],
  ) {
    // Refusal tests may fail because the write succeeded. Track the attempt before calling it.
    attemptedServerIds.add(input.id);
    return store.addCustomServer(input);
  }

  beforeAll(async () => {
    const encrypted = await encryptSecret(
      `${"A".repeat(43)}=`,
      "not-read-here",
    );
    await database.insert(credentialRows).values([
      {
        id: deploymentCredentialId,
        kind: "mcp",
        provider: customServerId,
        keyId: customServerId,
        encryptedValue: encrypted,
        metadata: {},
      },
      {
        id: personalCredentialId,
        kind: "mcp_user_token",
        provider: "google-drive",
        // For a user token the key is the person, which is what makes one pickable by name from the
        // administrator's own credential list.
        keyId: `user_someone_else_${suffix}`,
        encryptedValue: encrypted,
        metadata: {},
      },
      {
        id: upsertCredentialId,
        kind: "mcp",
        provider: `${customServerId}-upsert`,
        keyId: `${customServerId}-upsert`,
        encryptedValue: encrypted,
        metadata: {},
      },
      {
        id: oauthClientCredentialId,
        kind: "mcp_oauth_client",
        provider: "google-drive",
        keyId: "google-drive",
        encryptedValue: encrypted,
        metadata: {},
      },
    ]);
  });

  afterAll(async () => {
    if (attemptedServerIds.size > 0) {
      await database
        .delete(mcpServers)
        .where(inArray(mcpServers.id, [...attemptedServerIds]));
    }
    await database
      .delete(credentialRows)
      .where(
        inArray(credentialRows.id, [
          deploymentCredentialId,
          personalCredentialId,
          upsertCredentialId,
          oauthClientCredentialId,
        ]),
      );
  });

  test("somebody else's connector token is refused, and no server is written", async () => {
    const id = `${customServerId}-personal`;
    await expect(
      addCustomFixture({
        id,
        title: "Collector",
        url: "https://collector.example/mcp",
        credentialId: personalCredentialId,
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    // The refusal has to stop the write, not merely report on it: a row here is a pointer the next
    // refresh would dereference.
    const rows = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    expect(rows).toHaveLength(0);
  });

  test("the deployment's OAuth client is refused too", async () => {
    // Not a per-person secret, but not this server's token either, and handing a vendor its own
    // client secret as a bearer token is the mistake `refreshTools` was already changed to avoid.
    const id = `${customServerId}-client`;
    await expect(
      addCustomFixture({
        id,
        title: "Collector",
        url: "https://collector.example/mcp",
        credentialId: oauthClientCredentialId,
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);
  });

  test("a credential that does not exist is refused the same way", async () => {
    // Same message as the wrong-kind refusal on purpose. A caller who can tell "wrong kind" from
    // "no such row" can ask this endpoint which ids are real, which is a vault oracle.
    const id = `${customServerId}-missing`;
    const missing = addCustomFixture({
      id,
      title: "Collector",
      url: "https://collector.example/mcp",
      credentialId: randomUUID(),
      by: "admin@example.com",
    });
    await expect(missing).rejects.toBeInstanceOf(CustomServerRefusedError);

    const wrongKind = addCustomFixture({
      id: `${customServerId}-kind-message`,
      title: "Collector",
      url: "https://collector.example/mcp",
      credentialId: personalCredentialId,
      by: "admin@example.com",
    }).catch((error: Error) => error.message);
    const missingMessage = await missing.catch((error: Error) => error.message);
    expect(await wrongKind).toBe(missingMessage);
  });

  test("the server's own token still works", async () => {
    // The case that must keep passing, so the refusal above is a rule and not a wall. The URL is
    // unreachable and that is fine: a failed refresh is recorded on the row rather than thrown.
    const added = await addCustomFixture({
      id: customServerId,
      title: "Collector",
      url: "https://collector.example/mcp",
      credentialId: deploymentCredentialId,
      by: "admin@example.com",
    });
    expect(added.id).toBe(customServerId);

    const [row] = await database
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, customServerId));
    expect(row?.credentialId).toBe(deploymentCredentialId);
  });

  test("a credential id that is not an id is refused, not a database error", async () => {
    // `credentials.id` is a uuid column, so an unshaped value makes the lookup itself fail. The
    // route passes the body field through untouched, so this is reachable with one curl.
    for (const notAnId of ["not-a-uuid", "' OR 1=1 --"]) {
      await expect(
        addCustomFixture({
          id: `${customServerId}-shape`,
          title: "Collector",
          url: "https://collector.example/mcp",
          credentialId: notAnId,
          by: "admin@example.com",
        }),
      ).rejects.toBeInstanceOf(CustomServerRefusedError);
    }
  });

  test("an empty credential id reads as no credential", async () => {
    // Not the same as a wrong one. An empty string used to reach the insert and break the foreign
    // key; the honest reading is that the administrator named nothing.
    const id = `${customServerId}-empty`;
    const added = await addCustomFixture({
      id,
      title: "Collector",
      url: "https://collector.example/mcp",
      credentialId: "",
      by: "admin@example.com",
    });
    expect(added.id).toBe(id);

    const [row] = await database
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    expect(row?.credentialId).toBeNull();
  });

  test("re-adding an existing server cannot repoint it at a refused credential", async () => {
    // The add is an upsert, so the dangerous shape is not only a new server: an existing one that
    // already holds its own token can be re-added naming somebody else's. The guard has to run
    // before the write, and the pointer already on the row has to survive the refusal.
    const id = `${customServerId}-upsert`;
    await addCustomFixture({
      id,
      title: "Collector",
      url: "https://collector.example/mcp",
      credentialId: upsertCredentialId,
      by: "admin@example.com",
    });

    await expect(
      addCustomFixture({
        id,
        title: "Collector",
        url: "https://collector.example/mcp",
        credentialId: personalCredentialId,
        by: "admin@example.com",
      }),
    ).rejects.toBeInstanceOf(CustomServerRefusedError);

    const [row] = await database
      .select({ credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    expect(row?.credentialId).toBe(upsertCredentialId);
  });

  test("a custom server with no credential at all still works", async () => {
    const id = `${customServerId}-none`;
    const added = await addCustomFixture({
      id,
      title: "Collector",
      url: "https://collector.example/mcp",
      by: "admin@example.com",
    });
    expect(added.id).toBe(id);
  });
});

/**
 * Which advertised names a vendor's write list does not cover, as a rule on its own.
 *
 * Unit-tested here as well as through a refresh, because the rule is the part that decides whether
 * anybody ever hears about an under-inclusive write list, and it has two branches a live listing
 * cannot show side by side: a vendor whose consent screen is the whole barrier, and one whose own
 * scope is read-only. The entries are the real ones, so a catalogue edit that removed Drive's
 * read-only scope would fail here rather than start filing rows about Drive.
 */
describe("advertised tools a write list does not name", () => {
  test("a Notion tool absent from the write list is named, sorted", () => {
    expect(
      unlistedAdvertisedTools(catalogueEntry("notion"), [
        "notion-search",
        "notion-create-pages",
        "notion-fetch",
      ]),
    ).toEqual(["notion-fetch", "notion-search"]);
  });

  test("a write the list already names is not", () => {
    expect(
      unlistedAdvertisedTools(catalogueEntry("notion"), [
        "notion-create-pages",
      ]),
    ).toEqual([]);
  });

  /*
   * Drive's grant is `drive.readonly`, so a tool missing from its write list cannot write whatever
   * this deployment believes about it — the vendor refuses. Filing rows about it would be noise
   * standing between somebody and the vendor where it is the only barrier.
   */
  test("a vendor whose own scope is read-only is not reconciled here", () => {
    expect(
      unlistedAdvertisedTools(catalogueEntry("google-drive"), [
        "search_files",
        "made_up_tool",
      ]),
    ).toEqual([]);
  });

  /** A server an administrator added by URL: every tool of theirs is already a write. */
  test("a server nobody reviewed is not reconciled here either", () => {
    expect(unlistedAdvertisedTools(null, ["anything"])).toEqual([]);
  });
});

/**
 * What the real token endpoint said, read by the real exchange.
 *
 * Every other suite in this file injects `exchangeRefreshToken`, because what they are about is which
 * credential a call goes out with rather than how a reply is parsed. That leaves the parsing itself —
 * the one part that meets a vendor's actual bytes — with nothing exercising it, and the interesting
 * bytes are the dishonest ones: a 200 carrying a CDN interstitial rather than a token.
 */
describe("a vendor reply that is not a token", () => {
  const replyClient: OAuthClient = { clientId: "c-1", clientSecret: "" };

  test("a 200 that is not JSON is a refusal, not a thrown parse error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>checking your browser</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    try {
      /*
       * The refusal this module already knows how to carry, rather than a SyntaxError.
       *
       * An unguarded parse throws out of here into `callTool`, which records it as `mcp.call_failed`
       * with the parser's message — and that message quotes the vendor's body, so an interstitial's
       * HTML ends up in an audit payload and in front of the person who asked.
       */
      await expect(
        exchangeRefreshTokenOverHttp({
          tokenUrl: "https://vendor.example/token",
          client: replyClient,
          refreshToken: "rt-1",
        }),
      ).rejects.toThrow(
        "The vendor answered this renewal with something other than a token.",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a 200 with JSON and no access token is still the refusal it always was", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ token_type: "bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      await expect(
        exchangeRefreshTokenOverHttp({
          tokenUrl: "https://vendor.example/token",
          client: replyClient,
          refreshToken: "rt-1",
        }),
      ).rejects.toThrow("The vendor renewed this access with no token.");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  /** The error branch, which already read defensively: the status survives an unparseable body. */
  test("a refusal that is not JSON keeps the status, which is the one fact there is", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>502</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    try {
      await expect(
        exchangeRefreshTokenOverHttp({
          tokenUrl: "https://vendor.example/token",
          client: replyClient,
          refreshToken: "rt-1",
        }),
      ).rejects.toThrow("The vendor would not renew this access (502).");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/**
 * What a brokered app needs before any of it can be asserted: a clean slate and a fixture.
 *
 * The suites above each own a suite-scoped id, because they run against a database somebody may be
 * using. These fixtures cannot: a Composio app IS its toolkit slug — `gmail` is both the row's id and
 * the name sent to Composio — so the rows have to be spelled the way production spells them, and
 * `bot_helper` and `user_asker` name them in every assertion.
 *
 * What replaces the suffix is the guard at the top of this file, not the ordering below. The deletes
 * here would be indefensible on their own — a real `notion` row cascades into every person's per-user
 * credentials, a real Bot into the six tables behind it, a real person into the ten behind them. They
 * are safe only because the guard has established that no row at any of these ids exists, which makes
 * every row they remove one of this file's own, and the first thing below is the check that it did.
 * Cleaning before each test rather than after is then just so a run that dies halfway leaves the next
 * one nothing to trip over; the `afterAll` below is what stops the last test's fixtures from outliving
 * the run.
 */
async function freshDatabase(): Promise<Database> {
  /*
   * The guard's answer, asked again rather than assumed.
   *
   * "Nothing gets this far unless the guard has established the ids are free" was the whole
   * justification for the deletes below, and it was an assumption about the runner: a `beforeAll`
   * that throws is supposed to stop every test under it. The rest of this file already declines to
   * rely on that — `afterAll` is documented as running anyway, which is why {@link ownsFixtureIds}
   * exists at all — and a delete cascading through a real person is not a thing to leave resting on
   * the difference. So the same positive evidence the teardown waits for authorises these too, and
   * a run that never got it fails loudly here instead of quietly emptying rows.
   */
  if (!ownsFixtureIds) {
    throw new Error(
      "the ownership guard has not cleared this run to own 'gmail', 'notion', 'bot_helper', " +
        "'user_asker' and 'user_leaver', so nothing may be deleted at those ids",
    );
  }
  /*
   * The Bot's own grants, never a delete by ref.
   *
   * The primary key is (kind, ref, agent_id), and `gmail/GMAIL_FETCH_EMAILS` is a real action of a
   * real app: a delete by ref alone would take an administrator's grant for a Bot people use. This
   * file has already done that once — the `afterAll` near the top of it says what that cost.
   */
  await database
    .delete(pluginGrants)
    .where(eq(pluginGrants.agentId, "bot_helper"));
  await database.delete(agents).where(eq(agents.id, "bot_helper"));
  // The actions before the servers. `mcp_tools` cascades on the server row anyway, so this is what
  // clears actions a previous run left against a server row it is not what created.
  await database
    .delete(mcpTools)
    .where(inArray(mcpTools.serverId, ["gmail", "notion"]));
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, ["gmail", "notion"]));
  /*
   * Brokered connections, by the pair and never by half of it.
   *
   * NEITHER HALF ALONE. By toolkit it would take every person's Gmail connection, leaving one
   * orphaned at the broker with no local row to find it by — the table has no foreign key to
   * `users`, which is the property the first test below is about, so nothing else would ever
   * remove it. By person it would take a `("slack", "user_asker")` row belonging to somebody else,
   * for the same reason and at the same cost. {@link ownedConnections} is what the guard at the
   * top of this file has already established nothing else holds.
   *
   * The anonymous pair is swept here as well as in the `finally` of the test that inserts it,
   * because that `finally` covers a failed assertion and not a killed process — and the row it
   * would leave is what the guard refuses on. A pair stranded earlier in this run is therefore
   * gone before the next test looks; a pair that was already there when the run started is still
   * the guard's to refuse, because at that point nothing has established it is ours.
   */
  await database.delete(composioConnections).where(ownedConnections());
  // The person the connection outlives, who is a row in `users` like anybody else. Reached only
  // through the check at the top of this function, because there is no suffix on this id to tell a
  // fixture apart from somebody's account and ten cascades sit behind the difference.
  await database.delete(users).where(eq(users.id, "user_leaver"));
  return database;
}

/**
 * A store over the clean database, recording every event it writes.
 *
 * `recorded()` alongside the real insert rather than instead of it: the payload is what these tests
 * assert about, and reading it back out of `audit_events` would assert what the column round-trips
 * rather than what the store said. The row is still written, because a store whose audit insert
 * never touched the database would not be exercising the one it has.
 *
 * NO `callVendor`. Whose account a call runs as and which transport a row resolves to are the
 * properties under test, and both are decided on the way to the vendor — so the real path has to
 * run, and the vendor is stubbed further out at {@link useComposioClient}.
 *
 * `options` is spread over the defaults rather than read field by field, so a test that needs one
 * more seam — a broker, today — adds it at the call and nothing here has to learn its name.
 */
async function freshStore(options: { broker?: ComposioBroker } = {}) {
  const database = await freshDatabase();
  const persisting = createAuditStore(database);
  const events: Parameters<typeof persisting.insert>[0][] = [];
  const auditStore = {
    insert: async (event: Parameters<typeof persisting.insert>[0]) => {
      events.push(event);
      await persisting.insert(event);
    },
    recorded: () => events,
  };

  const store = createPluginStore({
    database,
    auditStore,
    credentials: credentialsStub,
    encryptionKey: "x".repeat(44),
    policy: () => policy,
    ...options,
  });

  return { store, database, auditStore };
}

/**
 * A Composio Gmail app, one granted read action, one Bot, and optionally a connected person.
 *
 * `version: null` is the action Composio listed without one — a granted, callable row whose version
 * column is null, which is a state the vendor's own optional field produces rather than a leftover
 * from before the column existed.
 *
 * `url` is an option because the id and the url are two fields and nothing holds them equal: a row
 * called `gmail` at `composio://slack` is the shape that used to pass the connection gate on one
 * spelling and run against the other. The connected person is still connected to `gmail`.
 *
 * `authScheme` is the vendor's own scheme literal, as it was recorded when somebody enabled the app,
 * and the call gate reads it to decide whether a connection row is required at all. Absent by
 * default, which is what every other test here wants: a row that is not `NO_AUTH` is a row the gate
 * still asks a connection for.
 */
async function seedComposioGmail(
  database: Database,
  store: PluginStore,
  options: {
    connect?: boolean;
    version?: string | null;
    url?: string;
    authScheme?: string;
  } = {},
) {
  await database.insert(mcpServers).values({
    id: "gmail",
    title: "Gmail",
    vendor: "Composio",
    url: options.url ?? "composio://gmail",
    provenance: "composio",
    authScheme: options.authScheme ?? null,
  });
  await database.insert(mcpTools).values({
    serverId: "gmail",
    name: "GMAIL_FETCH_EMAILS",
    description: "Fetch emails.",
    effect: "read",
    version: options.version === undefined ? "20260903_00" : options.version,
  });
  await database.insert(agents).values({
    id: "bot_helper",
    name: "Helper",
    type: "built_in",
    configuration: {},
  });
  if (options.connect !== false) {
    await database
      .insert(composioConnections)
      .values({ toolkit: "gmail", userId: "user_asker" });
  }
  await store.grant(
    "mcp",
    "gmail/GMAIL_FETCH_EMAILS",
    "bot_helper",
    "admin@example.com",
  );
}

/**
 * What Composio answers a call that worked, in the shape its own schema requires.
 *
 * `ToolExecuteResponseSchema` in `@composio/core` 0.18.1 spells `data`, `error` and `successful`
 * REQUIRED. Every stub below used to answer `{}` or `{ messages: [] }`, which are shapes the vendor
 * cannot produce, and nothing flagged it: `server/tsconfig.json` excludes `tests`, so no typecheck
 * reads these files at all. They stayed green for a reason that is not the property under test —
 * an ABSENT `successful` is not `successful === false`, so the transport's failure branch was
 * simply never entered. A stub that can only answer things the vendor could actually say is what
 * makes the success path's greenness mean something.
 *
 * Typed as {@link ComposioResult} rather than left to inference, so a vendor shape that drifts is a
 * red squiggle here even though the suite is outside the typecheck's reach.
 */
const vendorAnswered = (
  data: Record<string, unknown> = {},
): ComposioResult => ({
  data,
  error: null,
  successful: true,
});

/**
 * What Composio answers when it ran nothing and says why, which is a 200 and not a throw.
 *
 * `successful: false` beside a sentence is the vendor reporting its own failure inside the
 * envelope, which is the case that used to come back from this transport as `isError: false`.
 */
const vendorRefused = (sentence: string): ComposioResult => ({
  data: {},
  error: sentence,
  successful: false,
});

// The vendor is a process-wide registry, so a stub outliving its test would be answering somebody
// else's calls.
afterEach(() => useComposioClient(null));

/*
 * The last test's fixtures, which nothing else would remove.
 *
 * {@link freshDatabase} cleans BEFORE each test, so without this the final test's rows are
 * permanent: a `notion` server row and a `notion-fetch` action nobody configured, which makes
 * whatever database this ran against advertise a connector nobody set up. Worse on the next run —
 * the rotation and dynamic-registration suites above read the leak as a row they did not create,
 * correctly decline to clean what looks like the deployment's own, and leave this delete as the only
 * thing that removes it.
 *
 * Exactly what this file created, and only when the guard cleared the run to own these ids.
 */
afterAll(async () => {
  if (!ownsFixtureIds) return;
  await database
    .delete(mcpTools)
    .where(inArray(mcpTools.serverId, ["gmail", "notion"]));
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, ["gmail", "notion"]));
  await database.delete(composioConnections).where(ownedConnections());
  /*
   * And the witness row, which is at neither `gmail` nor any person.
   *
   * CRITERION. Nothing at `sweep_witness_${suite}` outlives this run.
   *
   * REASON. It is removed in its own test's `finally`, which a killed process does not run — and
   * nothing else would reach it: `ownedConnections` names `gmail` and `linear`, and the anonymous
   * actor is precisely what `retireConnectionsFor` refuses to act on, so no operation in the
   * product could clear it either. Named exactly rather than by prefix, because another run's
   * witness is that run's to take back.
   */
  await database
    .delete(composioConnections)
    .where(eq(composioConnections.toolkit, `sweep_witness_${suite}`));
  await database.delete(agents).where(eq(agents.id, "bot_helper"));
  await database.delete(users).where(eq(users.id, "user_leaver"));
});

test("a Composio connection row survives the person being deleted", async () => {
  const database = await freshDatabase();

  await database
    .insert(users)
    .values({ id: "user_leaver", email: "leaver@example.com", name: "Leaver" });
  await database
    .insert(composioConnections)
    .values({ toolkit: "gmail", userId: "user_leaver" });

  await database.delete(users).where(eq(users.id, "user_leaver"));

  /*
   * Asked at the app this test connected, not at every app this person might hold.
   *
   * The guard at the top of this file is keyed on the pair, so a `("slack", "user_leaver")` row
   * belonging to somebody else is deliberately allowed to exist — and asking by person alone would
   * then read it into this assertion and fail over a row that has nothing to do with the property
   * under test.
   */
  const rows = await database
    .select({ toolkit: composioConnections.toolkit })
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, "gmail"),
        eq(composioConnections.userId, "user_leaver"),
      ),
    );

  // The whole reason this table exists rather than reusing mcp_user_credentials: offboarding has to
  // still find the connection and revoke it at Composio after the person is gone, and there is no
  // vault row to find it by, because Composio holds the account.
  expect(rows).toEqual([{ toolkit: "gmail" }]);
});

test("a Composio app is listed through the Composio transport, not dialled as MCP", async () => {
  const { store, database } = await freshStore();
  const asked: string[] = [];
  useComposioClient({
    listActions: async (toolkit) => {
      asked.push(toolkit);
      return [];
    },
    execute: async () => vendorAnswered(),
  });
  await database.insert(mcpServers).values({
    id: "gmail",
    title: "Gmail",
    vendor: "Composio",
    url: "composio://gmail",
    provenance: "composio",
  });

  await store.refreshTools("gmail", "admin_user");

  // The transport comes from the resolved kind, not from the absent entry. Derived from the entry,
  // this reached the MCP module instead and dialled `composio://gmail` as an HTTP server — which
  // `refreshTools` swallows into `lastError`, so nothing but this reaches the vendor stub.
  expect(asked).toEqual(["gmail"]);
});

test("a Composio call with nobody attributed is refused before it reaches the vendor", async () => {
  const { store, database } = await freshStore();
  const reached: string[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store);

  // The empty string is what the actor resolves to when nobody could be identified. Reaching the
  // vendor with it would run in whatever account Composio has against "", or in nobody's, and either
  // way the run is unattributable — the state every identity defect in OpenTag started from.
  await expect(
    store.callTool({
      ref: "gmail/GMAIL_FETCH_EMAILS",
      args: {},
      botId: "bot_helper",
      actorId: "",
    }),
  ).rejects.toThrow(/not attributed to anybody/i);

  expect(reached).toEqual([]);
});

/**
 * The same refusal, with a legal row sitting at the anonymous actor.
 *
 * `composio_connections.user_id` is text notNull with NO foreign key — the property that lets a
 * connection outlive its person, so offboarding can still find it and revoke it at the broker. And
 * `notNull` does not exclude the empty string, so a row at `("gmail", "")` is legal: without the
 * guard ahead of the lookup, that row IS the match, the connection gate passes, and the run goes
 * out in whatever account Composio holds against "". The sibling `user-oauth` path cannot reach
 * this state — `mcp_user_credentials.user_id` carries a foreign key to `users.id` — so its test
 * asserts only the sentence, and borrowing that shape here would leave this property untested.
 *
 * A rejection, not a failed result, and that is the assertion doing the work: the transport repeats
 * the refusal as its own last line, but it answers with `isError` rather than throwing. So a
 * `rejects` here is what separates this gate from its twin downstream of the lookup.
 */
test("a Composio call with nobody attributed is refused even when a connection row exists for the empty actor", async () => {
  const { store, database } = await freshStore();
  const reached: string[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store);
  await database
    .insert(composioConnections)
    .values({ toolkit: "gmail", userId: "" });
  /*
   * A second anonymous row, at an app this file has nothing to do with.
   *
   * CRITERION. Whatever removes the row above must leave this one exactly where it is.
   *
   * REASON. The cleanup below used to be `user_id = ''`, which is every app at once. That reached
   * the anonymous row `composio-connections.test.ts` writes against its own run-suffixed app —
   * deleting another file's fixture out from under it when the two run together — and it is the
   * other half of the same confusion the guard at the top of this file suffered from. Suffixed, so
   * this row is provably this run's to insert and to take away again, and so no real deployment
   * row can be what the assertion below is reading.
   */
  const unrelatedApp = `sweep_witness_${suite}`;
  await database
    .insert(composioConnections)
    .values({ toolkit: unrelatedApp, userId: "" });

  try {
    await expect(
      store.callTool({
        ref: "gmail/GMAIL_FETCH_EMAILS",
        args: {},
        botId: "bot_helper",
        actorId: "",
      }),
    ).rejects.toThrow(/not attributed to anybody/i);

    expect(reached).toEqual([]);

    // Here rather than only in `freshDatabase`, so the row is gone the moment this test is done
    // with it and the assertion below has something to read. Keyed on the PAIR either way: the app
    // is what makes this row this file's, and the anonymous actor on its own names nobody's.
    await database
      .delete(composioConnections)
      .where(
        and(
          eq(composioConnections.toolkit, "gmail"),
          eq(composioConnections.userId, ""),
        ),
      );

    // What the cleanup took, and what it did not. Asked as two facts about this list rather than
    // as the whole of it, deliberately: a third app's anonymous row is somebody else's business,
    // and a test that failed because one existed would be the same over-reach in assertion form.
    const anonymous = (
      await database
        .select({ toolkit: composioConnections.toolkit })
        .from(composioConnections)
        .where(eq(composioConnections.userId, ""))
    ).map((row) => row.toolkit);
    expect(anonymous).not.toContain("gmail");
    expect(anonymous).toContain(unrelatedApp);
  } finally {
    // Both, so a failed assertion above still leaves the table as this test found it. Each is keyed
    // on an app this run named, which is what makes the deletes this run's to make.
    await database
      .delete(composioConnections)
      .where(eq(composioConnections.toolkit, unrelatedApp));
    await database
      .delete(composioConnections)
      .where(
        and(
          eq(composioConnections.toolkit, "gmail"),
          eq(composioConnections.userId, ""),
        ),
      );
  }
});

test("a Composio call by somebody who has not connected the app is refused with a sentence they can act on", async () => {
  const { store, database } = await freshStore();
  const reached: string[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store, { connect: false });

  await expect(
    store.callTool({
      ref: "gmail/GMAIL_FETCH_EMAILS",
      args: {},
      botId: "bot_helper",
      actorId: "user_asker",
    }),
  ).rejects.toThrow(/connect it in settings/i);

  // Refused here rather than at Composio, so a person is told what to do instead of being shown
  // somebody else's error, and so no call is spent finding out.
  expect(reached).toEqual([]);
});

/**
 * One person having connected the app is not the asking person having connected it.
 *
 * THE FAIL-OPEN THIS CLOSES. The gate reads `composio_connections` for `(toolkit, actorId)`, and
 * every test around it seeds a database where the app is connected by the asker or by nobody at
 * all — so dropping `eq(composioConnections.userId, actorId)` from that `where`, which turns the
 * question into "has ANYBODY connected Gmail", left the whole suite green. That single term is what
 * keeps one person's mailbox out of another's: with it gone, the first colleague to connect Gmail
 * makes the app callable by everybody, the broker is handed the stranger's id, and Composio answers
 * with whatever account it holds for them — or refuses in words that read as the connector being
 * broken.
 *
 * The stranger is never inserted anywhere. `composio_connections.user_id` is text with no foreign
 * key and the brokered path touches no vault row, so asking as somebody unknown writes nothing this
 * suite would have to clean up — which is the only reason a second person can appear here without
 * a fixture.
 */
test("a Composio call by somebody who has not connected the app is refused even though a colleague has", async () => {
  const { store, database } = await freshStore();
  const reached: string[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  // `user_asker` is connected to Gmail. Nobody else is.
  await seedComposioGmail(database, store);

  await expect(
    store.callTool({
      ref: "gmail/GMAIL_FETCH_EMAILS",
      args: {},
      botId: "bot_helper",
      actorId: "user_stranger",
    }),
  ).rejects.toThrow(/connect it in settings/i);

  // Never dialled, which is the half that matters: a call let through here is spent at the broker
  // in a stranger's name, and the person asking sees somebody else's mailbox or somebody else's
  // error.
  expect(reached).toEqual([]);
});

test("a Composio call whose url names no app is refused rather than falling back to the row id", async () => {
  const { store, database } = await freshStore();
  const reached: string[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  // Brokered by provenance, with a url that names no Composio app: `accessFor` answers
  // `{ credential: "brokered", toolkit: null }`, and falling back to the row id would check a
  // Gmail connection and then dial a hostname.
  await seedComposioGmail(database, store, { url: "https://example.com/mcp" });

  await expect(
    store.callTool({
      ref: "gmail/GMAIL_FETCH_EMAILS",
      args: {},
      botId: "bot_helper",
      actorId: "user_asker",
    }),
  ).rejects.toThrow(/no Composio app in its url/i);

  expect(reached).toEqual([]);
});

test("a Composio call whose row id and url name different apps is refused", async () => {
  const { store, database } = await freshStore();
  const reached: string[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  /*
   * The row is called `gmail` and the person has connected `gmail`; the url dials some OTHER app,
   * which is the one the call would actually run in.
   *
   * SUITE-SCOPED, and that is not cosmetic. Spelled `slack`, this test asserted a refusal on the
   * strength of `("slack", "user_asker")` not existing anywhere in the database — so it depended
   * on this file owning a production person id at every app in the world, and a real deployment
   * row at that pair would have turned the refusal into a completed call and read as this gate
   * being broken. An app nobody can have connected is what the property actually needs.
   */
  await seedComposioGmail(database, store, {
    url: `composio://unconnected_${suite}`,
  });

  await expect(
    store.callTool({
      ref: "gmail/GMAIL_FETCH_EMAILS",
      args: {},
      botId: "bot_helper",
      actorId: "user_asker",
    }),
  ).rejects.toThrow(/connect it in settings/i);

  // The gate keys on the app the url names, because that is the app the transport dials. Keyed on
  // the row id, this call completed: it ran a Slack action against a Gmail connection, sent the
  // version recorded for the Gmail action, and was audited as having reached the asker's own
  // account — a person granted one app and dialled into another with nothing noticing.
  expect(reached).toEqual([]);
});

/*
 * WHETHER A BROKERED CALL NEEDS A CONNECTION ROW AT ALL IS THE APP'S OWN QUESTION, AND THESE TWO
 * TESTS ARE ONE PAIR.
 *
 * The fixtures differ in exactly one field — the scheme recorded on the row when somebody enabled
 * the app — and otherwise dial the same app, at the same person, with no connection row anywhere.
 * So the opposite outcomes below cannot be caused by anything but the recorded scheme.
 *
 * SUITE-SCOPED APP, for the reason the test above is suite-scoped: `("unclaimed_<suite>",
 * "user_asker")` is a pair no deployment can be holding, so "nobody has connected this" is a
 * property of the run rather than a hope about the database. Spelled as a real app, a stray
 * connection row somebody else wrote would make the first test pass for the wrong reason and the
 * second one fail for it.
 */
test("a no-auth app runs without anybody having connected it", async () => {
  const { store, database } = await freshStore();
  const reached: string[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store, {
    url: `composio://unclaimed_${suite}`,
    authScheme: "NO_AUTH",
    connect: false,
  });

  const result = await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    args: {},
    botId: "bot_helper",
    actorId: "user_asker",
  });

  expect(result.isError).toBe(false);
  // Dialled, not merely un-refused. A no-auth app has no account to open, so the deployment's own
  // key is the entire credential the call goes out with, and reaching the vendor is what says the
  // gate returned rather than threw.
  expect(reached).toEqual(["GMAIL_FETCH_EMAILS"]);
});

test("an app whose accounts are somebody's still refuses without a row, and names the person's own step", async () => {
  const { store, database } = await freshStore();
  const reached: string[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug }) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store, {
    url: `composio://unclaimed_${suite}`,
    authScheme: "OAUTH2",
    connect: false,
  });

  await expect(
    store.callTool({
      ref: "gmail/GMAIL_FETCH_EMAILS",
      args: {},
      botId: "bot_helper",
      actorId: "user_asker",
    }),
  ).rejects.toThrow(/connect it in settings/i);

  // Never dialled. The refusal is local so the person is told their own next step instead of shown
  // the broker's error about an account it cannot find, and no call is spent finding that out.
  expect(reached).toEqual([]);
});

test("a Composio call sends the version recorded for that action", async () => {
  const { store, database } = await freshStore();
  const calls: { slug: string; version: string }[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug, version }) => {
      calls.push({ slug, version });
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store);

  await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    args: {},
    botId: "bot_helper",
    actorId: "user_asker",
  });

  expect(calls).toEqual([
    { slug: "GMAIL_FETCH_EMAILS", version: "20260903_00" },
  ]);
});

/*
 * The composite end-to-end outcome: a model that supplies the reserved key itself does not change
 * which revision runs. What holds it is the unconditional strip above the merge in `store.ts`.
 *
 * This is not a mutation gate, and no single mutation isolates it: reverting the strip, keeping the
 * strip but falling back to the raw arguments, and reversing the spread all leave it green, and its
 * assertion is already covered by `a Composio call sends the version recorded for that action`. It
 * is kept because the property is one somebody will want to confirm, not because it guards it.
 */
test("a version a model supplied in its own arguments cannot beat the recorded one", async () => {
  const { store, database } = await freshStore();
  const calls: { slug: string; version: string }[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug, version }) => {
      calls.push({ slug, version });
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store);

  await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    // A model filling in the reserved key itself. Stripped unconditionally, non-empty value and
    // all, before the recorded version is merged — so it never reaches the vendor under either
    // spread order.
    args: { __version: "19700101_00" },
    botId: "bot_helper",
    actorId: "user_asker",
  });

  // The listed revision, not the one the model asked for: supplying the reserved key changed
  // nothing about which revision ran.
  expect(calls).toEqual([
    { slug: "GMAIL_FETCH_EMAILS", version: "20260903_00" },
  ]);
});

test("a version a model supplied cannot stand in for an action with none recorded", async () => {
  const { store, database } = await freshStore();
  const calls: { slug: string; version: string }[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug, version }) => {
      calls.push({ slug, version });
      return vendorAnswered();
    },
  });
  // The action with no recorded version, which is the branch the test above does not cover: there
  // is nothing to merge in, and because the model's key was stripped there is no version in the
  // arguments at all — which is what the transport refuses on.
  await seedComposioGmail(database, store, { version: null });

  const result = await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    args: { __version: "19700101_00" },
    botId: "bot_helper",
    actorId: "user_asker",
  });

  // Never dialled. Honoured, the model's version runs a granted action at a revision that was never
  // listed, never classified and never granted, and the audit row carries no version field to say
  // which revision that was.
  //
  // Asserted before the refusal, so a regression fails here and names the version that reached the
  // vendor, rather than failing on a boolean that names nothing.
  expect(calls).toEqual([]);

  // The transport's refusal, which is the advertised answer for an action with no recorded version,
  // rather than a call against a revision a model named. The sentence offers a refresh CONDITIONALLY
  // — it recovers the action only where Composio publishes a version for it — because where the
  // vendor publishes none, no number of refreshes will make the action callable, and promising a
  // one-click fix that cannot work sends an operator round a loop.
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(
    /Refreshing this app's tools on its Plugins page recovers it only if/,
  );
  expect(result.text).toMatch(
    /Where Composio publishes none, no refresh will make it callable/,
  );
});

/*
 * WHOSE ACCOUNT THE CALL OPENS, OBSERVED AT THE VENDOR.
 *
 * This is the claim the whole brokered transport exists to make, and until these two tests it was
 * the one thing nothing looked at. The deployment holds ONE Composio key; which person's mailbox a
 * call opens is decided entirely by the id sent beside it. Every stub in this file took `_userId`
 * and threw it away, so a store that sent the Bot's id, or the empty string, or a constant, passed
 * all of them — the property held by construction and nothing would have noticed it stopping.
 *
 * `execute`'s SECOND positional argument is that id. Recorded here rather than counted, so a
 * regression fails naming the id that actually went out.
 */
test("a Composio call reaches the vendor as the person asking, not as the Bot", async () => {
  const { store, database } = await freshStore();
  const reached: { slug: string; userId: string }[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ slug, userId }) => {
      reached.push({ slug, userId });
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store);

  await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    args: {},
    botId: "bot_helper",
    actorId: "user_asker",
  });

  // `user_asker`, not `bot_helper` and not "". The id comes off the connection the call path built
  // from the session — `app.ts` takes it from a credential assertion and `routes.ts` from the
  // session — and it is the only thing standing between this Bot and somebody else's mailbox.
  expect(reached).toEqual([
    { slug: "GMAIL_FETCH_EMAILS", userId: "user_asker" },
  ]);
});

/**
 * An identity a model wrote into its own arguments does not become the identity of the call.
 *
 * THE THREE KEYS ARE THE ONES THAT WOULD WORK IF ANYTHING READ THEM. `userId` is the parameter
 * name on the transport's own projection, `user_id` is how Composio spells arguments, and
 * `entityId` is what their SDK called this before it was renamed — so a model that guessed at any
 * of the three would be guessing well.
 *
 * FORWARDED, NOT STRIPPED, AND THAT IS THE CORRECT BEHAVIOUR. The identity is `execute`'s second
 * POSITIONAL argument, taken from `connection.actorId`; `args` is the fourth and reaches the vendor
 * as the action's own parameters. Nothing on that path reads `args` looking for an identity, which
 * is what makes this structural rather than checked. Stripping the keys instead would be a bug with
 * a real victim: Composio's schemas are snake_case, `user_id` is an ordinary parameter name on real
 * actions, and a transport that swallowed it would quietly drop an argument the person meant. So
 * this asserts BOTH halves — the vendor is handed the asker as the identity, and it is handed the
 * model's arguments untouched.
 *
 * The absent `__version` is the other half of the same statement: the reserved key is the ONLY
 * thing removed from what a model sent.
 */
test("an identity a model puts in the arguments does not change whose account the call opens", async () => {
  const { store, database } = await freshStore();
  const reached: { userId: string; args: Record<string, unknown> }[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async ({ userId }, args) => {
      reached.push({ userId, args });
      return vendorAnswered();
    },
  });
  await seedComposioGmail(database, store);

  await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    // A model naming somebody else, three ways, beside one argument it genuinely meant.
    args: {
      userId: "user_stranger",
      user_id: "user_stranger",
      entityId: "user_stranger",
      query: "is:unread",
    },
    botId: "bot_helper",
    actorId: "user_asker",
  });

  expect(reached).toEqual([
    {
      // The session's person. None of the three keys reached the identity, because the identity is
      // not read from arguments at all.
      userId: "user_asker",
      // Passed through whole, minus nothing: the reserved version key is the only thing the call
      // path removes, and the model sent none.
      args: {
        userId: "user_stranger",
        user_id: "user_stranger",
        entityId: "user_stranger",
        query: "is:unread",
      },
    },
  ]);
});

test("a Composio call is recorded as reaching the vendor as the person, not as the deployment", async () => {
  const { store, database, auditStore } = await freshStore();
  useComposioClient({
    listActions: async () => [],
    execute: async () => vendorAnswered({ messages: [] }),
  });
  await seedComposioGmail(database, store);

  await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    args: {},
    botId: "bot_helper",
    actorId: "user_asker",
  });

  const call = auditStore
    .recorded()
    .find((event) => event.eventType === "mcp.call_succeeded");

  // The single question a per-person connector raises: whose account did this reach. Recorded as
  // "deployment", the trail is wrong about exactly the thing this connector exists for — two rows for
  // the same action and the same Bot can have touched two different mailboxes, and nothing else in
  // the row says which.
  expect(call?.payload).toMatchObject({ reachedAs: "user_asker" });
});

/**
 * Every call event this suite's store recorded against one tool, in order.
 *
 * Named because the assertions below are about WHICH event was written, and reading that off an
 * unfiltered list would also pick up the grant the fixture makes. `mcp.call_` is the prefix the
 * three outcomes share.
 */
function callEventsFor(
  auditStore: { recorded: () => { eventType: string; targetId?: string }[] },
  targetId: string,
) {
  return auditStore
    .recorded()
    .filter(
      (event) =>
        event.targetId === targetId && event.eventType.startsWith("mcp.call_"),
    );
}

/**
 * A vendor that reported its own failure is filed as a failure, not as a success.
 *
 * `mcp.call_failed` is derived from `result.isError` and nothing asserted the derivation: flipping
 * the two event names left the suite green, so the trail could have said `mcp.call_succeeded` about
 * every refused call and the only surface that counts successes would have agreed. That is the same
 * class of defect as the one the comment above the try block describes — a trail asserting the
 * opposite of what happened — and it was still open on this branch.
 *
 * The sentence matters as much as the name. `payload.failure` is the vendor's own words, and it is
 * the most useful thing an operator gets: it is what turned "the connector is broken" into "the
 * connection lapsed" on the Drive path.
 */
test("a call the vendor refused is filed as failed, with the vendor's own sentence", async () => {
  const { store, database, auditStore } = await freshStore();
  useComposioClient({
    listActions: async () => [],
    execute: async () =>
      vendorRefused("Gmail rejected the request: bad label."),
  });
  await seedComposioGmail(database, store);

  const result = await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    args: {},
    botId: "bot_helper",
    actorId: "user_asker",
  });

  expect(result.isError).toBe(true);

  // Exactly one call row, and it is the failure. Asserted as the whole list rather than by finding
  // a failure in it, because a `find` passes just as happily when a `mcp.call_succeeded` row sits
  // beside it — and a success row for a refused call is the thing being ruled out.
  expect(callEventsFor(auditStore, "gmail/GMAIL_FETCH_EMAILS")).toMatchObject([
    {
      eventType: "mcp.call_failed",
      payload: {
        actor: "user_asker",
        bot: "bot_helper",
        failure: "Gmail rejected the request: bad label.",
      },
    },
  ]);
});

/**
 * Our own unreadable answer is filed under the SAME name as the vendor's refusal.
 *
 * GATED AS IT BEHAVES TODAY, AND THE CONFLATION IS THE FINDING. `callTool` in `composio.ts` is
 * careful to keep these two apart — the vendor's `try` holds the vendor's call and nothing else,
 * precisely so a `JSON.stringify` throw of ours is not reported as the action having failed — and
 * then `store.ts` collapses the distinction again on the way to the trail, because the event name
 * is derived from `isError` alone and both are `isError: true`. So the only thing telling an
 * operator "Composio refused" from "Composio answered and we could not read it" is the sentence in
 * `payload.failure`, which is prose and not a queryable field. A reader counting `mcp.call_failed`
 * to decide whether a connector is healthy cannot separate a vendor fault from a bug of ours.
 *
 * A circular `data` is the honest way to reach it: `resultOf` stringifies whatever the vendor sent,
 * and a structure that cannot be serialized is one of the three faults its comment names.
 */
test("an answer this deployment could not read is filed under the same name as a vendor refusal", async () => {
  const { store, database, auditStore } = await freshStore();
  const circular: Record<string, unknown> = {};
  circular.itself = circular;
  useComposioClient({
    listActions: async () => [],
    execute: async () => vendorAnswered(circular),
  });
  await seedComposioGmail(database, store);

  const result = await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    args: {},
    botId: "bot_helper",
    actorId: "user_asker",
  });

  expect(result.isError).toBe(true);

  const [event] = callEventsFor(auditStore, "gmail/GMAIL_FETCH_EMAILS");
  // The same event name the vendor's own refusal gets, one test above.
  expect(event?.eventType).toBe("mcp.call_failed");
  // And the sentence is the only thing that says this one was ours.
  expect((event?.payload as { failure?: string } | undefined)?.failure).toMatch(
    /could not turn that answer into text/,
  );
});

test("an action's effect, destructive marker and version round-trip", async () => {
  const database = await freshDatabase();

  await database.insert(mcpServers).values({
    id: "gmail",
    title: "Gmail",
    vendor: "Composio",
    url: "composio://gmail",
    provenance: "composio",
  });

  await database.insert(mcpTools).values([
    {
      serverId: "gmail",
      name: "GMAIL_FETCH_EMAILS",
      description: "Fetch emails.",
      effect: "read",
      destructive: false,
      version: "20260903_00",
    },
    {
      serverId: "gmail",
      name: "GMAIL_DELETE_MESSAGE",
      description: "Delete a message.",
      effect: "write",
      destructive: true,
      version: "20260903_00",
    },
  ]);

  const rows = await database
    .select({
      name: mcpTools.name,
      effect: mcpTools.effect,
      destructive: mcpTools.destructive,
      version: mcpTools.version,
    })
    .from(mcpTools)
    .where(eq(mcpTools.serverId, "gmail"))
    .orderBy(asc(mcpTools.name));

  expect(rows).toEqual([
    {
      name: "GMAIL_DELETE_MESSAGE",
      effect: "write",
      destructive: true,
      version: "20260903_00",
    },
    {
      name: "GMAIL_FETCH_EMAILS",
      effect: "read",
      destructive: false,
      version: "20260903_00",
    },
  ]);
});

test("an action listed before these columns existed reads as unclassified and unversioned", async () => {
  const database = await freshDatabase();

  await database.insert(mcpServers).values({
    id: "notion",
    title: "Notion",
    vendor: "Notion",
    url: "https://mcp.notion.com/mcp",
    provenance: "first-party",
  });
  await database.insert(mcpTools).values({
    serverId: "notion",
    name: "notion-fetch",
    description: "Fetch a page.",
  });

  const [row] = await database
    .select({
      effect: mcpTools.effect,
      destructive: mcpTools.destructive,
      version: mcpTools.version,
    })
    .from(mcpTools)
    .where(eq(mcpTools.serverId, "notion"));

  // Null rather than a default: an existing row must keep meaning exactly what it meant, and the
  // classifier decides what an absent effect implies. A column default of "write" would silently
  // reclassify every already-listed Notion read as a write the moment the migration ran.
  expect(row).toEqual({ effect: null, destructive: false, version: null });
});

test("a brokered call is judged by the effect the vendor recorded, not by the absent catalogue entry", async () => {
  const { store, database, auditStore } = await freshStore();
  useComposioClient({
    listActions: async () => [],
    execute: async () => vendorAnswered(),
  });
  // `effect: "read"` on the seeded action, and no catalogue entry for `gmail` at all — so the two
  // sources disagree and the row records which one decided.
  expect(catalogueEntry("gmail")).toBeNull();
  await seedComposioGmail(database, store);

  const result = await store.callTool({
    ref: "gmail/GMAIL_FETCH_EMAILS",
    args: {},
    botId: "bot_helper",
    actorId: "user_asker",
  });

  // The call completes: the transport is handed the version this action was listed at. Irrelevant to
  // what is under test — `effect` is decided before the vendor is dialled and the row carries the
  // decision on either outcome, which is the whole point of holding `decided` rather than writing it.
  expect(result.isError).toBe(false);

  const call = auditStore
    .recorded()
    .find((event) => event.eventType === "mcp.call_succeeded");
  // "read", because Composio labelled the action and the classifier prefers that label. "write" is
  // what an unlisted-in-`writeTools` tool on a server with no entry behind it comes out as, and that
  // is what this row said while the recorded effect was being selected and never passed on: every
  // Gmail read gated as a write, and `intent` in the policy context reading `write_tool`.
  expect((call?.payload as { effect?: string } | undefined)?.effect).toBe(
    "read",
  );
});

test("the Plugins page shows a brokered action with the effect the vendor recorded", async () => {
  const { store, database } = await freshStore();
  await seedComposioGmail(database, store);

  const gmail = (await store.listServers()).find(
    (server) => server.id === "gmail",
  );

  // Same disagreement as the call path, on the surface an administrator reads: no catalogue entry
  // behind `gmail`, so the reviewed-list branch has nothing to say and would call every one of the
  // app's actions a write. Shown as a write, this page tells an administrator that granting a Bot
  // "fetch emails" grants it something that changes their mailbox.
  expect(
    gmail?.tools.map((tool) => ({ name: tool.name, effect: tool.effect })),
  ).toEqual([{ name: "GMAIL_FETCH_EMAILS", effect: "read" }]);
});

/**
 * The narrow read the brokered routes make, and the one thing it must not do.
 *
 * CRITERION. `serverAddress` answers the url the ROW holds, whatever the row is called.
 *
 * REASON. Everything brokered rests on the id and the url being allowed to differ: `addBrokeredApp`
 * writes `composio://<slug>` and names the row for it, and nothing afterwards holds the two equal.
 * The routes read the app out of the url for exactly that reason, so a read that answered them with
 * `composio://${id}` — composed, and always agreeing with the id — would put the mismatch back
 * underneath four call sites at once and read as correct on every row anybody had not renamed. The
 * fixture is seeded with the disagreement on purpose, which is what `seedComposioGmail`'s own `url`
 * option exists for.
 *
 * The url listing is asserted off this fixture rather than out of a case of its own: it answers the
 * directory's set question from the same column, and the property worth pinning is the same one.
 */
test("a server's address is the url the row holds, not one composed from its id", async () => {
  const { store, database } = await freshStore();
  // A row called `gmail` pointing at Slack, which is the shape the connection gate was once keyed
  // on the wrong half of.
  await seedComposioGmail(database, store, { url: "composio://slack" });

  expect(await store.serverAddress("gmail")).toEqual({
    id: "gmail",
    title: "Gmail",
    // Not `composio://gmail`. That is what composing the url from the id would have answered, and
    // it is the app this row does not run against.
    url: "composio://slack",
    // Null, because a scheme is written down when an authorization config is CREATED and this
    // fixture creates none. The column holds nothing for a row nothing was created against rather
    // than a default standing in for one, so null here is the read passing the column through.
    authScheme: null,
  });
  /*
   * By membership rather than by equality, because this database is not only this test's: the
   * suite's own `google-drive` row is there, and on a deployment somebody is using so is whatever
   * they have added. What is being asserted is which of the two spellings of this row reaches the
   * directory, and that survives the company.
   */
  const urls = await store.serverUrls();
  expect(urls).toContain("composio://slack");
  expect(urls).not.toContain("composio://gmail");
});

test("a server id naming no row is answered with nothing", async () => {
  const { store, database } = await freshStore();
  await seedComposioGmail(database, store);

  // `undefined` rather than a throw or an empty row, because that is what the `.find` over the
  // whole server list answered before — and the routes turn it into the 400 that says this app is
  // not reached through a broker.
  expect(await store.serverAddress("composio-gmail")).toBeUndefined();
});

test("refreshing a Composio app records each action's effect, destructive marker and version", async () => {
  const { store, database } = await freshStore();
  useComposioClient({
    listActions: async () => [
      {
        slug: "GMAIL_FETCH_EMAILS",
        description: "Fetch emails.",
        inputParameters: { type: "object", properties: {} },
        tags: ["readOnlyHint"],
        version: "20260903_00",
      },
      {
        slug: "GMAIL_DELETE_MESSAGE",
        description: "Delete a message.",
        inputParameters: { type: "object", properties: {} },
        tags: ["destructiveHint"],
        version: "20260903_00",
      },
      {
        slug: "GMAIL_SEND_EMAIL",
        description: "Send an email.",
        inputParameters: { type: "object", properties: {} },
        tags: ["createHint"],
        version: "20260903_00",
      },
    ],
    execute: async () => vendorAnswered(),
  });

  await database.insert(mcpServers).values({
    id: "gmail",
    title: "Gmail",
    vendor: "Composio",
    url: "composio://gmail",
    provenance: "composio",
  });

  await store.refreshTools("gmail", "admin_user");

  const rows = await database
    .select({
      name: mcpTools.name,
      effect: mcpTools.effect,
      destructive: mcpTools.destructive,
      version: mcpTools.version,
    })
    .from(mcpTools)
    .where(eq(mcpTools.serverId, "gmail"))
    .orderBy(asc(mcpTools.name));

  // The vendor's own three answers, as the listing gave them: a label, a marker, and the version a
  // call is impossible without. `createHint` is a write with no marker — an ordinary write is not
  // dangerous, and marking it so teaches an approver to click through the colour.
  expect(rows).toEqual([
    {
      name: "GMAIL_DELETE_MESSAGE",
      effect: "write",
      destructive: true,
      version: "20260903_00",
    },
    {
      name: "GMAIL_FETCH_EMAILS",
      effect: "read",
      destructive: false,
      version: "20260903_00",
    },
    {
      name: "GMAIL_SEND_EMAIL",
      effect: "write",
      destructive: false,
      version: "20260903_00",
    },
  ]);
});

/**
 * A grant on a Composio action the vendor has stopped listing, still reported as held.
 *
 * Confirmed for a brokered row rather than built: `listServers` derives `withdrawn` from the grants
 * no advertised action covers, with no transport-specific branch, so the Drive suite above gates
 * the mechanism. What a Composio row adds is that it inherits it — the app's page lists what the
 * last refresh advertised, so with nothing reporting the gap a permission on an action Composio
 * dropped is invisible and the Bot loses a capability nobody revoked.
 *
 * The refreshed listing names a DIFFERENT action rather than none at all, because an empty list is
 * also what a refresh the vendor refused leaves behind: every grant would come out withdrawn and
 * this would hold for a reason that has nothing to do with the action being gone.
 */
test("a granted Composio action that the vendor withdrew is still shown as granted", async () => {
  const { store, database } = await freshStore();
  useComposioClient({
    listActions: async () => [
      {
        slug: "GMAIL_SEND_EMAIL",
        description: "Send an email.",
        inputParameters: { type: "object", properties: {} },
        tags: ["createHint"],
        version: "20260903_00",
      },
    ],
    execute: async () => vendorAnswered(),
  });
  await seedComposioGmail(database, store);

  // The granted action is absent from what the vendor now lists, and another action is not.
  await store.refreshTools("gmail", "admin_user");

  const gmail = (await store.listServers()).find(
    (server) => server.id === "gmail",
  );

  expect(gmail?.withdrawn).toEqual([
    {
      ref: "gmail/GMAIL_FETCH_EMAILS",
      name: "GMAIL_FETCH_EMAILS",
      grantedTo: ["bot_helper"],
    },
  ]);
  // The advertised action came through as a tool, which is what says the refresh actually listed
  // rather than failing into the empty list that would withdraw everything.
  expect(gmail?.tools.map((tool) => tool.ref)).toEqual([
    "gmail/GMAIL_SEND_EMAIL",
  ]);
});

/*
 * A refresh the transport REFUSED, on the path every real deployment takes.
 *
 * NOTHING IN THE SHIPPED PRODUCT CALLS `useComposioClient`, so `installed` is null on every live
 * install and `composio.listTools` throws for want of a client to ask with. The tests below install
 * no stub, which is that state exactly rather than a fiction about it.
 *
 * THE PREMISE THIS DESCRIBE USED TO STATE — that the transport answers `[]` rather than throwing —
 * WAS TRUE AND IS NOT. It was corrected at the seam, deliberately: a transport that could not ask
 * anybody must throw, because an empty answer is indistinguishable from an app that genuinely
 * publishes nothing. These three cases therefore land in `refreshTools`'s vendor `catch`, which
 * records the sentence and returns before the replace — and they say nothing whatever about the
 * empty-listing guard below it, which is what the describe after this one is for. Two suites
 * asserting the same three outcomes through different branches is how that guard came to be
 * deletable with every test still green.
 *
 * What is under test here is the catch branch's own promise: a listing that could not be made
 * leaves every recorded action where it is, stamps no refresh, and withdraws nothing.
 */
describe("a refresh whose transport refused to ask anybody", () => {
  test("leaves the actions the app already advertises, with what the vendor said about them", async () => {
    const { store, database } = await freshStore();
    await seedComposioGmail(database, store);

    await store.refreshTools("gmail", "admin_user");

    const rows = await database
      .select({
        name: mcpTools.name,
        effect: mcpTools.effect,
        version: mcpTools.version,
      })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, "gmail"));

    // The version above all: it is what `callTool` sends, so losing it breaks every later call on
    // an app the refresh reported as fine.
    expect(rows).toEqual([
      { name: "GMAIL_FETCH_EMAILS", effect: "read", version: "20260903_00" },
    ]);
  });

  test("does not report the app as healthy", async () => {
    const { store, database } = await freshStore();
    await seedComposioGmail(database, store);
    await database
      .update(mcpServers)
      .set({ lastError: "The vendor would not answer." })
      .where(eq(mcpServers.id, "gmail"));

    await store.refreshTools("gmail", "admin_user");

    const [row] = await database
      .select({
        lastError: mcpServers.lastError,
        toolsRefreshedAt: mcpServers.toolsRefreshedAt,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, "gmail"));

    /*
     * The transport's own sentence, named rather than merely counted as present.
     *
     * `not.toBeNull()` was what this asserted, and the refresh had in fact OVERWRITTEN the value
     * the test set up two lines earlier — so "not cleared" passed on a different string than the
     * one it was about, and would have gone on passing had the column been filled with anything at
     * all, the empty-listing guard's sentence included. Which sentence is here is the whole
     * difference between "nobody could be asked" and "the app was asked and offers nothing", and
     * those send an operator to different places.
     */
    expect(row?.lastError).toContain("Composio is not configured");
    expect(row?.lastError).not.toBe("The vendor would not answer.");
    // And no refresh stamp, because nothing was listed: the column says when this deployment last
    // learned what the app offers, and it did not learn it here.
    expect(row?.toolsRefreshedAt).toBeNull();
  });

  test("does not strand the grants the app is holding", async () => {
    const { store, database, auditStore } = await freshStore();
    await seedComposioGmail(database, store);

    await store.refreshTools("gmail", "admin_user");

    const gmail = (await store.listServers()).find(
      (server) => server.id === "gmail",
    );

    // Still offered and still not withdrawn.
    expect(gmail?.tools.map((tool) => tool.ref)).toEqual([
      "gmail/GMAIL_FETCH_EMAILS",
    ]);
    expect(gmail?.withdrawn).toEqual([]);
    // Nor filed as having stopped being offered, which would be the trail asserting a withdrawal
    // the vendor never made.
    expect(
      auditStore
        .recorded()
        .filter(
          (event) =>
            (event.payload as { change?: string }).change ===
            "grants_not_advertised",
        ),
    ).toEqual([]);
  });

  test("a brokered row whose url names no app raises rather than blaming the vendor", async () => {
    const { store, database } = await freshStore();
    // `accessFor` still answers `brokered` for any row whose provenance says composio, so this is
    // `{ credential: "brokered", toolkit: null }` — a row a hand edit or an old backup produces and
    // nothing in the product can. There is no app to ask, so an empty answer is not the vendor's.
    await seedComposioGmail(database, store, {
      url: "https://example.com/mcp",
    });

    await expect(store.refreshTools("gmail", "admin_user")).rejects.toThrow(
      PluginInvariantError,
    );

    const [row] = await database
      .select({ lastError: mcpServers.lastError })
      .from(mcpServers)
      .where(eq(mcpServers.id, "gmail"));

    // The state is this deployment's own, so it must not be written down as something a vendor did.
    expect(row?.lastError).toBeNull();
  });
});

/**
 * THE VENDOR ITSELF ANSWERING NOTHING, which is the state the empty-listing guard exists for.
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DOES. The guard sits after the vendor `catch` and before the
 * wholesale replace, and only a listing that was actually MADE and came back empty reaches it. The
 * describe above cannot: its transport throws, so it returns from the catch several lines earlier.
 * With those three cases routed around it, `if (listed.length === 0)` could be replaced by
 * `if (false)` — deleting the guard outright — and the whole suite stayed green. Everything below
 * reddens under that mutation, which is the only thing that makes the guard's presence a fact
 * about this codebase rather than a comment in it.
 *
 * WHY IT MATTERS. The replace is a delete and an insert, so committing an empty answer deletes
 * every `mcp_tools` row for the app and takes `effect`, `destructive` and `version` with it.
 * `version` cannot be reconstructed — `callTool` refuses an action without one — so a refresh that
 * reported success broke every later call, with the grants left pointing at rows that no longer
 * exist. A stub that answers `[]` is a vendor's honest answer and is exactly what an app that has
 * been emptied at the broker looks like; keeping what is held is the only reading that is
 * recoverable if it is wrong.
 */
describe("a refresh the vendor answered with no actions at all", () => {
  /** A client that answers, and answers nothing — which no throw can stand in for. */
  function useEmptyAnsweringClient() {
    useComposioClient({
      listActions: async () => [],
      execute: async () => vendorAnswered(),
    });
  }

  test("keeps every action already recorded, with what the vendor said about them", async () => {
    const { store, database } = await freshStore();
    useEmptyAnsweringClient();
    await seedComposioGmail(database, store);

    // The honest count is what is HELD, because nothing was replaced. Answering 0 here would tell
    // the page the app offers nothing while the rows are still there.
    expect(await store.refreshTools("gmail", "admin_user")).toEqual({
      tools: 1,
    });

    const rows = await database
      .select({
        name: mcpTools.name,
        effect: mcpTools.effect,
        version: mcpTools.version,
      })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, "gmail"));

    // The version above all: it is what `callTool` sends, so losing it breaks every later call on
    // an app the refresh reported as fine.
    expect(rows).toEqual([
      { name: "GMAIL_FETCH_EMAILS", effect: "read", version: "20260903_00" },
    ]);
  });

  test("says the actions were kept, and does not stamp a refresh", async () => {
    const { store, database } = await freshStore();
    useEmptyAnsweringClient();
    await seedComposioGmail(database, store);

    await store.refreshTools("gmail", "admin_user");

    const [row] = await database
      .select({
        lastError: mcpServers.lastError,
        toolsRefreshedAt: mcpServers.toolsRefreshedAt,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, "gmail"));

    /*
     * The sentence for THIS state and not the other one. The app answered, so nothing here may
     * send an operator to check their configuration — that is the refused transport's sentence,
     * and the describe above asserts that one. What this reader needs to know is that the app
     * listed nothing and that the actions it holds were not deleted over it.
     */
    expect(row?.lastError).not.toBeNull();
    expect(row?.lastError).toContain("kept rather than deleted");
    // No stamp: the column says when this deployment last learned what the app offers, and an
    // answer it declined to believe is not it.
    expect(row?.toolsRefreshedAt).toBeNull();
  });

  test("withdraws nothing and strands no grant", async () => {
    const { store, database, auditStore } = await freshStore();
    useEmptyAnsweringClient();
    await seedComposioGmail(database, store);

    await store.refreshTools("gmail", "admin_user");

    const gmail = (await store.listServers()).find(
      (server) => server.id === "gmail",
    );

    // Still offered and still not withdrawn.
    expect(gmail?.tools.map((tool) => tool.ref)).toEqual([
      "gmail/GMAIL_FETCH_EMAILS",
    ]);
    expect(gmail?.withdrawn).toEqual([]);
    // Nor filed as having stopped being offered. That row is written from the listing, so an empty
    // one committed would name every grant the app holds — the trail asserting a withdrawal on
    // exactly the answer this deployment decided not to believe.
    expect(
      auditStore
        .recorded()
        .filter(
          (event) =>
            (event.payload as { change?: string }).change ===
            "grants_not_advertised",
        ),
    ).toEqual([]);
  });
});

/**
 * WHO IS TOLD WHAT, when the row itself is the thing that cannot be resolved.
 *
 * `ServerRowAmbiguousError` refuses a row whose provenance says `composio` and whose id is a
 * curated catalogue slug: nothing in the row and the entry tells a tampered curated row apart from
 * a brokered app that took the name, so there is no answer that is not wrong in one of the two
 * worlds. It shipped caught NOWHERE. Every audience therefore got the wrong thing at once — the
 * admin page a bodiless 500 it renders as "That did not work", and a model the operator's own
 * sentence about correcting a provenance column, offered to an end user as the reason their tool
 * failed.
 *
 * The store's half is asserted here: it refuses, and it records nothing about a vendor while doing
 * so. What each audience then sees is asserted where that audience is — the model below, and the
 * administrator in `plugin-routes.test.ts`, which is the file that exists for that mapping.
 */
describe("a row that resolves to two servers at once", () => {
  /** A colliding row, spelled the way the collision actually occurs: a curated slug, brokered. */
  async function seedCollidingNotion(database: Database) {
    await database.insert(mcpServers).values({
      id: "notion",
      title: "Notion",
      vendor: "Composio",
      url: "composio://notion",
      provenance: "composio",
    });
  }

  test("a refresh refuses it, and writes nothing about a vendor", async () => {
    const { store, database } = await freshStore();
    await seedCollidingNotion(database);

    await expect(store.refreshTools("notion", "admin_user")).rejects.toThrow(
      ServerRowAmbiguousError,
    );

    const [row] = await database
      .select({
        lastError: mcpServers.lastError,
        toolsRefreshedAt: mcpServers.toolsRefreshedAt,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, "notion"));

    // Two of our columns disagreeing is not a vendor's answer, so it must not be written where the
    // page draws what the vendor said. Raised instead, which is what the route reads.
    expect(row?.lastError).toBeNull();
    expect(row?.toolsRefreshedAt).toBeNull();
  });

  test("the model is told the call did not happen, and nothing about our columns", async () => {
    const { store, database } = await freshStore();
    await seedCollidingNotion(database);
    await database.insert(mcpTools).values({
      serverId: "notion",
      name: "notion-fetch",
      description: "Fetch a page.",
    });
    await database.insert(agents).values({
      id: "bot_helper",
      name: "Helper",
      type: "built_in",
      configuration: {},
    });
    await store.grant(
      "mcp",
      "notion/notion-fetch",
      "bot_helper",
      "admin@example.com",
    );

    const [tool] = await grantedTools({
      store,
      botId: "bot_helper",
      actorId: "user_asker",
    });
    if (!tool) throw new Error("the Bot was offered no tool to call");

    const answer = await tool.execute({});

    /*
     * Every part of the operator's sentence, named rather than summarised.
     *
     * The message says the row is one the deployment ships an entry for, that its provenance says
     * composio, and that somebody should rename it or correct the column. Each of those is a fact
     * about our database and an instruction only an administrator can act on; a model handed any
     * of them can only relay or embroider it. Asserted piecewise so a reworded sentence that still
     * leaks cannot pass by not matching one long string.
     */
    expect(answer).not.toContain("provenance");
    expect(answer).not.toContain("rename");
    expect(answer).not.toContain("notion");
    // And not dressed as a refusal either: nothing was decided against, so the marker the
    // transcript draws as a boundary holding would be a lie about which of the two happened.
    expect(answer.startsWith(REFUSAL_MARKER)).toBe(false);
    expect(answer).toBe("That tool could not be called.");
  });

  /**
   * AND THE CURATED ADD WILL NOT WRITE THROUGH IT, which is the other end of the same collision.
   *
   * CRITERION. `addServer` refuses a catalogue key whose row is brokered, and leaves the row exactly
   * as it stood.
   *
   * REASON. The refusals above are at RESOLUTION — they stop a colliding row being dialled. This one
   * is at the WRITE, and it protects something resolution cannot. `addServer` puts the catalogue's
   * url over whatever is there, and for this row that url is the only record of which app the
   * `composio_connections` rows behind it belong to: `removeServer` reads the app out of
   * `accessFor`, deliberately with no entry, so that a row in exactly this state is still removable
   * and its accounts still end at Composio. Overwritten, the app is unnameable, the accounts are
   * unreachable by any operation in this deployment, and the row is a curated server nobody
   * reviewed the arrival of.
   *
   * Unreachable from the shipped product today — `addBrokeredApp` mints `composio-<slug>` and no
   * entry is spelled that way — which is what the whole of this `describe` is already about: the
   * colliding row arrives by hand edit, by restore, or by a build whose catalogue took a name a past
   * build brokered. The two above say what happens when one is READ. This says what happens when
   * somebody presses Add on it.
   */
  test("the curated add refuses it rather than writing the catalogue's url over it", async () => {
    const { store, database } = await freshStore();
    await seedCollidingNotion(database);

    await expect(
      store.addServer({ key: "notion", by: "admin_user" }),
    ).rejects.toThrow(CustomServerRefusedError);

    // Untouched, which is what keeps the app removable: the slug is still readable off the url, so
    // `removeServer` can still find the accounts to end at the vendor.
    const [row] = await database
      .select({ url: mcpServers.url, provenance: mcpServers.provenance })
      .from(mcpServers)
      .where(eq(mcpServers.id, "notion"));
    expect(row).toEqual({
      url: "composio://notion",
      provenance: "composio",
    });
  });

  test("it is on the same shelf the store already raises rather than records", async () => {
    /*
     * The distinction, asked the way every audience asks it.
     *
     * Both audiences above branch on `isDeploymentFault` rather than on a class list of their own,
     * so what makes them correct is this answer and not the two `catch` blocks. A class added to
     * the shelf and forgotten here is the defect being fixed, one round later.
     */
    expect(isDeploymentFault(new ServerRowAmbiguousError("x"))).toBe(true);
    expect(isDeploymentFault(new CatalogueTransportUnroutableError("x"))).toBe(
      true,
    );
    expect(isDeploymentFault(new PluginInvariantError("x"))).toBe(true);
    // And the refusal somebody CAN act on is not on it: its message is the one thing this codebase
    // relays verbatim, to a model and to a browser alike.
    expect(isDeploymentFault(new PluginRefusedError("x", null))).toBe(false);
    expect(isDeploymentFault(new Error("the vendor did not answer"))).toBe(
      false,
    );
  });
});

/**
 * A catalogue entry naming the broker's transport, which no entry can be reached over.
 *
 * NOT A LIVE BUG AND NOT MEANT TO BECOME ONE. No entry declares it, and `CuratedTransportKind` now
 * makes declaring it a compile error — which is the real fix, since entries are code. This is what
 * holds when the type is bypassed: a cast, a fixture like the one below, or a loader that ever
 * reads an entry from outside the build.
 *
 * WHAT THE UNREFUSED ANSWER WAS. `transport: "composio"` with `toolkit: null`, a credential taken
 * from the entry's auth kind rather than `brokered`, and `reachedAs` from the same table. So the
 * dial went to the broker while both gates that keep one person's brokered account out of
 * another's — the connection lookup in `connectionTokenFor` and the app-slug check in
 * `refreshTools` — were keyed on a null app and skipped, and the trail recorded whose account had
 * been reached from a field that had nothing to do with it. Refusing is the only answer that does
 * not assert something false.
 */
test("a catalogue entry declaring the broker's transport is refused, not dialled", () => {
  /*
   * Cast at the fixture, deliberately and in one place. The type is what keeps this out of the
   * catalogue, so a test about what happens when the type is bypassed has to bypass it — and doing
   * it here rather than in a helper keeps the bypass visible beside the thing it is testing.
   */
  const brokered = {
    key: "brokered-entry",
    title: "Brokered Entry",
    vendor: "Somebody",
    summary: "An entry that names a transport an entry cannot be reached over.",
    host: "https://mcp.example.com",
    path: "/mcp",
    auth: {
      kind: "user-oauth" as const,
      authorizationUrl: "https://example.com/auth",
      tokenUrl: "https://example.com/token",
      revokeUrl: "https://example.com/revoke",
      scopes: [],
    },
    writeTools: [],
    transport: "composio",
    docsUrl: "https://example.com/docs",
  } as unknown as CatalogueEntry;

  expect(() =>
    accessFor(
      { provenance: "first-party", url: "https://mcp.example.com/mcp" },
      brokered,
    ),
  ).toThrow(CatalogueTransportUnroutableError);

  // The same entry with the transport it is actually reached over resolves as any other curated
  // per-person vendor does, so what is refused is the value and not the fixture.
  expect(
    accessFor(
      { provenance: "first-party", url: "https://mcp.example.com/mcp" },
      { ...brokered, transport: undefined },
    ),
  ).toEqual({
    transport: "mcp",
    credential: "person-oauth",
    reachedAs: "person",
    toolkit: null,
  });
});

/**
 * WHAT A VENDOR SENT THAT THIS DATABASE WILL NOT TAKE, and what came out when it did not.
 *
 * Both of these aborted the wholesale replace from INSIDE its transaction, which sits OUTSIDE the
 * vendor `try` above it — so neither was recorded and neither was caught. What left `refreshTools`
 * was drizzle's `DrizzleQueryError`, whose message is `Failed query:` followed by the entire
 * statement and then `params:` and every value bound to it. A SQL dump on an error path is the
 * same disclosure shape as a credential leak one layer out, and it reached the logs and any caller
 * that prints an error, while `lastError` sat holding whatever it held before: stale, or null, on
 * a refresh that had failed outright.
 *
 * Both are now settled before a statement is built, which is why the assertions below are about
 * the rows rather than about a better error.
 */
describe("a listing this database would not have taken", () => {
  test("a vendor naming one action twice records it once", async () => {
    const { store, database } = await freshStore();
    /*
     * The same slug twice, with different text, which is what a paginated listing that overlaps
     * or a broker with two entries for one action produces. `(server_id, name)` is the primary
     * key, so as one multi-row insert this refused the whole statement and rolled the delete back
     * with it — leaving the app holding its old actions and the refresh throwing a dump.
     */
    useComposioClient({
      listActions: async () => [
        {
          slug: "GMAIL_SEND_EMAIL",
          description: "Send an email.",
          inputParameters: { type: "object", properties: {} },
          version: "20260903_00",
        },
        {
          slug: "GMAIL_SEND_EMAIL",
          description: "Send an email, listed again.",
          inputParameters: { type: "object", properties: {} },
          version: "20260903_00",
        },
      ],
      execute: async () => vendorAnswered(),
    });
    await seedComposioGmail(database, store);

    // One action, because the vendor named one action. Not two rows, and not a refusal.
    expect(await store.refreshTools("gmail", "admin_user")).toEqual({
      tools: 1,
    });

    const rows = await database
      .select({
        name: mcpTools.name,
        description: mcpTools.description,
      })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, "gmail"));

    // The first occurrence, because the order is the vendor's own and there is no rule that says
    // which of two identical names is the real one.
    expect(rows).toEqual([
      { name: "GMAIL_SEND_EMAIL", description: "Send an email." },
    ]);

    const [row] = await database
      .select({ lastError: mcpServers.lastError })
      .from(mcpServers)
      .where(eq(mcpServers.id, "gmail"));
    // A healthy refresh, because that is what it was.
    expect(row?.lastError).toBeNull();
  });

  test("a U+0000 in what the vendor wrote is dropped rather than aborting the replace", async () => {
    const { store, database } = await freshStore();
    /*
     * In the name, in the description and inside the schema, because all three reach the insert
     * and the column types differ: `text` refuses the byte and `jsonb` refuses the escape, and
     * each aborts the same transaction from a different statement position.
     */
    useComposioClient({
      listActions: async () => [
        {
          slug: "GMAIL_SEND\u0000_EMAIL",
          description: "Send\u0000 an email.",
          inputParameters: {
            type: "object",
            properties: { subject: { description: "The\u0000 subject" } },
          },
          version: "2026\u00000903_00",
        },
      ],
      execute: async () => vendorAnswered(),
    });
    await seedComposioGmail(database, store);

    expect(await store.refreshTools("gmail", "admin_user")).toEqual({
      tools: 1,
    });

    const [stored] = await database
      .select({
        name: mcpTools.name,
        description: mcpTools.description,
        inputSchema: mcpTools.inputSchema,
        version: mcpTools.version,
      })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, "gmail"));

    expect(stored?.name).toBe("GMAIL_SEND_EMAIL");
    expect(stored?.description).toBe("Send an email.");
    expect(stored?.version).toBe("20260903_00");
    // Inside the schema too, and the rest of the schema rebuilt exactly as it arrived.
    expect(stored?.inputSchema).toEqual({
      type: "object",
      properties: { subject: { description: "The subject" } },
    });
  });

  test("a schema that SPELLS the escape keeps it, because the byte is what the column refuses", async () => {
    const { store, database } = await freshStore();
    /*
     * WHAT THE COLUMN REFUSES IS THE CHARACTER, NOT THE SIX LETTERS THAT NAME IT.
     *
     * The strip used to run over the SERIALISED schema and remove the six characters that spell
     * the escape from it, which is escape-blind: `JSON.stringify` writes a real backslash in a
     * string value as two of them, so a
     * pattern excluding control characters — the single most ordinary place those six letters
     * appear in a JSON Schema — serialised as `\\u0000` and had its TAIL eaten, leaving `\-`,
     * which is not a JSON escape. `JSON.parse` then threw a `SyntaxError` from a line that sits
     * outside both `try` blocks in `refreshTools`: a bodiless 500 on the refresh route, a
     * `lastError` still holding whatever it held before, and — on the add path, which refreshes
     * before answering — an abort AFTER the server row and its audit row had committed.
     *
     * So the assertion is that the schema is stored EXACTLY as the vendor wrote it. Nothing here
     * contains a U+0000; there is nothing for the strip to do.
     */
    const spellsTheEscape = {
      type: "object",
      properties: {
        subject: {
          type: "string",
          // Every control character excluded, which is what this pattern is for and why it is the
          // one a real vendor sends.
          pattern: "^[^\\u0000-\\u001f]+$",
          description: "No control characters, written as \\u0000 in the text.",
        },
      },
    };
    useComposioClient({
      listActions: async () => [
        {
          slug: "GMAIL_SEND_EMAIL",
          description: "Send an email.",
          inputParameters: spellsTheEscape,
          version: "20260903_00",
        },
      ],
      execute: async () => vendorAnswered(),
    });
    await seedComposioGmail(database, store);

    expect(await store.refreshTools("gmail", "admin_user")).toEqual({
      tools: 1,
    });

    const [stored] = await database
      .select({ name: mcpTools.name, inputSchema: mcpTools.inputSchema })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, "gmail"));

    expect(stored?.name).toBe("GMAIL_SEND_EMAIL");
    // Byte for byte what arrived, backslashes and all.
    expect(stored?.inputSchema).toEqual(spellsTheEscape);

    const [row] = await database
      .select({ lastError: mcpServers.lastError })
      .from(mcpServers)
      .where(eq(mcpServers.id, "gmail"));
    // A healthy refresh, because that is what it was.
    expect(row?.lastError).toBeNull();
  });

  test("a schema this deployment cannot make storable is recorded rather than thrown out of the refresh", async () => {
    const { store, database } = await freshStore();
    /*
     * THE CONTAINMENT, asserted on the one shape that still cannot be made into a row.
     *
     * A schema that refers to itself cannot be written to a `jsonb` column and cannot be walked to
     * the end. No wire JSON produces one, which is the point: what is under test is that the line
     * turning a vendor's answer into rows is INSIDE a `try` at all, so that whatever it cannot do
     * leaves `refreshTools` the way every other thing a vendor sent leaves it — recorded in
     * `lastError`, with what the app already holds kept, and the add that called it completed.
     *
     * The cycle hangs off `examples`, which `stagesAFile` does not walk, so it arrives here rather
     * than being refused by the transport's own filter one module earlier.
     */
    const selfReferential: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    selfReferential.examples = selfReferential;

    useComposioClient({
      listActions: async () => [
        {
          slug: "GMAIL_SEND_EMAIL",
          description: "Send an email.",
          inputParameters: selfReferential,
          version: "20260903_00",
        },
      ],
      execute: async () => vendorAnswered(),
    });
    await seedComposioGmail(database, store);

    // Not a throw, and not a count that claims anything was learned.
    expect(await store.refreshTools("gmail", "admin_user")).toEqual({
      tools: 0,
    });

    const [row] = await database
      .select({
        lastError: mcpServers.lastError,
        toolsRefreshedAt: mcpServers.toolsRefreshedAt,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, "gmail"));
    // Named on the row an operator reads, rather than lost with the throw.
    expect(row?.lastError).toContain("could not be stored");
    // And no statement or bound value in it, on the path that records a failure.
    expect(row?.lastError).not.toContain("Failed query");
    expect(row?.lastError).not.toContain("params:");
    // Nothing was learned about the app, so nothing says otherwise.
    expect(row?.toolsRefreshedAt).toBeNull();

    // What the app already had is still there, because nothing was replaced.
    expect(
      await database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, "gmail")),
    ).toEqual([{ name: "GMAIL_FETCH_EMAILS" }]);
  });

  test("a description that is not text is named as a description, not as a schema", async () => {
    /*
     * THE FAR END OF A FIELD NOBODY GUARDED, and the reason the guard went into the transport
     * rather than here.
     *
     * `storableTools` reads `(tool.description ?? "").replaceAll(NUL, "")`, and `??` answers for
     * absence and not for type. A number, an object or a list in the vendor's `description` reached
     * that line and threw the engine's own `replaceAll is not a function`, which the `try` around
     * `storableTools` catches — so what an administrator read on the Plugins page was "an action
     * whose schema could not be stored as it arrived" followed by that. BOTH HALVES WERE WRONG. It
     * was not the schema, nothing named the action, nothing named the field, and the whole app's
     * refresh failed on one malformed row out of sixty.
     *
     * `composio.listTools` now refuses the listing while a sentence can still name the action, so
     * this lands in the vendor `catch` instead — the app keeps what it holds, stamps no refresh,
     * and the row says which action and which field. The assertion is about that sentence, because
     * the sentence is the whole difference between the two paths.
     */
    const { store, database } = await freshStore();
    useComposioClient({
      listActions: async () =>
        [
          {
            slug: "GMAIL_SEND_EMAIL",
            description: 7,
            inputParameters: { type: "object", properties: {} },
            version: "20260903_00",
          },
        ] as never,
      execute: async () => vendorAnswered(),
    });
    await seedComposioGmail(database, store);

    // Not a throw, and not a count that claims anything was learned.
    expect(await store.refreshTools("gmail", "admin_user")).toEqual({
      tools: 0,
    });

    const [row] = await database
      .select({
        lastError: mcpServers.lastError,
        toolsRefreshedAt: mcpServers.toolsRefreshedAt,
      })
      .from(mcpServers)
      .where(eq(mcpServers.id, "gmail"));
    // The action, so an administrator has one row to look at rather than the app's whole listing.
    expect(row?.lastError).toContain("GMAIL_SEND_EMAIL");
    // The field, in the vendor's own terms.
    expect(row?.lastError).toContain("description");
    // Not the engine's sentence, and not the wrong noun for the field that was unreadable.
    expect(row?.lastError).not.toMatch(/is not a function/i);
    expect(row?.lastError).not.toContain("schema could not be stored");
    // Nothing was learned about the app, so nothing says otherwise.
    expect(row?.toolsRefreshedAt).toBeNull();

    // What the app already had is still there, because nothing was replaced.
    expect(
      await database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, "gmail")),
    ).toEqual([{ name: "GMAIL_FETCH_EMAILS" }]);
  });

  test("a replace this database still refuses raises without the statement", async () => {
    /*
     * A transaction forced to fail, because after the two cases above nothing a vendor can send
     * reaches this branch — and this branch is the one that used to publish the dump. What is
     * asserted is the SHAPE of what comes out: the driver's own complaint, and none of the
     * statement or the values bound to it.
     */
    const { store, database } = await freshStore();
    useComposioClient({
      listActions: async () => [
        {
          slug: "GMAIL_SEND_EMAIL",
          description: "Send an email.",
          inputParameters: { type: "object", properties: {} },
          version: "20260903_00",
        },
      ],
      execute: async () => vendorAnswered(),
    });
    await seedComposioGmail(database, store);

    /*
     * Derived from the real one rather than stubbed, so every other query the refresh makes is
     * the real query. The failure is spelled the way drizzle spells one: the statement and every
     * bound value in `message`, the driver's own error hung off `cause`. That message is what
     * used to escape.
     */
    const refusing: Database = Object.create(database);
    Object.defineProperty(refusing, "transaction", {
      value: async () => {
        throw Object.assign(
          new Error(
            'Failed query: insert into "mcp_tools" ("server_id", "name") values ($1, $2) params: gmail, GMAIL_SEND_EMAIL',
          ),
          {
            cause: new Error(
              'duplicate key value violates unique constraint "mcp_tools_pkey"',
            ),
          },
        );
      },
    });

    const failing = createPluginStore({
      database: refusing,
      auditStore: { insert: async () => {} },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
    });

    let thrown: unknown;
    try {
      await failing.refreshTools("gmail", "admin_user");
    } catch (error) {
      thrown = error;
    }

    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // The driver's complaint, which names what went wrong.
    expect(message).toContain("duplicate key value violates unique constraint");
    // And nothing of the statement or of what was bound to it.
    expect(message).not.toContain("Failed query");
    expect(message).not.toContain("insert into");
    expect(message).not.toContain("params:");
    // On the shelf that is raised rather than recorded and never relayed to a model, because a
    // transaction this database would not take is not something the vendor did.
    expect(isDeploymentFault(thrown)).toBe(true);

    // And what the app already had is still there, because nothing was committed.
    expect(
      await database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, "gmail")),
    ).toEqual([{ name: "GMAIL_FETCH_EMAILS" }]);
  });
});

/**
 * A QUERY OF OURS THAT FAILED, on the two paths that copy a caught message onward.
 *
 * WHAT THE SHAPE IS. drizzle wraps every failure as a `DrizzleQueryError`: `message` is `Failed
 * query:` plus the whole statement, then `params:` and every value bound to it, with the driver's
 * own error on `cause`. On the tool-call path those values are credential ids, user ids and server
 * ids; on the refresh path they are the vendor's tool list.
 *
 * WHERE IT COMES FROM. A per-person MCP listing is the shape that runs a query of ours inside the
 * block that catches the vendor's failures: `connectionTokenFor` reads the asking person's stored
 * grant there. `composio` never gets that far — `listNeedsCredential` is false for it, the only
 * brokered transport — and a server added by URL reads its one token from the vault rather than
 * from a query. So the failure is injected at that one read and arrives exactly where it would in
 * production, rather than being handed to the `catch` from somewhere it could not come from.
 */
describe("a query of this deployment's own that failed", () => {
  /** The drizzle shape, spelled once: statement and bound values in `message`, driver on `cause`. */
  function queryFailure() {
    return Object.assign(
      new Error(
        'Failed query: select "credential_id" from "mcp_user_credentials" where "user_id" = $1 params: user_asker',
      ),
      {
        query: 'select "credential_id" from "mcp_user_credentials"',
        params: ["user_asker"],
        cause: new Error("canceling statement due to statement timeout"),
      },
    );
  }

  test("a refresh raises it rather than recording it as what the vendor said", async () => {
    const { database } = await freshStore();

    /*
     * Notion, because a per-person MCP listing is the only shape that runs a query of ours inside
     * the vendor `try`. `composio` never gets there — `listNeedsCredential` is false for it, so
     * `connectionTokenFor` is not called at all — and a server added by URL reads its one token
     * from the vault rather than from a query. Resolved from the catalogue rather than spelled, so
     * a renamed slug breaks this file instead of quietly emptying it.
     */
    const notion = catalogueEntry("notion");
    if (!notion) {
      throw new Error(
        "catalogue slug `notion` is gone, so nothing here reaches a per-person listing",
      );
    }

    // `user_leaver` rather than a new id: this file already owns a `users` row at it, so the
    // person, the connection and the server row are all cleaned by machinery that exists.
    await database.insert(users).values({
      id: "user_leaver",
      email: "leaver@example.com",
      name: "Leaver",
    });
    const [grant] = await database
      .insert(credentialRows)
      .values({
        kind: "mcp_user_token",
        provider: "notion",
        keyId: "user_leaver",
        encryptedValue: "{}",
        metadata: {},
      })
      .returning({ id: credentialRows.id });
    if (!grant) throw new Error("grant row was not created");
    await database.insert(mcpServers).values({
      id: "notion",
      title: notion.title,
      vendor: notion.vendor,
      url: `${notion.host}${notion.path}`,
      provenance: "first-party",
    });
    await database.insert(mcpUserCredentials).values({
      serverId: "notion",
      userId: "user_leaver",
      credentialId: grant.id,
      scope: "",
    });

    /*
     * The stored-grant read, failed — and nothing else.
     *
     * Derived from the real database so every other query the refresh makes is the real query.
     * The second `select` is the one: `requireServer` reads the server row first, outside the
     * block that catches vendor failures, and `connectionTokenFor`'s read of this person's grant
     * is the next one and is inside it. Counting is what makes the failure land there rather than
     * somewhere a blanket override would put it, and the assertions below distinguish the two —
     * the row id in the message is added only by the conversion in that `catch`, so a failure
     * escaping the earlier read would arrive as the raw dump and redden.
     */
    let selects = 0;
    const refusing: Database = Object.create(database);
    Object.defineProperty(refusing, "select", {
      value: (...args: never[]) => {
        selects += 1;
        if (selects === 2) throw queryFailure();
        return database.select(...args);
      },
    });
    const failing = createPluginStore({
      database: refusing,
      auditStore: { insert: async () => {} },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
    });

    let thrown: unknown;
    try {
      await failing.refreshTools("notion", "user_leaver");
    } catch (error) {
      thrown = error;
    }

    try {
      const [row] = await database
        .select({
          lastError: mcpServers.lastError,
          toolsRefreshedAt: mcpServers.toolsRefreshedAt,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, "notion"));

      /*
       * Nothing in the column, asserted FIRST because it is the half that was actually broken and
       * because its failure prints what leaked.
       *
       * `lastError` is drawn on the Plugins page beside a refresh that looks merely to have
       * failed, and the narrowing meant to keep our own faults out of it tested for a class that
       * cannot arrive inside that `try` at all — so it could be deleted with every test green
       * while the statement and every value bound to it went into a column an operator reads and
       * an export carries.
       */
      expect(row?.lastError).toBeNull();
      expect(row?.toolsRefreshedAt).toBeNull();

      // Raised, because a query this database refused is not something the vendor did — the same
      // criterion the replace further down this method is held to.
      expect(isDeploymentFault(thrown)).toBe(true);
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).toContain("canceling statement due to statement timeout");
      expect(message).not.toContain("Failed query");
      expect(message).not.toContain("params:");
      expect(message).not.toContain("mcp_user_credentials");
      // Named by the conversion inside the refresh's own `catch`, which is how this asserts WHERE
      // the failure was classified and not merely that something was thrown.
      expect(message).toContain("notion:");
    } finally {
      /*
       * Locally, and in this order. `mcp_user_credentials.credential_id` is a real foreign key
       * that deliberately does not cascade, so the join row has to go before the vault row — and
       * the teardown that clears vault rows for this file runs before the one that clears server
       * rows, which is what would otherwise leave a delete refusing.
       */
      await database
        .delete(mcpUserCredentials)
        .where(
          and(
            eq(mcpUserCredentials.serverId, "notion"),
            eq(mcpUserCredentials.userId, "user_leaver"),
          ),
        );
      await database
        .delete(credentialRows)
        .where(eq(credentialRows.id, grant.id));
    }
  });

  test("the model is told the call did not happen, and none of the query", async () => {
    /*
     * At the seam that decides, which is where the leak was.
     *
     * `grantedTools` takes a store, and the question is what it hands the model when that store
     * throws — so the store is the thing stubbed and nothing else is. Every query on the call path
     * runs inside `callTool`'s own recording block and comes out of it unchanged, so this shape
     * arriving here is the production arrival, not an approximation of one.
     */
    const [tool] = await grantedTools({
      store: {
        listForAgent: async () => ({
          tools: [
            {
              ref: "gmail/GMAIL_FETCH_EMAILS",
              toolName: "gmail__GMAIL_FETCH_EMAILS",
              description: "Fetch emails.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          skills: [],
        }),
        callTool: async () => {
          throw queryFailure();
        },
      } as unknown as PluginStore,
      botId: "bot_helper",
      actorId: "user_asker",
    });
    if (!tool) throw new Error("the Bot was offered no tool to call");

    const answer = await tool.execute({});

    /*
     * What the model is handed, exactly.
     *
     * Not the statement and not the values bound to it — on this path those are credential ids,
     * user ids and server ids. Not a sentence blaming the vendor either: the call never reached
     * one, and `That tool could not be called: <our SQL>` is what the model used to be given to
     * explain the failure to the person asking.
     */
    expect(answer).toBe("That tool could not be called.");
    expect(answer).not.toContain("Failed query");
    expect(answer).not.toContain("params:");
    expect(answer).not.toContain("mcp_user_credentials");
  });

  test("the trail gets the reason and none of the query", async () => {
    const database = await freshDatabase();
    const events: { eventType: string; payload: unknown }[] = [];
    /*
     * Thrown at the vendor seam, and recorded by the block above it.
     *
     * WHERE THIS ARRIVES FROM IN PRODUCTION: `connectionTokenFor`, three lines earlier and inside
     * the same `try` — its connection gate read, its vault read and its locked credential swap
     * are all queries of ours. Reaching one of those and failing only it needs a counted override
     * of every `select` the call path makes, which pins a test to the order of queries rather than
     * to the property. `callVendor` is the one seam this store hands a caller, and a throw through
     * it lands in exactly the `catch` those queries land in; what that `catch` can do about a
     * throw is classify it, which is the property.
     */
    const failing = createPluginStore({
      database,
      auditStore: {
        insert: async (event) => {
          events.push(event as (typeof events)[number]);
        },
      },
      credentials: credentialsStub,
      encryptionKey: "x".repeat(44),
      policy: () => policy,
      callVendor: async () => {
        throw queryFailure();
      },
    });
    await seedComposioGmail(database, failing);

    await expect(
      failing.callTool({
        ref: "gmail/GMAIL_FETCH_EMAILS",
        args: {},
        botId: "bot_helper",
        actorId: "user_asker",
      }),
    ).rejects.toThrow();

    const failed = events.filter(
      (event) => event.eventType === "mcp.call_failed",
    );
    expect(failed).toHaveLength(1);
    const failure =
      (failed[0]?.payload as { failure?: string } | undefined)?.failure ?? "";
    /*
     * The reason, because "is this connector working" is asked of this row and the driver's
     * complaint answers it. Not the statement and not the values bound to it: on this path those
     * are credential ids, user ids and server ids, and `audit_events` is read by an operator and
     * carried out of the deployment by an export.
     */
    expect(failure).toContain("canceling statement due to statement timeout");
    expect(failure).not.toContain("Failed query");
    expect(failure).not.toContain("params:");
    expect(failure).not.toContain("mcp_user_credentials");
  });

  /**
   * AND THE ONE REMAINING SITE THAT ASKS NOTHING, read as text because nothing can drive it.
   *
   * WHY THERE IS NO BEHAVIOURAL TEST FOR THIS ONE, and why that is a reason to assert it rather
   * than to leave it. `refreshTools`' vendor `catch` opens with `isDeploymentFault`, which answers
   * true for a query failure, so every arrival whose message is a statement is raised before the
   * line below it can copy one. What that line can still be handed is a WRAPPER: `composio.ts`'s
   * `listTools` catches whatever the client threw and rethrows `new Error(listingSentence(...))`,
   * and `listingSentence` falls through to the thrown message verbatim. A wrapper has no `query`
   * and no `params` of its own, so it is not on the shelf and it is not a query failure by shape —
   * it is simply a message this deployment has stopped asking any question about. Nothing reachable
   * puts a statement inside one today, which is exactly the sentence that was true of the credential
   * envelope before the rotation path started writing one.
   *
   * SO WHAT IS ASSERTED IS THAT THE DOOR IS THE ONLY WAY THROUGH. `db/query-failure.ts` exists to be
   * the single place the question is asked; a site reading `.message` directly is a second answer to
   * it, and the last two leaks in this review were both a second answer that had drifted. The test
   * above owns the behaviour of the reachable path; this owns the shape of every path.
   */
  test("no recording site in the plugin store reads a caught message without asking", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "plugins", "store.ts"),
      "utf8",
    );
    /*
     * Comments blanked rather than removed, because this file argues about `error.message` at
     * length — the prose naming the hazard must not be mistaken for the hazard, and the line
     * numbers reported below have to stay the file's own so a failure names where to look.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
      .replace(/^([^\n"'`]*?)\/\/.*$/gm, "$1");

    // Listed rather than matched, so a failure prints the line to correct instead of the file.
    expect(
      code
        .split("\n")
        .flatMap((line, index) =>
          /\berror\.message\b/.test(line)
            ? [`${index + 1}: ${line.trim()}`]
            : [],
        ),
    ).toEqual([]);
    // And the door is genuinely in use, so the assertion above cannot be satisfied by deleting the
    // read altogether and saying nothing.
    expect(code).toMatch(/\b(withoutStatement|reasonWithoutStatement)\(/);
  });
});

/**
 * The genuine empty listing, which has to stay recordable.
 *
 * The guard above must not turn "this app advertises nothing" into a state the deployment cannot
 * hold, or an app that really offers no actions would read as broken for good. An app with nothing
 * recorded against it has nothing to lose, so the empty answer commits: refreshed, no error and no
 * actions, which is the honest reading of an app that advertises none.
 */
test("an app with nothing recorded against it can be refreshed to no actions at all", async () => {
  const { store, database } = await freshStore();
  useComposioClient({
    listActions: async () => [],
    execute: async () => vendorAnswered(),
  });
  await database.insert(mcpServers).values({
    id: "gmail",
    title: "Gmail",
    vendor: "Composio",
    url: "composio://gmail",
    provenance: "composio",
    lastError: "Whatever was wrong last time.",
  });

  expect(await store.refreshTools("gmail", "admin_user")).toEqual({ tools: 0 });

  const [row] = await database
    .select({
      lastError: mcpServers.lastError,
      toolsRefreshedAt: mcpServers.toolsRefreshedAt,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, "gmail"));

  expect(row?.lastError).toBeNull();
  expect(row?.toolsRefreshedAt).not.toBeNull();
});

/**
 * An audit write that fails, which is not the vendor misbehaving.
 *
 * The refresh used to run the listing, the replace, the server-row update and both audit writes
 * inside one `catch` that recorded everything as `lastError` and answered `{ tools: 0 }`. So a
 * database that would not take an audit row reported a vendor which had in fact answered correctly,
 * and reported it against actions the refresh had already committed — sending whoever reads the
 * page to a vendor's status page over a fault in their own database.
 *
 * Its own store rather than {@link freshStore}, because the audit insert is the seam that has to
 * fail and that fixture's is deliberately a real one.
 */
test("an audit write that fails is not recorded as the vendor misbehaving", async () => {
  const database = await freshDatabase();
  const failing = createPluginStore({
    database,
    auditStore: {
      insert: async (event) => {
        if (
          (event.payload as { change?: string }).change ===
          "grants_not_advertised"
        ) {
          throw new Error("audit_events would not take the row");
        }
      },
    },
    credentials: credentialsStub,
    encryptionKey: "x".repeat(44),
    policy: () => policy,
  });

  useComposioClient({
    listActions: async () => [
      {
        slug: "GMAIL_SEND_EMAIL",
        description: "Send an email.",
        inputParameters: { type: "object", properties: {} },
        tags: ["createHint"],
        version: "20260903_00",
      },
    ],
    execute: async () => vendorAnswered(),
  });
  // The granted action is absent from what the vendor now lists, so the refresh reaches the audit
  // write about grants nothing advertises — the one the stub above refuses.
  await seedComposioGmail(database, failing);

  await expect(failing.refreshTools("gmail", "admin_user")).rejects.toThrow(
    "audit_events would not take the row",
  );

  const [row] = await database
    .select({ lastError: mcpServers.lastError })
    .from(mcpServers)
    .where(eq(mcpServers.id, "gmail"));

  expect(row?.lastError).toBeNull();
});

/**
 * The moment a brokered app starts existing, which is an auth config before it is a row.
 *
 * The id and the url are different strings on purpose, and both are asserted. `composio-linear` is
 * what a grant and a policy rule are written against, and it carries a prefix so it cannot land on
 * a curated entry's slug or on one of the ids the fixtures above reserve; `composio://linear` is
 * what `accessFor` reads the app off, and that is the field the transport and the connection gate
 * both settle the app from. A test that asserted only one of them would pass on an implementation
 * that made them equal, which is the arrangement those two rules exist to keep apart.
 *
 * THE BROKER IS ASKED FIRST AND EXACTLY ONCE. First because a row whose auth config does not exist
 * is an app an administrator can see and nobody can connect to; once because `ensureAuthConfig` is
 * idempotent at the vendor and a second call here would be this deployment leaning on that. The
 * connection the caller resolved is asserted as it reaches the broker unchanged, because that kind
 * decides what config is created at the vendor: an enable path that re-derived it here rather than
 * passing the caller's through would be a second answer to the question this argument exists to
 * settle once.
 *
 * `composio-linear` is cleaned up in a `finally` rather than by {@link freshDatabase}, which knows
 * only the ids the guard at the top of this file cleared. The row is checked absent before the add
 * for the same reason every delete in this file is guarded: the id is spelled the way production
 * spells it, so a row already at it would be somebody's app rather than this test's.
 */
test("enabling an app writes a brokered row, and asks for its auth config first", async () => {
  const asked: {
    toolkit: string;
    name: string;
    connection: BrokerConnection;
  }[] = [];
  const rowsWhenAsked: string[] = [];
  const unasked = (what: string) => async (): Promise<never> => {
    throw new Error(`enabling an app asked the broker to ${what}`);
  };
  const broker: ComposioBroker = {
    listApps: unasked("list the catalogue"),
    ensureAuthConfig: async (config) => {
      asked.push(config);
      /*
       * What the table held at the moment the broker was asked, which is how "first" is asserted
       * rather than assumed. Counting the calls says nothing about the order, and the order is the
       * whole property: an implementation that wrote the row and then asked would leave an app on
       * the page that nobody can connect to whenever this call fails.
       */
      const rows = await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, "composio-linear"));
      rowsWhenAsked.push(...rows.map((row) => row.id));
      return "created";
    },
    deleteAuthConfig: unasked("delete an auth config"),
    authorize: unasked("begin somebody's connection"),
    isConnected: unasked("check somebody's connection"),
    revoke: unasked("withdraw somebody's grant"),
  };

  const { store, database, auditStore } = await freshStore({ broker });
  useComposioClient({
    listActions: async () => [
      {
        slug: "LINEAR_CREATE_ISSUE",
        description: "Create an issue.",
        inputParameters: { type: "object", properties: {} },
        tags: ["createHint"],
        version: "20260903_00",
      },
    ],
    execute: async () => vendorAnswered(),
  });

  const [present] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, "composio-linear"));
  if (present) {
    throw new Error(
      "a row at 'composio-linear' was already here, so it is not this test's to write over",
    );
  }

  try {
    const record = await store.addBrokeredApp({
      slug: "linear",
      title: "Linear",
      logo: "https://example.com/linear.svg",
      by: "admin@example.com",
      connection: { kind: "consent" },
    });

    expect(record.id).toBe("composio-linear");
    expect(record.logo).toBe("https://example.com/linear.svg");
    expect(record.url).toBe("composio://linear");
    expect(record.provenance).toBe("composio");
    // No credential of its own, and none to come: a brokered row is reached as the person asking,
    // on their connection at the vendor, so there is nothing on this row for a vault to hold.
    expect(record.hasCredential).toBe(false);

    expect(asked).toEqual([
      { toolkit: "linear", name: "Linear", connection: { kind: "consent" } },
    ]);
    expect(rowsWhenAsked).toEqual([]);

    const changes = auditStore
      .recorded()
      .filter((event) => event.eventType === "configuration.changed");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toMatchObject({
      change: "mcp_server_added",
      provenance: "composio",
    });
  } finally {
    await database
      .delete(mcpTools)
      .where(eq(mcpTools.serverId, "composio-linear"));
    await database
      .delete(mcpServers)
      .where(eq(mcpServers.id, "composio-linear"));
  }
});

/**
 * The same call on a deployment that has no Composio key, which is the documented default.
 *
 * The refusal names the setting because the name is the whole remedy, and nothing else about a
 * deployment with no broker will tell an administrator what to set. Asserted on the message rather
 * than the class so that the sentence an operator actually reads is what this test is about.
 */
test("enabling an app with no broker says which setting is missing", async () => {
  const { store } = await freshStore();

  await expect(
    store.addBrokeredApp({
      slug: "linear",
      title: "Linear",
      by: "admin@example.com",
    }),
  ).rejects.toThrow("COMPOSIO_API_KEY");
});

/**
 * A broker that answers only the methods a test names, in the order it was asked.
 *
 * WHAT IS NOT NAMED THROWS, which is the half that carries the assertions below. "The disconnect
 * asked the broker to revoke" is worth very little on its own; "and asked it nothing else" is the
 * property, because a connection path that also listed the catalogue or created an auth config
 * would be doing work on somebody's behalf that nobody here has reasoned about. A default stub
 * answering plausibly would let all of that pass unremarked.
 *
 * `order` records the calls rather than counting them, so a test can say which of two things
 * happened first. The state a call found the database in is NOT recorded here: the handlers are
 * the test's own functions, so a test that needs to know what a row looked like at the moment of
 * the call reads it inside its own handler — the same way the enablement test above establishes
 * that the auth config comes before the row.
 *
 * AND THE ENTRY NAMES WHOSE CALL IT WAS, where the call has an owner. A path that revokes for one
 * person is fully described by `revoke`; a path that revokes for everybody connected to an app is
 * not, because "two revokes happened" says nothing about who they were for and nothing about the
 * order they went out in — and the order is what makes a removal repeatable. So the request's
 * `userId` is appended where there is one, and calls that are about the deployment rather than a
 * person (`deleteAuthConfig`) stay bare.
 */
function brokerSpy(answers: {
  ensureAuthConfig?: (config: {
    toolkit: string;
    name: string;
  }) => Promise<void>;
  deleteAuthConfig?: (toolkit: string) => Promise<void>;
  isConnected?: (request: {
    userId: string;
    toolkit: string;
  }) => Promise<boolean>;
  revoke?: (request: { userId: string; toolkit: string }) => Promise<boolean>;
}): { broker: ComposioBroker; order: string[] } {
  const order: string[] = [];
  const unasked = (what: string) => async (): Promise<never> => {
    throw new Error(`the connection path asked the broker to ${what}`);
  };
  const asked = <Request, Answer>(
    name: string,
    handler: ((request: Request) => Promise<Answer>) | undefined,
    what: string,
  ) => {
    return async (request: Request): Promise<Answer> => {
      const owner =
        typeof request === "object" &&
        request !== null &&
        "userId" in request &&
        typeof request.userId === "string"
          ? `:${request.userId}`
          : "";
      order.push(`${name}${owner}`);
      if (!handler)
        throw new Error(`the connection path asked the broker to ${what}`);
      return await handler(request);
    };
  };

  return {
    order,
    broker: {
      listApps: unasked("list the catalogue"),
      ensureAuthConfig: asked(
        "ensureAuthConfig",
        answers.ensureAuthConfig,
        "create an auth config",
      ),
      deleteAuthConfig: asked(
        "deleteAuthConfig",
        answers.deleteAuthConfig,
        "delete an auth config",
      ),
      authorize: unasked("begin somebody's connection"),
      isConnected: asked(
        "isConnected",
        answers.isConnected,
        "check somebody's connection",
      ),
      revoke: asked("revoke", answers.revoke, "withdraw somebody's grant"),
    },
  };
}

/**
 * The row is the vendor's answer written down, and nothing else may write it.
 *
 * CRITERION. After a confirm the deployment says somebody is connected if and only if Composio
 * said so when asked.
 *
 * REASON. The return trip from consent is an ordinary redirect with nothing signed in it, so a
 * browser arriving back on the page is evidence of nothing at all — not that the flow finished,
 * and not that the account it finished with is the one this row would claim. A confirm that wrote
 * a row because somebody came back would hand every subsequent brokered call a gate that passes
 * for an account that may not exist, and the first thing anybody would see of the mistake is the
 * vendor's own error about a connection it cannot find.
 *
 * BOTH ANSWERS IN ONE TEST, over one store, because the second is what makes the first mean
 * something: a confirm that never wrote a row would pass the "not connected" assertion on its own.
 */
test("a brokered connection row is written only where the vendor says the account is live", async () => {
  let live = false;
  const { broker, order } = brokerSpy({ isConnected: async () => live });
  const { store, auditStore } = await freshStore({ broker });
  const pair = { toolkit: "gmail", userId: "user_asker" };

  expect(await store.confirmBrokeredConnection(pair)).toEqual({
    connected: false,
  });
  // Nothing at all, which is the whole of the first half: the gate a brokered call is decided on
  // must not exist for somebody the vendor does not recognise.
  expect(await store.brokeredConnection(pair)).toBeNull();
  expect(auditStore.recorded()).toHaveLength(0);

  live = true;
  expect(await store.confirmBrokeredConnection(pair)).toEqual({
    connected: true,
  });
  const connection = await store.brokeredConnection(pair);
  expect(connection?.connectedAt).toBeTruthy();

  expect(order).toEqual(["isConnected:user_asker", "isConnected:user_asker"]);
  const connected = auditStore
    .recorded()
    .filter((event) => event.eventType === "mcp.account_connected");
  expect(connected).toHaveLength(1);
  expect(connected[0]?.payload).toMatchObject({
    actor: "user_asker",
    server: "gmail",
    // Empty because Composio grants no scope this deployment is told about, and the field explains
    // a later refusal for want of one. A guess written here would be an explanation nobody gave.
    scope: "",
    reconnected: false,
  });
});

/**
 * An account ended in Composio's own dashboard is forgotten here the next time we ask.
 *
 * CRITERION. Where a row is already written down and the vendor says the account is not live, the
 * confirm removes the row, and it files nothing in the trail for having removed it.
 *
 * REASON. The row is a cache of the vendor's answer, and nothing tells this deployment when that
 * answer changes: a grant withdrawn at Composio ends the account with no callback arriving here.
 * A confirm that only ever wrote rows would leave the settings list drawing "Connected" for an
 * account nobody has, leave the gate every brokered call is decided on passing for it, and leave
 * the app's own detail page — which asks the vendor on mount — contradicting the list beside it.
 *
 * THE TRAIL STAYS EMPTY, which is asserted rather than assumed. Nobody disconnected anything: the
 * grant ended elsewhere and this is the record catching up, so an `mcp.account_disconnected` row
 * written here would credit a page load with an act it did not perform. `disconnectBrokered` is
 * what files that event, for the disconnect it actually carried out.
 */
test("confirming a brokered connection the vendor no longer has removes the row", async () => {
  const { broker, order } = brokerSpy({ isConnected: async () => false });
  const { store, database, auditStore } = await freshStore({ broker });
  const pair = { toolkit: "gmail", userId: "user_asker" };
  await database.insert(composioConnections).values(pair);

  expect(await store.confirmBrokeredConnection(pair)).toEqual({
    connected: false,
  });

  expect(await store.brokeredConnection(pair)).toBeNull();
  expect(order).toEqual(["isConnected:user_asker"]);
  expect(auditStore.recorded()).toHaveLength(0);
});

/**
 * A confirm that healed a row nothing changed is a read, and the trail does not record reads.
 *
 * CRITERION. Confirming a connection that is already written down leaves exactly the one
 * `mcp.account_connected` row the first confirm filed, however many times it is called.
 *
 * REASON. This method runs on page load and not on a button: the connector page calls it once per
 * mount for every brokered app it draws. An event per yes from the vendor therefore writes ten
 * "account connected" rows for somebody who opened the page ten times having connected once, and
 * a trail padded with acts nobody performed cannot answer the only question it is kept for. It is
 * the failure the `reconnected` field is already written to avoid, arriving one level up at the
 * event itself.
 *
 * THE VENDOR IS STILL ASKED EVERY TIME, which is asserted here rather than assumed: the row is a
 * cache of Composio's answer and the re-asking is how a row that drifted heals. What stops on the
 * second call is the writing-down of the heal as somebody's act, not the heal.
 */
test("confirming a brokered connection already recorded writes no second trail row", async () => {
  const { broker, order } = brokerSpy({ isConnected: async () => true });
  const { store, auditStore } = await freshStore({ broker });
  const pair = { toolkit: "gmail", userId: "user_asker" };

  expect(await store.confirmBrokeredConnection(pair)).toEqual({
    connected: true,
  });
  const first = await store.brokeredConnection(pair);
  expect(first?.connectedAt).toBeTruthy();

  expect(await store.confirmBrokeredConnection(pair)).toEqual({
    connected: true,
  });
  expect(await store.confirmBrokeredConnection(pair)).toEqual({
    connected: true,
  });

  expect(order).toEqual([
    "isConnected:user_asker",
    "isConnected:user_asker",
    "isConnected:user_asker",
  ]);
  // Unmoved, because the person connected when they connected: the confirms above are page loads.
  expect(await store.brokeredConnection(pair)).toEqual(first);
  expect(
    auditStore
      .recorded()
      .filter((event) => event.eventType === "mcp.account_connected"),
  ).toHaveLength(1);
});

/**
 * Disconnecting ends the account at the vendor BEFORE it forgets where the account was.
 *
 * CRITERION. The broker is asked to revoke while the row is still there, and the row goes only
 * after it answered.
 *
 * REASON. The row is the only thing in this deployment that names which app this person connected:
 * delete it first and a revoke that then fails leaves a live grant on somebody's mailbox that no
 * operation here can reach, because the toolkit it would have to be revoked under is readable off
 * a row that is by now gone. Ordering the other way is recoverable by definition — pressing
 * disconnect again asks again.
 *
 * ASSERTED ON WHAT THE REVOKE SAW, not on a call count, because a count says nothing about order
 * and the order is the entire property.
 */
test("disconnecting a brokered connection revokes at the vendor before the row goes", async () => {
  const rowsWhenRevoked: string[] = [];
  const { broker, order } = brokerSpy({
    revoke: async () => {
      const rows = await database
        .select({ userId: composioConnections.userId })
        .from(composioConnections)
        .where(ownedConnections());
      rowsWhenRevoked.push(...rows.map((row) => row.userId));
      return true;
    },
  });
  const { store, database, auditStore } = await freshStore({ broker });
  const pair = { toolkit: "gmail", userId: "user_asker" };
  await database.insert(composioConnections).values(pair);

  const outcome = await store.disconnectBrokered({
    ...pair,
    by: "user_asker",
    reason: "self",
  });

  expect(outcome).toEqual({ vendorRevocationRequested: true });
  expect(rowsWhenRevoked).toEqual(["user_asker"]);
  expect(order).toEqual(["revoke:user_asker"]);
  expect(await store.brokeredConnection(pair)).toBeNull();

  const disconnected = auditStore
    .recorded()
    .filter((event) => event.eventType === "mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0]?.payload).toMatchObject({
    actor: "user_asker",
    server: "gmail",
    owner: "user_asker",
    reason: "self",
    // What happened, not what was attempted. The broker said it withdrew a grant, so the trail
    // says so; a field that always said true would make the row a worse record than none.
    vendorRevocationRequested: true,
  });
});

/**
 * A revoke that throws leaves the connection exactly where it was, so pressing again finishes it.
 *
 * CRITERION. A failed disconnect removes nothing and records nothing, and the same call made again
 * against a broker that now answers completes the job.
 *
 * REASON. This is the payoff of the ordering above, stated as the behaviour somebody actually
 * meets: Composio is down for a minute, the person presses disconnect, and the alternative to
 * keeping the row is an account still live at the vendor with nothing left here that knows which
 * app it belongs to. Keeping it means the only cost of the failure is that they press the button
 * again.
 */
test("a brokered connection outlives a revoke that failed, and a second attempt ends it", async () => {
  let broken = true;
  const { broker } = brokerSpy({
    revoke: async () => {
      if (broken) throw new Error("Composio would not answer (502).");
      return true;
    },
  });
  const { store, database, auditStore } = await freshStore({ broker });
  const pair = { toolkit: "gmail", userId: "user_asker" };
  await database.insert(composioConnections).values(pair);

  await expect(
    store.disconnectBrokered({
      ...pair,
      by: "user_asker",
      reason: "self",
    }),
  ).rejects.toThrow("Composio would not answer (502).");

  expect(await store.brokeredConnection(pair)).not.toBeNull();
  // No row in the trail either. "Their account was disconnected" is a claim about the vendor, and
  // nothing was disconnected anywhere.
  expect(auditStore.recorded()).toHaveLength(0);

  broken = false;
  expect(
    await store.disconnectBrokered({
      ...pair,
      by: "user_asker",
      reason: "self",
    }),
  ).toEqual({ vendorRevocationRequested: true });
  expect(await store.brokeredConnection(pair)).toBeNull();
});

/**
 * A revoke that found nothing to withdraw says so, and the row goes all the same.
 *
 * CRITERION. Where the broker answers `false`, both the outcome and the trail carry
 * `vendorRevocationRequested: false`, and the `composio_connections` row is deleted regardless.
 *
 * REASON. This is the grant somebody already ended in Composio's own dashboard. The account is
 * gone at the vendor, so the local row is the stale half of a pair that has drifted and deleting
 * it is what makes the two agree again. What must not happen is the trail claiming this
 * deployment withdrew something: a row saying the grant was ended here when it was ended
 * somewhere else is a worse record than none, because whoever reads back for who ended it is
 * given the wrong answer in the same words as the right one.
 *
 * THE FALSE IS THE WHOLE TEST. `vendorRevocationRequested` is indistinguishable from a hardcoded
 * `true` until a revoke answers no, and no other test in this file exercises one.
 */
test("a brokered disconnect that withdrew no grant records that it withdrew none", async () => {
  const { broker, order } = brokerSpy({ revoke: async () => false });
  const { store, database, auditStore } = await freshStore({ broker });
  const pair = { toolkit: "gmail", userId: "user_asker" };
  await database.insert(composioConnections).values(pair);

  expect(
    await store.disconnectBrokered({
      ...pair,
      by: "user_asker",
      reason: "self",
    }),
  ).toEqual({ vendorRevocationRequested: false });

  expect(order).toEqual(["revoke:user_asker"]);
  // Gone, because there was nothing at the vendor and the row was therefore the half that had
  // drifted. Keeping it would leave the gate on every brokered call passing for an account that
  // no longer exists anywhere.
  expect(await store.brokeredConnection(pair)).toBeNull();

  const disconnected = auditStore
    .recorded()
    .filter((event) => event.eventType === "mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0]?.payload).toMatchObject({
    actor: "user_asker",
    server: "gmail",
    owner: "user_asker",
    reason: "self",
    vendorRevocationRequested: false,
  });
});

/**
 * A disconnect that found nothing to disconnect says nothing in the trail.
 *
 * CRITERION. With no `composio_connections` row for the pair, the call still asks the broker to
 * revoke, and files an `mcp.account_disconnected` event only where that ask withdrew a grant.
 * Nothing here and nothing at the vendor is nothing disconnected, and the trail stays empty.
 *
 * REASON. This is the second press of Disconnect. The screen that made it easy — a row still
 * reading "Connected" after a successful disconnect — has been fixed, but any caller can make the
 * same call twice, and an event filed for it would tell whoever reads the trail back that
 * somebody's account ended at a moment when nobody's did. A trail padded with acts nobody
 * performed cannot answer the one question it is kept for, which is the reasoning
 * `confirmBrokeredConnection` already files its connected event under.
 *
 * THE VENDOR IS ASKED ALL THE SAME, which is asserted and not assumed. The row is a cache of
 * Composio's answer and it drifts by construction — the confirm deletes it on any `false` from the
 * vendor — so an absence here is no evidence that the grant is gone, and this call is the only
 * operation in this deployment that can end one. What the missing row stops is the writing-down of
 * an act, not the ask.
 *
 * BOTH ANSWERS IN ONE TEST, because the second is what makes the first mean something: a guard
 * that filed nothing whenever the row was missing would pass the empty-trail assertion on its own,
 * and would lose the case that matters most — a live account ended for somebody whose local row
 * had already gone.
 */
test("a brokered disconnect with nothing to disconnect files nothing in the trail", async () => {
  let granted = false;
  const { broker, order } = brokerSpy({ revoke: async () => granted });
  const { store, auditStore } = await freshStore({ broker });
  const pair = { toolkit: "gmail", userId: "user_asker" };

  expect(
    await store.disconnectBrokered({
      ...pair,
      by: "user_asker",
      reason: "self",
    }),
  ).toEqual({ vendorRevocationRequested: false });

  expect(order).toEqual(["revoke:user_asker"]);
  expect(await store.brokeredConnection(pair)).toBeNull();
  // Empty, which is the whole of the first half: no row went and no grant was withdrawn, so
  // nobody was disconnected and the trail has nothing to say about it.
  expect(auditStore.recorded()).toHaveLength(0);

  // The same absence locally, but this time the ask found a live account and ended it. That is an
  // act — the weightier of the two this method performs — and it is recorded.
  granted = true;
  expect(
    await store.disconnectBrokered({
      ...pair,
      by: "user_asker",
      reason: "self",
    }),
  ).toEqual({ vendorRevocationRequested: true });

  const disconnected = auditStore
    .recorded()
    .filter((event) => event.eventType === "mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0]?.payload).toMatchObject({
    actor: "user_asker",
    server: "gmail",
    owner: "user_asker",
    reason: "self",
    vendorRevocationRequested: true,
  });
});

/**
 * A brokered connection is visible to the person who made it, under the server row's own id.
 *
 * CRITERION. `brokeredConnectionsFor` answers one row per app this person has connected, carrying
 * the `serverId`, `scope` and `connectedAt` that `connectionsFor` answers with — so one screen
 * draws both kinds of row — plus the `verified` and `verifiedAt` that only a brokered row has,
 * because only a brokered row is a thing this deployment can re-check. The `serverId` in it is the
 * id of the `mcp_servers` row whose url names that app.
 *
 * REASON. `connectionsFor` selects from the vault's join table alone, so a brokered connection was
 * invisible to the browser and the settings screen could not honestly say whether somebody was
 * connected. The id has to be joined rather than composed because the url is where the app is
 * recorded: `composio-${toolkit}` spelled by hand answers with whatever production happens to
 * spell today, and this fixture — a server row at `gmail`, not at `composio-gmail` — is the case
 * that tells a joined id from a guessed one.
 */
test("a brokered connection is listed for its owner under the server row's own id", async () => {
  const { store, database } = await freshStore();
  await seedComposioGmail(database, store);

  const connections = await store.brokeredConnectionsFor("user_asker");
  expect(connections).toHaveLength(1);
  expect(connections[0]).toMatchObject({
    serverId: "gmail",
    // Empty for the reason the confirm gives: Composio grants no scope it tells us about, and the
    // field is returned anyway so one settings screen can draw both kinds of connection.
    scope: "",
  });
  expect(connections[0]?.connectedAt).toBeTruthy();

  // Nobody else's, which is the only other thing this query promises.
  expect(await store.brokeredConnectionsFor("user_leaver")).toEqual([]);
});

/**
 * And it is the url that decides which server row a connection belongs to, not the id.
 *
 * CRITERION. A person connected to `gmail`, with the only Composio server row sitting at
 * `composio://slack`, is listed against nothing.
 *
 * REASON. The id and the url are two fields and nothing in the schema holds them equal — which is
 * the shape `seedComposioGmail` exists to reproduce. Reading the connection's app off the url is
 * the same thing the directory route does when it decides which apps are enabled, and it is what
 * stops this query telling somebody they have a Slack connection because a row called `gmail`
 * happened to be pointed somewhere else.
 */
test("a brokered connection is not listed against a server row whose url names another app", async () => {
  const { store, database } = await freshStore();
  await seedComposioGmail(database, store, { url: "composio://slack" });

  expect(await store.brokeredConnectionsFor("user_asker")).toEqual([]);
});

/**
 * Removing an app ends every account at the vendor, and only then forgets where they were.
 *
 * CRITERION. `removeServer` on a brokered row revokes at the broker for every connected person
 * while their rows are still standing, deletes the rows after that, and drops the deployment's
 * auth config last of all — and the trail says of each person that the grant was really withdrawn.
 *
 * REASON. Clearing `composio_connections` closes the gate this deployment owns and nothing else:
 * the account the person attached is still live at Composio, and an administrator who pressed
 * "remove" was not told they had left it there. So the removal ends the accounts too, and the
 * order is forced. A brokered row's toolkit is readable off nothing but the row, so delete-first
 * and a revoke that then fails leaves a live grant on somebody's mailbox with no value left here
 * to revoke it under; revoke-first and the same failure leaves the app present, every account
 * dead, and removing again finishes the job. Dead-and-reachable beats live-and-unreachable.
 *
 * THE AUTH CONFIG GOES LAST for the same reasoning one step out. An orphaned auth config grants
 * nobody anything — it is a shape this deployment holds at Composio, not an account — while a live
 * account whose config has already gone is access nobody here can end.
 *
 * ASSERTED ON WHAT EACH CALL SAW, not on a count. Counting says nothing about order, and the order
 * is the entire property: an implementation that deleted the rows first and revoked off what the
 * delete returned would make exactly the same calls in exactly the same sequence.
 *
 * THE PEOPLE CONNECT IN REVERSE, `user-b` before `user-a`, so that the sorted revoke is doing work
 * rather than agreeing with the insertion order by luck.
 */
test("removing an app revokes everybody, then clears rows, then drops the config", async () => {
  /** Who was still connected to `linear` at the moment of each broker call, in call order. */
  const connectedWhenAsked: string[][] = [];
  const stillConnected = async () =>
    (
      await database
        .select({ userId: composioConnections.userId })
        .from(composioConnections)
        .where(eq(composioConnections.toolkit, "linear"))
        .orderBy(asc(composioConnections.userId))
    ).map((row) => row.userId);

  const { broker, order } = brokerSpy({
    ensureAuthConfig: async () => "created",
    isConnected: async () => true,
    revoke: async () => {
      connectedWhenAsked.push(await stillConnected());
      return true;
    },
    deleteAuthConfig: async () => {
      connectedWhenAsked.push(await stillConnected());
    },
  });
  const { store, database, auditStore } = await freshStore({ broker });
  useComposioClient({
    listActions: async () => [
      {
        slug: "LINEAR_CREATE_ISSUE",
        description: "Create an issue.",
        inputParameters: { type: "object", properties: {} },
        tags: ["createHint"],
        version: "20260903_00",
      },
    ],
    execute: async () => vendorAnswered(),
  });

  /*
   * This fixture's own ids, checked here because the guard at the top of the file does not cover
   * them: `composio-linear` and the pairs at `linear` are spelled the way production spells them,
   * so a row already sitting at one belongs to somebody else and the cleanup below would take it.
   */
  const [present] = await database
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(eq(mcpServers.id, "composio-linear"));
  const strangers = await database
    .select({ userId: composioConnections.userId })
    .from(composioConnections)
    .where(
      and(
        eq(composioConnections.toolkit, "linear"),
        inArray(composioConnections.userId, ["user-a", "user-b"]),
      ),
    );
  if (present || strangers.length > 0) {
    throw new Error(
      "a 'composio-linear' server row or a 'linear' connection for user-a or user-b was already " +
        "here, so it is not this test's to write over",
    );
  }

  try {
    await store.addBrokeredApp({
      slug: "linear",
      title: "Linear",
      by: "admin",
      connection: { kind: "consent" },
    });
    for (const userId of ["user-b", "user-a"]) {
      expect(
        await store.confirmBrokeredConnection({ toolkit: "linear", userId }),
      ).toEqual({ connected: true });
    }

    // The setup's own traffic, cleared so what follows is about the removal and nothing else.
    order.length = 0;
    connectedWhenAsked.length = 0;

    await store.removeServer("composio-linear", "admin");

    expect(order).toEqual([
      "revoke:user-a",
      "revoke:user-b",
      "deleteAuthConfig",
    ]);
    /*
     * Both revokes found both rows, and the auth config was dropped with none left. This is the
     * ordering the call list above cannot see: revoking off the rows a delete had already returned
     * would produce that same list while leaving nothing to revoke under if the broker refused.
     */
    expect(connectedWhenAsked).toEqual([
      ["user-a", "user-b"],
      ["user-a", "user-b"],
      [],
    ]);

    expect(
      await store.brokeredConnection({ toolkit: "linear", userId: "user-a" }),
    ).toBeNull();
    expect(
      await store.brokeredConnection({ toolkit: "linear", userId: "user-b" }),
    ).toBeNull();

    const disconnected = auditStore
      .recorded()
      .filter((event) => event.eventType === "mcp.account_disconnected");
    expect(disconnected).toHaveLength(2);
    expect(disconnected.map((event) => event.targetId)).toEqual([
      // The app, not the server row's id, because that is what a brokered connection is keyed on
      // and the id is gone by the time anybody reads back.
      "linear",
      "linear",
    ]);
    expect(disconnected.map((event) => event.payload)).toEqual([
      {
        actor: "admin",
        server: "linear",
        owner: "user-a",
        // Not "they disconnected" and not "they were removed": an administrator took the whole
        // app away and the person did nothing.
        reason: "mcp_server_removed",
        /*
         * True, and true because the broker said so rather than because the call returned. This
         * is the whole change: the row used to say `false` here whatever happened, which was
         * honest only while the removal left every account live at Composio.
         */
        vendorRevocationRequested: true,
      },
      {
        actor: "admin",
        server: "linear",
        owner: "user-b",
        reason: "mcp_server_removed",
        vendorRevocationRequested: true,
      },
    ]);
  } finally {
    await database
      .delete(mcpTools)
      .where(eq(mcpTools.serverId, "composio-linear"));
    await database
      .delete(mcpServers)
      .where(eq(mcpServers.id, "composio-linear"));
    await database
      .delete(composioConnections)
      .where(
        and(
          eq(composioConnections.toolkit, "linear"),
          inArray(composioConnections.userId, ["user-a", "user-b"]),
        ),
      );
  }
});

/**
 * Offboarding somebody ends the accounts they connected, where they actually live.
 *
 * CRITERION. `retireConnectionsFor` on somebody holding two brokered connections revokes both at
 * the broker while their rows are still standing, deletes the rows after that, counts both, and
 * says in the trail of each that the grant was really withdrawn.
 *
 * REASON. A brokered connection holds no secret of ours, so deleting the row shuts the gate this
 * deployment owns and leaves the mailbox attached at Composio. "We removed their access" was then
 * untrue of the only thing that matters — the grant at the vendor — for the person it matters most
 * about, one who has been removed and cannot be asked to disconnect anything themselves.
 *
 * REVOKE BEFORE DELETE, and the order is forced by what the row is. It is the only place naming
 * which apps this person had, and it outlives the `users` row precisely so offboarding can still
 * find them; that was the table's whole justification and until now nothing exercised it. Delete
 * first and a broker that refuses leaves a live grant on a departed person's mailbox with nothing
 * left here to revoke it under. Revoke first and the same refusal leaves the rows standing and
 * offboarding repeatable. Dead-and-reachable beats live-and-unreachable.
 *
 * ASSERTED ON WHAT EACH CALL SAW, not on a count and not on the call list. Both revokes are for
 * one person, so the recorded sequence is identical whichever order the code uses — an
 * implementation revoking off what the delete returned would make the same two calls. Reading the
 * table from inside the stub is the only thing here that can tell the two apart.
 *
 * THE APPS ARE CONNECTED IN REVERSE, `linear` before `gmail`, so the sorted revoke is doing work
 * rather than agreeing with the insertion order by luck.
 */
test("removing a person revokes their brokered accounts at the broker", async () => {
  /** Which apps this person was still connected to at the moment of each revoke, in call order. */
  const connectedWhenAsked: string[][] = [];
  /** Which app each revoke was for, which the spy's own `revoke:user_leaver` entries cannot say. */
  const revoked: string[] = [];
  // Through the file's own handle, which is the one `freshStore` hands back: the rows this test
  // writes are swept by {@link freshDatabase} and the teardown, so nothing here needs a local name
  // for the database.
  const stillConnected = async () =>
    (
      await database
        .select({ toolkit: composioConnections.toolkit })
        .from(composioConnections)
        .where(eq(composioConnections.userId, "user_leaver"))
        .orderBy(asc(composioConnections.toolkit))
    ).map((row) => row.toolkit);

  const { broker, order } = brokerSpy({
    isConnected: async () => true,
    revoke: async ({ toolkit }) => {
      connectedWhenAsked.push(await stillConnected());
      revoked.push(toolkit);
      return true;
    },
  });
  const { store, auditStore } = await freshStore({ broker });

  for (const toolkit of ["linear", "gmail"]) {
    expect(
      await store.confirmBrokeredConnection({ toolkit, userId: "user_leaver" }),
    ).toEqual({ connected: true });
  }

  // The setup's own traffic, cleared so what follows is about the offboarding and nothing else.
  order.length = 0;

  expect(await store.retireConnectionsFor("user_leaver", "admin")).toEqual({
    // Both of them, because the number is what "we removed their access" claims.
    retired: 2,
  });

  expect(order).toEqual(["revoke:user_leaver", "revoke:user_leaver"]);
  expect(revoked).toEqual(["gmail", "linear"]);
  /*
   * Both revokes found both rows. This is the ordering neither list above can see: revoking off
   * the rows a delete had already returned would produce both of them unchanged while leaving
   * nothing to revoke under if the broker refused.
   */
  expect(connectedWhenAsked).toEqual([
    ["gmail", "linear"],
    ["gmail", "linear"],
  ]);

  expect(
    await store.brokeredConnection({ toolkit: "gmail", userId: "user_leaver" }),
  ).toBeNull();
  expect(
    await store.brokeredConnection({
      toolkit: "linear",
      userId: "user_leaver",
    }),
  ).toBeNull();

  const disconnected = auditStore
    .recorded()
    .filter((event) => event.eventType === "mcp.account_disconnected");
  expect(disconnected).toHaveLength(2);
  // The app, which for a brokered connection is all the row records and all that is left once
  // the person is gone.
  expect(disconnected.map((event) => event.targetId)).toEqual([
    "gmail",
    "linear",
  ]);
  expect(disconnected.map((event) => event.payload)).toEqual([
    {
      actor: "admin",
      server: "gmail",
      owner: "user_leaver",
      // An administrator removing somebody, never somebody changing their own mind.
      reason: "person_removed",
      /*
       * True, and true because the broker said so rather than because the call returned. This
       * is the whole change: the row used to say `false` here whatever happened, which was
       * honest only while offboarding left every account live at Composio.
       */
      vendorRevocationRequested: true,
    },
    {
      actor: "admin",
      server: "linear",
      owner: "user_leaver",
      reason: "person_removed",
      vendorRevocationRequested: true,
    },
  ]);
});

/**
 * And where there was no grant left to withdraw, offboarding says so.
 *
 * CRITERION. A broker answering `false` leaves `vendorRevocationRequested: false` in the trail, and
 * the row is deleted and counted just the same.
 *
 * REASON. The account was already ended in Composio's own dashboard, so the local row is the stale
 * half of a pair that has drifted. What must not happen is the trail claiming this deployment
 * withdrew something: whoever reads back for who ended somebody's access is then given the wrong
 * answer in the same words as the right one.
 *
 * THE FALSE IS THE WHOLE TEST. A pass-through is indistinguishable from a hardcoded `true` until a
 * revoke answers no, and nothing else on this path exercises one.
 */
test("offboarding a brokered account nobody held any more withdraws nothing, and says so", async () => {
  const { broker, order } = brokerSpy({ revoke: async () => false });
  const { store, database, auditStore } = await freshStore({ broker });
  const pair = { toolkit: "gmail", userId: "user_leaver" };
  await database.insert(composioConnections).values(pair);

  expect(await store.retireConnectionsFor("user_leaver", "admin")).toEqual({
    retired: 1,
  });

  expect(order).toEqual(["revoke:user_leaver"]);
  // Gone, because there was nothing at the vendor and the row was therefore the half that had
  // drifted. Keeping it would leave the gate passing for a person who no longer exists.
  expect(await store.brokeredConnection(pair)).toBeNull();

  const disconnected = auditStore
    .recorded()
    .filter((event) => event.eventType === "mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0]?.payload).toMatchObject({
    actor: "admin",
    server: "gmail",
    owner: "user_leaver",
    reason: "person_removed",
    vendorRevocationRequested: false,
  });
});

/**
 * The same false, on the other act that ends a brokered connection.
 *
 * CRITERION. `removeServer` on a brokered row whose broker answers `false` records
 * `vendorRevocationRequested: false`, and still clears the row and drops the config.
 *
 * REASON. The removal test above pins the `true`, which a literal `true` in the store would pass
 * just as well — and one did, for the whole of this suite, until this test. A field whose only
 * purpose is to tell a grant this deployment ended from one that outlives it somewhere else is
 * worth nothing if it can only ever say one of the two.
 */
test("removing an app records the grant it did not withdraw as not withdrawn", async () => {
  const { broker, order } = brokerSpy({
    revoke: async () => false,
    deleteAuthConfig: async () => {},
  });
  const { store, database, auditStore } = await freshStore({ broker });
  await seedComposioGmail(database, store);

  await store.removeServer("gmail", "admin");

  expect(order).toEqual(["revoke:user_asker", "deleteAuthConfig"]);
  expect(
    await store.brokeredConnection({ toolkit: "gmail", userId: "user_asker" }),
  ).toBeNull();

  const disconnected = auditStore
    .recorded()
    .filter((event) => event.eventType === "mcp.account_disconnected");
  expect(disconnected).toHaveLength(1);
  expect(disconnected[0]?.payload).toMatchObject({
    actor: "admin",
    server: "gmail",
    owner: "user_asker",
    reason: "mcp_server_removed",
    vendorRevocationRequested: false,
  });
});

/**
 * The vendor's destructive label, carried out of the database to the screens that draw it.
 *
 * CRITERION. A `mcp_tools` row Composio labelled destructive reaches `listServers` as
 * `destructive: true`, and every tool in the list carries the field as a boolean.
 *
 * REASON. The column has been recorded since the brokered transport landed and reached nothing: the
 * store selected the row and then built a tool object without the field, so a delete read out
 * identically to any other write on every screen. The per-Bot grants screen already draws its danger
 * mark from `PluginTool.destructive`, which could only ever be false while the mapping was missing —
 * a mark that cannot turn on is worse than no mark, because it reads as an assurance. The second
 * assertion is the half a `true` alone would not hold: the field must be present on the ordinary read
 * beside it, not only on the row that happens to be dangerous.
 */
test("a destructive action says so in the list the screens read", async () => {
  const { store, database } = await freshStore();
  await seedComposioGmail(database, store);
  await database.insert(mcpTools).values({
    serverId: "gmail",
    name: "GMAIL_DELETE_MESSAGE",
    description: "Delete a message.",
    effect: "write",
    destructive: true,
  });

  const gmail = (await store.listServers()).find(
    (server) => server.id === "gmail",
  );

  const deletes = gmail?.tools.find(
    (tool) => tool.name === "GMAIL_DELETE_MESSAGE",
  );
  expect(deletes?.destructive).toBe(true);
  // Not only on the dangerous row: the reader asks every tool the same question, and an undefined
  // on the read beside it is a screen with nothing to draw rather than a screen drawing "safe".
  expect(gmail?.tools.map((tool) => typeof tool.destructive)).toEqual(
    gmail?.tools.map(() => "boolean"),
  );
});

/**
 * A database fault on the vault read, which is not a withdrawn credential.
 *
 * CRITERION. When the read that fetches a server's token fails on a query of this deployment's own,
 * the call is refused as a fault of ours — it is on the {@link isDeploymentFault} shelf, and it is
 * NOT a {@link PluginRefusedError}. Neither the sentence the caller gets nor the row the trail keeps
 * says a credential was withdrawn.
 *
 * REASON. `secretFor` used to tell a withdrawn credential from a broken query by looking for the
 * words "revoked" and "not found" inside `error.message`. drizzle reports every failure as a
 * `DrizzleQueryError` whose message opens `Failed query: select "encrypted_value", "revoked_at" from
 * "credentials" …` — so the column name matched the substring, and EVERY database fault on that read
 * became the one sentence that is certainly false about it: a Postgres that is down, an address that
 * names no database, a statement the server cancelled, each reported as an administrator having
 * taken the credential away.
 *
 * WHY THAT IS WORSE THAN A WRONG MESSAGE. The confident sentence is a {@link PluginRefusedError},
 * which is the one class this codebase relays VERBATIM. It reaches the model as the reason the tool
 * failed, a browser through the routes that pass a refusal straight out as a 400, and
 * `mcp_servers.last_error` for whoever operates the deployment — and the step it names, add the
 * credential again, is work against a credential that was never the problem while the real fault
 * goes unreported. Told apart by class, all three audiences get "that did not work" instead, which
 * is what a fault of ours is allowed to say.
 *
 * THE FAULT IS A REAL ONE, which is the point of the fixture. The production credential store
 * issues its production statement over an address that resolves to no database, so what arrives at
 * `secretFor` is drizzle's own wrapper around the driver's complaint. A hand-thrown `Error` would
 * prove nothing here: the message is exactly what the bug was reading, so the message has to come
 * from the same place production's does.
 */
describe("a vault read that fails on a query of this deployment's own", () => {
  const faultServerId = `vault-fault-${suite}`;
  const faultToolName = "do_something";
  const faultRef = `${faultServerId}/${faultToolName}`;
  const faultBotId = `agent_vault_fault_${suite}`;
  const faultActorId = "someone@openbot.local";
  /** The sentence a withdrawn credential earns, and the one a query fault must never be given. */
  const WITHDRAWN = "An administrator has to add it again.";

  let faultCredentialId: string | null = null;

  /**
   * The suite's own address, pointed at a database that is not there.
   *
   * Derived rather than written out, so the fixture fails the way the deployment would on whatever
   * Postgres this run was given — including a scratch one — instead of only against localhost.
   */
  function unreachableVault() {
    const address = new URL(testDatabaseUrl());
    address.pathname = `/absent_vault_${suite}`;
    return address.toString();
  }

  /**
   * The vault on that address: `createCredentialStore`, unwrapped.
   *
   * Every other seam is the real one, because the fault under test is meant to arrive from the real
   * read. Its own policy rather than the file's mutable `policy`, so a describe that ran earlier and
   * left it somewhere else cannot decide whether this call gets as far as the vault.
   */
  const faultStore = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(
      createDatabase(unreachableVault(), TEST_POOL),
    ),
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    // Loud rather than silent: the token is read before the vendor is dialled, so a call that gets
    // this far means the vault read did not fail at all and the test is asserting nothing.
    callVendor: async () => {
      throw new Error(
        "the vendor must not be reached when the vault read fails",
      );
    },
  });

  beforeAll(async () => {
    await database
      .insert(agents)
      .values({
        id: faultBotId,
        name: faultBotId,
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();

    // A real vault row, on the real database. What breaks is the READ, not the pointer: the server
    // is configured exactly as a working one is, which is what makes the fault a fault rather than
    // a missing credential wearing one's clothes.
    const [credential] = await database
      .insert(credentialRows)
      .values({
        kind: "mcp",
        provider: faultServerId,
        keyId: `mcp-${faultServerId}`,
        /*
         * A placeholder rather than a real envelope: the read is what fails, so nothing here is
         * ever decrypted, and an encrypted value would assert a step this test never reaches.
         */
        encryptedValue: "{}",
        metadata: {},
      })
      .returning({ id: credentialRows.id });
    if (!credential) throw new Error("the fixture credential was not stored");
    faultCredentialId = credential.id;

    /*
     * Custom provenance and a suite-scoped id, so `accessFor` resolves it to the deployment-token
     * path — which is the branch of `connectionTokenFor` that reads the vault for a server's own
     * token, and the one whose refusal names an administrator.
     */
    await database.insert(mcpServers).values({
      id: faultServerId,
      title: "a server whose vault is unreachable",
      vendor: "test",
      url: "https://example.invalid/mcp",
      credentialId: credential.id,
      provenance: "custom",
    });
    await database.insert(mcpTools).values({
      serverId: faultServerId,
      name: faultToolName,
      description: "Do something.",
    });
    await faultStore.grant("mcp", faultRef, faultBotId, "admin@openbot.local");
  });

  afterAll(async () => {
    await database
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.ref, faultRef),
          eq(pluginGrants.agentId, faultBotId),
        ),
      );
    // The tools go with the server row, which cascades; both ids carry this run's suffix, so
    // neither can be a row the deployment configured.
    await database.delete(mcpServers).where(eq(mcpServers.id, faultServerId));
    await database.delete(agents).where(eq(agents.id, faultBotId));
    if (faultCredentialId) {
      await database
        .delete(credentialRows)
        .where(eq(credentialRows.id, faultCredentialId));
    }
  });

  test("is refused as this deployment's own fault, never as a withdrawn credential", async () => {
    const thrown = await faultStore
      .callTool({
        ref: faultRef,
        args: {},
        botId: faultBotId,
        actorId: faultActorId,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    /*
     * The class is the assertion, not the wording. `PluginRefusedError` is what the relays key on:
     * `grantedTools` hands its message to the model, and four routes hand it to a browser as a 400.
     */
    expect(thrown).not.toBeInstanceOf(PluginRefusedError);
    expect(isDeploymentFault(thrown)).toBe(true);
    expect(
      thrown instanceof Error ? thrown.message : String(thrown),
    ).not.toContain(WITHDRAWN);
  });

  test("does not write a withdrawn credential into the trail a failed call leaves", async () => {
    await faultStore
      .callTool({
        ref: faultRef,
        args: {},
        botId: faultBotId,
        actorId: faultActorId,
      })
      .catch(() => {});

    const failures = (
      await auditRowsFor(faultRef, faultBotId, faultActorId)
    ).filter((row) => row.eventType === "mcp.call_failed");
    expect(failures.length).toBeGreaterThan(0);
    const written = JSON.stringify(failures);
    // The false accusation, which is what an operator would act on.
    expect(written).not.toContain(WITHDRAWN);
    expect(written).not.toContain("no longer holds");
    /*
     * And the true half is still recorded, without the statement or anything bound to it — the
     * driver's own complaint is what `withoutStatement` keeps, and a credential id is what it drops.
     */
    expect(written).toContain(`absent_vault_${suite}`);
    expect(written).not.toContain("Failed query:");
    expect(written).not.toContain(faultCredentialId ?? "<none>");
  });
});
