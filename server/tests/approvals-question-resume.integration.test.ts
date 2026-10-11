import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  PERSON_QUESTION_WAITING,
  resumePersonQuestion,
} from "../src/approvals/question-resume";
import {
  createApprovalQuestions,
  type PersonQuestion,
  personQuestionSchema,
} from "../src/approvals/questions";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { responsibilityTools } from "../src/responsibilities/tools";
import type {
  Responsibility,
  ResponsibilityStore,
} from "../src/responsibilities/types";
import { ResponsibilityNotFoundError } from "../src/responsibilities/types";
import type { TurnRunner } from "../src/routines/runner";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A responsibility's run asked the person a question; the person answered on the Bot's page. The answer
 * must resume that responsibility's work, with its tools and initiator, in the same conversation.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `question-${randomUUID()}`;
const owner = `${prefix}-owner`;
const questions = createApprovalQuestions(database, async () => undefined);
const keys: string[] = [];

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
});
afterAll(async () => {
  if (keys.length)
    await database
      .delete(workItems)
      .where(
        and(
          inArray(workItems.kind, ["person.question", "person.response"]),
          inArray(workItems.key, keys),
        ),
      );
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

const responsibility: Responsibility = {
  id: `${prefix}-lunch`,
  ownerUserId: owner,
  agentId: "general-assistant",
  channelId: `${prefix}-channel`,
  threadId: `${prefix}-thread`,
  title: "Order lunch",
  instruction: "Ask what I want for lunch and record it.",
  successCriteria: "Lunch choice recorded",
  subscriptions: [],
  status: "active",
  progress: "",
  lastResult: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  completedAt: null,
} as Responsibility;

const question = (over: Partial<PersonQuestion> = {}): PersonQuestion => ({
  actorId: owner,
  botId: "general-assistant",
  threadId: responsibility.threadId,
  runId: randomUUID(),
  question: "What would you like for lunch?",
  mode: "completed_question",
  initiator: { kind: "responsibility", id: responsibility.id },
  ...over,
});

test("the question's initiator survives being asked and answered", async () => {
  const key = randomUUID();
  keys.push(key);
  await database.insert(workItems).values({
    kind: "person.question",
    key,
    payload: question(),
  });
  expect(
    (await questions.list(owner)).some((entry) => entry.id === key),
  ).toBeTrue();
  await questions.respond(owner, key, "Ramen, please.");
  const [response] = await database
    .select()
    .from(workItems)
    .where(and(eq(workItems.kind, "person.response"), eq(workItems.key, key)));
  if (!response) throw new Error("the answer was not queued");
  const saved = (response.payload as { question: unknown }).question;
  expect(personQuestionSchema.parse(saved).initiator).toEqual({
    kind: "responsibility",
    id: responsibility.id,
  });
});

test("an answer to a responsibility's question resumes it with its own tools, run and initiator", async () => {
  const recorded: unknown[] = [];
  const store = {
    get: async (ownerUserId: string, id: string) => {
      if (ownerUserId !== owner || id !== responsibility.id)
        throw new ResponsibilityNotFoundError();
      return responsibility;
    },
    listRuns: async () => [{ id: "run-latest" }, { id: "run-older" }],
    recordProgress: async (...args: unknown[]) => {
      recorded.push(args);
      return { ok: true };
    },
  } as unknown as ResponsibilityStore;
  const plain: TurnRunner = async () => {
    throw new Error("the ordinary runner must not be used");
  };
  let turn: Parameters<TurnRunner>[0] | undefined;
  const outcome = await resumePersonQuestion({
    ownerUserId: owner,
    question: question(),
    response: "Ramen, please.",
    messageId: "person-response:1",
    runTurn: plain,
    responsibilities: store,
    // The same construction the process uses: the responsibility's tools bound to its latest run.
    responsibilityTurn: ({ responsibility: goal, responsibilityRunId }) => {
      const tools = responsibilityTools({
        store,
        engine: { ingest: async () => ({}) as never },
        ownerUserId: goal.ownerUserId,
        agentId: goal.agentId,
        channelId: goal.channelId,
        ...(responsibilityRunId ? { responsibilityRunId } : {}),
      });
      return async (input) => {
        turn = input;
        const report = tools.find(
          (tool) => tool.name === "report_responsibility_progress",
        );
        if (!report) throw new Error("report_responsibility_progress missing");
        await report.execute({
          id: goal.id,
          summary: "Lunch: ramen",
          complete: true,
        });
        return { replyText: "Ramen it is. Recorded." };
      };
    },
  });
  expect(outcome).toEqual({
    replyText: "Ramen it is. Recorded.",
    responsibilityId: responsibility.id,
  });
  expect(turn).toMatchObject({
    ownerUserId: owner,
    routineId: responsibility.id,
    agentId: "general-assistant",
    threadId: responsibility.threadId,
    initiator: { kind: "responsibility", id: responsibility.id },
    userMessage: {
      id: "person-response:1",
      role: "user",
      content: expect.stringContaining("Ramen, please."),
    },
  });
  // Progress is recorded against the responsibility's latest run, which is what completes it.
  expect(recorded).toEqual([
    [
      owner,
      responsibility.id,
      { summary: "Lunch: ramen", complete: true, sourceRunId: "run-latest" },
      "general-assistant",
    ],
  ]);
});

/*
 * The run that asked is suspended, waiting for this answer. It is resumed rather than a second,
 * detached turn run beside it: the detached turn could read the answer, but its progress was refused
 * by the real store because the run it named had already finished, and the goal never completed.
 */
test("an answer resumes the responsibility run that is waiting for it", async () => {
  const resumed: unknown[] = [];
  const store = {
    get: async () => responsibility,
    listRuns: async () => [
      {
        id: "run-asked",
        status: "waiting",
        waiting: { kind: PERSON_QUESTION_WAITING },
      },
    ],
    resumeWaiting: async (...args: unknown[]) => {
      resumed.push(args);
      return true;
    },
  } as unknown as Pick<
    ResponsibilityStore,
    "get" | "listRuns" | "resumeWaiting"
  >;
  const never: TurnRunner = async () => {
    throw new Error("no detached turn may run");
  };
  const outcome = await resumePersonQuestion({
    ownerUserId: owner,
    question: question(),
    response: "Latte, please.",
    messageId: "person-response:2",
    runTurn: never,
    responsibilities: store,
    responsibilityTurn: () => never,
  });
  expect(outcome).toEqual({
    replyText: "",
    responsibilityId: responsibility.id,
  });
  expect(resumed).toEqual([
    [owner, "run-asked", { content: "The person answered: Latte, please." }],
  ]);
});

test("an answer cannot be pointed at another person's responsibility or another conversation", async () => {
  const store = {
    get: async (ownerUserId: string, id: string) => {
      if (id !== responsibility.id) throw new ResponsibilityNotFoundError();
      return { ...responsibility, ownerUserId };
    },
    listRuns: async () => [],
  } as unknown as Pick<ResponsibilityStore, "get" | "listRuns">;
  const never = () => {
    throw new Error("must not run");
  };
  await expect(
    resumePersonQuestion({
      ownerUserId: owner,
      question: question({
        initiator: { kind: "responsibility", id: "theirs" },
      }),
      response: "x",
      messageId: "m",
      runTurn: never,
      responsibilities: store,
      responsibilityTurn: never,
    }),
  ).rejects.toBeInstanceOf(ResponsibilityNotFoundError);
  await expect(
    resumePersonQuestion({
      ownerUserId: owner,
      question: question({ threadId: "another-thread" }),
      response: "x",
      messageId: "m",
      runTurn: never,
      responsibilities: store,
      responsibilityTurn: never,
    }),
  ).rejects.toThrow("does not belong to this responsibility");
});

test("other questions keep the initiator they were asked under", async () => {
  const seen: unknown[] = [];
  const runTurn: TurnRunner = async (input) => {
    seen.push(input.initiator);
    return { replyText: "ok" };
  };
  for (const initiator of [
    undefined,
    { kind: "routine" as const, id: "routine-1" },
  ])
    await resumePersonQuestion({
      ownerUserId: owner,
      question: question({ initiator }),
      response: "yes",
      messageId: "m",
      runTurn,
    });
  expect(seen).toEqual([
    { kind: "person" },
    { kind: "routine", id: "routine-1" },
  ]);
});
