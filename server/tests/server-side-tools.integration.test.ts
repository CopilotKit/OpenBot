import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MCPMock } from "@copilotkit/aimock/mcp";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { grantedTools, REFUSAL_MARKER } from "../src/plugins/tools";
import type { ActionPolicy } from "../src/policy/engine";
import { TEST_POOL } from "./support/database";

/**
 * A tool call that happens with no browser involved.
 *
 * The loop used to run in the surface, so every one of these paths needed somebody watching. What is
 * asserted here is that the same call runs from the server and arrives at a real MCP server, and
 * that moving it did not take the grant, the policy or the audit row with it.
 *
 * The server on the other end is `@copilotkit/aimock`, ours, speaking real MCP over HTTP rather than
 * a stubbed fetch. A stub would pass whether or not we had understood the protocol; this fails if
 * the wire format moves underneath us, which is the whole promise of pointing a Bot at somebody
 * else's server.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openkai:openkai@localhost:5432/openkai",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const holderId = `agent_tools_holder_${suite}`;
const strangerId = `agent_tools_stranger_${suite}`;
const serverId = `notes_${suite}`;
const toolName = "search_notes";
const ref = `${serverId}/${toolName}`;

let policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

const mock = new MCPMock();
/** What the server on the other end was actually asked, recorded where the assertion can see it. */
const received: unknown[] = [];

beforeAll(async () => {
  // Both Bots must exist: a grant is a row against a real agent, which is what keeps a grant from
  // outliving the Bot it was given to.
  for (const id of [holderId, strangerId]) {
    await database
      .insert(agents)
      .values({ id, name: id, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
  }

  mock.addTool({
    name: toolName,
    description: "Search the notes.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  });
  mock.onToolCall(toolName, (args) => {
    received.push(args);
    const query = (args as { query?: string })?.query ?? "";
    return `Found one note about ${query}.`;
  });
  const url = await mock.start();

  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Notes",
      vendor: "notes",
      url,
      provenance: "custom",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: toolName,
      description: "Search the notes.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database
    .delete(pluginGrants)
    .where(and(eq(pluginGrants.kind, "skill"), eq(pluginGrants.ref, ref)));
  await database.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agents).where(eq(agents.id, holderId));
  await database.delete(agents).where(eq(agents.id, strangerId));
  await mock.stop();
});

describe("the tools a Bot is handed on the server", () => {
  test("a Bot with no grant is offered nothing", async () => {
    const tools = await grantedTools({
      store,
      botId: strangerId,
      actorId: "someone@openkai.local",
    });
    expect(tools).toHaveLength(0);
  });

  test("a granted tool is offered with the vendor's own schema", async () => {
    await store.grant("mcp", ref, holderId, "admin@openkai.local");

    const tools = await grantedTools({
      store,
      botId: holderId,
      actorId: "someone@openkai.local",
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toBe("Search the notes.");
    // The vendor's schema reached the model rather than being flattened to "any object": a tool
    // offered without its arguments is a tool the model calls wrongly every time.
    const parsed = tools[0]?.parameters.safeParse({ query: "invoices" });
    expect(parsed?.success).toBe(true);
    expect(tools[0]?.parameters.safeParse({}).success).toBe(false);
  });

  test("executing it reaches the real MCP server, with no browser anywhere", async () => {
    const tools = await grantedTools({
      store,
      botId: holderId,
      actorId: "someone@openkai.local",
    });

    const text = await tools[0]?.execute({ query: "invoices" });

    expect(text).toContain("Found one note about invoices");
    // The server on the other end was really called, with the arguments the model chose, rather
    // than us asserting against our own hopes.
    expect(received).toContainEqual({ query: "invoices" });
  });

  test("the call is still audited, and still names the Bot", async () => {
    const rows = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, ref));

    const succeeded = rows.filter(
      (row) => row.eventType === "mcp.call_succeeded",
    );
    expect(succeeded.length).toBeGreaterThan(0);
    expect((succeeded[0]?.payload as { bot?: string } | null)?.bot).toBe(
      holderId,
    );
  });

  test("a policy that forbids it refuses, and says so as the tool's answer", async () => {
    policy = {
      mode: "enforce",
      deny: [`mcp.server == "${serverId}"`],
      allow: ["true"],
    };
    try {
      const tools = await grantedTools({
        store,
        botId: holderId,
        actorId: "someone@openkai.local",
      });
      const text = await tools[0]?.execute({ query: "invoices" });

      // Returned, not thrown: the run continues and the person is told what was blocked.
      expect(text).toContain("policy");
      // And marked, so the transcript can draw it as a refusal rather than as a result. The wording
      // is an administrator's to change; the marker is not, which is the whole reason it exists.
      expect(text?.startsWith(REFUSAL_MARKER)).toBe(true);
      const rejected = await database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.eventType, "mcp.call_rejected"));
      expect(rejected.length).toBeGreaterThan(0);
    } finally {
      policy = { mode: "enforce", deny: [], allow: ["true"] };
    }
  });
});
