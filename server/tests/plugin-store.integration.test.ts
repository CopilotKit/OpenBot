import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import {
  createCredentialStore,
  type CredentialStoreValue,
  decryptSecret,
  encryptSecret,
} from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import {
  agents,
  auditEvents,
  credentials,
  credentials as credentialRows,
  mcpServers,
  mcpTools,
  mcpUserCredentials,
  pluginGrants,
  users,
} from "../src/db/schema";
import { catalogueEntry } from "../src/plugins/catalogue";
import { redirectUriFor } from "../src/plugins/oauth";
import {
  type AccessToken,
  createPluginStore,
  CustomServerRefusedError,
  INVALID_CLIENT,
  type OAuthClient,
  PluginRefusedError,
  TokenRefusedError,
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

const revokedCredentialIds: string[] = [];
const issuedCredentialIds: string[] = [];
const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
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

  let notionWasAlreadyConfigured = false;
  /**
   * The OAuth client this deployment had before the suite ran, restored afterwards.
   *
   * `mcp_servers.credential_id` is live configuration, and this suite repoints it. Restored
   * unconditionally, because the delete below removes the row it would otherwise still address.
   */
  let clientBefore: string | null = null;

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
    notionWasAlreadyConfigured = existing !== undefined;
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
    // Before the deletes, because the column addresses one of the rows they remove.
    await database
      .update(mcpServers)
      .set({ credentialId: clientBefore })
      .where(eq(mcpServers.id, rotationServerId));
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
    if (!notionWasAlreadyConfigured) {
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
});

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
  /** Which client each exchange was offered, in order. That ordering IS the retry. */
  const offered: string[] = [];
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
   * one wrapper is the bookkeeping that lets the cleanup take exactly this suite's rows.
   */
  const realVault = createCredentialStore(database);
  const vault = {
    ...realVault,
    create: async (value: Parameters<typeof realVault.create>[0]) => {
      const row = await realVault.create(value);
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
      if (!accepted.has(client.clientId)) {
        throw refuse();
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

  /** Point the server at a client, the way a registration does, without going through one. */
  async function putClient(client: OAuthClient) {
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
        ),
      );
  }

  /** A connection holding `rt-1`, written through the store so the vault is exercised. */
  async function connect() {
    await dynamicStore.recordConnection({
      serverId: dynamicServerId,
      userId: dynamicUserId,
      refreshToken: "rt-1",
      scope: SCOPE,
    });
    offered.length = 0;
    registrations.length = 0;
  }

  let notionWasAlreadyConfigured = false;
  /** This deployment's own client, restored afterwards: the column is live configuration. */
  let clientBefore: string | null = null;

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
    notionWasAlreadyConfigured = existing !== undefined;
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
    // Before the deletes, because the column addresses one of the rows they remove.
    await database
      .update(mcpServers)
      .set({ credentialId: clientBefore })
      .where(eq(mcpServers.id, dynamicServerId));
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
    if (!notionWasAlreadyConfigured) {
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

  test("the deployment registers again, once, and the call goes through", async () => {
    await putClient(EVICTED);
    await connect();
    const registeredBefore = await registeredRows();
    accepted = new Set([FRESH.clientId]);
    issue = () => FRESH;

    const result = await dynamicStore.callTool({
      ref: dynamicRef,
      args: {},
      botId: dynamicBotId,
      actorId: dynamicUserId,
    });

    // The call the person asked for happened, on the client the vendor had never heard of until now.
    expect(result.isError).toBe(false);
    expect(offered).toEqual([EVICTED.clientId, FRESH.clientId]);

    // Registered exactly once, with the pinned endpoint and the deployment's own redirect URI —
    // never a URL from the request, which is the property `redirectUriFor` exists for.
    expect(registrations).toEqual([
      { registrationUrl: REGISTRATION_URL, redirectUri: REDIRECT_URI },
    ]);

    // And kept, so the next call starts from the client that works rather than repeating this.
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

  test("a second refusal in a row is surfaced rather than registered around", async () => {
    await putClient(EVICTED);
    await connect();
    // The vendor honours nothing, which is what an outage looks like from here.
    accepted = new Set<string>();
    issue = () => ({ clientId: "dyn-3", clientSecret: "" });

    await expect(
      dynamicStore.callTool({
        ref: dynamicRef,
        args: {},
        botId: dynamicBotId,
        actorId: dynamicUserId,
      }),
    ).rejects.toThrow("invalid_client");

    // One registration and two exchanges: the retry is bounded, so a vendor refusing everything
    // costs one new client rather than one per call forever.
    expect(registrations.length).toBe(1);
    expect(offered).toEqual([EVICTED.clientId, "dyn-3"]);
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

    const result = await dynamicStore.callTool({
      ref: dynamicRef,
      args: {},
      botId: dynamicBotId,
      actorId: dynamicUserId,
    });

    expect(result.isError).toBe(false);
    expect(offered).toEqual([EVICTED.clientId, FRESH.clientId]);
    expect(registrations.length).toBe(1);
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

    await expect(
      dynamicStore.callTool({
        ref: dynamicRef,
        args: {},
        botId: dynamicBotId,
        actorId: dynamicUserId,
      }),
    ).rejects.toThrow("invalid_grant");

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
   * a connection the deployment already fixed.
   */
  test("two calls queued on one connection register once between them", async () => {
    await putClient(EVICTED);
    await connect();
    accepted = new Set([FRESH.clientId]);
    issue = () => FRESH;

    const call = () =>
      dynamicStore.callTool({
        ref: dynamicRef,
        args: {},
        botId: dynamicBotId,
        actorId: dynamicUserId,
      });
    const results = await Promise.all([call(), call()]);

    expect(results.map((result) => result.isError)).toEqual([false, false]);
    // The evicted client was offered once, by whichever call got there first.
    expect(offered).toEqual([EVICTED.clientId, FRESH.clientId, FRESH.clientId]);
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
      .delete(credentialRows)
      .where(
        inArray(credentialRows.id, [
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
