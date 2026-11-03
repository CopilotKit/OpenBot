import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { channels, users } from "../src/db/schema/core";
import { botTasks } from "../src/db/schema/tasks";
import { createProactiveStore } from "../src/proactive/store";
import {
  ScheduleAlreadyExistsError,
  ScheduleConflictError,
  ScheduleError,
} from "../src/schedules/client";
import type {
  CheckInRunRecord,
  CheckInSuggestionRecord,
  ScheduleDraft,
} from "../src/schedules/types";
import { removeBots, seedBot } from "./support/bots";
import { changeHistory, purgeSchedulesOf } from "./support/check-ins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testScheduleClient, useTestSchedules } from "./support/schedules";

/*
 * The backstops of check-ins: the rules that hold when two replicas race, which no code path can
 * promise on its own. They are Intelligence's now (its agent schedules hold the records), so each
 * test drives the real Intelligence through the same client the server uses.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const client = testScheduleClient();
const prefix = `proactive-schema-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
let counter = 0;
const next = () => `${prefix}-${counter++}`;

/** The rule that refused it, as an error class and status. */
async function refusal(promise: Promise<unknown>): Promise<ScheduleError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ScheduleError);
  return error as ScheduleError;
}

/** A local table's own rule refused it, named in the driver's error. */
async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  let message = "";
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    message = `${String(error)} ${String(cause ?? "")} ${JSON.stringify(error)}`;
  }
  expect(message).toMatch(pattern);
}

let settingId = "";
beforeAll(async () => {
  await useTestSchedules();
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await seedBot({ id: bot, name: "Inbox Bot", type: "built_in" });
  settingId = (
    await createProactiveStore(database).create(
      owner,
      { agentId: bot, channelId: next() },
      next(),
    )
  ).id;
});

afterAll(async () => {
  await purgeSchedulesOf([owner]);
  await removeBots([bot]);
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

function item(
  overrides: Partial<ScheduleDraft<"check-in-suggestions">> = {},
): ScheduleDraft<"check-in-suggestions"> {
  return {
    id: next(),
    ownerUserId: owner,
    agentId: bot,
    settingId,
    runId: next(),
    title: "Reply to Dana about Friday",
    detail: "Dana asked whether Friday still works.",
    sourceApp: "Gmail",
    sourceRef: "gmail.read",
    sourceLink: null,
    status: "open",
    dedupeKey: null,
    pingId: null,
    deliveredAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

test("a new setting checks in hourly unless the person chooses otherwise", async () => {
  expect(
    (await client.get("check-in-settings", settingId))?.intervalMinutes,
  ).toBe(60);
});

test("two open items with one normalized title cannot both stand for a person and Bot", async () => {
  // The race two check-ins can lose: both pass the repeat check, and only one create may land.
  const dedupeKey = `reply to dana about friday ${next()}`;
  const first = await client.create(
    "check-in-suggestions",
    item({ dedupeKey }),
  );
  expect(
    await refusal(client.create("check-in-suggestions", item({ dedupeKey }))),
  ).toBeInstanceOf(ScheduleConflictError);
  // Once the person hid the first, the rule no longer holds it; the 30-day rule is the engine's.
  await changeHistory("check-in-suggestions", first.id, {
    status: "dismissed",
    resolvedAt: new Date(),
  });
  await client.create("check-in-suggestions", item({ dedupeKey }));
  // Items from before the key existed are never refused by it.
  await client.create("check-in-suggestions", item());
  await client.create("check-in-suggestions", item());
});

test("one check-in runs at a time per setting, and only a skipped one carries a reason", async () => {
  const run = (
    overrides: Partial<ScheduleDraft<"check-in-runs">> = {},
  ): ScheduleDraft<"check-in-runs"> => ({
    id: next(),
    settingId,
    ownerUserId: owner,
    agentId: bot,
    threadId: null,
    trigger: "schedule",
    outcome: "running",
    skipReason: null,
    itemsRaised: 0,
    reads: 0,
    error: null,
    startedAt: new Date(),
    finishedAt: null,
    ...overrides,
  });
  const running: CheckInRunRecord = await client.create(
    "check-in-runs",
    run({ threadId: next() }),
  );
  // A second replica, or Run now, finds the first still running.
  expect(
    await refusal(client.create("check-in-runs", run({ trigger: "run_now" }))),
  ).toBeInstanceOf(ScheduleConflictError);
  await changeHistory("check-in-runs", running.id, {
    outcome: "quiet",
    finishedAt: new Date(),
  });
  await client.create("check-in-runs", run());

  const finished = new Date();
  await client.create(
    "check-in-runs",
    run({ outcome: "skipped", skipReason: "capped", finishedAt: finished }),
  );
  expect(
    (
      await refusal(
        client.create(
          "check-in-runs",
          run({ outcome: "skipped", finishedAt: finished }),
        ),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await refusal(
        client.create(
          "check-in-runs",
          run({ outcome: "failed", skipReason: "busy", finishedAt: finished }),
        ),
      )
    ).status,
  ).toBe(400);
  // A finished outcome has a finish time; a running one does not.
  expect(
    (await refusal(client.create("check-in-runs", run({ outcome: "raised" }))))
      .status,
  ).toBe(400);
});

test("a ping is the person's, carries at least one item, and its items outlive it", async () => {
  // A ping is only ever taken for something waiting.
  expect(
    (
      await refusal(
        client.takePing({
          id: randomUUID(),
          ownerUserId: owner,
          gapMinutes: 60,
          suggestionIds: [],
          text: "Nothing",
          pushBody: "Nothing",
        }),
      )
    ).status,
  ).toBe(400);
  const carried: CheckInSuggestionRecord = await client.create(
    "check-in-suggestions",
    item(),
  );
  const ping = await client.takePing({
    id: randomUUID(),
    ownerUserId: owner,
    gapMinutes: 60,
    suggestionIds: [carried.id],
    text: "One thing needs you",
    pushBody: "Inbox Bot: Reply to Dana",
  });
  expect(ping.itemCount).toBe(1);
  expect(await client.get("check-in-suggestions", carried.id)).toMatchObject({
    pingId: ping.id,
    deliveredAt: expect.any(Date),
    status: "open",
  });
  await client.purge("check-in-pings", ping.id);
  expect(await client.get("check-in-suggestions", carried.id)).toMatchObject({
    pingId: null,
    status: "open",
  });

  // One hourly slot per person, gone with them.
  const person = next();
  await client.create("check-in-people", { id: person, lastPingedAt: null });
  expect(
    await refusal(
      client.create("check-in-people", { id: person, lastPingedAt: null }),
    ),
  ).toBeInstanceOf(ScheduleAlreadyExistsError);
  await client.purgeOwner(person);
  expect(await client.get("check-in-people", person)).toBeNull();
});

test("starting an item opens one task, in a conversation of its own", async () => {
  const started = await client.create(
    "check-in-suggestions",
    item({ status: "started", resolvedAt: new Date() }),
  );
  const [first, second] = [next(), next()];
  await database.insert(channels).values(
    [first, second].map((id) => ({
      id,
      name: "Reply to Dana",
      description: "",
    })),
  );
  const task = (channelId: string, suggestionId: string | null) => ({
    id: next(),
    ownerUserId: owner,
    agentId: bot,
    channelId,
    suggestionId,
    title: started.title,
    why: started.detail,
    origin: "check_in" as const,
  });
  await database.insert(botTasks).values(task(first, started.id));
  // A second Start of the same item finds the first task.
  await rejects(
    database.insert(botTasks).values(task(second, started.id)),
    /bot_tasks_suggestion_idx/,
  );
  await rejects(
    database.insert(botTasks).values(task(first, null)),
    /bot_tasks_channel_idx/,
  );
  await rejects(
    database
      .insert(botTasks)
      .values({ ...task(second, null), origin: "asked" as never }),
    /bot_tasks_origin_check/,
  );
  // The item going away for good, in Intelligence, leaves its task.
  await client.purge("check-in-suggestions", started.id);
  const [row] = await database
    .select({ title: botTasks.title })
    .from(botTasks)
    .where(eq(botTasks.channelId, first));
  expect(row).toEqual({ title: started.title });
  await database.delete(channels).where(inArray(channels.id, [first, second]));
});
