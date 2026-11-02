import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, channels, users } from "../src/db/schema/core";
import {
  proactivePeople,
  proactivePings,
  proactiveRuns,
  proactiveSettings,
  proactiveSuggestions,
} from "../src/db/schema/proactive";
import { botTasks } from "../src/db/schema/tasks";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * The database half of check-ins: the backstops that hold when two replicas race, which no code
 * path can promise on its own. Each test drives the real tables through real SQL.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `proactive-schema-${randomUUID()}`;
const owner = `${prefix}-owner`;
const bot = `${prefix}-bot`;
let counter = 0;
const next = () => `${prefix}-${counter++}`;

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

async function setting() {
  const id = next();
  await database.insert(proactiveSettings).values({
    id,
    ownerUserId: owner,
    agentId: bot,
    channelId: next(),
    threadId: next(),
  });
  return id;
}

let settingId = "";
beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await database.insert(agents).values({
    id: bot,
    name: "Inbox Bot",
    type: "built_in",
    configuration: {},
  });
  settingId = await setting();
});

afterAll(async () => {
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

function item(
  overrides: Partial<typeof proactiveSuggestions.$inferInsert> = {},
) {
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
    ...overrides,
  };
}

test("a new setting checks in hourly unless the person chooses otherwise", async () => {
  const [row] = await database
    .select({ interval: proactiveSettings.intervalMinutes })
    .from(proactiveSettings)
    .where(eq(proactiveSettings.id, settingId));
  expect(row?.interval).toBe(60);
});

test("two open items with one normalized title cannot both stand for a person and Bot", async () => {
  // The race two check-ins can lose: both pass the repeat check, and only one insert may land.
  const dedupeKey = `reply to dana about friday ${next()}`;
  const first = item({ dedupeKey });
  await database.insert(proactiveSuggestions).values(first);
  await rejects(
    database.insert(proactiveSuggestions).values(item({ dedupeKey })),
    /proactive_suggestions_open_dedupe_idx/,
  );
  // Once the person hid the first, the index no longer holds it; the 30-day rule is the engine's.
  await database
    .update(proactiveSuggestions)
    .set({ status: "dismissed", resolvedAt: new Date() })
    .where(eq(proactiveSuggestions.id, first.id));
  await database.insert(proactiveSuggestions).values(item({ dedupeKey }));
  // Items from before the key existed are never refused by it.
  await database.insert(proactiveSuggestions).values([item(), item()]);
});

test("one check-in runs at a time per setting, and only a skipped one carries a reason", async () => {
  const own = settingId;
  const run = (overrides: Partial<typeof proactiveRuns.$inferInsert> = {}) => ({
    id: next(),
    settingId: own,
    ownerUserId: owner,
    agentId: bot,
    trigger: "schedule" as const,
    ...overrides,
  });
  const running = run({ threadId: next() });
  await database.insert(proactiveRuns).values(running);
  // A second replica, or Run now, finds the first still running.
  await rejects(
    database.insert(proactiveRuns).values(run({ trigger: "run_now" })),
    /proactive_runs_one_running_idx/,
  );
  await database
    .update(proactiveRuns)
    .set({ outcome: "quiet", finishedAt: new Date() })
    .where(eq(proactiveRuns.id, running.id));
  await database.insert(proactiveRuns).values(run());

  const finished = new Date();
  await database
    .insert(proactiveRuns)
    .values(
      run({ outcome: "skipped", skipReason: "capped", finishedAt: finished }),
    );
  await rejects(
    database
      .insert(proactiveRuns)
      .values(run({ outcome: "skipped", finishedAt: finished })),
    /proactive_runs_skip_reason_check/,
  );
  await rejects(
    database
      .insert(proactiveRuns)
      .values(
        run({ outcome: "failed", skipReason: "busy", finishedAt: finished }),
      ),
    /proactive_runs_skip_reason_check/,
  );
  // A finished outcome has a finish time; a running one does not.
  await rejects(
    database.insert(proactiveRuns).values(run({ outcome: "raised" })),
    /proactive_runs_finished_check/,
  );
});

test("a ping is the person's, and its items outlive it", async () => {
  const ping = {
    id: next(),
    ownerUserId: owner,
    text: "1 thing needs you",
    pushBody: "One thing needs you",
  };
  await rejects(
    database.insert(proactivePings).values({ ...ping, itemCount: 0 }),
    /proactive_pings_item_count_check/,
  );
  await database.insert(proactivePings).values({ ...ping, itemCount: 1 });
  const carried = item({ pingId: ping.id, deliveredAt: new Date() });
  await database.insert(proactiveSuggestions).values(carried);
  await database.delete(proactivePings).where(eq(proactivePings.id, ping.id));
  const [row] = await database
    .select({
      pingId: proactiveSuggestions.pingId,
      status: proactiveSuggestions.status,
    })
    .from(proactiveSuggestions)
    .where(eq(proactiveSuggestions.id, carried.id));
  expect(row).toEqual({ pingId: null, status: "open" });

  // One hourly slot per person, gone with them.
  const person = next();
  await database
    .insert(users)
    .values({ id: person, email: `${person}@example.test` });
  await database.insert(proactivePeople).values({ ownerUserId: person });
  await rejects(
    database.insert(proactivePeople).values({ ownerUserId: person }),
    /proactive_people_pkey/,
  );
  await database.delete(users).where(eq(users.id, person));
  expect(
    await database
      .select()
      .from(proactivePeople)
      .where(eq(proactivePeople.ownerUserId, person)),
  ).toEqual([]);
});

test("starting an item opens one task, in a conversation of its own", async () => {
  const started = item({ status: "started", resolvedAt: new Date() });
  await database.insert(proactiveSuggestions).values(started);
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
  // The item going away leaves its task, unlinked.
  await database
    .delete(proactiveSuggestions)
    .where(eq(proactiveSuggestions.id, started.id));
  const [row] = await database
    .select({ suggestionId: botTasks.suggestionId })
    .from(botTasks)
    .where(eq(botTasks.channelId, first));
  expect(row).toEqual({ suggestionId: null });
  await database.delete(channels).where(inArray(channels.id, [first, second]));
});
