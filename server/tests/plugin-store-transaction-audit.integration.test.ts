import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createAuditStore } from "../src/audit";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  pluginGrants,
  skills,
  users,
} from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * A write inside a caller's transaction must not need a second pooled connection.
 *
 * The template import opens one transaction and installs a Bot, its skills and their grants inside
 * it. Each of those writes also records a trail row, and while that row went to the audit store's
 * own pooled handle the import was holding one connection and asking for another. Bun's `SQL` has
 * no acquisition timeout, so with every connection inside such a transaction the ask never returns:
 * the transactions never commit, never roll back, and never give their connections back, and the
 * deployment stays wedged until it is restarted. Ten concurrent imports were enough.
 *
 * Pinning the pool to one connection is how that becomes a single deterministic test rather than a
 * load-dependent hang, which is what `TEST_POOL` says it is for.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";

/**
 * The pool the store under test writes through. One connection, so a write that quietly wants a
 * second one has nowhere to get it.
 */
const pinned = createDatabase(databaseUrl, { max: 1 });

/**
 * A second handle, for the setup and the assertions only.
 *
 * Separate because the point of `pinned` is that its one connection can be occupied. Reading the
 * result through it would be the very mistake this file is about.
 */
const database = createDatabase(databaseUrl, TEST_POOL);

const policy: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

const store = createPluginStore({
  database: pinned,
  auditStore: createAuditStore(pinned),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

/** What a fork's audit store would see. Written to by `forkStore` and by nothing else. */
const captured: AuditEventInput[] = [];

const forkStore = createPluginStore({
  database: pinned,
  auditStore: {
    insert: async (event) => {
      captured.push(event);
    },
  },
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => policy,
});

const suite = randomUUID().slice(0, 8);
const importer = `user_${suite}`;
const bot = `agent_${suite}`;
const importedSkill = `imported-skill-${suite}`;
const looseSkill = `loose-skill-${suite}`;

/**
 * Set when the transaction never came back, so the cleanup below does not go looking for locks the
 * wedged transaction is still holding and hang the run a second time.
 */
let wedged = false;

async function withinTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alarm = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`${what} did not return within ${milliseconds}ms`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([work, alarm]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: importer, email: `${importer}@example.test`, name: importer })
    .onConflictDoNothing();
  await database
    .insert(agents)
    .values({ id: bot, name: bot, type: "built_in", configuration: {} })
    .onConflictDoNothing();
});

afterAll(async () => {
  // Nothing is cleaned when the pool is wedged: the rows this file wrote are inside a transaction
  // that will never end, so a delete would either skip them or queue behind it.
  if (wedged) return;
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, bot));
  await database.delete(skills).where(eq(skills.slug, importedSkill));
  await database.delete(skills).where(eq(skills.slug, looseSkill));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(users).where(eq(users.id, importer));
  // The trail rows stay. `audit_events` is append-only in the database, which is the point of it.
});

test("an install and a grant inside one transaction never ask for a second connection", async () => {
  const imported = pinned.transaction(async (transaction) => {
    await store.installSkill(
      {
        slug: importedSkill,
        title: "Imported",
        summary: "Arrived in a template.",
        instructions: "Do the thing the template describes.",
        ownerUserId: importer,
        tools: [],
        allowUnknownTools: true,
        by: importer,
      },
      transaction,
    );
    await store.grant("skill", importedSkill, bot, importer, transaction);
  });

  try {
    await withinTimeout(imported, 5_000, "the import transaction");
  } catch (error) {
    wedged = true;
    throw error;
  }

  const [skill] = await database
    .select({ slug: skills.slug })
    .from(skills)
    .where(eq(skills.slug, importedSkill));
  expect(skill?.slug).toBe(importedSkill);

  const [held] = await database
    .select({ ref: pluginGrants.ref })
    .from(pluginGrants)
    .where(
      and(
        eq(pluginGrants.kind, "skill"),
        eq(pluginGrants.ref, importedSkill),
        eq(pluginGrants.agentId, bot),
      ),
    );
  expect(held?.ref).toBe(importedSkill);

  // Written on the transaction, so the trail committed with the change it describes rather than
  // separately from it.
  const trail = await database
    .select({ payload: auditEvents.payload })
    .from(auditEvents)
    .where(eq(auditEvents.targetId, importedSkill));
  const changes = trail.map(
    (row) => (row.payload as Record<string, unknown>).change,
  );
  expect(changes).toContain("skill_installed");
  expect(changes).toContain("plugin_granted");
});

test("a caller with no transaction still writes its trail through the injected audit store", async () => {
  await forkStore.installSkill(
    {
      slug: looseSkill,
      title: "Written here",
      summary: "Saved from the Skills page.",
      instructions: "Do the thing somebody typed.",
      ownerUserId: importer,
      tools: [],
      by: importer,
    },
    // No executor, exactly as the Skills page and the package sync call it.
  );
  await forkStore.grant("skill", looseSkill, bot, importer);

  expect(captured.map((event) => event.payload.change)).toEqual([
    "skill_installed",
    "plugin_granted",
  ]);

  /*
   * And nowhere else. A fork is entitled to redirect the trail, so the rows must not also land in
   * this deployment's own table — that would be the fix for the deadlock overreaching into the path
   * that never had it.
   */
  const rows = await database
    .select({ id: auditEvents.id })
    .from(auditEvents)
    .where(eq(auditEvents.targetId, looseSkill));
  expect(rows).toHaveLength(0);
});
