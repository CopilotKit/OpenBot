import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, inArray } from "drizzle-orm";
import { z } from "zod";
import { wireCoordination } from "../src/agents/coordination-wiring";
import { PUT_TO } from "../src/agents/escalation";
import { createApprovalQuestions } from "../src/approvals/questions";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * A question the person answers in their own words.
 *
 * `ask_person` took a decision's `options` as two to six, so the first-use "Find weekend plans"
 * starter, whose Bot asks which city with `options: []`, was refused before anybody was asked: the
 * chat drew "Blocked: Asked you" and no question reached the person. Driven here through the tool a
 * Bot's run is handed and the route that saves the question for its person, for a decision with no
 * options, an empty list, one suggestion, and the multiple choice that already worked.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `ask-free-${randomUUID()}`;
const owner = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;

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

async function askPersonTool(threadId: string) {
  const source = async () => ({ channelId, botId });
  const { coordinationForActor } = wireCoordination({
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
  return askPerson;
}

const CITY = { header: "City", question: "Which city are you in?" };

test.each([
  ["no options", CITY, CITY],
  ["an empty options list", { ...CITY, options: [] }, CITY],
  [
    "one suggested answer",
    { ...CITY, options: ["San Francisco"] },
    { ...CITY, options: ["San Francisco"] },
  ],
  [
    "two options",
    { ...CITY, options: ["San Francisco", "Oakland"] },
    { ...CITY, options: ["San Francisco", "Oakland"] },
  ],
])(
  "a decision with %s is put to the person and saved for the card",
  async (_name, sent, saved) => {
    const threadId = `${prefix}-thread-${randomUUID()}`;
    const askPerson = await askPersonTool(threadId);

    // The schema the model is shown accepts it too, so a harness that checks a call against that
    // schema does not refuse it before it reaches the server.
    const offered = z.fromJSONSchema(
      z.toJSONSchema(askPerson.parameters) as never,
    );
    expect(
      offered.safeParse({ question: CITY.question, parts: [sent] }).success,
    ).toBe(true);

    const said = await askPerson.execute({
      question: CITY.question,
      parts: [sent],
    });

    // Asked, rather than refused: the answer the chat draws as "Asked you" instead of Blocked.
    expect(String(said)).toStartWith(PUT_TO);

    // The person's inbox holds it, and an empty list travels as no list: the card draws an answer
    // field, with the options as choices above it when there are any.
    const waiting = (
      await createApprovalQuestions(database, async () => undefined).list(owner)
    ).find((entry) => entry.threadId === threadId);
    if (!waiting) throw new Error("the question was not saved for its person");
    asked.push(waiting.id);
    expect(waiting.question).toBe(CITY.question);
    expect(waiting.parts).toEqual([saved]);
  },
);
