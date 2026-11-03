/**
 * A Bot deleted for good takes its place in conversations, its tasks and its delivery bindings with
 * it, as the old foreign keys' cascade did; a soft delete takes nothing. The conversations themselves
 * stay, with their other Bots and their people.
 */
import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sweepPurgedBotReferences } from "../src/conversations/bot-purge";
import { deleteBot, removeBots, seedBot, useTestBots } from "./support/bots";
import {
  conversationClient,
  newThreadId,
  purgeConversations,
  seedBinding,
  seedConversation,
  seedTask,
  storedConversation,
  storedTask,
  useTestConversations,
} from "./support/conversations";

const conversationsMade: string[] = [];
const botsMade: string[] = [];

afterAll(async () => {
  await purgeConversations(conversationsMade);
  await removeBots(botsMade);
});

async function fixture() {
  const owner = `bot-purge-${randomUUID()}`;
  const leaving = await seedBot({ name: "Leaving" });
  const staying = await seedBot({ name: "Staying" });
  botsMade.push(staying.id);
  const group = await seedConversation({
    agentIds: [leaving.id, staying.id],
    members: [{ userId: owner }],
    threads: [
      { userId: owner, agentId: leaving.id },
      { userId: owner, agentId: staying.id },
    ],
    lastMessage: "Said by the Bot that is leaving.",
    lastMessageAgentId: leaving.id,
  });
  const own = await seedConversation({
    agentIds: [leaving.id],
    members: [{ userId: owner }],
  });
  conversationsMade.push(group.id, own.id);
  const task = await seedTask({
    userId: owner,
    agentId: leaving.id,
    conversationId: own.id,
  });
  const binding = await seedBinding({
    ownerUserId: owner,
    channelId: own.id,
    agentId: leaving.id,
    threadId: newThreadId(),
  });
  return { owner, leaving, staying, group, own, task, binding };
}

test("a Bot purged for good is forgotten where conversations, tasks and bindings named it", async () => {
  const f = await fixture();
  // A soft delete first: nothing goes.
  await deleteBot(f.leaving.id);
  expect(
    (await storedConversation(f.group.id)).agents.map((agent) => agent.agentId),
  ).toContain(f.leaving.id);

  await removeBots([f.leaving.id]);

  const group = await storedConversation(f.group.id);
  expect(group.agents.map((agent) => agent.agentId)).toEqual([f.staying.id]);
  expect(group.lastMessageAgentId).toBeNull();
  expect(group.threads.map((thread) => thread.agentId)).toEqual([
    null,
    f.staying.id,
  ]);
  expect(group.members.map((member) => member.userId)).toEqual([f.owner]);
  // The conversation it had alone stays, with nobody to answer in it, as the old cascade left it.
  expect((await storedConversation(f.own.id)).agents).toEqual([]);
  expect(await storedTask(f.task.id)).toBeNull();
  const { delivery } = await useTestConversations();
  await delivery.resync();
  expect(delivery.bindings().some((held) => held.id === f.binding.id)).toBe(
    false,
  );
});

test("a Bot purged while no server was running is forgotten at the next boot's sweep", async () => {
  const f = await fixture();
  botsMade.push(f.leaving.id);
  const { conversations, delivery } = await useTestConversations();
  // What a boot sees after a purge nobody heard: the registry's listing no longer has the Bot. It
  // is left out of the listing here, rather than purged, so no announcement races the sweep.
  const bots = await useTestBots();
  const known = new Set(
    (await bots.registry.all({ includeDeleted: true })).bots
      .map((bot) => bot.id)
      .filter((id) => id !== f.leaving.id),
  );

  const swept = await sweepPurgedBotReferences(conversations, delivery, known);

  expect(swept).toContain(f.leaving.id);
  expect(swept).not.toContain(f.staying.id);
  expect(
    (await storedConversation(f.group.id)).agents.map((agent) => agent.agentId),
  ).toEqual([f.staying.id]);
  expect(await storedTask(f.task.id)).toBeNull();
  expect(
    (await (await conversationClient()).agentReferences()).includes(
      f.leaving.id,
    ),
  ).toBe(false);
});
