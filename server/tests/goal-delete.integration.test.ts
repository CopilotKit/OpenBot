import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { routines } from "../src/db/schema/coworker";
import { agents, users } from "../src/db/schema/core";
import {
  responsibilities,
  responsibilityRuns,
} from "../src/db/schema/responsibilities";
import { createResponsibilityRoutes } from "../src/responsibilities/routes";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Deleting a goal from its dialog, through `DELETE /api/responsibilities/:id` against a real
 * PostgreSQL: the goal, the routines that run it and its runs go; another person's goal, and a
 * routine of the owner's that runs nothing, stay.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `goal-delete-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const strangerId = `${prefix}-stranger`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const store = createResponsibilityStore(database, {
  resolveTarget: async () => ({ threadId: `${prefix}-thread` }),
});

function appFor(userId: string) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: userId,
      email: `${userId}@example.test`,
      role: "user",
    } as AppVariables["actor"]);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/responsibilities",
    createResponsibilityRoutes(
      store,
      { ingest: async () => ({}) as never },
      requireUser,
    ),
  );
  return app;
}

const remove = (userId: string, id: string) =>
  appFor(userId).request(
    `http://openbot.test/api/responsibilities/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

beforeAll(async () => {
  await database.insert(users).values([
    { id: ownerId, email: `${ownerId}@example.test` },
    { id: strangerId, email: `${strangerId}@example.test` },
  ]);
  await database.insert(agents).values({
    id: botId,
    name: "Goal delete test Bot",
    type: "built_in",
    configuration: {},
  });
});
afterAll(async () => {
  await database
    .delete(routines)
    .where(inArray(routines.ownerUserId, [ownerId, strangerId]));
  await database.delete(users).where(inArray(users.id, [ownerId, strangerId]));
  await database.delete(agents).where(eq(agents.id, botId));
  await database.$client.close();
});

async function goal(ownerUserId = ownerId, title = "Ship the release") {
  return store.create(ownerUserId, {
    agentId: botId,
    channelId,
    title,
    instruction: "Ship the release",
    successCriteria: "It is out",
  });
}

/** A routine made before routines recorded their goal, which runs the goals its instruction names. */
async function olderRoutine(instruction: string) {
  const id = `routine_${randomUUID()}`;
  await database.insert(routines).values({
    id,
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
    instruction,
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000),
    goalId: null,
    goalByTitle: true,
  });
  return id;
}

async function routine(goalId: string | null) {
  const id = `routine_${randomUUID()}`;
  await database.insert(routines).values({
    id,
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
    instruction: "Check the release",
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000),
    goalId,
  });
  return id;
}

const routineIds = async (ids: string[]) =>
  (
    await database
      .select({ id: routines.id })
      .from(routines)
      .where(inArray(routines.id, ids))
  ).map((row) => row.id);

test("deleting a goal takes the routines that run it and its runs, and nothing else", async () => {
  const target = await goal();
  const runsIt = await routine(target.id);
  const unrelated = await routine(null);
  await store.ingestEvent({
    ownerUserId: ownerId,
    source: "manual",
    externalId: randomUUID(),
    type: "requested",
    responsibilityId: target.id,
    payload: {},
  });

  const response = await remove(ownerId, target.id);

  expect(response.status).toBe(204);
  expect(
    await database
      .select({ id: responsibilities.id })
      .from(responsibilities)
      .where(eq(responsibilities.id, target.id)),
  ).toEqual([]);
  expect(
    await database
      .select({ id: responsibilityRuns.id })
      .from(responsibilityRuns)
      .where(eq(responsibilityRuns.responsibilityId, target.id)),
  ).toEqual([]);
  expect(await routineIds([runsIt, unrelated])).toEqual([unrelated]);
});

test("another person's goal, or one that is gone, is not found", async () => {
  const theirs = await goal();
  const runsIt = await routine(theirs.id);

  const stranger = await remove(strangerId, theirs.id);
  expect(stranger.status).toBe(404);
  expect(await stranger.json()).toEqual({
    error: "This goal could not be found.",
  });
  expect(await store.get(ownerId, theirs.id)).toMatchObject({ id: theirs.id });
  expect(await routineIds([runsIt])).toEqual([runsIt]);

  const missing = await remove(ownerId, `${prefix}-missing`);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    error: "This goal could not be found.",
  });
});

test("an older routine that runs the goal by its title goes with it, unless it still runs another open goal", async () => {
  const title = `Weekly report ${randomUUID()}`;
  const otherTitle = `Inbox zero ${randomUUID()}`;
  const target = await goal(ownerId, title);
  await goal(ownerId, otherTitle);
  const byTitle = await olderRoutine(`Run the goal "${title}"`);
  const both = await olderRoutine(
    `Run the goal "${title}", then the goal "${otherTitle}"`,
  );

  expect((await remove(ownerId, target.id)).status).toBe(204);

  expect(await routineIds([byTitle, both])).toEqual([both]);
});

test("a run in progress when its goal is deleted settles as gone", async () => {
  const target = await goal();
  const { runIds } = await store.ingestEvent({
    ownerUserId: ownerId,
    source: "manual",
    externalId: randomUUID(),
    type: "requested",
    responsibilityId: target.id,
    payload: {},
  });
  const runId = runIds[0];
  if (!runId) throw new Error("Expected a queued run.");
  expect(await store.beginRun(runId)).not.toBeNull();

  expect((await remove(ownerId, target.id)).status).toBe(204);

  expect(
    await store.settleRun(runId, { status: "succeeded", replyText: "Done." }),
  ).toBe(false);
});
