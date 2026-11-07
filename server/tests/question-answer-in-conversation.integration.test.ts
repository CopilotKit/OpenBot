import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import {
  createApprovalQuestions,
  type PersonQuestion,
} from "../src/approvals/questions";
import { createApprovalRoutes } from "../src/approvals/routes";
import { createApprovalService } from "../src/approvals/service";
import { createApprovalStore } from "../src/approvals/store";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { workItems } from "../src/db/schema/work";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * A Bot asked the person a question in their conversation, and they answered it there.
 *
 * The answer to a question the person's own turn asked is that conversation's next turn, and the
 * conversation runs it, live and stoppable. It used to be queued for the server to resume headless,
 * so the screen showed "reading your answer" with no steps and no Stop until the turn was over, and
 * then drew every step at once. A question a routine asked still comes back to the server, which
 * resumes it with the routine's own tools; so does an answer given anywhere but the conversation.
 *
 * Over HTTP, through the real routes, service and store, on a real database.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `answer-here-${randomUUID()}`;
const owner = `${prefix}-owner`;
const keys: string[] = [];

const service = createApprovalService(
  createApprovalStore(database),
  createApprovalQuestions(database, async () => undefined),
);
const app = new Hono<{ Variables: AppVariables }>();
app.route(
  "/api/approvals",
  createApprovalRoutes(service, async (context, next) => {
    context.set("actor", {
      id: owner,
      email: `${owner}@example.test`,
      role: "user",
    });
    await next();
  }),
);

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

async function asked(initiator?: PersonQuestion["initiator"]) {
  const key = randomUUID();
  keys.push(key);
  const question: PersonQuestion = {
    actorId: owner,
    botId: "picked-harness",
    sourceBotId: "picked-harness",
    channelId: `${prefix}-channel`,
    threadId: `${prefix}-thread`,
    runId: randomUUID(),
    question: "Which city are you in?",
    mode: "completed_question",
    ...(initiator ? { initiator } : {}),
  };
  await database
    .insert(workItems)
    .values({ kind: "person.question", key, payload: question });
  return key;
}
const answer = (key: string, body: unknown) =>
  app.request(`/api/approvals/questions/${key}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
async function state(key: string) {
  const [question] = await database
    .select()
    .from(workItems)
    .where(and(eq(workItems.kind, "person.question"), eq(workItems.key, key)));
  const resumes = await database
    .select()
    .from(workItems)
    .where(and(eq(workItems.kind, "person.response"), eq(workItems.key, key)));
  return { closed: question?.finishedAt != null, resumes: resumes.length };
}

test("an answer given in the conversation to its own turn's question is that conversation's turn to run", async () => {
  for (const initiator of [undefined, { kind: "person" as const }]) {
    const key = await asked(initiator);
    const response = await answer(key, {
      response: "Chicago",
      inConversation: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: key, continueHere: true });
    // Closed, and nothing queued for the server to run out of the conversation's sight.
    expect(await state(key)).toEqual({ closed: true, resumes: 0 });
    // And once only.
    const again = await answer(key, {
      response: "Chicago",
      inConversation: true,
    });
    expect(again.status).toBe(400);
  }
});

test("a routine's question is resumed by the server even when answered in the conversation", async () => {
  const key = await asked({ kind: "routine", id: "weekend-digest" });
  const response = await answer(key, {
    response: "Chicago",
    inConversation: true,
  });
  expect(await response.json()).toEqual({ id: key, queued: true });
  expect(await state(key)).toEqual({ closed: true, resumes: 1 });
});

test("an answer given away from the conversation is resumed by the server", async () => {
  const key = await asked({ kind: "person" });
  const response = await answer(key, { response: "Chicago" });
  expect(await response.json()).toEqual({ id: key, queued: true });
  expect(await state(key)).toEqual({ closed: true, resumes: 1 });
});
