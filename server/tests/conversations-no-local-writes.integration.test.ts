/**
 * Conversations live in Intelligence: this deployment's channel, group, voice, task, binding and
 * device tables get no writes.
 *
 * They stay for one release so an upgrading deployment has rows to copy, and are read only by that
 * copy (and emptied of a Bot's rows when the Bot is purged, as the old cascade did). Two guards: no
 * server source outside those names any of them, and a conversation's whole life through the stores
 * leaves every one of them as it was while Intelligence holds every step.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { count, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  botTasks,
  channelAgents,
  channelMemberships,
  channels,
  deliveryBindings,
  groupBotThreads,
  groupMessages,
  intelligenceChannelMappings,
  pushDevices,
  users,
  voiceSessions,
} from "../src/db/schema";
import { createDeliveryStore } from "../src/delivery/store";
import { createGroupStore } from "../src/channels/group";
import { createVoiceSessionStore } from "../src/voice/sessions";
import { removeBots, useTestBots } from "./support/bots";
import {
  purgeConversations,
  storedBindings,
  storedConversation,
  storedDevices,
  storedMessages,
} from "./support/conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { sourceFiles, stripComments } from "./support/source-scan";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made = { bots: [] as string[], conversations: [] as string[] };
const owners: string[] = [];

afterAll(async () => {
  await purgeConversations(made.conversations);
  await removeBots(made.bots);
  await database.delete(users).where(inArray(users.id, owners));
  await database.$client.close();
});

const MOVED = [
  "channels",
  "channelMemberships",
  "channelAgents",
  "intelligenceChannelMappings",
  "groupBotThreads",
  "groupMessages",
  "voiceSessions",
  "botTasks",
  "deliveryBindings",
  "pushDevices",
];

describe("the conversation tables kept for the upgrade", () => {
  test("no server source names them except the copies, the schema and the purge cleanup", () => {
    const root = join(import.meta.dir, "..", "src");
    const allowed = new Set([
      "conversations/upgrade.ts",
      "delivery/upgrade.ts",
      "agents/bot-registry/local-rows.ts",
      "db/schema/core.ts",
      "db/schema/group.ts",
      "db/schema/voice.ts",
      "db/schema/tasks.ts",
      "db/schema/delivery.ts",
      "db/schema/index.ts",
    ]);
    const named = new RegExp(
      `import \\{[^}]*\\b(${MOVED.join("|")})\\b[^}]*\\} from "[./]+db\\/schema`,
    );
    const offenders = sourceFiles(root, [".ts"]).flatMap((file) => {
      const path = relative(root, file);
      if (allowed.has(path)) return [];
      return named.test(stripComments(readFileSync(file, "utf8")))
        ? [path]
        : [];
    });
    expect(offenders).toEqual([]);
  });

  test("a conversation's whole life through the stores writes nothing to them", async () => {
    await useTestBots();
    const tag = randomUUID().slice(0, 8);
    const owner = `no-local-writes-${tag}`;
    const mate = `no-local-writes-mate-${tag}`;
    owners.push(owner, mate);
    await database.insert(users).values([
      { id: owner, email: `${owner}@example.test`, name: "Owner" },
      { id: mate, email: `${mate}@example.test`, name: "Mate" },
    ]);
    const actor = { id: owner, role: "user" as const };
    const profiles = createAgentProfileStore(
      database,
      new URL("https://managed.example.test/ag-ui"),
    );
    const identity = createThreadIdentity("no-local-writes");
    const store = createChannelStore(database, profiles, identity);
    const before = await tableCounts();

    const bots = [];
    for (const name of ["Research", "Writer"]) {
      const profile = await profiles.create(actor, {
        name,
        title: "Tester",
        roleDescription: "Lives in Intelligence.",
        visibility: "public",
      });
      bots.push(profile.id);
      made.bots.push(profile.id);
    }
    const [research, writer] = bots as [string, string];

    // A conversation with one Bot: made, spoken in, pinned, read, deleted.
    const direct = await store.create(actor, [research]);
    made.conversations.push(direct.id);
    await store.recordActivity(actor, direct.id, {
      text: "Hello",
      agentId: null,
      at: new Date(),
    });
    await store.setPinned(actor, direct.id, true);
    await store.markRead(actor, direct.id);
    const found = await store.direct(actor, research);
    expect(found.id).toBe(direct.id);

    // A group: made, a teammate added, a line in its transcript, a Bot's thread.
    const group = await store.create(actor, [research, writer]);
    made.conversations.push(group.id);
    const groups = createGroupStore(database, () => identity.mint());
    await groups.seedOrder(owner, group.id, [research, writer]);
    await groups.addMember(group.id, `${mate}@example.test`);
    await groups.append({
      id: `line-${tag}`,
      ownerUserId: owner,
      channelId: group.id,
      agentId: research,
      threadId: await groups.thread(owner, group.id, research),
      text: "An answer.",
      details: {},
    });

    // A voice session in it, and its summary.
    const voice = createVoiceSessionStore(store);
    const session = await voice.save(actor, {
      id: `voice-${tag}`,
      channelId: group.id,
      anchorMessageId: null,
      startedAt: "2026-09-21T00:00:00.000Z",
      endedAt: "2026-09-21T00:00:10.000Z",
      transcript: [{ id: "t", role: "user", text: "Plan it." }],
    });
    await voice.summarize(actor, session.id, "Planned it.");

    // A binding to SMS, and a push device.
    const delivery = createDeliveryStore(database);
    const binding = await delivery.bind({
      ownerUserId: owner,
      channelId: direct.id,
      agentId: research,
      threadId: direct.threadId,
      transport: "sms",
      realm: `+1555${tag.slice(0, 4)}`,
      identity: `+1777${tag.slice(0, 4)}`,
      address: `+1777${tag.slice(0, 4)}`,
    });
    const device = await delivery.registerDevice({
      id: randomUUID(),
      ownerUserId: owner,
      token: `ExponentPushToken[${tag}]`,
      projectId: "push",
      platform: "ios",
    });

    await store.softDelete(actor, direct.id);

    expect(await tableCounts()).toEqual(before);

    // Every step is in Intelligence instead.
    const held = await storedConversation(direct.id);
    expect(held.deletedAt).not.toBeNull();
    expect(held.lastMessage).toBe("Hello");
    expect(held.members[0]?.pinnedAt).not.toBeNull();
    const heldGroup = await storedConversation(group.id);
    expect(heldGroup.members.map((member) => member.userId).sort()).toEqual(
      [owner, mate].sort(),
    );
    expect(
      heldGroup.threads.filter((thread) => thread.agentId !== null),
    ).toHaveLength(2);
    expect((await storedMessages(group.id)).map((line) => line.text)).toEqual([
      "An answer.",
    ]);
    expect((await storedBindings(owner)).map((row) => row.id)).toEqual([
      binding.id,
    ]);
    expect((await storedDevices(owner)).map((row) => row.id)).toEqual([
      device.id,
    ]);
    await delivery.removeBinding(owner, binding.id);
    await delivery.removeDevice(owner, device.id);
  });
});

async function tableCounts() {
  const counted = async (table: PgTable) => {
    const [row] = await database.select({ n: count() }).from(table);
    return row?.n ?? 0;
  };
  return {
    channels: await counted(channels),
    channelMemberships: await counted(channelMemberships),
    channelAgents: await counted(channelAgents),
    intelligenceChannelMappings: await counted(intelligenceChannelMappings),
    groupBotThreads: await counted(groupBotThreads),
    groupMessages: await counted(groupMessages),
    voiceSessions: await counted(voiceSessions),
    botTasks: await counted(botTasks),
    deliveryBindings: await counted(deliveryBindings),
    pushDevices: await counted(pushDevices),
  };
}
