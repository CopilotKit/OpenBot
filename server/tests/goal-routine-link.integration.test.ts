import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { routines } from "../src/db/schema/coworker";
import { responsibilities } from "../src/db/schema/responsibilities";
import { workItems } from "../src/db/schema/work";
import { GOAL_TOOLS } from "../src/responsibilities/chat-tools";
import { createResponsibilityStore } from "../src/responsibilities/store";
import { routineRunsGoal } from "../src/responsibilities/types";
import { createRoutineStore, RoutineRefusedError } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * How a routine got the goal it records, and what completing or deleting that goal does to it.
 *
 * A routine is made for a goal (`goalId` on create, or the goal's id in its instruction), or a
 * firing of a broad routine ran the goal with `run_goal` and `linkGoal` recorded it. Completing the
 * goal switches off the first and unlinks the second, leaving it on; deleting the goal deletes the
 * first and unlinks the second. An older routine, made before routines recorded their goal, runs a
 * goal only where its instruction clearly does.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `goal-routine-link-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const channelId = `${prefix}-channel`;
const store = createResponsibilityStore(database, {
  async resolveTarget(owner, bot, channel) {
    return owner === ownerId && bot === botId && channel === channelId
      ? { threadId: `${prefix}-thread` }
      : null;
  },
});
const schedules = createRoutineStore(database);
const valid = {
  agentId: botId,
  channelId,
  instruction: "Check the latest release and report what changed",
  successCriteria: "The person knows what changed",
};
const queuedRuns: string[] = [];
const broadInstruction =
  "Summarize my inbox, and if a release shipped run the goal that tracks it.";

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: ownerId, email: `${ownerId}@example.test` });
  await database.insert(agents).values({
    id: botId,
    name: "Goal routine link test Bot",
    type: "built_in",
    configuration: {},
  });
});
afterAll(async () => {
  if (queuedRuns.length)
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "responsibility.run"),
          inArray(workItems.key, queuedRuns),
        ),
      );
  await database.delete(routines).where(eq(routines.ownerUserId, ownerId));
  await database
    .delete(responsibilities)
    .where(eq(responsibilities.ownerUserId, ownerId));
  await database.delete(users).where(eq(users.id, ownerId));
  await database.delete(agents).where(inArray(agents.id, [botId]));
  await database.$client.close();
});

function goalTitled(title: string) {
  return store.create(ownerId, { ...valid, title });
}
async function routine(
  instruction: string,
  fields: Partial<typeof routines.$inferInsert> = {},
) {
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
    ...fields,
  });
  return id;
}
/** Made for the goal the way a Bot makes one: the goal recorded, its title in the instruction. */
function madeFor(goal: { id: string; title: string }) {
  return routine(`Run the goal "${goal.title}"`, { goalId: goal.id });
}
/** A broad routine whose firing ran the goal through `run_goal`, so `linkGoal` recorded it. */
async function linkedByRun(goalId: string) {
  const id = await routine(broadInstruction);
  expect(await schedules.linkGoal(ownerId, botId, id, goalId)).toBe(true);
  expect((await row(id))?.goalId).toBe(goalId);
  return id;
}
function olderRoutine(instruction: string) {
  return routine(instruction, { goalByTitle: true });
}
async function row(id: string) {
  const [found] = await database
    .select()
    .from(routines)
    .where(eq(routines.id, id));
  return found;
}
async function expectOnAndFree(id: string) {
  const found = await row(id);
  expect(found?.enabled).toBe(true);
  expect(found?.goalId).toBeNull();
  // Not refused as `goal_complete`: the person can switch it off and on again.
  await schedules.setEnabled(ownerId, id, false);
  await schedules.setEnabled(ownerId, id, true);
  expect((await row(id))?.enabled).toBe(true);
}
async function expectOffForGood(id: string) {
  expect((await row(id))?.enabled).toBe(false);
  await expect(schedules.setEnabled(ownerId, id, true)).rejects.toBeInstanceOf(
    RoutineRefusedError,
  );
}

/*
 * FOUND IN REVIEW: completion guessed whether a routine was made for its goal from whether the
 * instruction still quoted the goal's id or title. A Bot writes `Run the goal "Title"` and records the
 * goal's id, so after the person renamed the goal, completing it unlinked the routine and left it on,
 * firing `run_goal` at a completed goal every day.
 */
test("completing a goal the person renamed switches off the routines made for it", async () => {
  const goal = await goalTitled(`Track releases ${randomUUID()}`);
  const recorded = await madeFor(goal);
  // Made without `goalId`; its first firing ran the goal and recorded it.
  const linkedOnFiring = await routine(`Run the goal "${goal.title}"`);
  expect(
    await schedules.linkGoal(ownerId, botId, linkedOnFiring, goal.id),
  ).toBe(true);
  // Made before routines recorded their goal; its firing recorded it.
  const older = await olderRoutine(`Run the goal "${goal.title}" and post it.`);
  expect(await schedules.linkGoal(ownerId, botId, older, goal.id)).toBe(true);
  const broad = await linkedByRun(goal.id);

  await store.update(ownerId, goal.id, {
    title: `Release watch ${randomUUID()}`,
  });
  await store.transition(ownerId, goal.id, "completed");

  for (const id of [recorded, linkedOnFiring, older]) {
    expect((await row(id))?.goalId).toBe(goal.id);
    await expectOffForGood(id);
  }
  await expectOnAndFree(broad);
});

test("a run completing a goal the person renamed switches off the routine made for it", async () => {
  const goal = await store.create(ownerId, {
    ...valid,
    title: `Ship the report ${randomUUID()}`,
    endsWhenMet: true,
  });
  const recorded = await madeFor(goal);
  await store.update(ownerId, goal.id, { title: `Report ${randomUUID()}` });
  const queued = await store.ingestEvent({
    ownerUserId: ownerId,
    source: "manual",
    externalId: randomUUID(),
    type: "requested",
    responsibilityId: goal.id,
    payload: {},
  });
  queuedRuns.push(...queued.runIds);
  const runId = queued.runIds[0];
  if (!runId || !(await store.beginRun(runId)))
    throw new Error("Expected a running run.");
  await store.recordProgress(ownerId, goal.id, {
    summary: "Shipped.",
    complete: true,
    sourceRunId: runId,
  });
  await expectOffForGood(recorded);
});

// A broad routine the person had switched off is unlinked too, so they can switch it back on.
test("completing a goal unlinks a switched-off broad routine a run linked to it", async () => {
  const goal = await goalTitled(`Track releases ${randomUUID()}`);
  const broad = await linkedByRun(goal.id);
  await schedules.setEnabled(ownerId, broad, false);
  await store.transition(ownerId, goal.id, "completed");
  expect((await row(broad))?.goalId).toBeNull();
  await schedules.setEnabled(ownerId, broad, true);
  expect((await row(broad))?.enabled).toBe(true);
});

/*
 * FOUND IN REVIEW: deleting a goal deleted every routine that recorded it, including a broad routine
 * one of whose firings had run it, and the person lost the rest of what that routine did.
 */
test("deleting a goal unlinks a broad routine a run linked to it, and deletes the routine made for it", async () => {
  const goal = await goalTitled(`Track releases ${randomUUID()}`);
  const recorded = await madeFor(goal);
  const broad = await linkedByRun(goal.id);
  const broadOff = await linkedByRun(goal.id);
  await schedules.setEnabled(ownerId, broadOff, false);

  await store.delete(ownerId, goal.id);

  expect(await row(recorded)).toBeUndefined();
  await expectOnAndFree(broad);
  const kept = await row(broadOff);
  expect(kept?.goalId).toBeNull();
  expect(kept?.enabled).toBe(false);
});

/*
 * FOUND IN REVIEW: `linkGoal` read the routine and wrote the link with nothing holding the goal, so a
 * firing's `run_goal` still in flight when the person completed the goal linked the routine to a
 * completed goal, and it could never be switched back on.
 */
test("linkGoal links nothing to a goal that is complete or paused", async () => {
  const done = await goalTitled(`Done ${randomUUID()}`);
  await store.transition(ownerId, done.id, "completed");
  const paused = await goalTitled(`Paused ${randomUUID()}`);
  await store.transition(ownerId, paused.id, "paused");
  const broad = await routine(broadInstruction);

  expect(await schedules.linkGoal(ownerId, botId, broad, done.id)).toBe(false);
  expect(await schedules.linkGoal(ownerId, botId, broad, paused.id)).toBe(
    false,
  );
  await expectOnAndFree(broad);
});

test("linkGoal waits for a completion holding the goal, and then links nothing", async () => {
  const goal = await goalTitled(`Track releases ${randomUUID()}`);
  const broad = await routine(broadInstruction);
  let linking: Promise<boolean> | undefined;
  await database.transaction(async (transaction) => {
    // What completing the goal holds first: its row, for update.
    await transaction
      .select({ id: responsibilities.id })
      .from(responsibilities)
      .where(eq(responsibilities.id, goal.id))
      .for("update");
    linking = schedules.linkGoal(ownerId, botId, broad, goal.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await transaction
      .update(responsibilities)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(responsibilities.id, goal.id));
  });
  expect(await linking).toBe(false);
  await expectOnAndFree(broad);
});

/*
 * FOUND IN REVIEW: an older routine ran a goal when its instruction held the goal's whole title in
 * quotes anywhere, so `Ship "Report"` ran the goal "Report", and a quote inside a longer title ran a
 * shorter goal. Completing that goal switched the routine off for good. It now runs a goal only where
 * it clearly does: the goal's id, or the word "goal" (or `run_goal`) before its quoted title.
 */
test("an older routine runs a goal only where its instruction clearly runs it", () => {
  const older = (instruction: string) => ({
    goalId: null,
    goalByTitle: true,
    instruction,
  });
  const report = { id: "goal-report", title: "Report" };
  const bob = { id: "goal-bob", title: "Bob" };
  for (const instruction of [
    'Ship "Report"',
    'Ship "Report" to the team every Friday',
    "Remind me about “Report” on Fridays",
    'Run the goal "Report draft"',
    'Run the goal "Weekly "Report""',
  ])
    expect(routineRunsGoal(older(instruction), report)).toBe(false);
  expect(routineRunsGoal(older("Run the goal 'Bob's report'"), bob)).toBe(
    false,
  );
  for (const instruction of [
    'Run the goal "Report"',
    'Run the goal "Report" and post it here.',
    "Run the existing goal “Report” and tell me what changed",
    'Run the goal "Inbox zero", then the goal "Report".',
    'Call run_goal "Report"',
    "Run goal goal-report and report back",
  ])
    expect(routineRunsGoal(older(instruction), report)).toBe(true);
});

test("completing a goal leaves on an older routine that only quotes its title", async () => {
  const goal = await goalTitled(`Report ${randomUUID()}`);
  const quotes = await olderRoutine(`Ship "${goal.title}" to the team`);
  const runs = await olderRoutine(`Run the goal "${goal.title}"`);
  expect(await store.repeats(ownerId, goal.id)).toBe("routine");
  await store.transition(ownerId, goal.id, "completed");
  expect((await row(quotes))?.enabled).toBe(true);
  await schedules.setEnabled(ownerId, quotes, false);
  await schedules.setEnabled(ownerId, quotes, true);
  expect((await row(quotes))?.enabled).toBe(true);
  expect((await row(runs))?.enabled).toBe(false);
});

/*
 * Deleting a goal deletes an older routine that runs it by title, unless it still runs another open
 * goal. One that only quotes the goal's title never ran it, and stays.
 */
test("deleting a goal deletes an older routine that runs it, and keeps one that only quotes its title", async () => {
  const goal = await goalTitled(`Weekly report ${randomUUID()}`);
  const open = await goalTitled(`Inbox zero ${randomUUID()}`);
  const runsIt = await olderRoutine(`Run the goal "${goal.title}"`);
  const runsBoth = await olderRoutine(
    `Run the goal "${goal.title}", then the goal "${open.title}"`,
  );
  const quotesIt = await olderRoutine(`Ship "${goal.title}" to the team`);

  await store.delete(ownerId, goal.id);

  expect(await row(runsIt)).toBeUndefined();
  expect((await row(runsBoth))?.enabled).toBe(true);
  expect((await row(quotesIt))?.enabled).toBe(true);
  expect(await store.repeats(ownerId, open.id)).toBe("routine");
});

// What a Bot reads before it sets `endsWhenMet`: never on work wanted every time.
test("create_goal tells a Bot not to end a goal wanted every time when it is met", () => {
  const createGoal = GOAL_TOOLS.find((tool) => tool.name === "create_goal");
  const field = (
    createGoal?.inputSchema as {
      properties?: Record<string, { description?: string }>;
    }
  )?.properties?.endsWhenMet?.description;
  expect(createGoal?.description.replace(/\s+/g, " ")).toContain(
    "Never set `endsWhenMet` for work the person wants done every time",
  );
  expect(field).toContain(
    "Never set this for work the person wants done every time",
  );
});
