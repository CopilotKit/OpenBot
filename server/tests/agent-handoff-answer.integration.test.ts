import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent, BaseEvent } from "@ag-ui/client";
import { answeredBy, answerMessageId } from "@openbot/shared/handoff-markers";
import { IntelligenceKnowingANewThread } from "@openbot/toolkit/copilotkit/agents";
import { createIntelligenceThreadLock } from "@openbot/toolkit/copilotkit/thread-lock";
import { and, eq, gte, like, sql } from "drizzle-orm";
import { Observable } from "rxjs";
import { z } from "zod";
import { askTheirOwnPerson } from "../src/agents/escalation";
import { createHandoffDesk, HANDOFF_KIND } from "../src/agents/handoff";
import {
  createHandoffDelivery,
  type ThreadRunner,
} from "../src/agents/handoff-delivery";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { answerGoneFrom, botNamesFrom } from "../src/agents/handoff-wiring";
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
import { observeIntelligenceAuthentication } from "../src/intelligence-client";
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
// Every Bot here is built in, so there is no managed agent endpoint to hand the store.
const profiles = createAgentProfileStore(database, undefined);

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

/**
 * Intelligence's thread and lock routes over HTTP, as `apps/app-api/src/routes/threads-routes.ts`
 * answers them: one run holds a thread's lock, and anybody else asking is refused with
 * `THREAD_LOCK_FAILED`, a 409 the platform marks retryable.
 */
function lockingIntelligence() {
  const threads = new Set<string>();
  const holders = new Map<string, string>();
  const refused: string[] = [];
  const envelope = (code: string, message: string, retryable: boolean) => ({
    error: { code, message, category: "x", retryable },
    requestId: "request-test",
    traceId: "trace-test",
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/threads") {
        const { threadId } = (await request.json()) as { threadId: string };
        threads.add(threadId);
        return Response.json(
          { thread: { id: threadId, name: null } },
          { status: 201 },
        );
      }
      const [, , , id, tail] = url.pathname.split("/");
      const threadId = decodeURIComponent(id ?? "");
      if (request.method === "GET" && tail === undefined) {
        return threads.has(threadId)
          ? Response.json({ thread: { id: threadId, name: null } })
          : Response.json(
              envelope("THREAD_NOT_FOUND", "Thread not found.", false),
              { status: 404 },
            );
      }
      if (tail === "lock") {
        const { runId } = (await request.json()) as { runId: string };
        if (request.method === "POST") {
          threads.add(threadId);
          if (holders.has(threadId)) {
            refused.push(threadId);
            return Response.json(
              envelope(
                "THREAD_LOCK_FAILED",
                "Thread is already locked by another runner.",
                true,
              ),
              { status: 409 },
            );
          }
          holders.set(threadId, runId);
          return Response.json({
            threadId,
            runId,
            joinToken: "join",
            ttlSeconds: 120,
          });
        }
        if (request.method === "PATCH")
          return Response.json({ ttlSeconds: 120 });
        if (request.method === "DELETE") {
          if (holders.get(threadId) === runId) holders.delete(threadId);
          return new Response(null, { status: 204 });
        }
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    /** The lock a hop takes, on the client copilot.ts builds for the runtime and its hops. */
    lock: createIntelligenceThreadLock({
      client: observeIntelligenceAuthentication(
        new IntelligenceKnowingANewThread({
          apiUrl: `http://127.0.0.1:${server.port}`,
          wsUrl: `ws://127.0.0.1:${server.port}`,
          apiKey: "cpk-test-key",
          // The hop's own wait is what these tests drive; the client's few seconds of asking again
          // (follow-up-run-lock.test.ts) would only stretch each busy try.
          lockConflictWaitMs: 0,
        }),
      ),
    }),
    /** A person's run, or the asking Bot's, holding a conversation. */
    hold(threadId: string, runId: string) {
      threads.add(threadId);
      holders.set(threadId, runId);
    },
    free(threadId: string) {
      holders.delete(threadId);
    },
    refused,
    stop: () => server.stop(true),
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

const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
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
   * Asked a second time, Knowledge reads the conversation it is brought into, and its own earlier
   * answer is in it. That answer is stored in General Assistant's thread under General Assistant's
   * voice, and was quoted to Knowledge as something General Assistant had said.
   */
  test("an earlier answer in the conversation is quoted as the Bot's that gave it", async () => {
    endpoint = startOpenAICompatibleEndpoint();
    const built = await botsAgainst(endpoint.baseUrl);
    const intelligence = platform();
    const EARLIER = "Helm is a package manager for Kubernetes.";
    intelligence.seed(THREAD, [
      {
        id: "person-1",
        role: "user",
        content: "Ask the Knowledge Bot what Helm is.",
      },
      {
        id: answerMessageId(KNOWLEDGE, "earlier-run"),
        role: "assistant",
        content: EARLIER,
      },
      {
        id: answerMessageId(RESEARCH, "other-run"),
        role: "assistant",
        content: "Helm charts are versioned.",
      },
      { id: "person-2", role: "user", content: PERSON },
    ]);
    const delivery = createHandoffRunner({
      queue: createWorkQueue(database),
      owner: `replica-a-${suite}`,
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
        botNames: botNamesFrom(database),
      }),
    });
    const handed = await handoffTool({
      desk,
      from: {
        botId: ASKER,
        actorId: ACTOR,
        runId: `asking-run-again-${suite}`,
        threadId: THREAD,
        depth: 0,
      },
      hasSomebodyToAsk: true,
      maxDepth: 2,
      maxPerRun: 3,
    })?.execute({
      bot: KNOWLEDGE,
      task: "Say what kinds of questions you answer.",
    });
    expect(String(handed)).toStartWith("Handed to Knowledge");
    expect((await delivery.sweep()).delivered).toContain(KNOWLEDGE);

    const [asked] = turns(endpoint.conversations[0], "user");
    expect(asked).toContain(
      `You (Knowledge), answering General Assistant: ${EARLIER}`,
    );
    expect(asked).toContain(
      "Research, another Bot, answering General Assistant: Helm charts are versioned.",
    );
    expect(asked?.split("\n\n")).not.toContain(`General Assistant: ${EARLIER}`);
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
    const schema = z.toJSONSchema(offered?.parameters as z.ZodType);
    expect(schema.properties?.bot).toEqual(
      expect.objectContaining({ enum: ["Knowledge"] }),
    );

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

/*
 * Kink 25 of the Helm bundle build. General Assistant asked Knowledge; the answer appeared, but the
 * server printed `Intelligence platform request failed` with a 409 `THREAD_LOCK_FAILED` first: the
 * answer going home asked for the person's conversation while General Assistant's own run was still
 * finishing the sentence that said it had asked. The hop went back on the queue and was delivered
 * five seconds later. Now it waits for the conversation, takes it the moment it is free, and the
 * platform's "not yet" is not printed as a failure.
 */
describe("an answer that comes home while the asking Bot is still finishing", () => {
  const failedPrints = (printed: { mock: { calls: unknown[][] } }) =>
    printed.mock.calls.filter((call) =>
      call.some(
        (part) =>
          typeof part === "string" &&
          part.includes("Intelligence platform request failed"),
      ),
    );
  const answersIn = (
    intelligence: ReturnType<typeof platform>,
    threadId: string,
  ) =>
    intelligence
      .messages(threadId)
      .filter((message) => answeredBy(message.id) !== null);
  const relays = () =>
    database
      .select({
        attempts: workItems.attempts,
        finishedAt: workItems.finishedAt,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, HANDOFF_KIND),
          like(workItems.key, "relay:%"),
          sql`${workItems.payload}->>'actorId' = ${ACTOR}`,
        ),
      );

  const relayKey = and(
    eq(workItems.kind, HANDOFF_KIND),
    like(workItems.key, "relay:%"),
    sql`${workItems.payload}->>'actorId' = ${ACTOR}`,
  );
  const relayRows = async () =>
    (
      await database
        .select({
          attempts: workItems.attempts,
          // Measured on the database's clock, which is the one that set it.
          waitS: sql<number>`extract(epoch from (${workItems.runAt} - now()))::float8`,
          payload: workItems.payload,
        })
        .from(workItems)
        .where(relayKey)
    ).map((row) => ({
      ...row,
      payload: row.payload as { busyRetries?: number },
    }));
  /** The relay due now, rather than after its backoff, so a test of many tries takes no minutes. */
  const dueNow = () =>
    database
      .update(workItems)
      .set({ runAt: sql`now() - interval '1 second'` })
      .where(relayKey);
  /** When this test began, so the trail read is this test's own. */
  let since = new Date();
  /** The failure rows written for this person's hops in this test. */
  const failureRows = async () =>
    (
      await database
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, ACTOR),
            eq(auditEvents.eventType, "agent.handoff_failed"),
            gte(auditEvents.createdAt, since),
          ),
        )
    ).map((row) => row.payload as Record<string, unknown>);

  async function handedToKnowledge() {
    since = new Date();
    endpoint = startOpenAICompatibleEndpoint();
    const built = await botsAgainst(endpoint.baseUrl);
    const intelligence = platform();
    intelligence.seed(THREAD, [
      { id: "person-1", role: "user", content: PERSON },
    ]);
    const locks = lockingIntelligence();
    stops.push(locks.stop);
    const replica = (owner: string, busyWaitMs?: number) =>
      createHandoffRunner({
        queue: createWorkQueue(database),
        owner,
        sign: () => "signed",
        auditStore,
        // The server's own check, and the queue's real attempt budget (five).
        answerGone: answerGoneFrom(database),
        delivery: createHandoffDelivery({
          admission: serverTurnAdmission,
          agentFor: async ({ botId }) =>
            (built[botId]?.clone() as AbstractAgent | undefined) ?? null,
          history: intelligence.history,
          lock: locks.lock,
          runner: intelligence.runner,
          mintThreadId: () => `scratch-${randomUUID()}`,
          newRunId: () => randomUUID(),
          ...(busyWaitMs === undefined ? {} : { busyWaitMs }),
        }),
      });
    // General Assistant's run, which holds its conversation until it has finished saying it asked.
    locks.hold(THREAD, `asking-run-${suite}`);
    const handed = await handoffTool({
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
    })?.execute({
      bot: KNOWLEDGE,
      task: "Describe, in exactly two sentences, what kinds of questions you are set up to answer and which sources you can use.",
    });
    expect(String(handed)).toStartWith("Handed to Knowledge");
    return { intelligence, locks, replica };
  }

  test("waits for the conversation, lands once under its own name, and prints nothing", async () => {
    const { intelligence, locks, replica } = await handedToKnowledge();
    const printed = spyOn(console, "error").mockImplementation(() => {});
    try {
      const there = await replica(`replica-a-${suite}`).sweep();
      expect(there.delivered).toContain(KNOWLEDGE);

      // General Assistant finishes a moment after Knowledge's answer is ready.
      const finishing = setTimeout(() => locks.free(THREAD), 1_000);
      const back = await replica(`replica-b-${suite}`).sweep();
      clearTimeout(finishing);
      expect(back).toEqual({ delivered: [ASKER], skipped: [] });
      // It did meet the busy conversation, and waited rather than failing.
      expect(locks.refused).toContain(THREAD);

      const answers = answersIn(intelligence, THREAD);
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({ content: MODEL_ANSWER });
      expect(answeredBy(answers[0]?.id ?? "")).toBe(KNOWLEDGE);
      expect(await relays()).toEqual([
        { attempts: 1, finishedAt: expect.any(Date) },
      ]);

      // Never twice: neither replica finds anything left to deliver.
      expect((await replica(`replica-a-${suite}`).sweep()).delivered).toEqual(
        [],
      );
      expect((await replica(`replica-b-${suite}`).sweep()).delivered).toEqual(
        [],
      );
      expect(answersIn(intelligence, THREAD)).toHaveLength(1);
      expect(failedPrints(printed)).toEqual([]);
    } finally {
      printed.mockRestore();
    }
  });

  /*
   * The bug after the first fix: a conversation busy for longer than the queue's five attempts ran
   * the relay out of attempts, and the answer was dropped with nobody told. A held lock is not a
   * failure: it spends no attempt, and the relay keeps trying, backing off, until the lock frees.
   */
  test("busy for longer than five attempts, it spends none, is not lost, and lands once when free", async () => {
    const { intelligence, locks, replica } = await handedToKnowledge();
    const printed = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        (await replica(`replica-a-${suite}`, 20).sweep()).delivered,
      ).toContain(KNOWLEDGE);

      // The person runs in that conversation across eight tries, more than the five the queue allows.
      for (let attempt = 1; attempt <= 8; attempt++) {
        const busy = await replica(
          `replica-${attempt % 2 ? "b" : "a"}-${suite}`,
          20,
        ).sweep();
        expect(busy.delivered).toEqual([]);
        expect(busy.skipped).toEqual([
          expect.objectContaining({
            reason: expect.stringContaining("busy with another run"),
          }),
        ]);
        // Nothing spent, and the wait before the next try grows: 5 s, 10 s, 20 s, 40 s, then a minute.
        const [row] = await relayRows();
        expect(row?.attempts).toBe(0);
        expect(row?.payload.busyRetries).toBe(attempt);
        const expected = Math.min(5 * 2 ** (attempt - 1), 60);
        expect(Number(row?.waitS)).toBeLessThanOrEqual(expected);
        expect(Number(row?.waitS)).toBeGreaterThan(expected - 5);
        await dueNow();
      }
      expect(answersIn(intelligence, THREAD)).toEqual([]);
      // Waiting is not failing: no failure row for any of those tries.
      expect(await failureRows()).toEqual([]);

      // Their run ends.
      locks.free(THREAD);
      const later = await replica(`replica-a-${suite}`, 20).sweep();
      expect(later).toEqual({ delivered: [ASKER], skipped: [] });

      const answers = answersIn(intelligence, THREAD);
      expect(answers).toHaveLength(1);
      expect(answeredBy(answers[0]?.id ?? "")).toBe(KNOWLEDGE);
      expect(await relays()).toEqual([
        { attempts: 1, finishedAt: expect.any(Date) },
      ]);
      expect(
        (await replica(`replica-b-${suite}`, 20).sweep()).delivered,
      ).toEqual([]);
      expect(answersIn(intelligence, THREAD)).toHaveLength(1);
      expect(failedPrints(printed)).toEqual([]);
    } finally {
      printed.mockRestore();
    }
  });

  test("a Bot deleted while its conversation is busy is recorded as not delivered, never silently dropped", async () => {
    const { intelligence, replica } = await handedToKnowledge();
    expect(
      (await replica(`replica-a-${suite}`, 20).sweep()).delivered,
    ).toContain(KNOWLEDGE);
    expect((await replica(`replica-b-${suite}`, 20).sweep()).delivered).toEqual(
      [],
    );

    // The person deletes General Assistant, whose conversation the answer was going to.
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, ASKER));
    await dueNow();
    const over = await replica(`replica-a-${suite}`, 20).sweep();
    expect(over.delivered).toEqual([]);
    expect(over.skipped).toEqual([
      expect.objectContaining({
        reason: "the Bot it was to speak as was deleted",
      }),
    ]);
    expect(await relays()).toEqual([
      { attempts: 1, finishedAt: expect.any(Date) },
    ]);
    expect(await failureRows()).toEqual([
      expect.objectContaining({
        reason: "not delivered: the Bot it was to speak as was deleted",
        final: true,
        to: ASKER,
      }),
    ]);
    expect(answersIn(intelligence, THREAD)).toEqual([]);
  });
});
