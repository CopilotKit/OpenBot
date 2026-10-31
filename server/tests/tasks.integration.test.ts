import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type BaseEvent,
  EventType,
  HttpAgent,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { createTurnRunner, type RunnerLike } from "@openbot/toolkit/run-turn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { Observable } from "rxjs";
import { createActivityStore } from "../src/activity/activity";
import { createBotLifecycleStore } from "../src/agents/lifecycle";
import { createBotLifecycleRoutes } from "../src/agents/lifecycle-routes";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createApprovalResumeTick } from "../src/approvals/resume-sweep";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import { currentApprovalContext } from "../src/approvals/types";
import { PERSON_INITIATOR } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  approvalRequests,
  botTasks,
  channelAgents,
  channelMemberships,
  channels,
  proactiveSettings,
  proactiveSuggestions,
  users,
  workItems,
} from "../src/db/schema";
import type { AttentionResponse } from "../src/proactive/contracts";
import { createProactiveStore } from "../src/proactive/store";
import type { ResponsibilityStore } from "../src/responsibilities/types";
import { createTaskRoutes } from "../src/tasks/routes";
import { createTaskRunner } from "../src/tasks/runner";
import { PROACTIVE_TASK_KIND } from "../src/tasks/state";
import { createTaskStore } from "../src/tasks/store";
import { createTaskTurn } from "../src/tasks/turn";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Tasks through the paths a person's Start takes: the real stores, the real work queue, the real
 * turn runner and the real approval gate against PostgreSQL. The model is the only fake, a scripted
 * AG-UI agent that answers, calls a tool or errors as a real one would; the mail app it writes to is
 * a connector fake at the tool boundary, behind the same approval gate a granted app's call meets.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const proactive = createProactiveStore(database);
const queue = createWorkQueue(database);
const approvalStore = createApprovalStore(database);
const approvalService = createApprovalService(approvalStore);
const taskStore = createTaskStore(database);
const prefix = `tasks-${randomUUID()}`;
const people: string[] = [];
const bots: string[] = [];

const actorFor = async (id: string): Promise<AgentActor> => ({
  id,
  role: "user",
});

/* ------------------------------------------------------------------------------------------------
 * The model: a scripted AG-UI agent, one script for the test running now.
 * ---------------------------------------------------------------------------------------------- */

const lifecycle = (input: RunAgentInput, body: BaseEvent[]) =>
  [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    ...body,
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    },
  ] as BaseEvent[];
const reply = (input: RunAgentInput, text: string) =>
  lifecycle(input, [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "reply",
      role: "assistant",
    },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "reply", delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId: "reply" },
  ] as BaseEvent[]);
const callTool = (
  input: RunAgentInput,
  name: string,
  args: unknown,
  id = "call",
) =>
  lifecycle(input, [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: id,
      toolCallName: name,
      parentMessageId: `${id}-message`,
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: id,
      delta: JSON.stringify(args),
    },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ] as BaseEvent[]);
/** A provider that is down, as the runner hears it: the run starts and errors. */
const providerDown = (input: RunAgentInput) =>
  [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    },
    {
      type: EventType.RUN_ERROR,
      message: "The model provider is unavailable (503).",
    },
  ] as BaseEvent[];

let script: (input: RunAgentInput) => BaseEvent[] = (input) =>
  reply(input, "Done.");
const asked: RunAgentInput[] = [];
const persisted: Message[][] = [];
const initiators: unknown[] = [];

const runner: RunnerLike = {
  run: ({ agent, input, persistedInputMessages }) => {
    persisted.push(persistedInputMessages ?? []);
    return new Observable((subscriber) => {
      agent
        .runAgent(input, { onEvent: ({ event }) => subscriber.next(event) })
        .then(
          () => subscriber.complete(),
          (error) => subscriber.error(error),
        );
    });
  },
  stop: async () => true,
};

/* ------------------------------------------------------------------------------------------------
 * The mail app, at the tool boundary: every send meets the approval gate first.
 * ---------------------------------------------------------------------------------------------- */

const sent: unknown[] = [];
const read: unknown[] = [];
/** A read meets the same gate, as every granted app's call does, and runs without asking. */
async function readInbox(args: unknown, actorId: string, botId: string) {
  await approvalService.gate({
    actorId,
    botId,
    toolRef: "mail/list_messages",
    effect: "read",
    scope: "mail",
    args,
    continuation: currentApprovalContext(),
  });
  read.push(args);
  return "Sam: can you send the spec by Friday?";
}
async function sendMessage(args: unknown, actorId: string, botId: string) {
  const approval = await approvalService.gate({
    actorId,
    botId,
    toolRef: "mail/send_message",
    effect: "write",
    scope: "mail",
    args,
    continuation: currentApprovalContext(),
  });
  if (approval && "replay" in approval) return approval.replay;
  sent.push(args);
  await approval?.complete("Sent.");
  return "Sent.";
}

/** The approval continuation runner, as index.ts builds it, with the model and the platform faked. */
const runTurn = createTurnRunner({
  admission: serverTurnAdmission,
  intelligence: {
    getOrCreateThread: async () => undefined,
    getThreadMessages: async () => ({ messages: [] }),
    ɵacquireThreadLock: async () => undefined,
    ɵrenewThreadLock: async () => undefined,
    ɵcleanupThreadLock: async () => undefined,
  },
  runner,
  buildAgentFor: async ({ initiator }) => {
    initiators.push(initiator);
    return new HttpAgent({
      agentId: "bot",
      url: "https://agent.example/ag-ui",
      fetch: async (_url, init) => {
        const input = JSON.parse(String(init?.body)) as RunAgentInput;
        asked.push(input);
        return new Response(
          script(input)
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
  },
  toolsForTurn: async ({ ownerUserId, agentId }) => [
    {
      definition: {
        name: "send_message",
        description: "Send an email.",
        parameters: {
          type: "object",
          properties: { to: { type: "string" }, body: { type: "string" } },
          required: ["to", "body"],
        },
      },
      execute: (args) => sendMessage(args, ownerUserId, agentId),
    },
    {
      definition: {
        name: "read_inbox",
        description: "Search the inbox.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      execute: (args) => readInbox(args, ownerUserId, agentId),
    },
  ],
});

/** Where a turn runs, by the rule index.ts's `deliveryScopeFor` uses. */
const scopeFor = async (
  ownerUserId: string,
  channelId: string,
  agentId: string,
) => {
  const actor = await actorFor(ownerUserId);
  const [channel, bot] = await Promise.all([
    channelStore.get(actor, channelId),
    profileStore.get(actor, agentId),
  ]);
  return channel?.active && bot && channel.agentIds.includes(agentId)
    ? { ownerUserId, channelId, agentId, threadId: channel.threadId }
    : null;
};

const tasks = createTaskRunner({
  database,
  store: taskStore,
  channels: channelStore,
  actorFor,
  queue,
  owner: `${prefix}-worker`,
  scopeFor,
  runTask: createTaskTurn({ channels: channelStore, actorFor, runTurn }),
  retryMs: 0,
});

const resumeApproval = createApprovalResumeTick({
  approvalQueue: queue,
  approvalOwner: `${prefix}-approval`,
  approvalService,
  executeApprovedAction: (action) =>
    sendMessage(action.args, action.actorId, action.botId),
  database,
  // Read only for a responsibility's waiting run, which these turns never are.
  responsibilityStore: {} as ResponsibilityStore,
  // Not a group conversation: carried on as one Bot's, as the real one does for these.
  groupConversations: { continueWaiting: (_approvalId, run) => run() },
  approvalContinuationRunner: runTurn,
  channelStore,
  actorFor,
  notify: async () => undefined,
});

const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/tasks",
  createTaskRoutes(taskStore, tasks, async (context, next) => {
    const id = context.req.header("x-test-user") ?? "";
    context.set("actor", { id, email: `${id}@example.test`, role: "user" });
    await next();
  }),
);
const call = (user: string, path: string, method = "GET") =>
  app.request(`/api/tasks${path}`, {
    method,
    headers: { "x-test-user": user },
  });

/* ------------------------------------------------------------------------------------------------
 * A person, their Bot, their own conversation with it, and an item a check-in raised.
 * ---------------------------------------------------------------------------------------------- */

async function person() {
  const id = `${prefix}-person-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, name: "Task Test Person" });
  people.push(id);
  return actorFor(id);
}

async function seed(
  item: { title?: string; detail?: string; sourceLink?: string } = {},
) {
  const owner = await person();
  const bot = await profileStore.create(owner, {
    name: "Assistant",
    title: "Research",
    roleDescription: "Find things out.",
    visibility: "private",
  });
  bots.push(bot.id);
  const own = await channelStore.direct(owner, bot.id);
  const settingId = randomUUID();
  await database.insert(proactiveSettings).values({
    id: settingId,
    ownerUserId: owner.id,
    agentId: bot.id,
    channelId: own.id,
    threadId: `${prefix}-check-ins-${randomUUID()}`,
  });
  const [raised] = await database
    .insert(proactiveSuggestions)
    .values({
      id: randomUUID(),
      ownerUserId: owner.id,
      agentId: bot.id,
      settingId,
      runId: `${prefix}-run`,
      title: item.title ?? "Reply to Sam about the spec",
      detail:
        item.detail ??
        "Sam asked for the spec by Friday.\n\nA short reply with the date would do.",
      sourceApp: "Gmail",
      sourceRef: "gmail/search",
      sourceLink: item.sourceLink ?? "https://mail.example.test/m/1",
    })
    .returning();
  if (!raised) throw new Error("No item.");
  return { owner, botId: bot.id, own, item: raised };
}

/** Start, as `POST /api/proactive/suggestions/:id/start` does it: the item once, then its task. */
async function start(owner: AgentActor, itemId: string) {
  const item = await proactive.resolveSuggestion(owner.id, itemId, "started");
  return tasks.startFromItem({ ownerUserId: owner.id, item });
}

async function conversation(channelId: string) {
  const [row] = await database
    .select()
    .from(channels)
    .where(eq(channels.id, channelId));
  return row;
}

afterAll(async () => {
  await tasks.idle();
  const theirs = await database
    .select({ id: channelMemberships.channelId })
    .from(channelMemberships)
    .where(inArray(channelMemberships.userId, people));
  const approvals = await database
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(inArray(approvalRequests.ownerUserId, people));
  await database
    .delete(workItems)
    .where(
      sql`${workItems.payload}->>'ownerUserId' in ${people} or (${workItems.kind} = 'approval.resume' and ${workItems.key} in ${approvals.length ? approvals.map((row) => row.id) : [""]})`,
    );
  if (theirs.length)
    await database.delete(channels).where(
      inArray(
        channels.id,
        theirs.map((row) => row.id),
      ),
    );
  await database.delete(users).where(inArray(users.id, people));
  await database
    .delete(agentProfiles)
    .where(inArray(agentProfiles.agentId, bots));
  await database.delete(agents).where(inArray(agents.id, bots));
  await database.$client.close();
});

describe("Start on an item", () => {
  test("opens one task in a new conversation with the Bot, where the ask runs as the person's own turn", async () => {
    const { owner, botId, own, item } = await seed();
    script = (input) =>
      reply(
        input,
        "I read Sam's email. Here is a reply that gives Friday as the date.\n\nShall I send it?",
      );
    const from = asked.length;

    const task = await start(owner, item.id);
    await tasks.idle();

    // A conversation of its own, with this Bot alone, and not the one the person chats in.
    expect(task.channelId).not.toBe(own.id);
    const roster = await database
      .select({ agentId: channelAgents.agentId })
      .from(channelAgents)
      .where(eq(channelAgents.channelId, task.channelId));
    expect(roster).toEqual([{ agentId: botId }]);
    const [row] = await database
      .select()
      .from(botTasks)
      .where(eq(botTasks.id, task.id));
    expect(row).toMatchObject({
      ownerUserId: owner.id,
      agentId: botId,
      channelId: task.channelId,
      suggestionId: item.id,
      title: "Reply to Sam about the spec",
      why: "Sam asked for the spec by Friday.",
      sourceApp: "Gmail",
      origin: "check_in",
    });

    // The ask is the person's message in that conversation, run as their turn.
    const ask =
      "Reply to Sam about the spec\n\nSam asked for the spec by Friday.\n\nA short reply with the date would do.\n\nSource: https://mail.example.test/m/1";
    expect(asked.length - from).toBe(1);
    expect(asked.at(-1)?.messages.at(-1)).toMatchObject({
      role: "user",
      content: ask,
    });
    expect(persisted.at(-1)).toEqual([
      { id: `task-${task.id}`, role: "user", content: ask },
    ]);
    expect(initiators.at(-1)).toEqual({ kind: "person" });
    expect(await conversation(task.channelId)).toMatchObject({
      lastMessage:
        "Here is a reply that gives Friday as the date. Shall I send it?",
      lastMessageAgentId: botId,
    });

    const listed = await taskStore.get(owner.id, task.id);
    expect(listed).toMatchObject({
      status: "ready_for_review",
      next: "Here is a reply that gives Friday as the date. Shall I send it?",
      failure: null,
    });

    // A second Start is refused, and opens nothing.
    await expect(start(owner, item.id)).rejects.toThrow(
      "already started or dismissed",
    );
    expect(asked.length - from).toBe(1);
    expect(
      await database
        .select({ id: botTasks.id })
        .from(botTasks)
        .where(eq(botTasks.ownerUserId, owner.id)),
    ).toHaveLength(1);

    // The person's own conversation with the Bot is still the one anything else finds, though the
    // task's is newer.
    expect((await channelStore.direct(owner, botId)).id).toBe(own.id);
    // And their list says which is the task's, so choosing where check-ins reach them leaves it out.
    const { channels: listedChannels } = await channelStore.list(owner);
    expect(
      Object.fromEntries(
        listedChannels.map((channel) => [channel.id, channel.task]),
      ),
    ).toEqual({ [own.id]: false, [task.channelId]: true });
  });

  test("started twice at once, an item opens one task and one conversation, and runs its turn once", async () => {
    const { owner, botId, item } = await seed();
    script = (input) => reply(input, "The reply to Sam is drafted.");
    const from = asked.length;

    const [first, second] = await Promise.all([
      tasks.startFromItem({ ownerUserId: owner.id, item }),
      tasks.startFromItem({ ownerUserId: owner.id, item }),
    ]);
    await tasks.idle();

    expect(second).toEqual(first);
    const conversations = await database
      .select({ id: channelAgents.channelId })
      .from(channelAgents)
      .innerJoin(
        channelMemberships,
        eq(channelMemberships.channelId, channelAgents.channelId),
      )
      .where(
        and(
          eq(channelAgents.agentId, botId),
          eq(channelMemberships.userId, owner.id),
        ),
      );
    // Their own conversation and the task's: the losing Start's conversation was rolled back.
    expect(conversations).toHaveLength(2);
    expect(asked.length - from).toBe(1);
  });
});

describe("where a task stands", () => {
  test("a turn that stops on an approval needs input, and deciding it carries the conversation on to ready for review", async () => {
    const { owner, item } = await seed();
    await approvalStore.setEnabled(owner.id, true);
    script = (input) =>
      input.messages.at(-1)?.role === "tool"
        ? reply(input, "I sent your reply to Sam.")
        : callTool(input, "send_message", {
            to: "sam@example.test",
            body: "Friday works for the spec.",
          });
    const before = sent.length;

    const task = await start(owner, item.id);
    await tasks.idle();

    const waiting = await taskStore.get(owner.id, task.id);
    expect(waiting.status).toBe("needs_input");
    expect(sent.length).toBe(before);
    expect(await conversation(task.channelId)).toMatchObject({
      lastMessage: "This action is waiting for your approval.",
    });
    // Stopping for the person is not failing: the turn is done, and is not run again.
    const [turn] = await database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, PROACTIVE_TASK_KIND),
          eq(workItems.key, item.id),
        ),
      );
    expect(turn?.finishedAt).not.toBeNull();
    const [request] = await database
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.ownerUserId, owner.id),
          eq(approvalRequests.status, "pending"),
        ),
      );
    if (!request) throw new Error("No approval was asked for.");
    expect(request.action.threadId).toBe(waiting.threadId ?? "");
    // Its next step is what it waits for, in the words of the approval card in its conversation.
    expect(waiting.next).toBe(
      "Waiting for your approval: send message on Mail",
    );
    // Still that, once the person has said something there, never their own words back to them.
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Also copy Ana on it.",
      agentId: null,
      at: new Date(),
    });
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "needs_input",
      next: "Waiting for your approval: send message on Mail",
    });

    await approvalService.decide(owner.id, request.id, "allow_once");
    // Decided, and being carried out: nothing waits on the person now.
    expect((await taskStore.get(owner.id, task.id)).status).toBe("working");

    for (let tick = 0; tick < 10; tick += 1) {
      await resumeApproval();
      if (
        (await approvalStore.get(owner.id, request.id)).status === "completed"
      )
        break;
    }
    expect(sent.length).toBe(before + 1);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      next: "I sent your reply to Sam.",
    });
  });

  test("a task asks before every change though Ask before making changes is off, its reads run freely, and the person's own conversation is unchanged", async () => {
    const { owner, botId, own, item } = await seed();
    // The deployment's default: off, and the person never turned it on.
    expect(await approvalStore.enabled(owner.id)).toBe(false);
    const toSam = {
      to: "sam@example.test",
      body: "Friday works for the spec.",
    };
    script = (input) => {
      const answered = input.messages.filter(
        (message) => message.role === "tool",
      ).length;
      return answered === 0
        ? callTool(input, "read_inbox", { query: "from:sam" }, "read")
        : answered === 1
          ? callTool(input, "send_message", toSam, "send")
          : reply(input, "I sent your reply to Sam.");
    };
    const [readBefore, sentBefore] = [read.length, sent.length];

    const task = await start(owner, item.id);
    await tasks.idle();
    // The read ran without asking; the send did not run, and waits for the person.
    expect(read.length).toBe(readBefore + 1);
    expect(sent.length).toBe(sentBefore);
    const waiting = await database
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.ownerUserId, owner.id),
          eq(approvalRequests.status, "pending"),
        ),
      );
    expect(waiting.map((request) => request.action.policy)).toEqual([
      {
        behaviour: "ask",
        source: "task",
        reason: "Tasks started from a check-in ask before every change.",
      },
    ]);
    expect(waiting[0]?.action).toMatchObject({
      toolRef: "mail/send_message",
      args: toSam,
    });
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "needs_input",
      next: "Waiting for your approval: send message on Mail",
    });
    // A standing rule would be ignored by the next task, so none is saved from one: once, or no.
    await expect(
      approvalService.decide(owner.id, waiting[0]?.id ?? "", "allow_always"),
    ).rejects.toThrow(
      "Tasks started from a check-in ask before every change. Allow this once, or deny it.",
    );
    expect(await approvalStore.rules(owner.id)).toEqual([]);
    expect(
      (await approvalStore.get(owner.id, waiting[0]?.id ?? "")).status,
    ).toBe("pending");

    // The same send in the person's own conversation with the Bot goes, as their switch says.
    await runTurn({
      ownerUserId: owner.id,
      routineId: `${prefix}-own-${randomUUID()}`,
      agentId: botId,
      threadId: own.threadId,
      instruction: "Reply to Sam.",
      userMessage: { id: randomUUID(), role: "user", content: "Reply to Sam." },
      initiator: PERSON_INITIATOR,
    });
    expect(sent.length).toBe(sentBefore + 1);
    expect(
      await database
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.ownerUserId, owner.id),
            eq(approvalRequests.status, "pending"),
          ),
        ),
    ).toHaveLength(1);
  });

  test("a turn that fails twice reads failed, says so in its conversation, and Try again runs once however often it is pressed", async () => {
    const { owner, item } = await seed();
    script = providerDown;
    const from = asked.length;

    const task = await start(owner, item.id);
    await tasks.idle();

    // Run once, and once more after the throw: then it has failed.
    expect(asked.length - from).toBe(2);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "failed",
      failure: "a service didn't answer",
    });
    expect(await conversation(task.channelId)).toMatchObject({
      lastMessage: "I couldn't finish this: a service didn't answer.",
    });
    expect(await (await call(owner.id, "")).json()).toMatchObject({
      tasks: [{ id: task.id, status: "failed" }],
    });

    script = (input) => reply(input, "The reply to Sam is drafted.");
    const pressed = await Promise.all([
      call(owner.id, `/${task.id}/again`, "POST"),
      call(owner.id, `/${task.id}/again`, "POST"),
    ]);
    await tasks.idle();
    expect(pressed.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(asked.length - from).toBe(3);
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      failure: null,
      next: "The reply to Sam is drafted.",
    });
    // Pressed again once it no longer failed, it is refused too.
    expect((await call(owner.id, `/${task.id}/again`, "POST")).status).toBe(
      409,
    );
  });

  test("marked done reads resolved, and a turn accepted after it reopens it", async () => {
    const { owner, item } = await seed();
    script = providerDown;
    const task = await start(owner, item.id);
    await tasks.idle();
    expect((await taskStore.get(owner.id, task.id)).status).toBe("failed");

    // Done with it as it is: resolved, keeping why it failed for Reopen.
    const done = await (
      await call(owner.id, `/${task.id}/resolve`, "POST")
    ).json();
    expect(done.task).toMatchObject({
      status: "resolved",
      failure: "a service didn't answer",
    });
    expect(done.task.resolvedAt).not.toBeNull();
    expect((await taskStore.list(owner.id)).map((row) => row.id)).toEqual([
      task.id,
    ]);

    // Try again after it: a turn accepted after the "done" supersedes it.
    script = (input) => reply(input, "The reply to Sam is drafted.");
    await tasks.again(owner.id, task.id);
    await tasks.idle();
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      resolvedAt: null,
    });
  });

  test("marked done stays done when earlier work is said after it, and reopens when the person speaks there", async () => {
    const { owner, botId, item } = await seed();
    script = (input) => reply(input, "The reply to Sam is drafted.");
    const task = await start(owner, item.id);
    await tasks.idle();

    expect((await taskStore.resolve(owner.id, task.id)).status).toBe(
      "resolved",
    );
    // The Bot carrying on work the person accepted before: its lines name their run.
    await Bun.sleep(5);
    await channelStore.recordActivity(
      owner,
      task.channelId,
      { text: "I also saved the draft.", agentId: botId, at: new Date() },
      { id: `approval:${randomUUID()}` },
    );
    expect((await taskStore.get(owner.id, task.id)).status).toBe("resolved");

    // The person speaking in it, from the browser, which names no run.
    await Bun.sleep(5);
    await channelStore.recordActivity(owner, task.channelId, {
      text: "Also copy Ana on it.",
      agentId: null,
      at: new Date(),
    });
    expect(await taskStore.get(owner.id, task.id)).toMatchObject({
      status: "ready_for_review",
      resolvedAt: null,
      next: "“Also copy Ana on it.”",
    });

    // Reopen undoes a "done" by hand.
    await taskStore.resolve(owner.id, task.id);
    expect((await taskStore.reopen(owner.id, task.id)).status).toBe(
      "ready_for_review",
    );
  });

  test("another person's task is answered like no task", async () => {
    const { owner, botId, item } = await seed();
    script = (input) => reply(input, "The reply to Sam is drafted.");
    const task = await start(owner, item.id);
    await tasks.idle();
    const stranger = await person();

    for (const [path, method] of [
      [`/${task.id}`, "GET"],
      [`/${task.id}/resolve`, "POST"],
      [`/${task.id}/reopen`, "POST"],
      [`/${task.id}/again`, "POST"],
      [`/${randomUUID()}`, "GET"],
    ] as const) {
      const response = await call(stranger.id, path, method);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Couldn't find that task.",
      });
    }
    expect(await (await call(stranger.id, "")).json()).toEqual({
      tasks: [],
    });
    expect(await tasks.counts(stranger.id)).toEqual([]);
    // Untouched for its owner.
    expect(await tasks.counts(owner.id)).toEqual([
      { agentId: botId, needsInput: 0, ready: 1, failed: 0 },
    ]);
    expect((await taskStore.get(owner.id, task.id)).status).toBe(
      "ready_for_review",
    );
  });

  test("a task whose turn never reached the queue reads failed after a minute, and Try again runs its ask", async () => {
    const { owner, botId, item } = await seed();
    await proactive.resolveSuggestion(owner.id, item.id, "started");
    // The task committed, and the process stopped before its turn was queued.
    const opened = await channelStore.create(owner, [botId]);
    const id = randomUUID();
    await database.insert(botTasks).values({
      id,
      ownerUserId: owner.id,
      agentId: botId,
      channelId: opened.id,
      suggestionId: item.id,
      title: item.title,
      why: "Sam asked for the spec by Friday.",
      sourceApp: "Gmail",
      sourceLink: item.sourceLink,
      origin: "check_in",
      createdAt: new Date(Date.now() - 2 * 60_000),
    });
    expect(await taskStore.get(owner.id, id)).toMatchObject({
      status: "failed",
      failure: "it never started",
    });

    script = (input) => reply(input, "The reply to Sam is drafted.");
    const from = asked.length;
    await tasks.again(owner.id, id);
    await tasks.idle();
    expect(asked.length - from).toBe(1);
    expect(asked.at(-1)?.messages.at(-1)).toMatchObject({
      role: "user",
      content:
        "Reply to Sam about the spec\n\nSam asked for the spec by Friday.\n\nSource: https://mail.example.test/m/1",
    });
    expect((await taskStore.get(owner.id, id)).status).toBe("ready_for_review");
  });
});

describe("a turn queued by a Start from before tasks", () => {
  test("gets its task when it runs, and runs there, never in the person's own conversation", async () => {
    const { owner, own, item } = await seed();
    await proactive.resolveSuggestion(owner.id, item.id, "started");
    // As the Start before tasks queued it: the item's id, and nothing else.
    await queue.offer({
      kind: PROACTIVE_TASK_KIND,
      key: item.id,
      payload: { ownerUserId: owner.id, suggestionId: item.id },
    });
    script = (input) => reply(input, "The reply to Sam is drafted.");
    const from = asked.length;

    await tasks.sweep();
    await tasks.idle();

    const task = await taskStore.byItem(owner.id, item.id);
    if (!task) throw new Error("No task was opened.");
    expect(task.channelId).not.toBe(own.id);
    expect(asked.length - from).toBe(1);
    expect((await conversation(own.id))?.lastMessage).toBeNull();
    expect((await taskStore.get(owner.id, task.id)).status).toBe(
      "ready_for_review",
    );
  });

  test("that already failed once under the old one-try rule is not run again", async () => {
    const { owner, item } = await seed();
    await proactive.resolveSuggestion(owner.id, item.id, "started");
    await database.insert(workItems).values({
      kind: PROACTIVE_TASK_KIND,
      key: item.id,
      payload: { ownerUserId: owner.id, suggestionId: item.id },
      attempts: 1,
      lastError: "The model provider is unavailable (503).",
    });
    const from = asked.length;

    await tasks.sweep().catch(() => undefined);
    await tasks.idle();

    expect(asked.length - from).toBe(0);
    expect(await taskStore.byItem(owner.id, item.id)).toBeNull();
    const [left] = await database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, PROACTIVE_TASK_KIND),
          eq(workItems.key, item.id),
        ),
      );
    expect(left).toMatchObject({
      attempts: 2,
      finishedAt: null,
      lastError: "This turn failed before it could be tried again.",
    });
  });
});

describe("what needs the person", () => {
  test("a task waiting on an approval and a question is counted once, as the task, never again as an approval or a question", async () => {
    const { owner, botId, own, item } = await seed();
    await approvalStore.setEnabled(owner.id, true);
    script = (input) =>
      input.messages.at(-1)?.role === "tool"
        ? reply(input, "I sent your reply to Sam.")
        : callTool(input, "send_message", {
            to: "sam@example.test",
            body: "Friday works for the spec.",
          });
    const task = await start(owner, item.id);
    await tasks.idle();
    const waiting = await taskStore.get(owner.id, task.id);
    expect(waiting.status).toBe("needs_input");
    const [request] = await database
      .select()
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.ownerUserId, owner.id),
          eq(approvalRequests.status, "pending"),
        ),
      );
    if (!request) throw new Error("No approval was asked for.");
    // The Bot also asked a question in the task's conversation...
    const questionKey = `${prefix}-question-${randomUUID()}`;
    await queue.offer({
      kind: "person.question",
      key: questionKey,
      payload: {
        actorId: owner.id,
        botId,
        channelId: task.channelId,
        threadId: waiting.threadId,
        question: "Which date works?",
      },
    });
    // Asked after the approval, the question is what it now waits for.
    expect((await taskStore.get(owner.id, task.id)).next).toBe(
      "Waiting for your answer: Which date works?",
    );
    // ...and an approval waits in the person's own conversation with it, which is no task's.
    await database.insert(approvalRequests).values({
      ...request,
      id: randomUUID(),
      runId: randomUUID(),
      action: { ...request.action, threadId: own.threadId },
    });

    const lifecycleRoutes = new Hono<{ Variables: AppVariables }>();
    lifecycleRoutes.route(
      "/api/bots",
      createBotLifecycleRoutes(
        {
          lifecycle: createBotLifecycleStore(database),
          reset: {} as never,
          activity: createActivityStore(database),
          wakeUps: {} as never,
          profiles: profileStore,
          tasks,
        },
        async (context, next) => {
          context.set("actor", {
            id: owner.id,
            email: `${owner.id}@example.test`,
            role: "user",
          });
          await next();
        },
      ),
    );
    try {
      const response = await lifecycleRoutes.request("/api/bots/attention");
      const { bots: rows } = (await response.json()) as AttentionResponse;
      const bot = rows.find((row) => row.agentId === botId);
      expect(bot).toMatchObject({
        approvals: 1,
        questions: 0,
        tasks: { needsInput: 1, ready: 0, failed: 0 },
      });
      // What a badge adds up: the task, and the approval in their own conversation.
      expect(
        (bot?.approvals ?? 0) +
          (bot?.questions ?? 0) +
          (bot?.tasks.needsInput ?? 0),
      ).toBe(2);
    } finally {
      await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, "person.question"),
            eq(workItems.key, questionKey),
          ),
        );
    }
  });
});
