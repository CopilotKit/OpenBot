import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema";
import { proactiveRuns, proactiveSettings } from "../src/db/schema/proactive";
import { createDeliveryScopes } from "../src/delivery/scope";
import { createPeopleStore } from "../src/people/store";
import { createProactiveEngine } from "../src/proactive/engine";
import { createProactiveStore } from "../src/proactive/store";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A check-in belongs to its Bot. It used to be tied to a conversation that nothing was ever posted
 * in: New routine made an empty one for it, and deleting that conversation silently stopped the
 * check-in, skipped as unreachable on every run. Its reach check is now the server's own rule for a
 * Bot (`canUseBot` in delivery/scope.ts): the person is not revoked and can still use the Bot.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profiles, threadIdentity);
const prefix = `belongs-${randomUUID().slice(0, 8)}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});
const scopes = createDeliveryScopes({
  database,
  people: createPeopleStore(database, []),
  actorFor,
  channels: channelStore,
  bots: profiles,
});
const store = createProactiveStore(database);
const turns: string[] = [];
const engine = createProactiveEngine({
  store,
  queue: createWorkQueue(database),
  owner: `${prefix}-proactive`,
  runTurn: async (input) => {
    turns.push(input.agentId);
    return { replyText: "" };
  },
  canUseBot: scopes.canUseBot,
  readableApps: async () => [
    { title: "Gmail", serverId: "gmail", refs: ["gmail/list"], names: [] },
  ],
  attention: { notifyAttention: async () => {} },
  catalogue: { listServers: async () => [] },
  mintThreadId: () => `${prefix}-thread-${randomUUID()}`,
});
const madeBots: string[] = [];
const madeChannels: string[] = [];

async function bot(by: string, name: string) {
  const profile = await profiles.create(await actorFor(by), {
    name,
    title: "Helper",
    roleDescription: "Answer briefly.",
    visibility: "private",
  });
  madeBots.push(profile.id);
  return profile.id;
}

/** Due now, so the next sweep claims it. */
async function due(id: string) {
  await database
    .update(proactiveSettings)
    .set({ nextRunAt: new Date(Date.now() - 1_000) })
    .where(eq(proactiveSettings.id, id));
}

async function runsOf(id: string) {
  return database
    .select({
      outcome: proactiveRuns.outcome,
      skipReason: proactiveRuns.skipReason,
    })
    .from(proactiveRuns)
    .where(eq(proactiveRuns.settingId, id));
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test`, name: "Dana" },
    { id: stranger, email: `${stranger}@example.test`, name: "Sam" },
  ]);
});
afterEach(async () => {
  turns.length = 0;
  await database
    .delete(proactiveSettings)
    .where(inArray(proactiveSettings.ownerUserId, [owner, stranger]));
});
afterAll(async () => {
  await database.delete(channels).where(inArray(channels.id, madeChannels));
  await database.delete(agents).where(inArray(agents.id, madeBots));
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

test("a check-in is made with no conversation and runs", async () => {
  const agentId = await bot(owner, "Inbox Bot");
  const setting = await engine.create(owner, {
    agentId,
    subject: "Your Gmail inbox",
  });
  expect(setting.channelId).toBeNull();
  await due(setting.id);
  await engine.sweep();
  expect(turns).toEqual([agentId]);
  expect(
    (await runsOf(setting.id)).every((run) => run.outcome !== "skipped"),
  ).toBe(true);
});

test("a conversation sent with it, as older clients do, is ignored", async () => {
  const agentId = await bot(owner, "Inbox Bot");
  const channel = await channelStore.create(await actorFor(owner), [agentId]);
  madeChannels.push(channel.id);
  const setting = await engine.create(owner, {
    agentId,
    channelId: channel.id,
    subject: "Your Gmail inbox",
  });
  expect(setting.channelId).toBeNull();
});

test("deleting the conversation an older check-in made does not stop it", async () => {
  const agentId = await bot(owner, "Inbox Bot");
  const channel = await channelStore.create(await actorFor(owner), [agentId]);
  madeChannels.push(channel.id);
  const setting = await engine.create(owner, {
    agentId,
    subject: "Your Gmail inbox",
  });
  // As a check-in made before this change: it names the conversation it was made with.
  await database
    .update(proactiveSettings)
    .set({ channelId: channel.id })
    .where(eq(proactiveSettings.id, setting.id));
  await database.delete(channels).where(eq(channels.id, channel.id));
  await due(setting.id);
  await engine.sweep();
  expect(turns).toEqual([agentId]);
  expect(await runsOf(setting.id)).not.toContainEqual({
    outcome: "skipped",
    skipReason: "unreachable",
  });
});

test("a Bot the person can no longer use is refused at create and skipped as unreachable", async () => {
  const theirs = await bot(stranger, "Sam's Bot");
  await expect(
    engine.create(owner, { agentId: theirs, subject: "Sam's inbox" }),
  ).rejects.toThrow("Choose one of your Bots.");

  // One made while it was theirs to use, as a row: the Bot is somebody else's now.
  const [row] = await database
    .insert(proactiveSettings)
    .values({
      id: randomUUID(),
      ownerUserId: owner,
      agentId: theirs,
      threadId: `${prefix}-thread-lost`,
      subject: "Sam's inbox",
      intervalMinutes: 60,
      nextRunAt: new Date(Date.now() - 1_000),
    })
    .returning();
  if (!row) throw new Error("No row.");
  await engine.sweep();
  expect(turns).toEqual([]);
  expect(await runsOf(row.id)).toEqual([
    { outcome: "skipped", skipReason: "unreachable" },
  ]);
  expect((await store.get(owner, row.id)).lastError).toBe(
    "This Bot is no longer available to you, so it didn't check in.",
  );
});
