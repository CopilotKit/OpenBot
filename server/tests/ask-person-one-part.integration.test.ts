import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, inArray } from "drizzle-orm";
import { wireCoordination } from "../src/agents/coordination-wiring";
import { PUT_TO } from "../src/agents/escalation";
import { resumePersonQuestion } from "../src/approvals/question-resume";
import {
  createApprovalQuestions,
  personQuestionSchema,
} from "../src/approvals/questions";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A Bot asking the person one thing, with the answers it expects.
 *
 * `ask_person` took its `parts` as two to six decisions, so a model that put a single decision
 * there (a time zone, with the likely zones as options) was refused before anybody was asked. The
 * chat drew the step as Blocked and the Bot went on to guess, which is the one thing the tool exists
 * to stop. Driven here through the same tool a Bot's run is handed and the route that saves the
 * question for its person, then answered from the inbox and resumed, because the refusal sat at the
 * front of that path and the rest of it had never seen a question of one part.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `ask-one-${randomUUID()}`;
const owner = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const threadId = `${prefix}-thread`;

const asked: string[] = [];

afterAll(async () => {
  if (asked.length)
    await database
      .delete(workItems)
      .where(
        and(
          inArray(workItems.kind, ["person.question", "person.response"]),
          inArray(workItems.key, asked),
        ),
      );
  await database.$client.close();
});

function coordinationForThisBot() {
  const source = async () => ({ channelId, botId });
  return wireCoordination({
    handoffDesk: {
      send: async () => ({ ok: false, refusal: "No Bot to hand to." }),
    } as never,
    config: loadConfig(testEnvironment()),
    approvalService: { store: {} } as never,
    agentProfileStore: {
      get: async () => ({ name: "General Assistant" }),
      list: async () => [],
    } as never,
    actorFor: async (id) => ({ id }) as never,
    channelSourceForRun: source,
    database,
    pluginStore: { botsReachableFrom: async () => [] } as never,
    bootAuditStore: { insert: async () => undefined } as never,
    peopleStore: { find: async () => ({ revoked: false }) } as never,
    sourceForCoordinationRun: source,
    channelStore: { recordActivity: async () => undefined } as never,
    notify: async () => undefined,
  });
}

test("a question of one decision is put to the person, answered from the inbox, and resumed", async () => {
  const { coordinationForActor } = coordinationForThisBot();
  const tools = await coordinationForActor(owner)(botId, {
    threadId,
    runId: randomUUID(),
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
  const askPerson = tools.find((tool) => tool.name === "ask_person");
  if (!askPerson) throw new Error("the run was not offered ask_person");

  const part = {
    header: "Time zone",
    question: "Which time zone should the event use?",
    options: ["Europe/London", "America/New_York", "Asia/Tokyo"],
  };
  const said = await askPerson.execute({
    question: "Which time zone should the event use?",
    parts: [part],
  });

  // Asked, rather than refused: the answer the chat draws as "Asked you" instead of Blocked.
  expect(String(said)).toStartWith(PUT_TO);

  // The person's inbox holds it with its one decision and its options, which the drawer draws.
  const waiting = (
    await createApprovalQuestions(database, async () => undefined).list(owner)
  ).find((entry) => entry.threadId === threadId);
  if (!waiting) throw new Error("the question was not saved for its person");
  asked.push(waiting.id);
  expect(waiting.channelId).toBe(channelId);
  expect(waiting.parts).toEqual([part]);

  // Answered the way the drawer sends one: the decision's label, then the option picked.
  await createApprovalQuestions(database, async () => undefined).respond(
    owner,
    waiting.id,
    "Time zone: Europe/London",
  );
  const [response] = await database
    .select()
    .from(workItems)
    .where(
      and(eq(workItems.kind, "person.response"), eq(workItems.key, waiting.id)),
    );
  if (!response) throw new Error("the answer was not queued");
  const payload = response.payload as { question: unknown; response: string };
  const question = personQuestionSchema.parse(payload.question);
  expect(question.parts).toEqual([part]);

  // And the Bot's next turn, in the same conversation, opens on that answer.
  const turns: Parameters<TurnRunner>[0][] = [];
  await resumePersonQuestion({
    ownerUserId: owner,
    question,
    response: payload.response,
    messageId: `person-response:${waiting.id}`,
    runTurn: async (turn) => {
      turns.push(turn);
      return { replyText: "Booked for 10:00 Europe/London." };
    },
  });
  expect(turns[0]?.threadId).toBe(threadId);
  expect(turns[0]?.userMessage?.content).toBe(
    "In response to your question: Which time zone should the event use?\n\nTime zone: Europe/London",
  );
});
