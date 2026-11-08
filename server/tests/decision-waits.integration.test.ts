import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AbstractAgent,
  type BaseEvent,
  EventType,
  type Message,
  type RunAgentInput,
} from "@ag-ui/client";
import { eq, inArray, like } from "drizzle-orm";
import { Observable } from "rxjs";
import { createActivityStore } from "../src/activity/activity";
import {
  createDecisionWaits,
  DECISION_KIND,
  type DecisionWaits,
  watchDecisionWaits,
} from "../src/approvals/decision-waits";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A card a Bot asks with in the conversation (the form, the choice, the approval card) puts the Bot
 * under Needs you for the person whose conversation it is, with that conversation as where the
 * notice opens, and the answer in the next run takes it off again.
 *
 * Against a real PostgreSQL, through the watch `mountCopilotRuntime` puts on the runtime's runner.
 * The runner is the stand-in, and it does what the Intelligence runner does with a run: it runs the
 * run's agent in place with `runAgent` and passes on only the run's start and its error, sending the
 * rest to the platform. The agent is a real AG-UI agent streaming what a Bot streams when it calls a
 * card: the call's start, its arguments, its end, and the run finishing with the call unanswered.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `decision-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const conversation = `${prefix}-conversation`;
const deleted = `${prefix}-deleted`;
const othersConversation = `${prefix}-others`;
const threadOf = (channelId: string) => `${channelId}-thread`;

/** A Bot that calls one tool and finishes its run waiting on it, as a Bot calling a card does. */
class CallingAgent extends AbstractAgent {
  constructor(
    private readonly call: { id: string; name: string; args: unknown },
  ) {
    super({ agentId: bot });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    const { id, name, args } = this.call;
    return new Observable<BaseEvent>((observer) => {
      const events = [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
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
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ] as BaseEvent[];
      for (const event of events) observer.next(event);
      observer.complete();
    });
  }
}

/** A Bot that answers in words, for the run that carries the person's answer. */
class ReplyingAgent extends AbstractAgent {
  constructor() {
    super({ agentId: bot });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      for (const event of [
        {
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        },
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: `${input.runId}-reply`,
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: `${input.runId}-reply`,
          delta: "Thanks.",
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: `${input.runId}-reply` },
        {
          type: EventType.RUN_FINISHED,
          threadId: input.threadId,
          runId: input.runId,
        },
      ] as BaseEvent[])
        observer.next(event);
      observer.complete();
    });
  }
}

type RunRequest = {
  threadId: string;
  agent: AbstractAgent;
  input: RunAgentInput;
};

/** The runtime's runner, as far as a run's events go: see the file's comment. */
function intelligenceLikeRunner() {
  const runner = {
    run(request: RunRequest): Observable<BaseEvent> {
      return new Observable<BaseEvent>((observer) => {
        void request.agent
          .runAgent(request.input, {
            onEvent: ({ event }) => {
              if (
                event.type === EventType.RUN_STARTED ||
                event.type === EventType.RUN_ERROR
              )
                observer.next(event);
            },
          })
          .then(
            () => observer.complete(),
            (error) => observer.error(error),
          );
      });
    },
    runWithStartupBoundary(request: RunRequest) {
      return { events: runner.run(request), startup: Promise.resolve() };
    },
  };
  return runner;
}

/** The real store, with each write it is asked for kept, so a test can wait for them. */
const writes: Promise<void>[] = [];
const store = createDecisionWaits(database);
const tracked: DecisionWaits = {
  opened: (input) => {
    const write = store.opened(input);
    writes.push(write);
    return write;
  },
  answered: (threadId, ids) => {
    const write = store.answered(threadId, ids);
    writes.push(write);
    return write;
  },
};
const runner = intelligenceLikeRunner();
watchDecisionWaits(runner, tracked);
const activity = createActivityStore(database);

/** Run one turn the way the runtime does, and wait for what the watch writes. */
async function runTurn(
  channelId: string,
  agent: AbstractAgent,
  messages: Message[],
  way: "run" | "startup" = "run",
) {
  const threadId = threadOf(channelId);
  const request = {
    threadId,
    agent,
    input: {
      threadId,
      runId: randomUUID(),
      messages,
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    } satisfies RunAgentInput,
  };
  const events =
    way === "run"
      ? runner.run(request)
      : (
          runner.runWithStartupBoundary(request) as {
            events: Observable<BaseEvent>;
          }
        ).events;
  await new Promise<void>((resolve, reject) =>
    events.subscribe({ complete: resolve, error: reject }),
  );
  // The writes go beside the run, never in its way; wait for them before reading.
  await Promise.all(writes.splice(0));
}

/** The assistant message a card's call is stored as, and the person's answer to it. */
const askedWith = (id: string, name: string, args: unknown): Message => ({
  id: `${id}-message`,
  role: "assistant",
  toolCalls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const answer = (id: string, content: unknown): Message => ({
  id: `${id}-answer`,
  role: "tool",
  toolCallId: id,
  content: JSON.stringify(content),
});

const botRow = async (person: string) =>
  (await activity.attention(person)).find((row) => row.agentId === bot);

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values({
    id: bot,
    name: "Asking Bot",
    type: "built_in",
    configuration: {},
  });
  await database.insert(channels).values(
    [conversation, deleted, othersConversation].map((id) => ({
      id,
      name: id,
      description: "",
    })),
  );
  await database.insert(channelMemberships).values([
    { channelId: conversation, userId: owner },
    { channelId: deleted, userId: owner },
    { channelId: othersConversation, userId: other },
  ]);
  await database.insert(channelAgents).values([
    { channelId: conversation, agentId: bot },
    { channelId: deleted, agentId: bot },
    { channelId: othersConversation, agentId: bot },
  ]);
  await database.insert(intelligenceChannelMappings).values([
    {
      userId: owner,
      channelId: conversation,
      threadId: threadOf(conversation),
    },
    { userId: owner, channelId: deleted, threadId: threadOf(deleted) },
    {
      userId: other,
      channelId: othersConversation,
      threadId: threadOf(othersConversation),
    },
  ]);
});

afterAll(async () => {
  await database.delete(workItems).where(like(workItems.key, `${prefix}%`));
  await database
    .delete(channels)
    .where(inArray(channels.id, [conversation, deleted, othersConversation]));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.$client.close();
});

describe("a card the Bot asks with in the conversation", () => {
  test("a form it waits on counts as a question in that conversation, and the answer clears it", async () => {
    const id = `${prefix}-form`;
    const form = {
      title: "Plan your next project",
      fields: [{ id: "team", label: "Team name", type: "text" }],
    };
    await runTurn(
      conversation,
      new CallingAgent({ id, name: "askForm", args: form }),
      [{ id: `${id}-ask`, role: "user", content: "Help me plan" }],
    );

    expect(await botRow(owner)).toMatchObject({ questions: 1, approvals: 0 });
    expect((await activity.waitingIn(owner)).get(bot)).toBe(conversation);
    // Nobody else's: the other person's Bot row is not raised by it.
    expect((await botRow(other))?.questions ?? 0).toBe(0);
    // The Bot's own page lists it, so the count is never one the page can't show.
    const listed = (await activity.forBot(owner, bot)).inProgress.find(
      (item) => item.kind === "question",
    );
    expect(listed).toMatchObject({
      title: "Plan your next project",
      channelId: conversation,
      needsYou: true,
    });

    await runTurn(conversation, new ReplyingAgent(), [
      { id: `${id}-ask`, role: "user", content: "Help me plan" },
      askedWith(id, "askForm", form),
      answer(id, { status: "submitted", values: { team: "Ops" } }),
    ]);

    expect((await botRow(owner))?.questions ?? 0).toBe(0);
    expect((await activity.waitingIn(owner)).has(bot)).toBe(false);
  });

  test("an approval card counts as an approval, through the runner's startup way in too", async () => {
    const id = `${prefix}-approval`;
    const card = { title: "Refund this order?", approveLabel: "Refund" };
    await runTurn(
      conversation,
      new CallingAgent({ id, name: "askApproval", args: card }),
      [{ id: `${id}-ask`, role: "user", content: "Refund it" }],
      "startup",
    );

    expect(await botRow(owner)).toMatchObject({ questions: 0, approvals: 1 });
    expect((await activity.waitingIn(owner)).get(bot)).toBe(conversation);

    await runTurn(
      conversation,
      new ReplyingAgent(),
      [
        { id: `${id}-ask`, role: "user", content: "Refund it" },
        askedWith(id, "askApproval", card),
        answer(id, { decision: "approved" }),
      ],
      "startup",
    );

    expect((await botRow(owner))?.approvals ?? 0).toBe(0);
  });

  test("a call to any other tool the browser answers is not a card waiting on the person", async () => {
    await runTurn(
      conversation,
      new CallingAgent({
        id: `${prefix}-chart`,
        name: "showChart",
        args: { title: "Revenue" },
      }),
      [],
    );
    expect((await botRow(owner))?.questions ?? 0).toBe(0);
  });

  test("an answer that reaches the server before the asking run was saved still closes it", async () => {
    const id = `${prefix}-early`;
    const choice = { title: "Which environment?", options: [] };
    // The answer's run first, as when the browser answers the card on its own at once.
    await runTurn(conversation, new ReplyingAgent(), [
      askedWith(id, "askChoice", choice),
      answer(id, { choice: "staging" }),
    ]);
    // Then the asking run is saved, late.
    await store.opened({
      threadId: threadOf(conversation),
      runId: "late",
      botId: bot,
      calls: [{ toolCallId: id, toolName: "askChoice", title: "Which?" }],
    });
    expect((await botRow(owner))?.questions ?? 0).toBe(0);
  });

  test("a card in a conversation that was deleted no longer counts", async () => {
    const id = `${prefix}-deleted-card`;
    await runTurn(
      deleted,
      new CallingAgent({
        id,
        name: "askChoice",
        args: { title: "Which one?", options: [] },
      }),
      [],
    );
    expect(await botRow(owner)).toMatchObject({ questions: 1 });
    await database
      .update(channels)
      .set({ deletedAt: new Date() })
      .where(eq(channels.id, deleted));
    expect((await botRow(owner))?.questions ?? 0).toBe(0);
    const [saved] = await database
      .select({ kind: workItems.kind })
      .from(workItems)
      .where(eq(workItems.key, `${threadOf(deleted)}:${id}`));
    expect(saved?.kind).toBe(DECISION_KIND);
  });
});
