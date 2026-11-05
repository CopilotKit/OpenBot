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
import { and, eq, sql } from "drizzle-orm";
import { Observable } from "rxjs";
import { createHandoffDesk } from "../src/agents/handoff";
import {
  createHandoffDelivery,
  type ThreadRunner,
} from "../src/agents/handoff-delivery";
import { createHandoffRunner } from "../src/agents/handoff-runner";
import { handoffTool } from "../src/agents/handoff-tool";
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
const ASKER = `general-assistant-${suite}`;
const KNOWLEDGE = `knowledge-${suite}`;
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

const desk = createHandoffDesk({
  queue,
  profiles,
  actorFor: async (id: string) => ({ id, role: "user" as const }),
  mayAddress: async (fromBotId, toBotId) =>
    (
      await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "bot"),
            eq(pluginGrants.agentId, fromBotId),
          ),
        )
    ).some((row) => row.ref === toBotId),
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
  for (const id of [ASKER, KNOWLEDGE]) {
    await database.delete(pluginGrants).where(eq(pluginGrants.agentId, id));
    await database.delete(agentProfiles).where(eq(agentProfiles.agentId, id));
    await database.delete(agents).where(eq(agents.id, id));
  }
}

beforeEach(async () => {
  await clean();
  for (const [id, name] of [
    [ASKER, "General Assistant"],
    [KNOWLEDGE, "Knowledge"],
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
});
