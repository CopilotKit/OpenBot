import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AbstractAgent,
  type BaseEvent,
  EventType,
  HttpAgent,
  type RunAgentInput,
} from "@ag-ui/client";
import { readResponsibilityTurn } from "@openbot/shared/responsibility-turn";
import { withApprovalContext } from "@openbot/toolkit/continuation";
import type { RunnerLike } from "@openbot/toolkit/run-turn";
import { and, eq, inArray } from "drizzle-orm";
import { Observable } from "rxjs";
import { createActivityStore } from "../src/activity/activity";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  mcpServers,
  pluginGrants,
  responsibilities,
  responsibilityRuns,
  routines,
  users,
  workItems,
} from "../src/db/schema";
import { useRoutineTools } from "../src/plugins/builtin-routines";
import {
  ALWAYS_ON_APP,
  ensureAlwaysOnApp,
  personalDefaultsDeps,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { useGoalTools } from "../src/responsibilities/chat-tools";
import { RESPONSIBILITY_RUN_KIND } from "../src/responsibilities/engine";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { createServerResponsibilityEngine } from "../src/responsibilities/wiring";
import { createRoutineStore } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A run of a goal that repeats records its result and leaves the goal active.
 *
 * FOUND ON WINDOWS: asked "check the latest OpenBot release every morning and tell me what changed,
 * and run it now", the Personal Assistant made a goal and a daily 08:00 UTC routine that runs it, and
 * ran it. The run met the goal's success criteria, as every run of it would, and called
 * `complete_goal`. The Bot then made a second goal and pointed the routine at that one, which left
 * the Goals page with the same goal twice: one Completed, one active.
 *
 * Real: PostgreSQL; the plugin store with the Routines app added and granted as boot does it, each
 * conversation call made through its `callTool`; the goal and routine stores; the goal engine the
 * server builds (`createServerResponsibilityEngine`) with its work queue and headless turn. The model
 * is a stand-in that does what the Windows model did: it calls `complete_goal` on the goal its run is
 * working on, and `report_goal_progress` with `complete: true`.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const OWNER = `goal-recurring-owner-${suite}`;
const BOT = `goal-recurring-assistant-${suite}`;
const CONVERSATION = {
  id: `goal-recurring-conversation-${suite}`,
  threadId: `goal-recurring-thread-${suite}`,
  title: "Morning OpenBot release check",
} as const;

const pluginStore = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  // Allowed, as a person who has not turned on Ask before acting has it.
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});
const goalStore = createResponsibilityStore(database, {
  resolveTarget: async (ownerUserId, agentId, channelId) => {
    const [row] = await database
      .select({ threadId: intelligenceChannelMappings.threadId })
      .from(intelligenceChannelMappings)
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
          eq(channelAgents.agentId, agentId),
        ),
      )
      .where(
        and(
          eq(intelligenceChannelMappings.userId, ownerUserId),
          eq(intelligenceChannelMappings.channelId, channelId),
        ),
      );
    return row ? { threadId: row.threadId } : null;
  },
});
const routineStore = createRoutineStore(database);

const SUMMARY =
  "v0.3.2 is the latest release, published today: 14 changes, mostly desktop updates.";
const REPLY =
  "OpenBot v0.3.2 is out. It has 14 changes, mostly to how the desktop app updates.";

/** What the stand-in model was sent, request by request. */
const requests: RunAgentInput[] = [];
const replies: string[] = [];
/** Runs before the stand-in answers a goal's run for the first time, as a conversation might. */
let duringRun: (() => Promise<void>) | undefined;

function lifecycle(input: RunAgentInput, body: BaseEvent[]): BaseEvent[] {
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent,
    ...body,
    {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent,
  ];
}

/** One assistant message calling each tool in turn. */
function calls(
  messageId: string,
  each: readonly [name: string, args: unknown][],
): BaseEvent[] {
  return each.flatMap(([name, args], index) => {
    const toolCallId = `${messageId}-${index}`;
    return [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: name,
        parentMessageId: messageId,
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: JSON.stringify(args),
      },
      { type: EventType.TOOL_CALL_END, toolCallId },
    ] as BaseEvent[];
  });
}

function reply(messageId: string, text: string): BaseEvent[] {
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId },
  ] as BaseEvent[];
}

/**
 * The model, as it behaved on Windows: the goal's run does the work, then ends the goal it was one
 * run of, both ways it can, then answers.
 */
function standInModel(): AbstractAgent {
  return new HttpAgent({
    agentId: BOT,
    url: "https://model.example/ag-ui",
    fetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as RunAgentInput;
      requests.push(input);
      const turn = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const goal = readResponsibilityTurn(String(turn?.content ?? ""));
      if (!goal) throw new Error("The stand-in model only runs goals.");
      const answered = input.messages.some(
        (message) => message.role === "tool",
      );
      if (!answered) await duringRun?.();
      const body = answered
        ? reply(`reply-${input.runId}`, REPLY)
        : calls(`calls-${input.runId}`, [
            ["complete_goal", { id: goal.responsibilityId }],
            [
              "report_goal_progress",
              { id: goal.responsibilityId, summary: SUMMARY, complete: true },
            ],
          ]);
      return new Response(
        lifecycle(input, body)
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}

/** The Intelligence runner, reduced to running the agent: its tools run in the turn's middleware. */
const runner: RunnerLike = {
  run: ({ agent, input }) =>
    new Observable((subscriber) => {
      agent
        .runAgent(input, { onEvent: ({ event }) => subscriber.next(event) })
        .then(
          () => subscriber.complete(),
          (error) => subscriber.error(error),
        );
    }),
  stop: async () => true,
};

const engine = createServerResponsibilityEngine({
  database,
  responsibilityStore: goalStore,
  routineIntelligence: {
    getOrCreateThread: async () => ({}),
    getThreadMessages: async () => ({ messages: [] }),
    ɵacquireThreadLock: async (input: { runId: string; threadId: string }) => ({
      ...input,
      joinToken: "token",
    }),
    ɵrenewThreadLock: async () => ({ ttlSeconds: 120 }),
    ɵcleanupThreadLock: async () => undefined,
  } as never,
  routineAgentRunner: runner as never,
  componentCatalog: { names: new Set(), toolsForTurn: async () => [] },
  buildAgentFor: async () => standInModel(),
  actorFor: async (id) => ({ id, role: "user" }),
  computerGateway: undefined,
  agentProfileStore: {} as never,
  bootAuditStore: {} as never,
  signInService: undefined,
  copilotRuntime: { learning: undefined } as never,
  channelStore: { recordActivity: async () => undefined } as never,
  notify: async (_scope, input) => {
    replies.push(input.text);
  },
});

let routinesWereAdded = false;

/** A call the Bot makes in the conversation, or a routine's turn makes there, through Routines. */
const call = (tool: string, args: Record<string, unknown>) =>
  pluginStore.callTool({
    ref: `${ALWAYS_ON_APP}/${tool}`,
    args,
    botId: BOT,
    actorId: OWNER,
    threadId: CONVERSATION.threadId,
  });

/** One sweep of the goal engine, as the server's goal sweep runs it. */
const sweep = () => engine.dispatch({ owner: `goal-recurring-${suite}` });

async function goals() {
  return database
    .select()
    .from(responsibilities)
    .where(eq(responsibilities.ownerUserId, OWNER));
}

async function runsOf(goalId: string) {
  return database
    .select()
    .from(responsibilityRuns)
    .where(eq(responsibilityRuns.responsibilityId, goalId));
}

/** What the goal's run was offered, from the first request the model received. */
function offered(input: RunAgentInput | undefined) {
  const tools = new Map(
    (input?.tools ?? []).map((tool) => [tool.name, tool] as const),
  );
  const progress = tools.get("report_goal_progress")?.parameters as
    | { properties?: Record<string, unknown> }
    | undefined;
  return {
    names: [...tools.keys()],
    progressFields: Object.keys(progress?.properties ?? {}),
  };
}

function turnText(input: RunAgentInput | undefined) {
  const turn = [...(input?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user");
  return String(turn?.content ?? "");
}

/** What each tool the model called answered, by name. */
function answers(input: RunAgentInput | undefined) {
  const named = new Map<string, string>();
  for (const message of input?.messages ?? [])
    if (message.role === "assistant")
      for (const toolCall of message.toolCalls ?? [])
        named.set(toolCall.id, toolCall.function.name);
  return Object.fromEntries(
    (input?.messages ?? []).flatMap((message) =>
      message.role === "tool"
        ? [[named.get(message.toolCallId) ?? "", String(message.content)]]
        : [],
    ),
  );
}

/** "Make the goal and a daily 08:00 UTC routine that runs it, and run it now", as the Bot did. */
async function askedInTheConversation(options: { recurring?: boolean } = {}) {
  const made = await call("create_goal", {
    title: "Morning OpenBot release check",
    instruction:
      "Check the latest release on github.com/CopilotKit/OpenBot/releases and tell the person what changed since the last check.",
    successCriteria:
      "The person is told the latest release and what changed in it.",
    ...(options.recurring ? { recurring: true } : {}),
  });
  expect(made.isError).toBe(false);
  const [goal] = await goals();
  if (!goal) throw new Error("The goal was not made.");
  return goal;
}

async function routineFor(goalId: string) {
  const routine = await call("create_routine", {
    instruction: `Run the goal ${goalId} with run_goal.`,
    cron: "0 8 * * *",
    timezone: "UTC",
  });
  expect(routine.isError).toBe(false);
}

async function clean() {
  const owned = await goals();
  const runs = owned.length
    ? await database
        .select({ id: responsibilityRuns.id })
        .from(responsibilityRuns)
        .where(
          inArray(
            responsibilityRuns.responsibilityId,
            owned.map((goal) => goal.id),
          ),
        )
    : [];
  if (runs.length)
    await database.delete(workItems).where(
      and(
        eq(workItems.kind, RESPONSIBILITY_RUN_KIND),
        inArray(
          workItems.key,
          runs.map((run) => run.id),
        ),
      ),
    );
  await database.delete(routines).where(eq(routines.ownerUserId, OWNER));
  await database
    .delete(responsibilities)
    .where(eq(responsibilities.ownerUserId, OWNER));
  await database
    .delete(intelligenceChannelMappings)
    .where(eq(intelligenceChannelMappings.channelId, CONVERSATION.id));
  await database.delete(channels).where(eq(channels.id, CONVERSATION.id));
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, BOT));
  await database.delete(agentProfiles).where(eq(agentProfiles.agentId, BOT));
  await database.delete(agents).where(eq(agents.id, BOT));
  await database.delete(users).where(eq(users.id, OWNER));
}

beforeEach(async () => {
  await clean();
  requests.length = 0;
  replies.length = 0;
  duringRun = undefined;
  await database.insert(users).values({
    id: OWNER,
    email: `${OWNER}@example.test`,
    name: "Goal Recurring Test User",
  });
  await database.insert(agents).values({
    id: BOT,
    name: "Personal Assistant",
    type: "built_in",
    configuration: { systemPrompt: "You are a personal assistant." },
  });
  await database.insert(agentProfiles).values({
    agentId: BOT,
    title: "",
    roleDescription: "",
    avatarSeed: BOT,
    visibility: "private",
  });
  await database.insert(channels).values({
    id: CONVERSATION.id,
    name: "Personal Assistant",
    description: "",
    summary: CONVERSATION.title,
  });
  await database
    .insert(channelMemberships)
    .values({ channelId: CONVERSATION.id, userId: OWNER });
  await database
    .insert(channelAgents)
    .values({ channelId: CONVERSATION.id, agentId: BOT });
  await database.insert(intelligenceChannelMappings).values({
    userId: OWNER,
    channelId: CONVERSATION.id,
    threadId: CONVERSATION.threadId,
  });
  // Routines, added and given to this Bot exactly as boot does it for every Bot.
  routinesWereAdded =
    routinesWereAdded ||
    Boolean(await pluginStore.serverAddress(ALWAYS_ON_APP));
  await ensureAlwaysOnApp(pluginStore, {
    ...personalDefaultsDeps(database),
    bots: async () => [BOT],
  });
  useRoutineTools(routineStore);
  useGoalTools({
    store: goalStore,
    engine,
    conversationFor: routineStore.conversationFor,
    linkRoutine: routineStore.linkGoal,
  });
});

afterAll(async () => {
  useRoutineTools(null);
  useGoalTools(null);
  await clean();
  if (!routinesWereAdded)
    await database.delete(mcpServers).where(eq(mcpServers.id, ALWAYS_ON_APP));
  await database.$client.end({ timeout: 5 });
});

describe("a run of a goal that repeats", () => {
  test("a routine's goal stays active after its first run, once, and runs again the next morning", async () => {
    const goal = await askedInTheConversation();
    await routineFor(goal.id);
    expect((await call("run_goal", { id: goal.id })).isError).toBe(false);

    const first = await sweep();
    expect(first.failed).toEqual([]);
    expect(first.succeeded).toHaveLength(1);

    // The goal is still active, there is one of it, and its run posted once.
    const after = await goals();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: goal.id,
      status: "active",
      completedAt: null,
      progress: SUMMARY,
      lastResult: REPLY,
    });
    expect(replies).toEqual([REPLY]);

    // The run was told the goal repeats.
    expect(turnText(requests[0])).toContain(
      "This goal repeats because a routine runs it. This run is one of many",
    );
    // Ending it was refused in words the run can pass on, and its result was kept.
    const answered = answers(requests[1]);
    expect(answered.complete_goal).toBe(
      "Refused. This goal repeats because a routine runs it, so a run can't complete it. It stays active. Only the person ends it.",
    );
    expect(JSON.parse(answered.report_goal_progress ?? "{}")).toMatchObject({
      status: "active",
      progress: SUMMARY,
      note: "Recorded. This goal repeats because a routine runs it, so a run can't complete it. It stays active. Only the person ends it.",
    });

    // The next morning, the routine's turn runs it again, and it runs.
    expect((await call("run_goal", { id: goal.id })).isError).toBe(false);
    expect((await sweep()).succeeded).toHaveLength(1);
    expect((await runsOf(goal.id)).map((run) => run.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect((await goalStore.get(OWNER, goal.id)).status).toBe("active");
  });

  test("a goal made recurring stays active after its run, with no routine", async () => {
    const goal = await askedInTheConversation({ recurring: true });
    expect(goal.recurring).toBe(true);
    expect((await call("run_goal", { id: goal.id })).isError).toBe(false);

    expect((await sweep()).succeeded).toHaveLength(1);
    expect(turnText(requests[0])).toContain(
      "This goal repeats because it was set up to repeat.",
    );
    expect(answers(requests[1]).complete_goal).toStartWith(
      "Refused. This goal repeats because it was set up to repeat",
    );
    expect(await goalStore.get(OWNER, goal.id)).toMatchObject({
      status: "active",
      progress: SUMMARY,
    });
  });

  test("a run that began before its routine was made still can't complete it", async () => {
    const goal = await askedInTheConversation();
    expect((await call("run_goal", { id: goal.id })).isError).toBe(false);
    // The conversation makes the routine while the run is already working.
    duringRun = async () => {
      duringRun = undefined;
      await routineFor(goal.id);
    };

    expect((await sweep()).succeeded).toHaveLength(1);
    expect(turnText(requests[0])).not.toContain("This goal repeats");
    expect(answers(requests[1]).complete_goal).toStartWith(
      "Refused. This goal repeats because a routine runs it",
    );
    expect(await goalStore.get(OWNER, goal.id)).toMatchObject({
      status: "active",
      progress: SUMMARY,
    });
  });
});

describe("a goal that is done once", () => {
  test("is still completed by its run when its criteria are met", async () => {
    const goal = await askedInTheConversation();
    expect((await call("run_goal", { id: goal.id })).isError).toBe(false);

    expect((await sweep()).succeeded).toHaveLength(1);
    const { names, progressFields } = offered(requests[0]);
    expect(names).toContain("complete_goal");
    expect(progressFields).toContain("complete");
    expect(turnText(requests[0])).not.toContain("This goal repeats");
    expect((await goalStore.get(OWNER, goal.id)).status).toBe("completed");
  });
});

describe("ending a goal that repeats", () => {
  test("is the person's, and its routine then says so instead of running nothing", async () => {
    const goal = await askedInTheConversation();
    await routineFor(goal.id);

    // The person asks for it to end, in the conversation.
    expect((await call("complete_goal", { id: goal.id })).isError).toBe(false);
    expect((await goalStore.get(OWNER, goal.id)).status).toBe("completed");

    // The next morning the routine's turn asks to run it, and is told why nothing ran.
    const fired = await call("run_goal", { id: goal.id });
    expect(fired.isError).toBe(true);
    expect(fired.text).toContain(
      '"Morning OpenBot release check" is complete, so it no longer runs and nothing was done.',
    );
    expect(await runsOf(goal.id)).toEqual([]);
  });

  test("a change to its title leaves it recurring and keeps the events that wake it", async () => {
    const made = await call("create_goal", {
      title: "Release notes",
      instruction: "Summarise each new release.",
      successCriteria: "Each release is summarised.",
      recurring: true,
      subscriptions: [{ source: "github", eventType: "release.published" }],
    });
    expect(made.isError).toBe(false);
    const [goal] = await goals();
    if (!goal) throw new Error("The goal was not made.");

    expect(
      (
        await call("update_goal", {
          id: goal.id,
          patch: { title: "OpenBot release notes" },
        })
      ).isError,
    ).toBe(false);
    expect(await goalStore.get(OWNER, goal.id)).toMatchObject({
      title: "OpenBot release notes",
      recurring: true,
      subscriptions: [{ source: "github", eventType: "release.published" }],
    });
  });
});

/*
 * FOUND BEFORE 0.3.3: a routine was taken to run any goal whose title its instruction contained, so a
 * goal titled "Email" was run by every routine that mentioned email. Its runs could then never
 * complete it, and Activity listed it under Scheduled with that routine's schedule. A routine made
 * for a goal now records the goal's id; an older routine is read only by the goal's id or its whole
 * title in quotes.
 */
describe("which goal a routine runs", () => {
  const activity = createActivityStore(database);

  async function goalTitled(title: string) {
    const made = await call("create_goal", {
      title,
      instruction: "Tell the person how many unread messages they have.",
      successCriteria: "The person is told the count.",
    });
    expect(made.isError).toBe(false);
    const [goal] = (await goals()).filter((each) => each.title === title);
    if (!goal) throw new Error("The goal was not made.");
    return goal;
  }

  async function routineRow(routineId: string) {
    const [row] = await database
      .select()
      .from(routines)
      .where(eq(routines.id, routineId));
    return row;
  }

  /** A routine as rows made before routines recorded their goal still are. */
  async function olderRoutine(instruction: string) {
    const id = `routine_${randomUUID()}`;
    await database.insert(routines).values({
      id,
      ownerUserId: OWNER,
      agentId: BOT,
      channelId: CONVERSATION.id,
      instruction,
      cron: "0 8 * * *",
      timezone: "UTC",
      nextRunAt: new Date(Date.now() + 3_600_000),
      goalByTitle: true,
    });
    return id;
  }

  async function scheduledIds() {
    return (await activity.forBot(OWNER, BOT)).scheduled.map((item) => item.id);
  }

  test("a goal titled Email stays one-off beside a routine that mentions email, and its run completes it", async () => {
    const goal = await goalTitled("Email");
    expect(
      (
        await call("create_routine", {
          instruction: "Summarise my unread email and post it here.",
          cron: "0 8 * * *",
          timezone: "UTC",
        })
      ).isError,
    ).toBe(false);
    await olderRoutine("Archive the newsletters in my email.");

    expect(await goalStore.repeats(OWNER, goal.id)).toBeNull();
    expect(await scheduledIds()).not.toContain(`responsibility:${goal.id}`);

    expect((await call("run_goal", { id: goal.id })).isError).toBe(false);
    expect((await sweep()).succeeded).toHaveLength(1);
    expect(turnText(requests[0])).not.toContain("This goal repeats");
    expect((await goalStore.get(OWNER, goal.id)).status).toBe("completed");
  });

  test("a routine made for a goal records it by id, carries its title, and the goal repeats", async () => {
    const goal = await askedInTheConversation();
    const made = await call("create_routine", {
      instruction: "Check the latest release and report what changed.",
      goalId: goal.id,
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    expect(made.isError).toBe(false);
    const [routine] = await database
      .select()
      .from(routines)
      .where(eq(routines.ownerUserId, OWNER));
    expect(routine).toMatchObject({
      goalId: goal.id,
      title: "Morning OpenBot release check",
      goalByTitle: false,
    });

    expect(await goalStore.repeats(OWNER, goal.id)).toBe("routine");
    expect(await scheduledIds()).toContain(`responsibility:${goal.id}`);
    expect((await call("run_goal", { id: goal.id })).isError).toBe(false);
    expect((await sweep()).succeeded).toHaveLength(1);
    expect(turnText(requests[0])).toContain(
      "This goal repeats because a routine runs it.",
    );
    expect((await goalStore.get(OWNER, goal.id)).status).toBe("active");
  });

  test("a goal it may not run is refused by name", async () => {
    const goal = await askedInTheConversation();
    expect((await call("complete_goal", { id: goal.id })).isError).toBe(false);
    const made = await call("create_routine", {
      instruction: "Check the latest release.",
      goalId: goal.id,
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    expect(made.isError).toBe(true);
    expect(made.text).toContain(
      '"Morning OpenBot release check" is complete, so a routine can\'t run it.',
    );
    const unknown = await call("create_routine", {
      instruction: "Check the latest release.",
      goalId: randomUUID(),
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("There is no goal of yours with that id");
  });

  test("a routine whose firing runs a goal is linked to it then", async () => {
    const goal = await askedInTheConversation();
    expect(
      (
        await call("create_routine", {
          instruction: "Run my morning release check goal.",
          cron: "0 8 * * *",
          timezone: "UTC",
        })
      ).isError,
    ).toBe(false);
    const [routine] = await database
      .select()
      .from(routines)
      .where(eq(routines.ownerUserId, OWNER));
    if (!routine) throw new Error("The routine was not made.");
    expect(routine.goalId).toBeNull();
    expect(await goalStore.repeats(OWNER, goal.id)).toBeNull();

    // The routine's turn runs the goal, as its firing would.
    const fired = await withApprovalContext(
      {
        runId: randomUUID(),
        threadId: CONVERSATION.threadId,
        toolCallId: "run-goal",
        toolName: "run_goal",
        args: { id: goal.id },
        messages: [],
        state: {},
        context: [],
        forwardedProps: {},
        initiator: { kind: "routine", id: routine.id },
      },
      () => call("run_goal", { id: goal.id }),
    );
    expect(fired.isError).toBe(false);
    expect((await routineRow(routine.id))?.goalId).toBe(goal.id);
    expect(await goalStore.repeats(OWNER, goal.id)).toBe("routine");
  });

  test("an older routine still runs the goal it names by its exact title in quotes, and no other", async () => {
    const goal = await askedInTheConversation();
    const email = await goalTitled("Email");
    await olderRoutine(
      `Run the goal \u201c${goal.title}\u201d and tell me what changed in my email.`,
    );

    expect(await goalStore.repeats(OWNER, goal.id)).toBe("routine");
    expect(await goalStore.repeats(OWNER, email.id)).toBeNull();
    const scheduled = await scheduledIds();
    expect(scheduled).toContain(`responsibility:${goal.id}`);
    expect(scheduled).not.toContain(`responsibility:${email.id}`);
  });
});
