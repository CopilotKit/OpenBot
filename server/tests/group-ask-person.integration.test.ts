import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { wireCoordination } from "../src/agents/coordination-wiring";
import { PUT_TO } from "../src/agents/escalation";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createApprovalQuestions } from "../src/approvals/questions";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { ApprovalRefusedError } from "../src/approvals/types";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import {
  createGroupConversations,
  createGroupStore,
  groupSourceForRun,
} from "../src/channels/group";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
  workItems,
} from "../src/db/schema";
import { deliveryOutbox, pushDevices } from "../src/db/schema/delivery";
import { createDeliveryRouter } from "../src/delivery/router";
import { createDeliveryScopes } from "../src/delivery/scope";
import { createDeliveryStore } from "../src/delivery/store";
import { createPeopleStore } from "../src/people/store";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A Bot's question in a conversation with two Bots.
 *
 * The person asked one Bot in a group which area to do first. It asked them back with `ask_person`,
 * and the question was saved, but the Bot told them "I couldn't send a question just now", Activity
 * said "Conversation access has been revoked", and the question waited behind a badge that nothing
 * in the conversation could answer. A Bot in a group works in a thread of its own, and delivery's
 * access check only knew the channel's. Answered from the inbox, the Bot's reply went to that thread
 * and never reached the group.
 *
 * Through the real stores on PostgreSQL: the coordination tools a run is handed, delivery's own
 * access check and outbox, the approval routes, and the group's transcript and turn queue. Only the
 * model is played, as the group's turn runner.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const threadIdentity = createThreadIdentity("test-deployment");
const channelStore = createChannelStore(database, profileStore, threadIdentity);
const prefix = `group-ask-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const actor: AgentActor = { id: owner, role: "user" };
const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});
const createdAgents: string[] = [];
const createdChannels: string[] = [];
/** Questions answered here, whose rows `questions.list` no longer returns. */
const answeredIds: string[] = [];

const QUESTION =
  "Where are you starting, and which errands are downtown versus in Riverside?";
const ANSWER =
  "From home. Dry cleaning is downtown, groceries are in Riverside.";

const scopes = createDeliveryScopes({
  database,
  people: createPeopleStore(database, []),
  actorFor,
  channels: channelStore,
  bots: profileStore,
});
const router = createDeliveryRouter({
  store: createDeliveryStore(database),
  queue: createWorkQueue(database),
  owner: `${prefix}-delivery`,
  authoriseScope: scopes.authorise,
  scopeFor: scopes.scopeFor,
  runTurn: async () => {
    throw new Error("No inbound delivery runs here.");
  },
  providers: {},
});

/** The group's turns, with the model played: what each Bot was asked, and what it says. */
const turns: Parameters<TurnRunner>[0][] = [];
const conversations = createGroupConversations({
  store: createGroupStore(database, () => threadIdentity.mint()),
  queue: createWorkQueue(database),
  owner: `${prefix}-group`,
  roster: async (ownerUserId, channelId) => {
    const channel = await channelStore.get(
      await actorFor(ownerUserId),
      channelId,
    );
    if (!channel || channel.agentIds.length < 2) return null;
    const bots = [];
    for (const agentId of channel.agentIds) {
      const profile = await profileStore.get(
        await actorFor(ownerUserId),
        agentId,
      );
      if (profile) bots.push({ id: agentId, name: profile.name });
    }
    return bots;
  },
  runTurn: async (input) => {
    turns.push(input);
    return { replyText: "Do downtown first, then Riverside on the way home." };
  },
  caps: { maxDepth: 1, maxPerRun: 2 },
  mayAddress: async () => true,
  auditStore: { insert: async () => undefined },
  createChannel: async (ownerUserId, agentIds) => {
    const channel = await channelStore.create(
      await actorFor(ownerUserId),
      agentIds,
    );
    createdChannels.push(channel.id);
    return channel;
  },
});

/** The production rule for a saved question's conversation, for a group Bot's thread. */
const authoriseQuestion = async (question: {
  actorId: string;
  botId: string;
  sourceBotId?: string;
  threadId: string;
  channelId?: string;
}) => {
  const source = await groupSourceForRun(database, {
    actorId: question.actorId,
    botId: question.sourceBotId ?? question.botId,
    threadId: question.threadId,
  });
  if (!source || source.channelId !== question.channelId)
    throw new ApprovalRefusedError(
      "That conversation is no longer available to this Bot and person.",
    );
};
const questions = createApprovalQuestions(database, authoriseQuestion);
const approvals = new Hono<{ Variables: AppVariables }>();
approvals.route(
  "/api/approvals",
  createApprovalRoutes(
    createApprovalService(createApprovalStore(database), questions),
    async (context, next) => {
      context.set("actor", {
        id: owner,
        email: `${owner}@example.test`,
        role: "user",
      });
      await next();
    },
  ),
);

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test`, name: "Dana" },
    { id: stranger, email: `${stranger}@example.test`, name: "Sam" },
  ]);
  // The person's phone, so a question that reaches them is told to them there too.
  await createDeliveryStore(database).registerDevice({
    id: `${prefix}-phone`,
    ownerUserId: owner,
    token: `ExponentPushToken[${prefix}]`,
    projectId: "test-project",
    platform: "ios",
  });
});
afterEach(() => {
  turns.length = 0;
});
afterAll(async () => {
  const outbox = await database
    .select({ id: deliveryOutbox.id })
    .from(deliveryOutbox)
    .where(eq(deliveryOutbox.ownerUserId, owner));
  const asked = (await questions.list(owner)).map((question) => question.id);
  const keys = [
    ...outbox.map((row) => row.id),
    ...asked,
    ...answeredIds,
    ...answeredIds.map((id) => `person-response:${id}`),
  ];
  if (keys.length)
    await database.delete(workItems).where(inArray(workItems.key, keys));
  await database
    .delete(deliveryOutbox)
    .where(eq(deliveryOutbox.ownerUserId, owner));
  await database.delete(pushDevices).where(eq(pushDevices.ownerUserId, owner));
  for (const id of createdChannels) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, id));
    await database.delete(channels).where(eq(channels.id, id));
  }
  if (createdAgents.length) {
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, createdAgents));
    await database.delete(agents).where(inArray(agents.id, createdAgents));
  }
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

async function bot(name: string) {
  const profile = await profileStore.create(actor, {
    name,
    title: "Helper",
    roleDescription: "Answer briefly.",
    visibility: "private",
  });
  createdAgents.push(profile.id);
  return profile.id;
}

/** Errand Helper and Budget Buddy in one conversation, as the person made it. */
async function group() {
  const errands = await bot("Errand Helper");
  const budget = await bot("Budget Buddy");
  const channel = await conversations.create(owner, {
    agentIds: [errands, budget],
  });
  const store = conversations.store;
  return {
    channelId: channel.id,
    channelThread: (await channelStore.get(actor, channel.id))?.threadId ?? "",
    errands,
    budget,
    errandsThread: await store.thread(owner, channel.id, errands),
    budgetThread: await store.thread(owner, channel.id, budget),
  };
}

/** The `ask_person` tool a Bot's group turn is handed, wired as the server wires it. */
async function askPerson(botId: string, threadId: string) {
  const audit: AuditEventInput[] = [];
  const source = (run: Parameters<typeof groupSourceForRun>[1]) =>
    groupSourceForRun(database, run);
  const { coordinationForActor } = wireCoordination({
    handoffDesk: {
      send: async () => ({ ok: false, refusal: "No Bot to hand to." }),
    } as never,
    config: loadConfig(testEnvironment()),
    approvalService: { store: {} } as never,
    agentProfileStore: profileStore,
    actorFor,
    // A group Bot's thread is not a channel's own, so only the group lookup finds it.
    channelSourceForRun: async () => null,
    database,
    pluginStore: { botsReachableFrom: async () => [] } as never,
    bootAuditStore: {
      insert: async (event: AuditEventInput) => {
        audit.push(event);
      },
    } as never,
    peopleStore: createPeopleStore(database, []),
    sourceForCoordinationRun: source,
    channelStore,
    notify: (scope, input) => router.notify(scope, input),
  });
  const tools = await coordinationForActor(owner)(botId, {
    threadId,
    runId: randomUUID(),
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
  const tool = tools.find((candidate) => candidate.name === "ask_person");
  if (!tool) throw new Error("the group turn was not offered ask_person");
  return { tool, audit };
}

async function waiting(channelId: string) {
  return (await questions.list(owner)).filter(
    (question) => question.channelId === channelId,
  );
}

test("a Bot's question in a group is put to the person, not refused, and their phone is told", async () => {
  const conversation = await group();
  const { tool, audit } = await askPerson(
    conversation.errands,
    conversation.errandsThread,
  );

  const said = await tool.execute({
    question: QUESTION,
    why: "The best order depends on your starting point and where the errands are.",
  });

  // Asked, so the Bot asks it rather than telling the person it could not.
  expect(String(said)).toStartWith(PUT_TO);
  // And Activity records it truly: asked, not "Did not happen".
  expect(audit.map((event) => event.eventType)).toEqual(["agent.escalated"]);

  const [question] = await waiting(conversation.channelId);
  expect(question).toMatchObject({
    question: QUESTION,
    conversationBotId: conversation.errands,
    threadId: conversation.errandsThread,
    channelId: conversation.channelId,
  });
  const told = await database
    .select()
    .from(deliveryOutbox)
    .where(eq(deliveryOutbox.requestId, question?.id ?? ""));
  expect(told).toMatchObject([
    {
      transport: "push",
      kind: "question",
      channelId: conversation.channelId,
      agentId: conversation.errands,
      text: `Errand Helper asks: ${QUESTION}`,
    },
  ]);
});

test("delivery reaches a Bot in its own group thread, and in nothing that is not its own", async () => {
  const conversation = await group();
  const solo = await channelStore.create(actor, [conversation.errands]);
  createdChannels.push(solo.id);
  const scope = {
    ownerUserId: owner,
    channelId: conversation.channelId,
    agentId: conversation.errands,
  };

  // The Bot's own thread in the group, and the group channel's own thread.
  expect(
    await scopes.authorise({ ...scope, threadId: conversation.errandsThread }),
  ).toBe(true);
  expect(
    await scopes.authorise({ ...scope, threadId: conversation.channelThread }),
  ).toBe(true);
  // Not another Bot's thread in the same group, and not for somebody who is not in it.
  expect(
    await scopes.authorise({ ...scope, threadId: conversation.budgetThread }),
  ).toBe(false);
  expect(
    await scopes.authorise({
      ...scope,
      ownerUserId: stranger,
      threadId: conversation.errandsThread,
    }),
  ).toBe(false);
  // A conversation with one Bot, unchanged: its own thread, and not a group thread passed off as it.
  expect(
    await scopes.authorise({
      ...scope,
      channelId: solo.id,
      threadId: solo.threadId,
    }),
  ).toBe(true);
  expect(
    await scopes.authorise({
      ...scope,
      channelId: solo.id,
      threadId: conversation.errandsThread,
    }),
  ).toBe(false);
});

test("an answer goes into the group, and the Bot that asked answers it there", async () => {
  const conversation = await group();
  const { tool } = await askPerson(
    conversation.errands,
    conversation.errandsThread,
  );
  await tool.execute({ question: QUESTION });
  const [question] = await waiting(conversation.channelId);
  if (!question) throw new Error("the question was not saved");
  answeredIds.push(question.id);

  const answered = await approvals.request(
    `/api/approvals/questions/${question.id}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: ANSWER }),
    },
  );
  expect(answered.status).toBe(200);

  // Answered: nothing waits on the person any more, so the badge has nothing to count.
  expect(await waiting(conversation.channelId)).toEqual([]);
  // Their words are in the shared transcript, as their own message.
  const before = await conversations.list(owner, conversation.channelId);
  expect(before.messages.at(-1)).toMatchObject({
    agentId: null,
    ownerUserId: owner,
    text: ANSWER,
  });
  // Not resumed out of sight in the Bot's own thread.
  const resumed = await database
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, "person.response"),
        eq(workItems.key, question.id),
      ),
    );
  expect(resumed).toEqual([]);

  // The group's next turn is that Bot's alone, told what the answer is to.
  while (await conversations.sweep()) {}
  const here = turns.filter(
    (turn) => turn.routineId === `group:${conversation.channelId}`,
  );
  expect(here.map((turn) => turn.agentId)).toEqual([conversation.errands]);
  expect(here[0]?.threadId).toBe(conversation.errandsThread);
  expect(here[0]?.instruction).toContain(
    `In response to your question: ${QUESTION}\n\n${ANSWER}`,
  );
  const after = await conversations.list(owner, conversation.channelId);
  expect(after.messages.at(-1)).toMatchObject({
    agentId: conversation.errands,
    status: "completed",
    text: "Do downtown first, then Riverside on the way home.",
  });
});
