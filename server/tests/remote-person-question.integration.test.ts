import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { EventType, HttpAgent, type RunAgentInput } from "@ag-ui/client";
import type { HeadlessWaiting } from "@openbot/toolkit/headless-tools";
import { turnInput, turnMessages } from "@openbot/toolkit/run-turn";
import { and, eq, inArray } from "drizzle-orm";
import { of } from "rxjs";
import { wireCoordination } from "../src/agents/coordination-wiring";
import {
  PERSON_QUESTION_WAITING,
  resumePersonQuestion,
} from "../src/approvals/question-resume";
import {
  createApprovalQuestions,
  personQuestionSchema,
} from "../src/approvals/questions";
import {
  parseApprovalContinuation,
  parseApprovalResult,
} from "../src/approvals/types";
import { type AuditInitiator, PERSON_INITIATOR } from "../src/audit";
import { loadConfig } from "../src/config";
import { buildAgents } from "../src/copilot";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { REFUSAL_MARKER } from "../src/plugins/tools";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `remote-question-${randomUUID()}`;
const owner = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const threadId = `${prefix}-thread`;
const store = createResponsibilityStore(database, {
  resolveTarget: async () => ({ threadId }),
});
const keys: string[] = [];
beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(agents).values({
    id: botId,
    name: "Remote",
    type: "remote_ag_ui",
    configuration: {},
  });
});
afterAll(async () => {
  if (keys.length)
    await database.delete(workItems).where(inArray(workItems.key, keys));
  await database.delete(users).where(eq(users.id, owner));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

async function fixture(
  initiator: AuditInitiator = PERSON_INITIATOR,
  revokeAfterOffer = false,
) {
  let revoked = false;
  let routed = 0;
  const source = async () => ({ channelId, botId });
  const { coordinationForActor } = wireCoordination({
    handoffDesk: {
      send: async () => ({ ok: false, refusal: "No Bot to hand to." }),
    },
    config: loadConfig(testEnvironment()),
    approvalService: { store: {} } as never,
    agentProfileStore: {
      get: async () => ({ name: "Remote" }),
      list: async () => [],
    } as never,
    actorFor: async (id) => ({ id }) as never,
    channelSourceForRun: source,
    database,
    pluginStore: { botsReachableFrom: async () => [] } as never,
    bootAuditStore: { insert: async () => undefined } as never,
    peopleStore: { find: async () => ({ revoked }) } as never,
    sourceForCoordinationRun: source,
    channelStore: { recordActivity: async () => undefined } as never,
    notify: async () => {
      routed += 1;
    },
  });
  const requests: RunAgentInput[] = [];
  const run = spyOn(HttpAgent.prototype, "run").mockImplementation((input) => {
    requests.push(input);
    // Re-emitting the same call in the continuation must not route it again.
    return of(
      { type: EventType.RUN_STARTED, threadId, runId: input.runId },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "q1",
        toolCallName: "ask_person",
        parentMessageId: "question",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "q1",
        delta: '{"question":"Which city?"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "q1" },
      { type: EventType.RUN_FINISHED, threadId, runId: input.runId },
    );
  });
  const args: Parameters<typeof buildAgents> = [
    [
      {
        id: botId,
        name: "Remote",
        type: "remote_ag_ui",
        endpoint: "https://remote.test/ag-ui",
        standingMessage: {
          id: `standing-role:${botId}`,
          role: "system",
          content: "Ask before continuing",
        },
      },
    ],
    { provider: "openai", defaultModel: "test" },
    null,
  ];
  args[10] = async (id, input) => {
    const tools = await coordinationForActor(owner, initiator)(id, input);
    if (revokeAfterOffer) revoked = true;
    return tools;
  };
  const agent = (await buildAgents(...args))[botId];
  if (!agent) throw new Error("Missing remote agent");
  agent.threadId = threadId;
  agent.messages = [
    { id: "request", role: "user", content: "Ask me which city" },
  ];
  return { agent, run, requests, routed: () => routed };
}

test("a remote question rechecks authorization before routing", async () => {
  const f = await fixture(PERSON_INITIATOR, true);
  try {
    await f.agent.runAgent({ runId: randomUUID() });
    expect(f.routed()).toBe(0);
    expect(f.requests).toHaveLength(2);
    const result = f.requests[1]?.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "q1",
    );
    expect(result?.content).toContain(REFUSAL_MARKER);
    expect(
      (
        await createApprovalQuestions(database, async () => undefined).list(
          owner,
        )
      ).filter((q) => q.threadId === threadId),
    ).toHaveLength(0);
  } finally {
    f.run.mockRestore();
  }
});

test("a remote responsibility question suspends, saves an answer, and resumes without asking twice", async () => {
  const goal = await store.create(owner, {
    agentId: botId,
    channelId,
    title: "Plan weekend",
    instruction: "Ask which city",
    successCriteria: "City known",
    subscriptions: [],
  });
  const event = await store.ingestEvent({
    ownerUserId: owner,
    source: "manual",
    externalId: randomUUID(),
    type: "requested",
    responsibilityId: goal.id,
    payload: {},
  });
  keys.push(...event.runIds);
  const runId = event.runIds[0];
  if (!runId) throw new Error("Missing responsibility run");
  await store.beginRun(runId);
  const f = await fixture({ kind: "responsibility", id: goal.id });
  try {
    let waiting: HeadlessWaiting | undefined;
    await f.agent.runAgent(
      { runId },
      {
        onCustomEvent: ({ event }) => {
          if (event.name === "openbot.headless.waiting") waiting = event.value;
        },
      },
    );
    expect(waiting?.kind).toBe(PERSON_QUESTION_WAITING);
    expect(f.routed()).toBe(1);
    expect(f.requests).toHaveLength(1);
    if (!waiting) throw new Error("Question did not suspend");
    await store.settleRun(runId, {
      status: "waiting",
      error: "Awaiting person",
      waiting,
    });
    const question = (
      await createApprovalQuestions(database, async () => undefined).list(owner)
    ).find((q) => q.threadId === threadId);
    if (!question) throw new Error("Question was not saved");
    keys.push(question.id);
    await createApprovalQuestions(database, async () => undefined).respond(
      owner,
      question.id,
      "Seattle",
    );
    const [response] = await database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.kind, "person.response"),
          eq(workItems.key, question.id),
        ),
      );
    if (!response) throw new Error("Answer was not queued");
    const savedQuestion = personQuestionSchema.parse(response.payload.question);
    const unexpected = async () => {
      throw new Error("Must resume the waiting run");
    };
    await resumePersonQuestion({
      ownerUserId: owner,
      question: savedQuestion,
      response: "Seattle",
      messageId: "answer",
      runTurn: unexpected,
      responsibilities: store,
      responsibilityTurn: () => unexpected,
    });
    const queued = await database
      .select()
      .from(workItems)
      .where(eq(workItems.kind, "responsibility.run"));
    keys.push(
      ...queued
        .filter((row) => row.payload.runId === runId)
        .map((row) => row.key),
    );
    const context = await store.beginRun(runId);
    expect(context?.runId).toBe(runId);
    const saved = context?.continuation;
    if (!saved) throw new Error("Missing saved answer");
    const snapshot = parseApprovalContinuation(saved.waiting.continuation);
    const continuation = {
      snapshot,
      result: parseApprovalResult(saved.response),
      messageId: "answer-result",
    };
    const { messages } = turnMessages({
      seeded: [],
      historicIds: new Set(),
      turn: { id: "unused", role: "user", content: "" },
      continuation,
    });
    const input = turnInput({
      threadId,
      runId,
      messages,
      state: snapshot.state,
      tools: [],
      continuation,
    });
    f.agent.messages = messages;
    f.agent.setState(snapshot.state);
    await f.agent.runAgent(input);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.runId).toBe(runId);
    expect(f.requests[1]?.resume?.[0]?.interruptId).toBe("q1");
    expect(f.requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "q1",
      content: "The person answered: Seattle",
    });
    expect(f.routed()).toBe(1);
    await store.settleRun(runId, {
      status: "succeeded",
      replyText: "Seattle recorded",
    });
  } finally {
    f.run.mockRestore();
  }
});
