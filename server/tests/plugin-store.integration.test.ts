import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { encryptSecret } from "../src/credentials";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import {
  agents,
  auditEvents,
  credentials,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import {
  createPluginStore,
  CustomServerRefusedError,
  PluginRefusedError,
} from "../src/plugins/store";

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
 * Whether this deployment already had the server before the test ran.
 *
 * The id is a real catalogue key rather than a suite-scoped one, because what is under test includes
 * the vendor's own read/write classification. On a database somebody is using, that key is their
 * configured server, so it is removed only when the test is what created it.
 */
let serverWasAlreadyConfigured = false;
/**
 * Whether this deployment already advertised the tool this suite inserts.
 *
 * The vendor really does advertise `search_files`, so the row may be a refreshed fact about the
 * vendor rather than the suite's fixture. Deleting by name regardless would take a real one; leaving
 * it always would leave a fixture that reads on screen as a tool the vendor offers.
 */
let toolWasAlreadyAdvertised = false;

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    // No credential is ever read in these tests, because every call is refused before the vault.
    readSecret: async () => null,
    // Nor written. Loud rather than absent: a call reaching either of these would mean this file had
    // started exercising something it does not claim to, and a silent no-op would hide that.
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => {
      throw new Error("this suite does not revoke credentials");
    },
  },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

async function auditRowsFor(targetId: string) {
  return database
    .select({
      eventType: auditEvents.eventType,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "mcp_tool"),
        eq(auditEvents.targetId, targetId),
      ),
    );
}

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

  serverWasAlreadyConfigured =
    (
      await database
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(eq(mcpServers.id, serverId))
    ).length > 0;

  toolWasAlreadyAdvertised =
    (
      await database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(
          and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)),
        )
    ).length > 0;

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
  if (!toolWasAlreadyAdvertised) {
    await database
      .delete(mcpTools)
      .where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, toolName)));
  }
  if (!serverWasAlreadyConfigured) {
    await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
    await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  }
  await database.delete(agents).where(eq(agents.id, holderId));
  await database.delete(agents).where(eq(agents.id, strangerId));
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

describe("the trail can be read by a second reader", () => {
  test("a refusal names the bot, the server and the tool in queryable JSON", async () => {
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
        ),
      )
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
  const customServerId = `custom-cred-${suffix}`;
  const madeServerIds: string[] = [];

  beforeAll(async () => {
    const encrypted = await encryptSecret(
      `${"A".repeat(43)}=`,
      "not-read-here",
    );
    await database.insert(credentials).values([
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
    await database
      .delete(credentials)
      .where(
        inArray(credentials.id, [
          deploymentCredentialId,
          personalCredentialId,
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
      credentialId: deploymentCredentialId,
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
    expect(row?.credentialId).toBe(deploymentCredentialId);
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
