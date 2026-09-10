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
import { MCPMock, type MCPToolDefinition } from "@copilotkit/aimock/mcp";
import { and, asc, eq, gte, inArray, like, or, sql } from "drizzle-orm";
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
  type OAuthClient,
  PluginInvariantError,
  PluginRefusedError,
  type PluginStore,
  TokenRefusedError,
  unlistedAdvertisedTools,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * The two questions a tool call has to pass, and the row each answer leaves behind.
 *
 * The refusals are the property under test. A call that succeeds proves the plumbing works; a call
 * that is refused proves the governance does. Both refusals here stop before any network call, which
 * is itself the property being asserted: a tool a Bot was never given must not reach the vault or
 * the vendor, so there is nothing to stub.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

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

async function auditRowsFor(targetId: string) {
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

  const [configuredServers, existingBots, existingConnections, existingPeople] =
    await Promise.all([
      database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(inArray(mcpServers.id, ["gmail", "notion"])),
      database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, "bot_helper")),
      /*
       * The anonymous actor is one of these ids too, but only at the app this file writes it
       * against.
       *
       * CRITERION. This guard refuses on the PAIR `("gmail", "")` and on no other row at the
       * anonymous actor, because that pair is the only one this file inserts and the only one it
       * deletes.
       *
       * REASON. `composio_connections.user_id` is notNull and notNull does not exclude the empty
       * string, so `("gmail", "")` is a row a deployment can legally hold — which is the whole
       * point of the test that inserts one. Asked as `user_id = ''` alone, this also caught the
       * anonymous row `composio-connections.test.ts` writes against its OWN run-suffixed app: a
       * run of that file killed between its insert and its cleanup left a row nobody here owns,
       * and every one of this file's tests then refused for good over it. Keyed on the pair, a
       * stranded row belonging to another file is simply not this one's business.
       */
      database
        .select({
          toolkit: composioConnections.toolkit,
          userId: composioConnections.userId,
        })
        .from(composioConnections)
        .where(
          or(
            inArray(composioConnections.userId, ["user_asker", "user_leaver"]),
            and(
              eq(composioConnections.toolkit, "gmail"),
              eq(composioConnections.userId, ""),
            ),
          ),
        ),
      /*
       * The person, who was missing from this guard entirely.
       *
       * `user_leaver` is inserted at and deleted at by the Composio fixtures, and the delete used to
       * run whatever the guard had decided — so a real row at that id was removed, with the ten
       * cascades above behind it, on a run the guard had already refused.
       */
      database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, "user_leaver")),
    ]);

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
        "ten behind them. Point DATABASE_URL at a scratch database.",
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
    await expect(
      store.callTool({
        ref,
        args: {},
        botId: strangerId,
        actorId: "someone@openbot.local",
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const rows = await auditRowsFor(ref);
    const rejected = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { bot?: string }).bot === strangerId,
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect((rejected[0].payload as { refusal?: string }).refusal).toBe(
      "not_granted",
    );
  });

  test("a refusal names the routine that asked, not only the person it ran as", async () => {
    await expect(
      store.callTool({
        ref,
        args: {},
        botId: strangerId,
        actorId: "someone@openbot.local",
        initiator: { kind: "routine", id: "routine_standup" },
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const rows = await auditRowsFor(ref);
    const rejected = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { bot?: string }).bot === strangerId &&
        row.initiatorKind === "routine",
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0].initiatorId).toBe("routine_standup");
  });

  test("a call nobody said anything about is still filed as a person's", async () => {
    await expect(
      store.callTool({
        ref,
        args: {},
        botId: strangerId,
        actorId: "someone@openbot.local",
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const rows = await auditRowsFor(ref);
    expect(
      rows.some(
        (row) =>
          row.eventType === "mcp.call_rejected" &&
          row.initiatorKind === "person" &&
          row.initiatorId === null,
      ),
    ).toBe(true);
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
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    const secret = `sk-${"z".repeat(32)}`;

    await expect(
      store.callTool({
        ref,
        args: { query: "quarterly report", nested: { apiKey: secret } },
        botId: holderId,
        actorId: "someone@openbot.local",
      }),
    ).rejects.toThrow("credential material");

    const rows = await auditRowsFor(ref);
    const rejected = rows.find(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { refusal?: string }).refusal ===
          "sensitive_tool_arguments",
    );
    expect(rejected).toBeDefined();
    expect(rejected?.payload).toMatchObject({
      bot: holderId,
      contentInspection: {
        reason: "sensitive_content",
        findings: [{ category: "credential_field", path: "$.nested.apiKey" }],
      },
    });
    expect(JSON.stringify(rejected)).not.toContain(secret);
  });

  test("a granted tool is still refused by a deny rule, and the rule is named", async () => {
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
        actorId: "someone@openbot.local",
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

    const rows = await auditRowsFor(ref);
    const refusedByPolicy = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { decision?: { rule?: string } }).decision?.rule ===
          'mcp.server == "google-drive"',
    );
    expect(refusedByPolicy.length).toBeGreaterThan(0);
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
          actorId: "someone@openbot.local",
        })
        // Forwarded past the policy, so what happens next is the vendor's business and not this
        // test's: nobody has connected an account, so it fails there. Swallowed deliberately.
        .catch(() => undefined);
    } finally {
      policy = { mode: "enforce", deny: [], allow: ["true"] };
    }

    const rows = await auditRowsFor(ref);
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
    const actorId = `trail_${suite}`;

    await expect(
      store.callTool({ ref, args: {}, botId: holderId, actorId }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const mine = (await auditRowsFor(ref)).filter(
      (row) => (row.payload as { actor?: string }).actor === actorId,
    );

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

  test("does not call revoke when the server had no credential", async () => {
    const removalServerId = `removal-target-nocred-${suite}`;
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
    /*
     * This run's refusal, not whichever of nine hundred the planner happened to hand back first.
     *
     * Unbounded, `limit(1)` was answered by the oldest row in the table — a refusal from a run
     * whose Bot id no longer names anything — so the payload shape being asserted was a shape this
     * branch's code had never written. Ordered as well as bounded, because `limit` without an order
     * is a row the query plan picks.
     */
    const [row] = await database
      .select({
        bot: sql<string>`payload ->> 'bot'`,
        server: sql<string>`payload ->> 'server'`,
        tool: sql<string>`payload ->> 'tool'`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "mcp_tool"),
          eq(auditEvents.eventType, "mcp.call_rejected"),
          eq(auditEvents.targetId, ref),
          sinceThisRun(),
        ),
      )
      .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
      .limit(1);

    // Asserted in SQL rather than through the application, because the stored payload shape is the
    // property under test.
    expect(row?.server).toBe(serverId);
    expect(row?.tool).toBe(toolName);
    expect(row?.bot).toBeTruthy();
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

        const failures = (await auditRowsFor(rotationRef)).filter(
          (row) => row.eventType === "mcp.call_failed",
        );
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
  tools: MCPToolDefinition[],
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

  /** Every vault row this suite created, so the cleanup can take exactly those. */
  const vaultRows: string[] = [];
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

  /*
   * The real vault, with every row it mints written down.
   *
   * Genuine rather than stubbed, because what this suite asserts is that a re-registered client is
   * KEPT — which is a write and a read back through the encryption, not a call that was made. The
   * wrappers are the bookkeeping that lets the cleanup take exactly this suite's rows.
   *
   * BOTH ways a row is minted, not just the first. `create` is the vault's answer when the key holds
   * no live row; `rotate` is its answer when one does, and `recordConnection` and `storeOAuthClient`
   * each pick between them on exactly that. So every reconnect after the first and every
   * re-registration after the first went through `rotate` — which the spread handed straight to the
   * real vault, unrecorded. This suite reconnects and re-registers repeatedly, and each run left
   * thirteen `notion` credential rows nothing would ever remove, the last of them LIVE: an
   * `mcp_user_token` for a person, unrevoked and referenced by nothing.
   */
  const realVault = createCredentialStore(database);
  const vault = {
    ...realVault,
    /*
     * The executor is FORWARDED, and dropping it is not a detail.
     *
     * The store hands its own transaction to the vault so that a secret and the pointer that names it
     * commit together. A wrapper that swallows it has the insert run on a second pooled connection
     * instead — which, with the caller holding the first and a sibling holding the second, is not a
     * slower write but a deadlock: the insert waits for a connection only a transaction that is
     * waiting for the insert can release.
     */
    create: async (
      value: Parameters<typeof realVault.create>[0],
      executor?: Parameters<typeof realVault.create>[1],
    ) => {
      const row = await realVault.create(value, executor);
      vaultRows.push(row.id);
      return row;
    },
    /** The same forwarding, for the same reason: `rotate` runs inside the caller's transaction too. */
    rotate: async (
      value: Parameters<typeof realVault.rotate>[0],
      executor?: Parameters<typeof realVault.rotate>[1],
    ) => {
      const row = await realVault.rotate(value, executor);
      vaultRows.push(row.id);
      return row;
    },
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
        metadata: { clientId: client.clientId },
        encryptedValue: await encryptSecret(
          DYNAMIC_KEY,
          JSON.stringify(client),
        ),
        createdAt: registeredAt,
      })
      .returning({ id: credentials.id });
    if (!row) throw new Error("client was not stored");
    vaultRows.push(row.id);
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
  /**
   * This deployment's own client, restored afterwards: the column is live configuration.
   *
   * `undefined` until the capture runs, so a `beforeAll` that dies before it leaves a teardown that
   * knows it has nothing to put back rather than one that writes null over somebody's client.
   */
  let clientBefore: string | null | undefined;

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
      .select({ id: mcpServers.id, credentialId: mcpServers.credentialId })
      .from(mcpServers)
      .where(eq(mcpServers.id, dynamicServerId));
    suiteCreatedNotionRow = existing === undefined;
    clientBefore = existing?.credentialId ?? null;

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
    // Before the deletes, because the column addresses one of the rows they remove. Skipped
    // entirely when no capture ran, for the reason on {@link clientBefore}.
    if (clientBefore !== undefined) {
      await database
        .update(mcpServers)
        .set({ credentialId: clientBefore })
        .where(eq(mcpServers.id, dynamicServerId));
    }
    for (const id of vaultRows) {
      await database.delete(credentials).where(eq(credentials.id, id));
    }
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
   * The three columns the refresh now writes are Composio's, and every other transport has to keep
   * coming out of that insert as null and false. `classifyTool` consults the reviewed `writeTools`
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
      vaultRows.push(row.id);
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
  const madeServerIds: string[] = [];

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
    // By prefix, not by the ids this suite meant to make: before the fix the refused adds succeed,
    // and a row left behind holds a foreign key onto the credentials deleted just below.
    await database
      .delete(mcpServers)
      .where(like(mcpServers.id, `${customServerId}%`));
    // Every id the `beforeAll` above minted, which is the list this one has to match. The upsert's
    // own token was missing from it, so each run left one live `mcp` credential behind for a server
    // that no longer exists — a secret in the vault reachable from nothing.
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
      store.addCustomServer({
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
      store.addCustomServer({
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
    const missing = store.addCustomServer({
      id,
      title: "Collector",
      url: "https://collector.example/mcp",
      credentialId: randomUUID(),
      by: "admin@example.com",
    });
    await expect(missing).rejects.toBeInstanceOf(CustomServerRefusedError);

    const wrongKind = store
      .addCustomServer({
        id: `${customServerId}-kind-message`,
        title: "Collector",
        url: "https://collector.example/mcp",
        credentialId: personalCredentialId,
        by: "admin@example.com",
      })
      .catch((error: Error) => error.message);
    const missingMessage = await missing.catch((error: Error) => error.message);
    expect(await wrongKind).toBe(missingMessage);
  });

  test("the server's own token still works", async () => {
    // The case that must keep passing, so the refusal above is a rule and not a wall. The URL is
    // unreachable and that is fine: a failed refresh is recorded on the row rather than thrown.
    madeServerIds.push(customServerId);
    const added = await store.addCustomServer({
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
        store.addCustomServer({
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
    madeServerIds.push(id);
    const added = await store.addCustomServer({
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
    madeServerIds.push(id);
    await store.addCustomServer({
      id,
      title: "Collector",
      url: "https://collector.example/mcp",
      credentialId: upsertCredentialId,
      by: "admin@example.com",
    });

    await expect(
      store.addCustomServer({
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
    madeServerIds.push(id);
    const added = await store.addCustomServer({
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
  // By person, never by toolkit: the table has no foreign key to `users` — which is the property the
  // first test below is about, so nothing else removes these rows — and a delete by toolkit alone
  // would take every person's Gmail connection, leaving one orphaned at the broker with no local row
  // left to find it by. Only the two people this file invents.
  await database.delete(composioConnections).where(
    or(
      inArray(composioConnections.userId, ["user_asker", "user_leaver"]),
      /*
       * And the one pair at the anonymous actor this file writes, which no person id names.
       *
       * CRITERION. Exactly `("gmail", "")`, never `user_id = ''` across every app: the second
       * spelling reaches the anonymous row another file owns at its own run-suffixed app.
       *
       * REASON. The test that inserts this pair takes it back in a `finally`, which covers a
       * failed assertion and not a killed process — and the row it would otherwise leave is
       * precisely what the guard at the top of this file refuses on. Swept here, a pair stranded
       * earlier in this same run is gone before the next test looks at it; a pair that was
       * already there when the run started is still the guard's to refuse, because at that point
       * nothing has established it is ours.
       */
      and(
        eq(composioConnections.toolkit, "gmail"),
        eq(composioConnections.userId, ""),
      ),
    ),
  );
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
 */
async function freshStore() {
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
 */
async function seedComposioGmail(
  database: Database,
  store: PluginStore,
  options: { connect?: boolean; version?: string | null; url?: string } = {},
) {
  await database.insert(mcpServers).values({
    id: "gmail",
    title: "Gmail",
    vendor: "Composio",
    url: options.url ?? "composio://gmail",
    provenance: "composio",
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
  await database
    .delete(composioConnections)
    .where(inArray(composioConnections.userId, ["user_asker", "user_leaver"]));
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

  const rows = await database
    .select({ toolkit: composioConnections.toolkit })
    .from(composioConnections)
    .where(eq(composioConnections.userId, "user_leaver"));

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
    execute: async (slug) => {
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
    execute: async (slug) => {
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
    execute: async (slug) => {
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
    execute: async (slug) => {
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
    execute: async (slug) => {
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
    execute: async (slug) => {
      reached.push(slug);
      return vendorAnswered();
    },
  });
  // The row is called `gmail` and the person has connected `gmail`; the url dials Slack, which is
  // the app the call would actually run in.
  await seedComposioGmail(database, store, { url: "composio://slack" });

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

test("a Composio call sends the version recorded for that action", async () => {
  const { store, database } = await freshStore();
  const calls: { slug: string; version: string }[] = [];
  useComposioClient({
    listActions: async () => [],
    execute: async (slug, _userId, version) => {
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
    execute: async (slug, _userId, version) => {
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
    execute: async (slug, _userId, version) => {
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
    execute: async (slug, userId) => {
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
    execute: async (_slug, userId, _version, args) => {
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
 * A refresh that listed nothing, on the path every real deployment takes.
 *
 * NOTHING IN THE SHIPPED PRODUCT CALLS `useComposioClient`, so `installed` is null on every live
 * install and the Composio transport answers `[]` — not a throw — for want of a client to ask with.
 * The tests below install no stub, which is that state exactly rather than a fiction about it.
 *
 * A wholesale replace on that answer deletes what the last real listing recorded, and `version` is
 * the column that cannot be reconstructed: `callTool` refuses without it, so an app whose actions
 * were dropped this way stops working for everybody until somebody presses Refresh on a deployment
 * that can actually reach the vendor. The grants survive the delete pointing at rows that no longer
 * exist, which is invisible on the Plugins page and revived by the next refresh that works.
 */
describe("a refresh whose transport could not ask anybody", () => {
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

    // Not cleared. An empty answer from a transport that reached no vendor is not evidence that
    // whatever was wrong before has been put right.
    expect(row?.lastError).not.toBeNull();
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
