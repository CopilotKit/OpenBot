import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { createPluginStore, PluginRefusedError } from "../src/plugins/store";

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
const serverId = `atlassian`;
const toolName = "searchJiraIssues";
const ref = `${serverId}/${toolName}`;

let policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/**
 * Whether this deployment already had the server before the test ran.
 *
 * The id is a real catalogue key rather than a suite-scoped one, because what is under test includes
 * the vendor's own read/write classification. On a database somebody is using, that key is their
 * configured server, so it is removed only when the test is what created it.
 */
let serverWasAlreadyConfigured = false;

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

  // The server row is written directly rather than through addServer, so the test needs no vendor
  // to be reachable. What is under test is the decision, not the listing.
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Atlassian",
      vendor: "Atlassian",
      url: "https://mcp.atlassian.com/v1/mcp/authv2",
      provenance: "first-party",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({ serverId, name: toolName, description: "Search issues." })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
  // A server row is deployment configuration, so it belongs to the deployment rather than here.
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
    expect(held.tools[0].toolName).toBe("mcp__atlassian__searchJiraIssues");

    const nothing = await store.listForAgent(strangerId);
    expect(nothing.tools).toEqual([]);
    expect(nothing.skills).toEqual([]);
  });
});

describe("the policy is asked as well as the grant", () => {
  test("a granted tool is still refused by a deny rule, and the rule is named", async () => {
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    policy = {
      mode: "enforce",
      deny: ['mcp.server == "atlassian"'],
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
      'mcp.server == "atlassian"',
    );

    const rows = await auditRowsFor(ref);
    const refusedByPolicy = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { decision?: { rule?: string } }).decision?.rule ===
          'mcp.server == "atlassian"',
    );
    expect(refusedByPolicy.length).toBeGreaterThan(0);
  });

  test("a rule can speak about effect rather than about tool names", async () => {
    await store.grant("mcp", ref, holderId, "admin@openbot.local");
    // `searchJiraIssues` is advertised and is not in the vendor's write list, so it is a read and
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

    expect(thrown).not.toBeInstanceOf(PluginRefusedError);
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

    // Not a refusal. It gets as far as the network, which is where this test stops caring.
    expect(thrown).not.toBeInstanceOf(PluginRefusedError);
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
