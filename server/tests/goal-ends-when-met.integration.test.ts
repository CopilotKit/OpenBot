import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import { routines } from "../src/db/schema/coworker";
import { responsibilityTriggers } from "../src/db/schema/responsibilities";
import { workItems } from "../src/db/schema/work";
import { createResponsibilityStore } from "../src/responsibilities/store";
import {
  ENDS_WITHOUT_OUTCOME,
  goalShownFor,
  parseResponsibilityInput,
} from "../src/responsibilities/types";
import { createRoutineStore, RoutineRefusedError } from "../src/routines/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `goal-ends-when-met-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const botId = `${prefix}-bot`;
const otherBotId = `${prefix}-other-bot`;
const channelId = `${prefix}-channel`;
const store = createResponsibilityStore(database, {
  async resolveTarget(owner, bot, channel) {
    return owner === ownerId && bot === botId && channel === channelId
      ? { threadId: `${prefix}-thread` }
      : null;
  },
});
const keys: string[] = [];
const valid = {
  agentId: botId,
  channelId,
  title: "Ship the report",
  instruction: "Produce the report",
  successCriteria: "The report is shipped",
};

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: ownerId, email: `${ownerId}@example.test` });
  await database.insert(agents).values([
    {
      id: botId,
      name: "Ends-when-met test Bot",
      type: "built_in",
      configuration: {},
    },
    {
      id: otherBotId,
      name: "Ends-when-met other test Bot",
      type: "built_in",
      configuration: {},
    },
  ]);
});
afterAll(async () => {
  if (keys.length)
    await database
      .delete(workItems)
      .where(
        and(
          eq(workItems.kind, "responsibility.run"),
          inArray(workItems.key, keys),
        ),
      );
  await database.delete(routines).where(eq(routines.ownerUserId, ownerId));
  await database.delete(users).where(eq(users.id, ownerId));
  await database.delete(agents).where(inArray(agents.id, [botId, otherBotId]));
  await database.$client.close();
});

async function goal(endsWhenMet: boolean) {
  return store.create(ownerId, { ...valid, endsWhenMet });
}
/** A routine made for a goal: it records the goal, and its instruction names it as the page writes. */
async function routineRunning(goalId: string, agentId = botId) {
  const id = `routine_${randomUUID()}`;
  await database.insert(routines).values({
    id,
    ownerUserId: ownerId,
    agentId,
    channelId,
    instruction: `Run the goal "${valid.title}" (${goalId}) with run_goal.`,
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000),
    goalId,
  });
  return id;
}
/** A routine made before routines recorded their goal: it names the goal in its instruction. */
async function olderRoutine(instruction: string, agentId = botId) {
  const id = `routine_${randomUUID()}`;
  await database.insert(routines).values({
    id,
    ownerUserId: ownerId,
    agentId,
    channelId,
    instruction,
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000),
    goalByTitle: true,
  });
  return id;
}
async function routineRow(id: string) {
  const [row] = await database
    .select()
    .from(routines)
    .where(eq(routines.id, id));
  return row;
}
async function beganRun(goalId: string) {
  const queued = await store.ingestEvent({
    ownerUserId: ownerId,
    source: "manual",
    externalId: randomUUID(),
    type: "requested",
    responsibilityId: goalId,
    payload: {},
  });
  keys.push(...queued.runIds);
  const runId = queued.runIds[0];
  if (!runId) throw new Error("Expected a queued run.");
  const context = await store.beginRun(runId);
  if (!context)
    throw new Error(
      `beginRun returned null for run ${runId} of goal ${goalId}: the run or the goal is gone.`,
    );
  return { runId, context };
}
async function runningRun(goalId: string) {
  return (await beganRun(goalId)).runId;
}
async function triggerWaking(goalId: string) {
  await database.insert(responsibilityTriggers).values({
    id: `trigger_${randomUUID()}`,
    ownerUserId: ownerId,
    responsibilityId: goalId,
    kind: "webhook",
    config: { kind: "webhook", filter: { eventTypes: [] } },
  });
}
const wakesOnRelease = [{ source: "github", eventType: "release.published" }];

test("a run completes a goal a routine runs, when the goal ends when met", async () => {
  const value = await goal(true);
  await routineRunning(value.id);
  const sourceRunId = await runningRun(value.id);
  expect(await store.repeats(ownerId, value.id)).toBeNull();
  const done = await store.recordProgress(ownerId, value.id, {
    summary: "Shipped.",
    complete: true,
    sourceRunId,
  });
  expect(done.status).toBe("completed");
});

test("completing a goal switches off the routines that run it", async () => {
  const value = await goal(true);
  const routineId = await routineRunning(value.id);
  const sourceRunId = await runningRun(value.id);
  await store.recordProgress(ownerId, value.id, {
    summary: "Shipped.",
    complete: true,
    sourceRunId,
  });
  expect((await routineRow(routineId))?.enabled).toBe(false);
});

test("a goal a routine runs still repeats without the flag", async () => {
  const value = await goal(false);
  await routineRunning(value.id);
  expect(await store.repeats(ownerId, value.id)).toBe("routine");
});

test("a goal can't both recur and end when met", () => {
  expect(() =>
    parseResponsibilityInput({
      ...valid,
      recurring: true,
      endsWhenMet: true,
    }),
  ).toThrow("A goal that recurs has no outcome that ends it.");
});

test("a goal that ends when met can't be made to recur", async () => {
  const value = await goal(true);
  await expect(
    store.update(ownerId, value.id, { recurring: true }),
  ).rejects.toThrow("A goal that recurs has no outcome that ends it.");
  const reread = await store.get(ownerId, value.id);
  expect(reread.recurring).toBe(false);
  expect(reread.endsWhenMet).toBe(true);
});

test("a goal that recurs can't be made to end when met", async () => {
  const value = await store.create(ownerId, { ...valid, recurring: true });
  await expect(
    store.update(ownerId, value.id, { endsWhenMet: true }),
  ).rejects.toThrow("A goal that recurs has no outcome that ends it.");
  const reread = await store.get(ownerId, value.id);
  expect(reread.recurring).toBe(true);
  expect(reread.endsWhenMet).toBe(false);
});

test("the person completing a goal switches off the routine that runs it", async () => {
  const value = await goal(false);
  const routineId = await routineRunning(value.id);
  await store.transition(ownerId, value.id, "completed");
  expect((await routineRow(routineId))?.enabled).toBe(false);
});

test("a goal that ends when met must say what done looks like", () => {
  expect(() =>
    parseResponsibilityInput({
      ...valid,
      endsWhenMet: true,
      successCriteria: "",
    }),
  ).toThrow(ENDS_WITHOUT_OUTCOME);
  expect(() =>
    parseResponsibilityInput({
      ...valid,
      endsWhenMet: true,
      successCriteria: "   ",
    }),
  ).toThrow(ENDS_WITHOUT_OUTCOME);
});

test("a patch that clears the success criteria of a goal that ends when met is refused", async () => {
  const value = await goal(true);
  await expect(
    store.update(ownerId, value.id, { successCriteria: "" }),
  ).rejects.toThrow(ENDS_WITHOUT_OUTCOME);
  expect((await store.get(ownerId, value.id)).successCriteria).toBe(
    valid.successCriteria,
  );
});

test("a patch that makes a goal with no success criteria end when met is refused", async () => {
  const value = await store.create(ownerId, { ...valid, successCriteria: "" });
  await expect(
    store.update(ownerId, value.id, { endsWhenMet: true }),
  ).rejects.toThrow(ENDS_WITHOUT_OUTCOME);
  const reread = await store.get(ownerId, value.id);
  expect(reread.endsWhenMet).toBe(false);
  expect(reread.successCriteria).toBe("");
});

test("a patch can set the success criteria and end when met together", async () => {
  const value = await store.create(ownerId, { ...valid, successCriteria: "" });
  const updated = await store.update(ownerId, value.id, {
    endsWhenMet: true,
    successCriteria: "The report is shipped",
  });
  expect(updated.endsWhenMet).toBe(true);
});

test("a goal with no success criteria that doesn't end when met is still accepted", async () => {
  const value = await store.create(ownerId, { ...valid, successCriteria: "" });
  expect(value.endsWhenMet).toBe(false);
  expect(value.successCriteria).toBe("");
  const cleared = await goal(false);
  const updated = await store.update(ownerId, cleared.id, {
    successCriteria: "",
  });
  expect(updated.successCriteria).toBe("");
});

test("the person completing a goal switches off an older routine that names it by title", async () => {
  const title = `Ship the report ${randomUUID()}`;
  const value = await store.create(ownerId, { ...valid, title });
  const routineId = await olderRoutine(`Run the goal "${title}" every morning`);
  expect(await store.repeats(ownerId, value.id)).toBe("routine");
  await store.transition(ownerId, value.id, "completed");
  expect((await routineRow(routineId))?.enabled).toBe(false);
});

test("the person completing a goal switches off an older routine that names its id", async () => {
  const value = await goal(false);
  const routineId = await olderRoutine(`Run goal ${value.id} and report back`);
  await store.transition(ownerId, value.id, "completed");
  expect((await routineRow(routineId))?.enabled).toBe(false);
});

test("a run completing a goal that ends when met switches off an older routine that names it", async () => {
  const title = `Ship the report ${randomUUID()}`;
  const value = await store.create(ownerId, {
    ...valid,
    title,
    endsWhenMet: true,
  });
  const byTitle = await olderRoutine(`Run the goal \u201c${title}\u201d daily`);
  const byId = await olderRoutine(`Run goal ${value.id}`);
  const sourceRunId = await runningRun(value.id);
  await store.recordProgress(ownerId, value.id, {
    summary: "Shipped.",
    complete: true,
    sourceRunId,
  });
  expect((await routineRow(byTitle))?.enabled).toBe(false);
  expect((await routineRow(byId))?.enabled).toBe(false);
});

test("completing a goal leaves on the routines that don't run it", async () => {
  const title = `Ship the report ${randomUUID()}`;
  const value = await store.create(ownerId, { ...valid, title });
  const other = await goal(false);
  const unrelated = await olderRoutine("Check the inbox and summarise it");
  // Mentions the title, but not whole and between quotes: an older routine that doesn't run it.
  const mentions = await olderRoutine(`Remind me about ${title} on Fridays`);
  const ofOtherGoal = await routineRunning(other.id);
  // Records another goal while its instruction quotes this one's title, and may read titles
  // (`goalByTitle`): the goal it records wins, so it doesn't run this one.
  const recordsOther = await routineRunning(other.id);
  await database
    .update(routines)
    .set({ instruction: `Run the goal "${title}"`, goalByTitle: true })
    .where(eq(routines.id, recordsOther));
  await store.transition(ownerId, value.id, "completed");
  expect((await routineRow(unrelated))?.enabled).toBe(true);
  expect((await routineRow(mentions))?.enabled).toBe(true);
  expect((await routineRow(ofOtherGoal))?.enabled).toBe(true);
  expect((await routineRow(recordsOther))?.enabled).toBe(true);
});

test("a run completing a goal leaves on the routines that don't run it", async () => {
  const value = await goal(true);
  const other = await goal(false);
  const unrelated = await olderRoutine("Check the inbox and summarise it");
  const ofOtherGoal = await routineRunning(other.id);
  const sourceRunId = await runningRun(value.id);
  await store.recordProgress(ownerId, value.id, {
    summary: "Shipped.",
    complete: true,
    sourceRunId,
  });
  expect((await routineRow(unrelated))?.enabled).toBe(true);
  expect((await routineRow(ofOtherGoal))?.enabled).toBe(true);
});

/*
 * An older routine can name two goals of its Bot. Completing one leaves it on while the other is not
 * completed, so the other still repeats; a routine that runs no other open goal is switched off.
 */
test("the person completing a goal leaves on an older routine that also runs another open goal", async () => {
  const done = await store.create(ownerId, {
    ...valid,
    title: `Weekly report ${randomUUID()}`,
  });
  const open = await store.create(ownerId, {
    ...valid,
    title: `Inbox zero ${randomUUID()}`,
  });
  const ended = await store.create(ownerId, {
    ...valid,
    title: `Old report ${randomUUID()}`,
  });
  await store.transition(ownerId, ended.id, "completed");
  const both = await olderRoutine(
    `Run the goal "${done.title}", then the goal "${open.title}"`,
  );
  const onlyDone = await olderRoutine(`Run the goal "${done.title}"`);
  const doneAndEnded = await olderRoutine(
    `Run goal ${done.id}, then the goal "${ended.title}"`,
  );
  // Records the goal its firing ran, but its instruction names only the open goal: completing the
  // recorded goal unlinks it, and it goes on running the goal it names.
  const recordsDone = await routineRunning(done.id);
  await database
    .update(routines)
    .set({ instruction: `Run the goal "${open.title}"`, goalByTitle: true })
    .where(eq(routines.id, recordsDone));

  await store.transition(ownerId, done.id, "completed");

  expect((await routineRow(both))?.enabled).toBe(true);
  expect((await routineRow(onlyDone))?.enabled).toBe(false);
  expect((await routineRow(doneAndEnded))?.enabled).toBe(false);
  expect((await routineRow(recordsDone))?.enabled).toBe(true);
  expect((await routineRow(recordsDone))?.goalId).toBeNull();
  expect(await store.repeats(ownerId, open.id)).toBe("routine");
  expect((await store.repeatingGoals(ownerId, botId)).get(open.id)).toBe(
    "routine",
  );
  expect((await beganRun(open.id)).context.repeats).toBe("routine");

  // The last open goal it runs completes, and it is switched off.
  await store.transition(ownerId, open.id, "completed");
  expect((await routineRow(both))?.enabled).toBe(false);
  expect((await routineRow(recordsDone))?.enabled).toBe(false);
});

// The Routines page draws such a routine under the goal it still runs, in whatever order goals are read.
test("an older routine naming a completed and an open goal is shown under the open one", () => {
  const shown = (titles: string[], statuses: string[]) =>
    goalShownFor(
      {
        agentId: botId,
        goalId: null,
        goalByTitle: true,
        instruction: titles
          .map((title) => `Run the goal "${title}".`)
          .join(" "),
      },
      titles.map((title, index) => ({
        id: title,
        title,
        agentId: botId,
        status: statuses[index] ?? "active",
      })),
    )?.id;
  expect(shown(["Weekly report", "Inbox zero"], ["completed", "active"])).toBe(
    "Inbox zero",
  );
  expect(shown(["Inbox zero", "Weekly report"], ["active", "completed"])).toBe(
    "Inbox zero",
  );
  expect(shown(["Weekly report", "Inbox zero"], ["completed", "paused"])).toBe(
    "Inbox zero",
  );
  expect(
    shown(["Weekly report", "Inbox zero"], ["completed", "completed"]),
  ).toBe("Weekly report");
});

test("a run completing a goal leaves on an older routine that also runs a paused goal", async () => {
  const done = await store.create(ownerId, {
    ...valid,
    title: `Weekly report ${randomUUID()}`,
    endsWhenMet: true,
  });
  const paused = await store.create(ownerId, {
    ...valid,
    title: `Inbox zero ${randomUUID()}`,
  });
  await store.transition(ownerId, paused.id, "paused");
  const both = await olderRoutine(
    `Run goal ${done.id}, then the goal “${paused.title}”`,
  );
  const onlyDone = await olderRoutine(`Run goal ${done.id}`);
  const sourceRunId = await runningRun(done.id);
  await store.recordProgress(ownerId, done.id, {
    summary: "Shipped.",
    complete: true,
    sourceRunId,
  });
  expect((await routineRow(both))?.enabled).toBe(true);
  expect((await routineRow(onlyDone))?.enabled).toBe(false);
  expect(await store.repeats(ownerId, paused.id)).toBe("routine");
});

/*
 * One rule for which routines run a goal (`routinesRunning`), whether the goal is asked about alone
 * (`repeats`, completion) or with the rest of its Bot's goals as a run begins (`repeatingGoals`): its
 * Bot's routines, and a routine on another Bot only when it records this goal.
 */
test("a routine on another Bot runs a goal it records, read alone or with its Bot's goals", async () => {
  const recorded = await goal(false);
  const titled = await store.create(ownerId, {
    ...valid,
    title: `Ship the report ${randomUUID()}`,
  });
  const elsewhere = await routineRunning(recorded.id, otherBotId);
  // On another Bot, and naming the goal only by its title: not this goal's routine.
  const byTitleElsewhere = await olderRoutine(
    `Run the goal "${titled.title}"`,
    otherBotId,
  );
  expect(await store.repeats(ownerId, recorded.id)).toBe("routine");
  expect(await store.repeats(ownerId, titled.id)).toBeNull();
  const repeating = await store.repeatingGoals(ownerId, botId);
  expect(repeating.get(recorded.id)).toBe("routine");
  expect(repeating.has(titled.id)).toBe(false);
  await store.transition(ownerId, recorded.id, "completed");
  await store.transition(ownerId, titled.id, "completed");
  expect((await routineRow(elsewhere))?.enabled).toBe(false);
  expect((await routineRow(byTitleElsewhere))?.enabled).toBe(true);
});

test("a goal that ends when met does not repeat because an event wakes it, and a run completes it", async () => {
  const subscribed = await store.create(ownerId, {
    ...valid,
    endsWhenMet: true,
    subscriptions: wakesOnRelease,
  });
  const triggered = await goal(true);
  await triggerWaking(triggered.id);
  for (const value of [subscribed, triggered]) {
    expect(await store.repeats(ownerId, value.id)).toBeNull();
    const { runId, context } = await beganRun(value.id);
    expect(context.repeats).toBeNull();
    const done = await store.recordProgress(ownerId, value.id, {
      summary: "Shipped.",
      complete: true,
      sourceRunId: runId,
    });
    expect(done.status).toBe("completed");
  }
});

test("a goal an event wakes still repeats without the flag", async () => {
  const subscribed = await store.create(ownerId, {
    ...valid,
    subscriptions: wakesOnRelease,
  });
  const triggered = await goal(false);
  await triggerWaking(triggered.id);
  expect(await store.repeats(ownerId, subscribed.id)).toBe("event");
  expect(await store.repeats(ownerId, triggered.id)).toBe("event");
  expect((await beganRun(subscribed.id)).context.repeats).toBe("event");
  expect((await beganRun(triggered.id)).context.repeats).toBe("event");
});

test("beginRun and repeatingGoals report what makes a goal repeat, and nothing for one that ends when met", async () => {
  const routineGoal = await goal(false);
  await routineRunning(routineGoal.id);
  const endsWithRoutine = await goal(true);
  await routineRunning(endsWithRoutine.id);
  const endsWithEvent = await store.create(ownerId, {
    ...valid,
    endsWhenMet: true,
    subscriptions: wakesOnRelease,
  });
  const endsWithTrigger = await goal(true);
  await triggerWaking(endsWithTrigger.id);
  const recurring = await store.create(ownerId, { ...valid, recurring: true });
  const plain = await goal(false);

  expect((await beganRun(routineGoal.id)).context.repeats).toBe("routine");
  expect((await beganRun(recurring.id)).context.repeats).toBe("recurring");
  expect((await beganRun(plain.id)).context.repeats).toBeNull();
  for (const value of [endsWithRoutine, endsWithEvent, endsWithTrigger])
    expect((await beganRun(value.id)).context.repeats).toBeNull();

  const repeating = await store.repeatingGoals(ownerId, botId);
  expect(repeating.get(routineGoal.id)).toBe("routine");
  expect(repeating.get(recurring.id)).toBe("recurring");
  for (const value of [endsWithRoutine, endsWithEvent, endsWithTrigger, plain])
    expect(repeating.has(value.id)).toBe(false);
});

test("a completed goal is not among the goals that repeat", async () => {
  const done = await store.create(ownerId, { ...valid, recurring: true });
  const open = await store.create(ownerId, { ...valid, recurring: true });
  expect((await store.repeatingGoals(ownerId, botId)).get(done.id)).toBe(
    "recurring",
  );
  await store.transition(ownerId, done.id, "completed");
  const repeating = await store.repeatingGoals(ownerId, botId);
  expect(repeating.has(done.id)).toBe(false);
  expect(repeating.get(open.id)).toBe("recurring");
});

test("an older schedule cannot be re-enabled after its last goal completes", async () => {
  const done = await store.create(ownerId, {
    ...valid,
    title: `Done ${randomUUID()}`,
  });
  const id = await olderRoutine(`Run the goal "${done.title}"`);
  await store.transition(ownerId, done.id, "completed");
  expect((await routineRow(id))?.enabled).toBe(false);
  await expect(
    createRoutineStore(database).setEnabled(ownerId, id, true),
  ).rejects.toBeInstanceOf(RoutineRefusedError);
  expect((await routineRow(id))?.enabled).toBe(false);
});

test("an older schedule may be enabled while another named goal remains open", async () => {
  const done = await store.create(ownerId, {
    ...valid,
    title: `Done ${randomUUID()}`,
  });
  const open = await store.create(ownerId, {
    ...valid,
    title: `Open ${randomUUID()}`,
  });
  const id = await olderRoutine(`Run "${done.title}" and "${open.title}"`);
  await store.transition(ownerId, done.id, "completed");
  const schedules = createRoutineStore(database);
  await schedules.setEnabled(ownerId, id, false);
  await schedules.setEnabled(ownerId, id, true);
  expect((await routineRow(id))?.enabled).toBe(true);
});

/*
 * A broad routine runs a goal only some days: "Summarise my inbox, and if a release shipped run the
 * goal". Its firing ran the goal through run_goal, so `linkGoal` recorded it, though its instruction
 * names neither the goal's id nor its quoted title.
 *
 * FOUND IN REVIEW: completing the goal switched the routine off, and switching it back on was refused
 * as `goal_complete`, so the person lost their daily inbox summary for good. Completion unlinks such a
 * routine and leaves it on; a routine whose instruction names the goal is still switched off.
 */
async function broadRoutineLinkedTo(goalId: string) {
  const id = `routine_${randomUUID()}`;
  await database.insert(routines).values({
    id,
    ownerUserId: ownerId,
    agentId: botId,
    channelId,
    instruction:
      "Summarise my inbox, and if a release shipped run the goal that tracks it.",
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000),
  });
  expect(
    await createRoutineStore(database).linkGoal(ownerId, botId, id, goalId),
  ).toBe(true);
  expect((await routineRow(id))?.goalId).toBe(goalId);
  return id;
}
async function expectLeftOnAndUnlinked(id: string) {
  const row = await routineRow(id);
  expect(row?.enabled).toBe(true);
  expect(row?.goalId).toBeNull();
  // Not refused as `goal_complete`: the person can switch it off and on again.
  const schedules = createRoutineStore(database);
  await schedules.setEnabled(ownerId, id, false);
  await schedules.setEnabled(ownerId, id, true);
  expect((await routineRow(id))?.enabled).toBe(true);
}

test("the person completing a goal unlinks a broad routine that only ran it, and leaves it on", async () => {
  const value = await store.create(ownerId, {
    ...valid,
    title: `Track releases ${randomUUID()}`,
  });
  const broad = await broadRoutineLinkedTo(value.id);
  await store.transition(ownerId, value.id, "completed");
  await expectLeftOnAndUnlinked(broad);
});

test("a run completing a goal unlinks a broad routine that only ran it, and leaves it on", async () => {
  const value = await store.create(ownerId, {
    ...valid,
    title: `Track releases ${randomUUID()}`,
    endsWhenMet: true,
  });
  const broad = await broadRoutineLinkedTo(value.id);
  const sourceRunId = await runningRun(value.id);
  await store.recordProgress(ownerId, value.id, {
    summary: "Shipped.",
    complete: true,
    sourceRunId,
  });
  await expectLeftOnAndUnlinked(broad);
});

test("completing a goal still switches off the routines whose instruction names it", async () => {
  const value = await store.create(ownerId, {
    ...valid,
    title: `Track releases ${randomUUID()}`,
  });
  const fromPage = await routineRunning(value.id);
  await database
    .update(routines)
    .set({
      instruction: `Run the goal "${value.title}" (${value.id}) with run_goal.`,
    })
    .where(eq(routines.id, fromPage));
  const fromBot = await routineRunning(value.id);
  await database
    .update(routines)
    .set({ instruction: `Run the goal "${value.title}"` })
    .where(eq(routines.id, fromBot));
  const broad = await broadRoutineLinkedTo(value.id);
  await store.transition(ownerId, value.id, "completed");
  for (const id of [fromPage, fromBot]) {
    const row = await routineRow(id);
    expect(row?.enabled).toBe(false);
    expect(row?.goalId).toBe(value.id);
    await expect(
      createRoutineStore(database).setEnabled(ownerId, id, true),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
  }
  await expectLeftOnAndUnlinked(broad);
});
