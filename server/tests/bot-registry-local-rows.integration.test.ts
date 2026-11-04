/**
 * A Bot deleted for good takes this deployment's rows that named it; a soft delete takes nothing.
 *
 * Bots live in Intelligence, so the 27 foreign keys that used to cascade from `agents` are gone and
 * `agents/bot-registry/local-rows.ts` runs the cascade by hand. These pin both halves: every column
 * that names a Bot is either cleaned up with it or listed here as deliberately outliving it, and the
 * cleanup really runs on a purge, at boot for a Bot purged while nothing was running, and never on a
 * soft delete, which is what keeps a deleted Bot's conversations readable.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, getTableName, inArray, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { createAgentRegistryClient } from "../src/agents/bot-registry/client";
import { createBotDirectory } from "../src/agents/bot-registry/directory";
import type { BotChange } from "../src/agents/bot-registry/events";
import {
  BOT_CHILD_TABLES,
  BOT_REFERENCE_COLUMNS,
  sweepPurgedBotRows,
} from "../src/agents/bot-registry/local-rows";
import { createDatabase } from "../src/db/client";
import * as schema from "../src/db/schema";
import { MOVED_TO_INTELLIGENCE } from "../src/configuration/frozen-tables";
import { channelAgents, channels, routines, users } from "../src/db/schema";
import {
  changeAccess,
  changePreferences,
  deleteBot,
  removeBots,
  seedBot,
  storedAccess,
  storedPreferences,
  testIntelligence,
  useTestBots,
} from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

afterAll(async () => {
  await database.$client.close();
});

/**
 * Columns that name a Bot and deliberately outlive it. None of them ever had a foreign key to
 * `agents`: they are history (who ran what, what a rule was for) and were never cascaded.
 */
const OUTLIVES_ITS_BOT = new Set([
  "action_records.bot_id",
  "approval_rules.bot_id",
  "approval_team_rules.bot_id",
  "group_bot_threads.agent_id",
  "group_messages.agent_id",
  "learning_thread_bindings.agent_id",
  "model_usage.agent_id",
  "shared_use_approval_members.agent_id",
  "sign_in_requests.bot_id",
  // The legacy table itself, read only by the upgrade copy.
  "agent_profiles.agent_id",
]);

describe("which rows go with a Bot", () => {
  test("every column naming a Bot is cleaned up with it or listed as outliving it", () => {
    const covered = new Set(
      [...BOT_CHILD_TABLES, ...BOT_REFERENCE_COLUMNS].map(
        ({ table, column }) => `${getTableName(table)}.${column.name}`,
      ),
    );
    // Tables whose data moved into Intelligence beside the Bot: Intelligence removes it with the
    // Bot, and these local tables are written by nothing (configuration/frozen-tables.ts).
    const moved = new Set<string>(
      Object.values(MOVED_TO_INTELLIGENCE).map((table) => getTableName(table)),
    );
    const named: string[] = [];
    for (const value of Object.values(schema)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      for (const column of config.columns) {
        if (/(^|_)(agent|bot)_id$/.test(column.name))
          named.push(`${config.name}.${column.name}`);
      }
    }
    const undecided = named.filter(
      (name) =>
        !covered.has(name) &&
        !OUTLIVES_ITS_BOT.has(name) &&
        !moved.has(name.split(".")[0] ?? ""),
    );
    // A new table naming a Bot: add it to BOT_CHILD_TABLES, or here with the reason it outlives one.
    expect(undecided).toEqual([]);
    // Of the 26 tables that cascaded, the 17 still here, and the one column that was set to null.
    // The other nine moved into Intelligence with the Bot configuration.
    expect(BOT_CHILD_TABLES.length).toBe(17);
    expect([...covered]).toContain("channels.last_message_agent_id");
  });

  test("no table here holds a foreign key to agents any more, except the legacy profile", async () => {
    const rows = await database.execute<{ table: string }>(sql`
      select conrelid::regclass::text as "table" from pg_constraint
      where contype = 'f' and confrelid = 'agents'::regclass`);
    expect(rows.map((row) => row.table)).toEqual(["agent_profiles"]);
  });
});

async function person() {
  const id = `local-rows-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Local rows" });
  return id;
}

async function rowsFor(botId: string, channelId: string, owner: string) {
  const [member] = await database
    .select()
    .from(channelAgents)
    .where(eq(channelAgents.agentId, botId));
  const [routine] = await database
    .select()
    .from(routines)
    .where(eq(routines.agentId, botId));
  const [channel] = await database
    .select({ lastMessageAgentId: channels.lastMessageAgentId })
    .from(channels)
    .where(eq(channels.id, channelId));
  // The grant, the publication and the person's pin are in Intelligence, which removes them with
  // the Bot.
  const access = await storedAccess(botId);
  const preferences = await storedPreferences(owner);
  return {
    preference: preferences.bots.some((entry) => entry.botId === botId),
    member: Boolean(member),
    grant: access.grants.length > 0,
    routine: Boolean(routine),
    publication: access.publication !== null,
    lastSpeaker: channel?.lastMessageAgentId ?? null,
  };
}

async function botWithRows() {
  const owner = await person();
  const bot = await seedBot({ ownerUserId: owner, visibility: "private" });
  const channelId = `channel_${randomUUID()}`;
  await database.insert(channels).values({
    id: channelId,
    name: "Local rows",
    description: "",
    lastMessageAgentId: bot.id,
  });
  await database.insert(channelAgents).values({ channelId, agentId: bot.id });
  await changePreferences(owner, [
    { op: "setBot", botId: bot.id, pinnedAt: new Date() },
  ]);
  await changeAccess([
    {
      op: "grant",
      botId: bot.id,
      kind: "skill",
      ref: `skill-${randomUUID()}`,
      grantedBy: owner,
      grantedAs: "admin",
      ifGranted: "replace",
    },
    {
      op: "publish",
      botId: bot.id,
      audience: "team",
      members: [],
      publishedBy: owner,
    },
  ]);
  await database.insert(routines).values({
    id: `routine_${randomUUID()}`,
    ownerUserId: owner,
    agentId: bot.id,
    channelId,
    instruction: "Check in.",
    cron: "0 9 * * *",
    nextRunAt: new Date(Date.now() + 86_400_000),
  });
  return { bot, owner, channelId };
}

describe("the cascade, by hand", () => {
  test("a soft delete keeps every row, so the conversations stay readable", async () => {
    const { bot, channelId, owner } = await botWithRows();
    await deleteBot(bot.id);
    expect(await rowsFor(bot.id, channelId, owner)).toEqual({
      preference: true,
      member: true,
      grant: true,
      routine: true,
      publication: true,
      lastSpeaker: bot.id,
    });
    await removeBots([bot.id]);
  });

  test("a purge removes every row and clears the channel's last speaker", async () => {
    const { bot, channelId, owner } = await botWithRows();
    await removeBots([bot.id]);
    expect(await rowsFor(bot.id, channelId, owner)).toEqual({
      preference: false,
      member: false,
      grant: false,
      routine: false,
      publication: false,
      lastSpeaker: null,
    });
    await database.delete(channels).where(eq(channels.id, channelId));
  });

  test("the boot sweep removes rows of a Bot purged while nothing was listening", async () => {
    const { bot, channelId, owner } = await botWithRows();
    const keep = await botWithRows();
    // Purged in Intelligence behind this process's back: the registry directly, no listener.
    const directory = await useTestBots();
    await directory.registry.purge(bot.id, `test:${randomUUID()}`);
    const swept = await sweepPurgedBotRows(
      database,
      async () => (await directory.registry.all({ includeDeleted: true })).bots,
    );
    expect(swept).toContain(bot.id);
    expect(swept).not.toContain(keep.bot.id);
    expect((await rowsFor(bot.id, channelId, owner)).member).toBe(false);
    expect(
      (await rowsFor(keep.bot.id, keep.channelId, keep.owner)).member,
    ).toBe(true);
    await removeBots([keep.bot.id]);
    await database
      .delete(channels)
      .where(inArray(channels.id, [channelId, keep.channelId]));
  });

  test("a purge announced after the id was made again leaves the new Bot and its rows", async () => {
    // Announcements are at most once and can arrive late. Driven by hand here so the order is the
    // one that matters: the purge's announcement reaches this instance after the id is back.
    let announce: ((change: BotChange) => void) | undefined;
    const intelligence = testIntelligence();
    const replica = createBotDirectory({
      registry: createAgentRegistryClient(intelligence),
      gatewayWsUrl: intelligence.gatewayWsUrl,
      subscribe: (options) => {
        announce = options.onChange;
        return { joinCode: () => "driven-by-test", renew() {}, stop() {} };
      },
    });
    const cleaned: string[] = [];
    replica.onPurged((id) => {
      cleaned.push(id);
    });
    await replica.start();
    try {
      const bot = await seedBot();
      await replica.find(bot.id);
      const registry = (await useTestBots()).registry;
      await registry.purge(bot.id, `test:${randomUUID()}`);
      // Every live instance hears that purge for real; give them time to clean up after it.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const again = await registry.create(
        { ...bot, deletedAt: null, createdAt: undefined },
        `test:${randomUUID()}`,
      );
      // The new Bot's own rows, made after it was.
      const channelId = `channel_${randomUUID()}`;
      await database
        .insert(channels)
        .values({ id: channelId, name: "Again", description: "" });
      await database
        .insert(channelAgents)
        .values({ channelId, agentId: bot.id });

      announce?.({ agentId: bot.id, version: bot.version, change: "purged" });
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(cleaned).toEqual([]);
      expect(replica.peek(bot.id)?.createdAt.toISOString()).toBe(
        again.createdAt.toISOString(),
      );
      expect((await rowsFor(bot.id, channelId, "nobody")).member).toBe(true);
      await removeBots([bot.id]);
      await database.delete(channels).where(eq(channels.id, channelId));
    } finally {
      replica.stop();
    }
  });
});
