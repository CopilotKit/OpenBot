/**
 * An upgrading deployment's conversations, group transcripts, voice sessions, tasks, delivery
 * bindings and push devices move into Intelligence once, at boot, and nothing is lost.
 *
 * Each case is a deployment of its own: a database created here and migrated with this repository's
 * migrations, holding rows the way a deployment before this release held them (`channels` and its
 * memberships, Bots and thread mappings, `group_bot_threads`, `group_messages`, `voice_sessions`,
 * `bot_tasks`, `delivery_bindings`, `push_devices`). The copy runs against the real test Intelligence.
 * What it must hold: every field crosses, deleted conversations included; running it again, or from
 * two replicas at once, copies nothing twice; once done it never runs again.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { createConversationClient } from "../src/conversations/client";
import { writeKey } from "../src/conversations/http";
import { copyLocalConversationsToIntelligence } from "../src/conversations/upgrade";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import {
  botTasks,
  channelAgents,
  channelMemberships,
  channels,
  deliveryBindings,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings,
  intelligenceCopies,
  proactiveSettings,
  proactiveSuggestions,
  pushDevices,
  users,
  voiceSessions,
} from "../src/db/schema";
import {
  createDeliveryBindingsClient,
  createDeliveryDirectory,
} from "../src/delivery/directory";
import { copyLocalDeliveryToIntelligence } from "../src/delivery/upgrade";
import { testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");
const created: string[] = [];
const opened: Database[] = [];
const copiedConversations: string[] = [];

async function freshDeployment(): Promise<Database> {
  const name = `openbot_conversation_copy_${suite}_${created.length}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(client, migrations);
  } finally {
    await client.end({ timeout: 5 });
  }
  const database = createDatabase(url.href, TEST_POOL);
  opened.push(database);
  return database;
}

const intelligence = () => {
  const { apiUrl, apiKey } = testIntelligence();
  return { apiUrl, apiKey };
};
const client = () => createConversationClient(intelligence());
/** A replica's delivery directory, without announcements: the copy needs none. */
const deliveryReplica = () =>
  createDeliveryDirectory({
    client: createDeliveryBindingsClient(intelligence()),
  });

afterEach(async () => {
  for (const database of opened.splice(0)) await database.$client.close();
  for (const id of copiedConversations.splice(0))
    await client().purge(id, writeKey("test.purge"));
});

afterAll(async () => {
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 60_000);

/** What a deployment before this release held: a two-Bot group with two people, a deleted
 * conversation, a task's conversation, a transcript, a voice session, a binding and a device. */
async function legacyConversations(database: Database) {
  const tag = randomUUID().slice(0, 8);
  const owner = `copy-owner-${tag}`;
  const teammate = `copy-mate-${tag}`;
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test`, name: "Owner" },
    { id: teammate, email: `${teammate}@example.test`, name: "Mate" },
  ]);
  const ids = {
    group: `channel_copy_group_${tag}`,
    deleted: `channel_copy_deleted_${tag}`,
    task: `channel_copy_task_${tag}`,
  };
  const threads = {
    ownerGroup: randomUUID(),
    mateGroup: randomUUID(),
    ownerResearch: randomUUID(),
    ownerWriter: randomUUID(),
    deleted: randomUUID(),
    task: randomUUID(),
  };
  const createdAt = new Date("2026-01-02T03:04:05.000Z");
  const lastAt = new Date("2026-01-03T04:05:06.000Z");
  await database.insert(channels).values([
    {
      id: ids.group,
      name: "Research, Writer",
      description: "Private agent channel.",
      summary: "Vendor contracts",
      summaryAt: lastAt,
      lastMessage: "Here are the clauses.",
      lastMessageAt: lastAt,
      lastMessageAgentId: "research",
      createdAt,
    },
    {
      id: ids.deleted,
      name: "Research",
      description: "Private agent channel.",
      deletedAt: lastAt,
      createdAt,
    },
    {
      id: ids.task,
      name: "Research",
      description: "Private agent channel.",
      lastMessage: "Done.",
      lastMessageSourceId: "task-turn:1",
      lastMessageAt: lastAt,
      lastMessageAgentId: "research",
      createdAt,
    },
  ]);
  copiedConversations.push(ids.group, ids.deleted, ids.task);
  await database.insert(channelMemberships).values([
    { channelId: ids.group, userId: owner, pinnedAt: lastAt, createdAt },
    {
      channelId: ids.group,
      userId: teammate,
      lastReadAt: lastAt,
      createdAt: lastAt,
    },
    { channelId: ids.deleted, userId: owner, createdAt },
    { channelId: ids.task, userId: owner, createdAt },
  ]);
  await database.insert(channelAgents).values([
    { channelId: ids.group, agentId: "research", createdAt },
    { channelId: ids.group, agentId: "writer", createdAt },
    { channelId: ids.deleted, agentId: "research", createdAt },
    { channelId: ids.task, agentId: "research", createdAt },
  ]);
  await database.insert(intelligenceChannelMappings).values([
    { userId: owner, channelId: ids.group, threadId: threads.ownerGroup },
    { userId: teammate, channelId: ids.group, threadId: threads.mateGroup },
    { userId: owner, channelId: ids.deleted, threadId: threads.deleted },
    { userId: owner, channelId: ids.task, threadId: threads.task },
  ]);
  await database.insert(groupBotThreads).values([
    {
      ownerUserId: owner,
      channelId: ids.group,
      agentId: "research",
      threadId: threads.ownerResearch,
      createdAt,
    },
    {
      ownerUserId: owner,
      channelId: ids.group,
      agentId: "writer",
      threadId: threads.ownerWriter,
      createdAt: new Date(createdAt.getTime() + 1),
    },
  ]);
  const messageIds = {
    asked: `msg-${tag}`,
    answered: `msg-${tag}:research`,
    waiting: `msg-${tag}:writer`,
  };
  await database.insert(groupMessages).values([
    {
      id: messageIds.asked,
      channelId: ids.group,
      ownerUserId: owner,
      text: "Compare the contracts.",
      details: { agentIds: ["research", "writer"] },
      createdAt,
    },
    {
      id: messageIds.answered,
      channelId: ids.group,
      ownerUserId: owner,
      agentId: "research",
      threadId: threads.ownerResearch,
      text: "Here are the clauses.",
      createdAt: lastAt,
    },
    {
      id: messageIds.waiting,
      channelId: ids.group,
      ownerUserId: owner,
      agentId: "writer",
      threadId: threads.ownerWriter,
      text: "",
      status: "waiting",
      details: { approvalId: `approval-${tag}`, message: "Waiting." },
      createdAt: lastAt,
    },
  ]);
  const voiceId = `voice-${tag}`;
  await database.insert(voiceSessions).values({
    id: voiceId,
    channelId: ids.group,
    userId: owner,
    anchorMessageId: null,
    startedAt: createdAt,
    endedAt: new Date(createdAt.getTime() + 45_000),
    durationSeconds: 45,
    transcript: { entries: [{ id: "t1", role: "user", text: "Plan it." }] },
    summary: "Planned it.",
    summaryStatus: "ready",
  });
  const [setting] = await database
    .insert(proactiveSettings)
    .values({
      id: randomUUID(),
      ownerUserId: owner,
      agentId: "research",
      channelId: ids.task,
      threadId: threads.task,
    })
    .returning();
  if (!setting) throw new Error("Expected a check-in setting.");
  const [item] = await database
    .insert(proactiveSuggestions)
    .values({
      id: randomUUID(),
      ownerUserId: owner,
      agentId: "research",
      settingId: setting.id,
      runId: randomUUID(),
      title: "Reply to the vendor",
      detail: "They asked for a date.",
      status: "started",
    })
    .returning();
  if (!item) throw new Error("Expected a check-in item.");
  const taskId = randomUUID();
  await database.insert(botTasks).values({
    id: taskId,
    ownerUserId: owner,
    agentId: "research",
    channelId: ids.task,
    suggestionId: item.id,
    title: "Reply to the vendor",
    why: "They asked for a date.",
    origin: "check_in",
    resolvedAt: lastAt,
    createdAt,
    updatedAt: lastAt,
  });
  const bindingId = randomUUID();
  await database.insert(deliveryBindings).values({
    id: bindingId,
    ownerUserId: owner,
    channelId: ids.group,
    agentId: "research",
    threadId: threads.ownerGroup,
    transport: "sms",
    realm: `+1555${tag.slice(0, 4)}`,
    identity: `+1666${tag.slice(0, 4)}`,
    address: `+1666${tag.slice(0, 4)}`,
    optedOutAt: lastAt,
    createdAt,
  });
  const deviceId = randomUUID();
  await database.insert(pushDevices).values({
    id: deviceId,
    ownerUserId: owner,
    token: `ExponentPushToken[${tag}]`,
    projectId: "push-project",
    platform: "android",
    createdAt,
  });
  return {
    owner,
    teammate,
    ids,
    threads,
    messageIds,
    voiceId,
    taskId,
    itemId: item.id,
    bindingId,
    deviceId,
    lastAt,
    createdAt,
  };
}

test("every conversation, line, session, task, binding and device crosses, with what it held", async () => {
  const database = await freshDeployment();
  const legacy = await legacyConversations(database);

  const outcome = await copyLocalConversationsToIntelligence(
    database,
    client(),
  );
  expect(outcome).toMatchObject({
    kind: "copied",
    conversations: 3,
    messages: 3,
    voiceSessions: 1,
    tasks: 1,
  });

  const group = await client().get(legacy.ids.group);
  expect(group).toMatchObject({
    name: "Research, Writer",
    summary: "Vendor contracts",
    lastMessage: "Here are the clauses.",
    lastMessageAgentId: "research",
    deletedAt: null,
  });
  expect(group?.createdAt.toISOString()).toBe(legacy.createdAt.toISOString());
  expect(group?.agents.map((agent) => agent.agentId)).toEqual([
    "research",
    "writer",
  ]);
  expect(
    group?.members.map((member) => ({
      userId: member.userId,
      pinned: member.pinnedAt?.toISOString() ?? null,
      read: member.lastReadAt?.toISOString() ?? null,
    })),
  ).toEqual([
    { userId: legacy.owner, pinned: legacy.lastAt.toISOString(), read: null },
    {
      userId: legacy.teammate,
      pinned: null,
      read: legacy.lastAt.toISOString(),
    },
  ]);
  const pointers = new Map(
    group?.threads.map((thread) => [
      `${thread.userId}/${thread.agentId ?? "own"}`,
      thread.threadId,
    ]),
  );
  expect(Object.fromEntries(pointers)).toEqual({
    [`${legacy.owner}/own`]: legacy.threads.ownerGroup,
    [`${legacy.teammate}/own`]: legacy.threads.mateGroup,
    [`${legacy.owner}/research`]: legacy.threads.ownerResearch,
    [`${legacy.owner}/writer`]: legacy.threads.ownerWriter,
  });

  // Deleted, and still there to read.
  const deleted = await client().get(legacy.ids.deleted);
  expect(deleted?.deletedAt?.toISOString()).toBe(legacy.lastAt.toISOString());

  // The task, linked to its item and its own conversation, done when it was done.
  const task = await client().tasks.get(legacy.taskId);
  expect(task).toMatchObject({
    userId: legacy.owner,
    conversationId: legacy.ids.task,
    originRef: legacy.itemId,
    origin: "check_in",
    title: "Reply to the vendor",
  });
  expect(task?.resolvedAt?.toISOString()).toBe(legacy.lastAt.toISOString());
  expect((await client().get(legacy.ids.task))?.taskId).toBe(legacy.taskId);

  // The transcript, oldest first, and the waiting line findable by what it waits on.
  const lines = (
    await client().messages.latest(legacy.ids.group, 200)
  ).messages.reverse();
  expect(lines.map((line) => [line.id, line.status])).toEqual([
    [legacy.messageIds.asked, "completed"],
    [legacy.messageIds.answered, "completed"],
    [legacy.messageIds.waiting, "waiting"],
  ]);
  const [waiting] = await client().messages.awaiting(
    (lines[2]?.details.approvalId as string) ?? "",
  );
  expect(waiting?.id).toBe(legacy.messageIds.waiting);

  const voice = await client().voice.get(legacy.voiceId);
  expect(voice).toMatchObject({
    conversationId: legacy.ids.group,
    userId: legacy.owner,
    durationSeconds: 45,
    summary: "Planned it.",
    summaryStatus: "ready",
    transcript: [{ id: "t1", role: "user", text: "Plan it." }],
  });

  // Recorded, so it never runs again.
  const [record] = await database
    .select()
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, "conversations"));
  expect(record?.copied).toBeGreaterThanOrEqual(8);

  const delivery = deliveryReplica();
  const copied = await copyLocalDeliveryToIntelligence(database, delivery);
  expect(copied).toEqual({ kind: "copied", bindings: 1, devices: 1 });
  const binding = delivery
    .bindings()
    .find((candidate) => candidate.id === legacy.bindingId);
  expect(binding).toMatchObject({
    ownerUserId: legacy.owner,
    channelId: legacy.ids.group,
    transport: "sms",
    enabled: true,
  });
  expect(binding?.optedOutAt?.toISOString()).toBe(legacy.lastAt.toISOString());
  expect(
    delivery.devices().find((device) => device.id === legacy.deviceId),
  ).toMatchObject({
    ownerUserId: legacy.owner,
    platform: "android",
    projectId: "push-project",
  });
  // Cleaned up for good: a binding and a device are not purged with a conversation.
  await delivery.changeBinding(legacy.bindingId, { enabled: false });
  await delivery.changeDevice(legacy.deviceId, false);
});

test("two replicas copying at once, and a second boot, copy nothing twice", async () => {
  const database = await freshDeployment();
  const legacy = await legacyConversations(database);

  const [left, right] = await Promise.all([
    copyLocalConversationsToIntelligence(database, client()),
    copyLocalConversationsToIntelligence(database, client()),
  ]);
  // Between them, each item was made once.
  const made =
    (left.kind === "copied" ? left.created : 0) +
    (right.kind === "copied" ? right.created : 0);
  expect(made).toBe(3 + 3 + 1 + 1);

  // Done, so a later boot does not run it, even after a conversation is purged in Intelligence.
  await client().purge(legacy.ids.deleted, writeKey("test.purge"));
  expect(
    await copyLocalConversationsToIntelligence(database, client()),
  ).toEqual({ kind: "done-before" });
  expect(await client().get(legacy.ids.deleted)).toBeNull();

  const delivery = deliveryReplica();
  await Promise.all([
    copyLocalDeliveryToIntelligence(database, delivery),
    copyLocalDeliveryToIntelligence(database, deliveryReplica()),
  ]);
  expect(await copyLocalDeliveryToIntelligence(database, delivery)).toEqual({
    kind: "done-before",
  });
  await delivery.changeBinding(legacy.bindingId, { enabled: false });
  await delivery.changeDevice(legacy.deviceId, false);
});
