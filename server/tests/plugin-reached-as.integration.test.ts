import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  pluginGrants,
} from "../src/db/schema";
import { catalogueEntry } from "../src/plugins/catalogue";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * Whose access a call ran on, as the audit trail records it, for the two connectors with no vendor.
 *
 * The catalogue says which each builtin is (`reachedAs` on the entry) and that is asserted where it
 * is written. This file asserts the half that actually matters: that the value reaches the ROW. The
 * question an investigation asks of a per-person connector is "who did this run reach as", and the
 * two builtins answer it differently for a real reason. A routine touches the asking person's own
 * rows, so the row names them. The mailbox is one mailbox belonging to the deployment, opened on a
 * password the deployment holds, so a row naming the asker would attribute access to somebody who
 * never had it.
 *
 * Nothing is dialled: the vendor is injected, so neither builtin transport runs and no mailbox or
 * routine store is needed. What is under test is the row, not the tool.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const botId = `agent_reached_as_${suite}`;
const actorId = `person_${suite}@openbot.local`;

const CALLS = [
  { serverId: "routines", toolName: "list_routines", reachedAs: actorId },
  { serverId: "mailbox", toolName: "list_messages", reachedAs: "deployment" },
] as const;

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

/** Which of the two server rows this suite created, so it removes only those. */
const created: string[] = [];

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    // A builtin server row holds no credential, so nothing here is ever read. Loud rather than
    // absent: a read would mean this file had started exercising something it does not claim to.
    readSecret: async () => {
      throw new Error("a builtin server has no credential to read");
    },
    create: async () => {
      throw new Error("this suite does not write credentials");
    },
    updateSecret: async () => {
      throw new Error("this suite does not write credentials");
    },
    revoke: async () => new Date(),
  },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  // No transport runs. The row is written from the entry and the actor, and both are known before
  // anything would have been dialled.
  callVendor: async () => ({ text: "ok", isError: false }),
});

beforeAll(async () => {
  await database
    .insert(agents)
    .values({ id: botId, name: botId, type: "remote_ag_ui", configuration: {} })
    .onConflictDoNothing();

  for (const { serverId, toolName } of CALLS) {
    const entry = catalogueEntry(serverId);
    if (!entry) throw new Error(`${serverId} is not in the catalogue`);

    const existing = await database
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId));
    if (existing.length === 0) created.push(serverId);

    // Written directly rather than through addServer, so the test needs nothing to be reachable.
    await database
      .insert(mcpServers)
      .values({
        id: serverId,
        title: entry.title,
        vendor: entry.vendor,
        url: entry.host as string,
        provenance: "first-party",
      })
      .onConflictDoNothing();

    await store.grant(
      "mcp",
      `${serverId}/${toolName}`,
      botId,
      "admin@openbot.local",
    );
  }
});

afterAll(async () => {
  // Scoped to this suite's own Bot. The refs name real connectors, so a delete by ref alone would
  // take an administrator's grants for a Bot people use.
  await database.delete(pluginGrants).where(
    and(
      inArray(
        pluginGrants.ref,
        CALLS.map(({ serverId, toolName }) => `${serverId}/${toolName}`),
      ),
      eq(pluginGrants.agentId, botId),
    ),
  );
  await database.delete(agents).where(eq(agents.id, botId));
  // A server row is deployment configuration. Removed only where this suite is what added it.
  if (created.length > 0) {
    await database.delete(mcpServers).where(inArray(mcpServers.id, created));
  }
});

describe("whose access a builtin call is recorded as", () => {
  for (const { serverId, toolName, reachedAs } of CALLS) {
    test(`${serverId} is reached as ${reachedAs === "deployment" ? "the deployment" : "the asker"}`, async () => {
      const ref = `${serverId}/${toolName}`;
      const result = await store.callTool({
        ref,
        args: {},
        botId,
        actorId,
      });
      expect(result.isError).toBe(false);

      const rows = await database
        .select({
          eventType: auditEvents.eventType,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.targetType, "mcp_tool"),
            eq(auditEvents.targetId, ref),
          ),
        );

      const mine = rows.filter(
        (row) =>
          row.eventType === "mcp.call_succeeded" &&
          (row.payload as { bot?: string }).bot === botId,
      );
      expect(mine.length).toBeGreaterThan(0);
      expect((mine[0].payload as { reachedAs?: string }).reachedAs).toBe(
        reachedAs,
      );
      // The actor is on the row either way. What `reachedAs` settles is whether the access was
      // theirs, which is a different question from who asked.
      expect((mine[0].payload as { actor?: string }).actor).toBe(actorId);
    });
  }
});
