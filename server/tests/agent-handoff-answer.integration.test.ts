import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import { answeredBy } from "@openbot/shared/handoff-markers";
import { and, eq, like, sql } from "drizzle-orm";
import { Observable } from "rxjs";
import { z } from "zod";
import { askTheirOwnPerson } from "../src/agents/escalation";
import { createHandoffDesk } from "../src/agents/handoff";
import {
  createHandoffDelivery,
  type ThreadRunner,
} from "../src/agents/handoff-delivery";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import {
  createCoordinationTools,
  handoffTool,
} from "../src/agents/handoff-tool";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { serverTurnAdmission } from "../src/agents/turn-admission";
import { createAuditStore } from "../src/audit";
import {
  chooseOpenAIApi,
  normalizeModelBaseUrls,
  resolveRuntimeAgents,
  runtimeModelForEnvironment,
} from "../src/copilot";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  auditEvents,
  pluginGrants,
  workItems,
} from "../src/db/schema";
import { loadTenantPackage } from "../src/tenant-package";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  type OpenAICompatibleEndpoint,
  startOpenAICompatibleEndpoint,
} from "./support/openai-compatible-endpoint";

/**
 * One Bot asking another, from the tool call to the answer in the person's conversation, across two
 * replicas.
 *
 * Found on a two-replica install: a person asked General Assistant to "ask the Knowledge Bot for
 * help with this, and do not answer it yourself". Knowledge was handed the person's words as though
 * they had been said to it, was never told it was Knowledge, went looking for a Knowledge Bot,
 * found none, and said so. General Assistant then repeated that, in its own voice, as the only
 * thing the person saw. Knowledge's answer never appeared under its own name, which is what the
 * Bot's settings promise.
 *
 * Real: the queue on PostgreSQL, the desk, the tool, two runners with their own deliveries, and both
 * Bots built the way the server builds them, calling a model endpoint over HTTP that answers in
 * OpenAI's own recorded bytes. Faked: the Intelligence platform (a thread's lock, its stored events
 * and its message read), shaped as the platform behaves, including that its message read keeps a
 * message's id and drops its `name`.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
/** Every Bot this file makes starts with this, so a run that died part way is cleaned by the next. */
const BOT_PREFIX = "handoff-answer-";
const ASKER = `${BOT_PREFIX}general-assistant-${suite}`;
const KNOWLEDGE = `${BOT_PREFIX}knowledge-${suite}`;
/** A Bot the person can see and General Assistant was never given. */
const RESEARCH = `${BOT_PREFIX}research-${suite}`;
const ACTOR = `handoff-answer-actor-${suite}`;
const THREAD = `asking-thread-${suite}`;

/** What the person typed, word for word, in the run that found this. */
const PERSON =
  "Ask the Knowledge Bot for help with this, and do not answer it yourself: have Knowledge describe, in two sentences, what kinds of questions it is set up to answer and which sources it can use.";

/** What the model endpoint answers, from OpenAI's recorded Responses API stream. */
const MODEL_ANSWER = "Answered on the Responses API.";

const queue = createWorkQueue(database);
const auditStore = createAuditStore(database);
const profiles = createAgentProfileStore(database);

/** The Bots one Bot has been granted, read from the grants table as the plugin store reads it. */
async function grantedTo(fromBotId: string): Promise<string[]> {
  return (
    await database
      .select({ ref: pluginGrants.ref })
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "bot"), eq(pluginGrants.agentId, fromBotId)),
      )
  ).map((row) => row.ref);
}

const desk = createHandoffDesk({
  queue,
  profiles,
  actorFor: async (id: string) => ({ id, role: "user" as const }),
  mayAddress: async (fromBotId, toBotId) =>
    (await grantedTo(fromBotId)).includes(toBotId),
  addressable: grantedTo,
  auditStore,
  caps: { maxDepth: 2, maxPerRun: 3 },
});

/**
 * The Intelligence platform, as far as a hop touches it.
 *
 * A thread is the events its runs published. A run is driven the way the platform's runner drives
 * one, through `agent.runAgent` with an `onEvent`, and its RUN_STARTED records what the run keeps
 * rather than what the model was sent. The message read rebuilds a transcript from those events the
 * way the platform's own read does: by message id and role, with `name` left behind.
 */
function platform() {
  const threads = new Map<string, Record<string, unknown>[]>();
  const held = new Map<string, string>();
  const eventsOf = (threadId: string) => {
    const events = threads.get(threadId) ?? [];
    threads.set(threadId, events);
    return events;
  };

  const runner: ThreadRunner = {
    run: ({ threadId, agent, input, persistedInputMessages }) =>
      new Observable<BaseEvent>((subscriber) => {
        const events = eventsOf(threadId);
        const run = input as { messages?: unknown[] };
        events.push({
          type: "RUN_STARTED",
          input: { messages: persistedInputMessages ?? run.messages ?? [] },
        });
        agent
          .runAgent(
            input as never,
            {
              onEvent: ({ event }: { event: BaseEvent }) => {
                if (event.type === "RUN_STARTED") return;
                events.push(event as unknown as Record<string, unknown>);
                subscriber.next(event);
              },
            } as never,
          )
          .then(
            () => subscriber.complete(),
            (error: unknown) => {
              const failed = {
                type: "RUN_ERROR",
                message: error instanceof Error ? error.message : String(error),
              };
              events.push(failed);
              subscriber.next(failed as unknown as BaseEvent);
              subscriber.complete();
            },
          );
      }),
  };

  const messages = (threadId: string) => {
    const byId = new Map<
      string,
      { id: string; role: string; content: string }
    >();
    for (const event of threads.get(threadId) ?? []) {
      if (event.type === "RUN_STARTED") {
        const input = event.input as { messages?: unknown[] };
        for (const message of input.messages ?? []) {
          const { id, role, content } = message as Record<string, unknown>;
          if (typeof id === "string" && !byId.has(id))
            byId.set(id, {
              id,
              role: String(role),
              content: typeof content === "string" ? content : "",
            });
        }
      }
      if (event.type === "TEXT_MESSAGE_START") {
        const id = String(event.messageId);
        byId.set(id, {
          id,
          role: typeof event.role === "string" ? event.role : "assistant",
          content: "",
        });
      }
      if (event.type === "TEXT_MESSAGE_CONTENT") {
        const message = byId.get(String(event.messageId));
        if (message) message.content += String(event.delta ?? "");
      }
    }
    return [...byId.values()];
  };

  return {
    runner,
    messages,
    history: async ({ threadId }: { threadId: string }) => messages(threadId),
    lock: {
      acquire: async (input: { threadId: string; runId: string }) => {
        if (held.has(input.threadId)) return null;
        held.set(input.threadId, input.runId);
        return { runId: input.runId };
      },
      renew: async () => {},
      release: async (input: { threadId: string; runId: string }) => {
        if (held.get(input.threadId) === input.runId)
          held.delete(input.threadId);
      },
    },
    /** Seed a conversation as the person's own run left it. */
    seed(
      threadId: string,
      said: { id: string; role: string; content: string }[],
    ) {
      const events = eventsOf(threadId);
      for (const message of said) {
        if (message.role === "user") {
          events.push({ type: "RUN_STARTED", input: { messages: [message] } });
        } else {
          events.push(
            {
              type: "TEXT_MESSAGE_START",
              messageId: message.id,
              role: "assistant",
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: message.id,
              delta: message.content,
            },
          );
        }
      }
    },
  };
}

/** The text of every message of one role in what the model was sent, whichever API carried it. */
function turns(conversation: unknown, role: string): string[] {
  if (!Array.isArray(conversation)) return [];
  return conversation
    .filter(
      (item): item is { role: string; content: unknown } =>
        typeof item === "object" && item !== null && item.role === role,
    )
    .map((item) =>
      typeof item.content === "string"
        ? item.content
        : Array.isArray(item.content)
          ? item.content
              .map((part: { text?: unknown }) =>
                typeof part.text === "string" ? part.text : "",
              )
              .join("")
          : "",
    );
}

const VARIABLES = [
  "OPENAI_BASE_URL",
  "BOT_MODEL",
  "BOT_PROVIDER",
  "COPILOTKIT_OPENAI_API",
] as const;
const saved = Object.fromEntries(
  VARIABLES.map((name) => [name, process.env[name]]),
);
let endpoint: OpenAICompatibleEndpoint | undefined;

/** Both Bots, built as the server builds a built-in Bot, against the endpoint. */
async function botsAgainst(baseUrl: string) {
  for (const name of VARIABLES) delete process.env[name];
  process.env.OPENAI_BASE_URL = baseUrl;
  normalizeModelBaseUrls();
  const packageModel = (
    await loadTenantPackage(
      new URL("../../examples/fintech", import.meta.url).pathname,
    )
  ).model;
  const model = runtimeModelForEnvironment(packageModel);
  chooseOpenAIApi(model);
  const built = await resolveRuntimeAgents(
    async () => [
      {
        id: ASKER,
        name: "General Assistant",
        type: "built_in" as const,
        systemPrompt:
          "You are a helpful general assistant. Give clear, concise, and accurate answers.",
      },
      {
        id: KNOWLEDGE,
        name: "Knowledge",
        type: "built_in" as const,
        systemPrompt:
          "Answer from the sources you can reach with the tools you have been given, and cite what you used.",
      },
    ],
    model,
    async () => "synthetic-model-key",
  );
  return built;
}

async function clean() {
  await database
    .delete(workItems)
    .where(sql`${workItems.payload}->>'actorId' = ${ACTOR}`);
  // By prefix, not by this run's ids: two Bots called Knowledge left by a run that died would make
  // "the Knowledge Bot" ambiguous, which is the desk working, not this test.
  await database
    .delete(pluginGrants)
    .where(like(pluginGrants.agentId, `${BOT_PREFIX}%`));
  await database
    .delete(agentProfiles)
    .where(like(agentProfiles.agentId, `${BOT_PREFIX}%`));
  await database.delete(agents).where(like(agents.id, `${BOT_PREFIX}%`));
}

beforeEach(async () => {
  await clean();
  for (const [id, name] of [
    [ASKER, "General Assistant"],
    [KNOWLEDGE, "Knowledge"],
    [RESEARCH, "Research"],
  ]) {
    await database
      .insert(agents)
      .values({ id, name, type: "built_in", configuration: {} })
      .onConflictDoNothing();
    await database
      .insert(agentProfiles)
      .values({
        agentId: id,
        name,
        title: "",
        roleDescription: "",
        avatarSeed: id,
        visibility: "public",
      })
      .onConflictDoNothing();
  }
  await database
    .insert(pluginGrants)
    .values({ kind: "bot", ref: KNOWLEDGE, agentId: ASKER, grantedBy: "test" })
    .onConflictDoNothing();
});

afterEach(async () => {
  for (const name of VARIABLES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await endpoint?.stop();
  endpoint = undefined;
});

afterAll(async () => {
  await clean();
  await database.$client.end({ timeout: 5 });
});

describe("one Bot asking another, on two replicas", () => {
  test("the Bot that was asked knows it is the one asked, and its answer lands under its own name", async () => {
    endpoint = startOpenAICompatibleEndpoint();
    const built = await botsAgainst(endpoint.baseUrl);
    const intelligence = platform();
    intelligence.seed(THREAD, [
      { id: "person-1", role: "user", content: PERSON },
    ]);

    /** One replica: its own runner and delivery, sharing only the database and the platform. */
    const replica = (owner: string) =>
      createHandoffRunner({
        queue: createWorkQueue(database),
        owner,
        sign: () => "signed",
        auditStore,
        delivery: createHandoffDelivery({
          admission: serverTurnAdmission,
          agentFor: async ({ botId }) =>
            (built[botId]?.clone() as AbstractAgent | undefined) ?? null,
          history: intelligence.history,
          lock: intelligence.lock,
          runner: intelligence.runner,
          mintThreadId: () => `scratch-${randomUUID()}`,
          newRunId: () => randomUUID(),
        }),
      });

    // General Assistant's own run, calling the tool it is offered.
    const tool = handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: `asking-run-${suite}`,
        threadId: THREAD,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
      maxPerRun: 3,
    });
    const handed = await tool?.execute({
      bot: KNOWLEDGE,
      task: "Describe, in exactly two sentences, what kinds of questions you are set up to answer and which sources you can use.",
      constraints:
        "Do not answer any other question. Keep it concise and factual.",
      expecting:
        "Exactly two sentences suitable to relay directly to the person.",
    });
    expect(String(handed)).toStartWith("Handed to Knowledge");

    // The hop on one replica, the answer going home on the other.
    const there = await replica(`replica-a-${suite}`).sweep();
    expect(there.delivered).toContain(KNOWLEDGE);
    const back = await replica(`replica-b-${suite}`).sweep();
    expect(back.delivered).toContain(ASKER);

    /*
     * What Knowledge's model was sent. The person's words reach it as the conversation it was
     * brought into, attributed to the Bot they were said to, and never as a turn of its own: sent as
     * its own, "do not answer it yourself" is an instruction to the one Bot that was meant to answer.
     */
    expect(endpoint.conversations.length).toBeGreaterThan(0);
    const asked = turns(endpoint.conversations[0], "user");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("You are Knowledge");
    expect(asked[0]).toContain(`General Assistant`);
    expect(asked[0]).toContain(PERSON);

    /*
     * What the person's conversation holds afterwards: Knowledge's words, exactly, as a message of
     * Knowledge's own, read back through the platform's read the way a reload reads it.
     */
    const shown = intelligence.messages(THREAD);
    const answer = shown.find((message) => answeredBy(message.id) !== null);
    expect(answer).toMatchObject({ role: "assistant", content: MODEL_ANSWER });
    expect(answeredBy(answer?.id ?? "")).toBe(KNOWLEDGE);

    // Said once. General Assistant is not run again to say it over in its own voice.
    expect(endpoint.requests).toHaveLength(1);
    expect(
      shown.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });
  /*
   * "Ask the Knowledge Bot for help with this": the model sent `bot: "Knowledge Bot"`, the desk
   * looked for a Bot with exactly that name, and the person saw a red "Blocked: Asked Knowledge Bot"
   * step before the model called `list_bots` and tried again. The run is now offered the names it
   * can ask, and a name said the way people say it resolves to the one Bot it means.
   */
  test("the Knowledge Bot is Knowledge: one handoff, no refusal, and its answer under its own name", async () => {
    endpoint = startOpenAICompatibleEndpoint();
    const built = await botsAgainst(endpoint.baseUrl);
    const intelligence = platform();
    intelligence.seed(THREAD, [
      { id: "person-1", role: "user", content: PERSON },
    ]);
    const replica = (owner: string) =>
      createHandoffRunner({
        queue: createWorkQueue(database),
        owner,
        sign: () => "signed",
        auditStore,
        delivery: createHandoffDelivery({
          admission: serverTurnAdmission,
          agentFor: async ({ botId }) =>
            (built[botId]?.clone() as AbstractAgent | undefined) ?? null,
          history: intelligence.history,
          lock: intelligence.lock,
          runner: intelligence.runner,
          mintThreadId: () => `scratch-${randomUUID()}`,
          newRunId: () => randomUUID(),
        }),
      });

    // The coordination tools as a built-in run is given them, wired as the server wires them.
    const coordination = createCoordinationTools({
      desk,
      caps: { maxDepth: 2, maxPerRun: 3 },
      botsReachableFrom: grantedTo,
      addressableBots: async (from) => {
        const granted = new Set(await grantedTo(from.botId));
        return (await profiles.list({ id: from.actorId, role: "user" }))
          .filter((bot) => granted.has(bot.id) && bot.id !== from.botId)
          .map((bot) => ({ id: bot.id, name: bot.name }));
      },
      route: askTheirOwnPerson,
      auditStore,
      authoriseRun: async () => true,
    });
    const run = {
      botId: ASKER,
      actorId: ACTOR,
      runId: `asking-run-${suite}`,
      threadId: THREAD,
      depth: 0,
    };
    const offered = (await coordination.toolsForRun(run)).find(
      (tool) => tool.name === "message_bot",
    );
    // Offered the names it can ask, so it has nothing to guess: Knowledge, and not Research.
    const schema = z.toJSONSchema(offered?.parameters as z.ZodType) as {
      properties: { bot: { enum?: string[] } };
    };
    expect(schema.properties.bot.enum).toEqual(["Knowledge"]);

    // The call the model made in the run that found this, through the same dispatch a run uses.
    const handed = await coordination.call({
      name: "message_bot",
      args: {
        bot: "Knowledge Bot",
        task: "Describe, in exactly two sentences, what kinds of questions you are set up to answer and which sources you can use.",
        expecting: "Exactly two sentences for the person.",
      },
      run,
    });
    expect(handed).toMatchObject({ isError: false });
    expect(handed?.text).toStartWith("Handed to Knowledge");

    const there = await replica(`replica-a-${suite}`).sweep();
    expect(there.delivered).toContain(KNOWLEDGE);
    const back = await replica(`replica-b-${suite}`).sweep();
    expect(back.delivered).toContain(ASKER);

    // One handoff, and nothing refused on the way.
    const hops = await database
      .select({ key: workItems.key })
      .from(workItems)
      .where(sql`${workItems.payload}->>'actorId' = ${ACTOR}`);
    expect(hops.filter((hop) => hop.key.startsWith("hop:"))).toHaveLength(1);
    const refused = await database
      .select({ type: auditEvents.eventType })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, ACTOR),
          eq(auditEvents.eventType, "agent.handoff_refused"),
        ),
      );
    expect(refused).toEqual([]);

    const answer = intelligence
      .messages(THREAD)
      .find((message) => answeredBy(message.id) !== null);
    expect(answer).toMatchObject({ role: "assistant", content: MODEL_ANSWER });
    expect(answeredBy(answer?.id ?? "")).toBe(KNOWLEDGE);

    // A Bot it was never given is still refused, however it is named.
    const notGiven = await coordination.call({
      name: "message_bot",
      args: { bot: "the Research Bot", task: "find the outage window" },
      run,
    });
    expect(notGiven?.isError).toBe(true);
    expect(notGiven?.text).toContain("You have not been given Research");
    // And a name that is nobody says who it can ask.
    const nobody = await coordination.call({
      name: "message_bot",
      args: { bot: "Archivist", task: "find the outage window" },
      run,
    });
    expect(nobody?.isError).toBe(true);
    expect(nobody?.text).toContain("The Bots you can ask are: Knowledge.");
  });
});
