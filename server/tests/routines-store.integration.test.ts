import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  routineRuns,
  routines,
  users,
} from "../src/db/schema";
import {
  MAX_ENABLED_ROUTINES,
  MAX_INSTRUCTION_CODE_POINTS,
  MAX_RUN_ERROR,
  RoutineNotFoundError,
  RoutineRefusedError,
  createRoutineStore,
} from "../src/routines/store";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const store = createRoutineStore(database);

const testPrefix = `routines-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

/** Every day at 09:00 UTC: comfortably above the floor and stable to describe. */
const DAILY = "0 9 * * *";

afterEach(async () => {
  // Routines cascade from both the owner and the agent, but they are cleared first so a failure
  // part-way through cleanup leaves nothing pointing at rows this file is about to delete.
  for (const userId of createdUserIds) {
    await database.delete(routines).where(eq(routines.ownerUserId, userId));
  }
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Routine Store Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name = "Expense Manager") {
  const profile = await profileStore.create(owner, {
    name,
    title: "Finance Operations",
    roleDescription: "Review receipts.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await channelStore.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

/** A person, a Bot and the one channel they share: the ordinary starting point. */
async function setUp() {
  const owner = await createUser();
  const agentId = await createAgent(owner);
  const channel = await createChannel(owner, [agentId]);
  return { owner, agentId, channel };
}

/**
 * A routine is one person's standing instruction, so every method takes the owner and every
 * statement is guarded by it. A routine belonging to somebody else has to be indistinguishable from
 * one that was never created — the `setPinned` rule — because anything else tells a stranger which
 * ids exist.
 */
describe("owner-guarding", () => {
  test("another person cannot update, remove or switch off a routine", async () => {
    const { owner, agentId, channel } = await setUp();
    const stranger = await createUser();
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise yesterday's receipts.",
      cron: DAILY,
    });

    await expect(
      store.update(stranger.id, routine.id, { instruction: "Do my bidding." }),
    ).rejects.toBeInstanceOf(RoutineNotFoundError);
    await expect(store.remove(stranger.id, routine.id)).rejects.toBeInstanceOf(
      RoutineNotFoundError,
    );
    await expect(
      store.setEnabled(stranger.id, routine.id, false),
    ).rejects.toBeInstanceOf(RoutineNotFoundError);

    const [mine] = await store.listFor(owner.id);
    expect(mine?.instruction).toBe("Summarise yesterday's receipts.");
    expect(mine?.enabled).toBe(true);
  });

  test("a stranger's list does not contain the routine", async () => {
    const { owner, agentId, channel } = await setUp();
    const stranger = await createUser();
    await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise yesterday's receipts.",
      cron: DAILY,
    });

    expect(await store.listFor(stranger.id)).toEqual([]);
  });
});

describe("what the schedule has to be", () => {
  test("refuses a cron under the floor, in the schedule's own words", async () => {
    const { owner, agentId, channel } = await setUp();

    // Every minute. The sentence is the schedule module's; the store only passes it along, because
    // a model recovers from prose and this is the prose that says what to try instead.
    await expect(
      store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Check my inbox.",
        cron: "* * * * *",
      }),
    ).rejects.toThrow(/15 minutes/);
    await expect(
      store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "Check my inbox.",
        cron: "* * * * *",
      }),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
  });

  test("refuses an instruction over the cap and accepts one at it", async () => {
    const { owner, agentId, channel } = await setUp();

    const atTheCap = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "x".repeat(MAX_INSTRUCTION_CODE_POINTS),
      cron: DAILY,
    });
    expect(Array.from(atTheCap.instruction)).toHaveLength(
      MAX_INSTRUCTION_CODE_POINTS,
    );

    await expect(
      store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "x".repeat(MAX_INSTRUCTION_CODE_POINTS + 1),
        cron: DAILY,
      }),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
  });

  test("refuses a blank instruction with the sentence a model is meant to read", async () => {
    const { owner, agentId, channel } = await setUp();

    const failure = await store
      .create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "   ",
        cron: DAILY,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(RoutineRefusedError);
    expect((failure as Error).message).toBe(
      "A routine needs an instruction to carry out.",
    );
  });
});

/**
 * The cap is a constant with a reason: every enabled routine is a headless turn somebody's Bot will
 * take without being watched, and a model that can be talked into creating them one at a time can be
 * talked into creating a hundred. It counts what is switched ON, so switching one off makes room.
 */
describe("how many a person may have switched on", () => {
  test("refuses the one past the cap, and accepts it once another is off", async () => {
    const { owner, agentId, channel } = await setUp();
    const created: string[] = [];
    for (let index = 0; index < MAX_ENABLED_ROUTINES; index += 1) {
      const routine = await store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: `Routine ${index}`,
        cron: DAILY,
      });
      created.push(routine.id);
    }

    await expect(
      store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: channel.id,
        instruction: "One too many.",
        cron: DAILY,
      }),
    ).rejects.toBeInstanceOf(RoutineRefusedError);

    await store.setEnabled(owner.id, created[0] as string, false);

    const room = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Now there is room.",
      cron: DAILY,
    });
    expect(room.enabled).toBe(true);

    // And switching the disabled one back on is refused for the same reason.
    await expect(
      store.setEnabled(owner.id, created[0] as string, true),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
  });
});

/**
 * The conversation's channel is not reachable at the tool layer, so the store resolves it. All four
 * branches matter: the wrong channel is a place a Bot could post something private, and the two
 * ambiguous branches are refusals a model has to be able to recover from in language.
 */
describe("resolving the channel to post into", () => {
  test("accepts a channel the owner and the agent share", async () => {
    const { owner, agentId, channel } = await setUp();

    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Post the summary here.",
      cron: DAILY,
    });

    expect(routine.channelId).toBe(channel.id);
  });

  test("refuses a channel the owner is not in", async () => {
    const { owner, agentId } = await setUp();
    const stranger = await createUser();
    const strangerAgentId = await createAgent(stranger, "Their Bot");
    const theirChannel = await createChannel(stranger, [strangerAgentId]);

    await expect(
      store.create({
        ownerUserId: owner.id,
        agentId,
        channelId: theirChannel.id,
        instruction: "Post into somebody else's channel.",
        cron: DAILY,
      }),
    ).rejects.toThrow(/both in/);
  });

  test("refuses a channel this agent is not in", async () => {
    const { owner, channel } = await setUp();
    const otherAgentId = await createAgent(owner, "Unrelated Bot");

    await expect(
      store.create({
        ownerUserId: owner.id,
        agentId: otherAgentId,
        channelId: channel.id,
        instruction: "Post where I do not live.",
        cron: DAILY,
      }),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
  });

  test("uses the only shared channel when none was named", async () => {
    const { owner, agentId, channel } = await setUp();

    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      instruction: "Wherever we talk.",
      cron: DAILY,
    });

    expect(routine.channelId).toBe(channel.id);
  });

  test("refuses with no channel at all, and says to start one", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);

    await expect(
      store.create({
        ownerUserId: owner.id,
        agentId,
        instruction: "Nowhere to put this.",
        cron: DAILY,
      }),
    ).rejects.toThrow(/Start one/);
  });

  test("refuses ambiguity by naming the channels, so a model can ask", async () => {
    const { owner, agentId, channel } = await setUp();
    const secondAgentId = await createAgent(owner, "Second Bot");
    const other = await createChannel(owner, [agentId, secondAgentId]);

    const failure = await store
      .create({
        ownerUserId: owner.id,
        agentId,
        instruction: "Which one?",
        cron: DAILY,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(RoutineRefusedError);
    const message = (failure as Error).message;
    expect(message).toContain(channel.name);
    expect(message).toContain(other.name);
    expect(message).toContain("Say which one.");
  });

  test("names at most five channels before it gives up and says 'and others'", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const sharedChannels = [];
    for (let index = 0; index < 6; index += 1) {
      sharedChannels.push(await createChannel(owner, [agentId]));
    }

    const failure = await store
      .create({
        ownerUserId: owner.id,
        agentId,
        instruction: "Which one?",
        cron: DAILY,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(RoutineRefusedError);
    const message = (failure as Error).message;
    expect(message).toContain(", and others");
    // All six channels share one agent, so they share one name; the cap names five of them, not
    // six, so that one name appears exactly five times rather than six.
    const name = sharedChannels[0]?.name as string;
    const occurrences = message.split(name).length - 1;
    expect(occurrences).toBe(5);
  });
});

describe("reading a person's routines", () => {
  test("says the schedule in words and never in cron", async () => {
    const { owner, agentId, channel } = await setUp();
    await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise the day.",
      cron: DAILY,
      timezone: "Europe/Madrid",
    });

    const [summary] = await store.listFor(owner.id);

    expect(summary?.schedule).toBe("Every day at 09:00");
    expect(summary?.schedule).not.toContain("*");
    expect(summary?.timezone).toBe("Europe/Madrid");
    expect(summary?.channelName).toBe(channel.name);
    expect(summary?.channelDeleted).toBe(false);
    expect(summary?.nextRunAt).toBeInstanceOf(Date);
    // A routine that has never fired has no run row, so the join has nothing to report.
    expect(summary?.lastRun).toBeNull();
  });

  test("says a step schedule in words too, never in cron", async () => {
    const { owner, agentId, channel } = await setUp();
    await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Check in often.",
      cron: "*/20 * * * *",
    });

    const [summary] = await store.listFor(owner.id);

    expect(summary?.schedule).not.toContain("*");
  });

  test("puts the newest first", async () => {
    const { owner, agentId, channel } = await setUp();
    const first = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "First.",
      cron: DAILY,
    });
    const second = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Second.",
      cron: DAILY,
    });

    expect((await store.listFor(owner.id)).map((row) => row.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  test("keeps a routine whose channel was deleted and reports it as gone", async () => {
    // The whole reason `routines.channel_id` is not a foreign key: a cascade here would delete the
    // person's standing instruction silently, and they would find out by it never running again.
    const { owner, agentId, channel } = await setUp();
    await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Post into a channel that is about to go.",
      cron: DAILY,
    });

    await channelStore.softDelete(owner, channel.id);

    const [summary] = await store.listFor(owner.id);
    expect(summary?.channelId).toBe(channel.id);
    expect(summary?.channelDeleted).toBe(true);
  });
});

describe("changing a routine", () => {
  test("recomputes the next run when the cron changes", async () => {
    const { owner, agentId, channel } = await setUp();
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise the day.",
      cron: DAILY,
    });

    const updated = await store.update(owner.id, routine.id, {
      cron: "30 21 * * *",
    });

    expect(updated.cron).toBe("30 21 * * *");
    expect(updated.nextRunAt.getTime()).not.toBe(routine.nextRunAt.getTime());
  });

  test("recomputes the next run when only the timezone changes, and refuses an unknown zone", async () => {
    const { owner, agentId, channel } = await setUp();
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise the day.",
      cron: DAILY,
    });

    const updated = await store.update(owner.id, routine.id, {
      timezone: "Asia/Tokyo",
    });

    expect(updated.timezone).toBe("Asia/Tokyo");
    expect(updated.nextRunAt.getTime()).not.toBe(routine.nextRunAt.getTime());

    await expect(
      store.update(owner.id, routine.id, { timezone: "Mars/Olympus" }),
    ).rejects.toBeInstanceOf(RoutineRefusedError);

    // The refusal must not have partially applied: the row still carries the timezone from the
    // update that succeeded, not the rejected "Mars/Olympus".
    const [summary] = await store.listFor(owner.id);
    expect(summary?.timezone).toBe("Asia/Tokyo");
  });

  test("leaves the next run alone when only the instruction changes", async () => {
    const { owner, agentId, channel } = await setUp();
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise the day.",
      cron: DAILY,
    });

    const updated = await store.update(owner.id, routine.id, {
      instruction: "Summarise the week.",
    });

    expect(updated.instruction).toBe("Summarise the week.");
    expect(updated.nextRunAt.getTime()).toBe(routine.nextRunAt.getTime());
  });

  test("re-validates only what was supplied", async () => {
    const { owner, agentId, channel } = await setUp();
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise the day.",
      cron: DAILY,
    });

    await expect(
      store.update(owner.id, routine.id, { cron: "* * * * *" }),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
    await expect(
      store.update(owner.id, routine.id, {
        instruction: "x".repeat(MAX_INSTRUCTION_CODE_POINTS + 1),
      }),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
    // Refused writes changed nothing.
    const [summary] = await store.listFor(owner.id);
    expect(summary?.instruction).toBe("Summarise the day.");
    expect(summary?.schedule).toBe("Every day at 09:00");
  });

  test("re-resolves the channel when a new one is named", async () => {
    const { owner, agentId, channel } = await setUp();
    const secondAgentId = await createAgent(owner, "Second Bot");
    const other = await createChannel(owner, [agentId, secondAgentId]);
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise the day.",
      cron: DAILY,
    });

    const moved = await store.update(owner.id, routine.id, {
      channelId: other.id,
    });
    expect(moved.channelId).toBe(other.id);

    const stranger = await createUser();
    const strangerAgentId = await createAgent(stranger, "Their Bot");
    const theirChannel = await createChannel(stranger, [strangerAgentId]);
    await expect(
      store.update(owner.id, routine.id, { channelId: theirChannel.id }),
    ).rejects.toBeInstanceOf(RoutineRefusedError);
  });

  test("switching off and on again recomputes the next run", async () => {
    const { owner, agentId, channel } = await setUp();
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise the day.",
      cron: DAILY,
    });
    // A routine switched off for a month has a next run a month in the past. Enabling it must not
    // hand the sweep a firing that was due in June. Forcing the stamp into the past makes that
    // stale state real rather than assumed: without this, `nextRunAt > now` would already have
    // been true before the disable, and deleting the recompute branch would leave this green.
    await store.setEnabled(owner.id, routine.id, false);
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await database
      .update(routines)
      .set({ nextRunAt: stale })
      .where(eq(routines.id, routine.id));

    const enabled = await store.update(owner.id, routine.id, { enabled: true });

    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt.getTime()).toBeGreaterThan(Date.now());

    // The mirror image: an instruction-only change on an already-enabled routine must not recompute,
    // even when the stored stamp is one that recomputing would obviously move.
    await database
      .update(routines)
      .set({ nextRunAt: stale })
      .where(eq(routines.id, routine.id));

    const untouched = await store.update(owner.id, routine.id, {
      instruction: "Summarise the week instead.",
    });

    expect(untouched.nextRunAt.getTime()).toBe(stale.getTime());
  });

  test("removing one is a hard delete, and only once", async () => {
    const { owner, agentId, channel } = await setUp();
    const routine = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Summarise the day.",
      cron: DAILY,
    });

    await store.remove(owner.id, routine.id);

    expect(await store.listFor(owner.id)).toEqual([]);
    await expect(store.remove(owner.id, routine.id)).rejects.toBeInstanceOf(
      RoutineNotFoundError,
    );
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * The sweep's half. Nothing below is asked a question by a person, and everything below is about
 * two things happening at once: several replicas reading the same due row in the same second.
 *
 * NO CLAIM OR LEASE SEMANTICS ARE TESTED HERE. Firing mechanics live in the shared `work_items`
 * queue, and `server/tests/work-queue.integration.test.ts` owns `for update skip locked`, leases
 * on the database's clock, and the attempt count. What this file tests is the routines table's own
 * compare-and-set on `next_run_at`, which is a different guarantee: the clock moves once.
 */

/**
 * The create path always computes a future stamp, so a due-in-the-past row has to be written
 * directly — the same direct write the staleness test above uses. The stamps are deliberately
 * ancient: `dueRoutines` is not owner-scoped, so a test that asserts on ordering has to be sure
 * its own rows sort ahead of anything else in the database.
 */
async function makeDueAt(routineId: string, nextRunAt: Date): Promise<Date> {
  await database
    .update(routines)
    .set({ nextRunAt })
    .where(eq(routines.id, routineId));
  const [row] = await database
    .select({ nextRunAt: routines.nextRunAt })
    .from(routines)
    .where(eq(routines.id, routineId))
    .limit(1);
  // Read back rather than trusting the Date we wrote: the comparison the CAS makes is Postgres's.
  return row?.nextRunAt as Date;
}

async function readRoutine(routineId: string) {
  const [row] = await database
    .select()
    .from(routines)
    .where(eq(routines.id, routineId))
    .limit(1);
  return row;
}

async function makeRoutine(instruction = "Summarise the day.") {
  const { owner, agentId, channel } = await setUp();
  const routine = await store.create({
    ownerUserId: owner.id,
    agentId,
    channelId: channel.id,
    instruction,
    cron: DAILY,
  });
  return { owner, agentId, channel, routine };
}

describe("moving a routine's clock", () => {
  test("two sweeps racing on the same stamp advance it exactly once", async () => {
    const { routine } = await makeRoutine();
    const from = await makeDueAt(routine.id, new Date("2001-03-04T09:00:00Z"));

    const outcomes = await Promise.all([
      store.advanceNextRun(routine.id, from),
      store.advanceNextRun(routine.id, from),
    ]);

    expect(outcomes.filter((won) => won)).toHaveLength(1);
    expect(outcomes.filter((won) => !won)).toHaveLength(1);

    // The loser's re-read sees the advanced value: whichever call lost, the clock has moved on and
    // nothing is left holding the stamp it was asked to move from.
    const after = await readRoutine(routine.id);
    expect(after?.nextRunAt.getTime()).toBeGreaterThan(from.getTime());
  });

  test("a stale `from` returns false and moves nothing", async () => {
    const { routine } = await makeRoutine();
    const from = await makeDueAt(routine.id, new Date("2001-03-04T09:00:00Z"));

    const moved = await store.advanceNextRun(
      routine.id,
      new Date("2001-03-03T09:00:00Z"),
    );

    expect(moved).toBe(false);
    const after = await readRoutine(routine.id);
    expect(after?.nextRunAt.getTime()).toBe(from.getTime());
    expect(after?.lastRunAt).toBeNull();
  });

  test("advancing stamps last_run_at with the `from` it was given", async () => {
    const { routine } = await makeRoutine();
    const from = await makeDueAt(routine.id, new Date("2001-03-04T09:00:00Z"));

    expect(await store.advanceNextRun(routine.id, from)).toBe(true);

    const after = await readRoutine(routine.id);
    // The moment the routine was due, not the moment the sweep happened to look at it.
    expect(after?.lastRunAt?.getTime()).toBe(from.getTime());
    expect(after?.nextRunAt.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe("reading which routines are due", () => {
  test("returns the due ones oldest first and respects the limit", async () => {
    const { owner, agentId, channel } = await setUp();
    const oldest = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Oldest.",
      cron: DAILY,
    });
    const middle = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Middle.",
      cron: DAILY,
    });
    const newest = await store.create({
      ownerUserId: owner.id,
      agentId,
      channelId: channel.id,
      instruction: "Newest.",
      cron: DAILY,
    });
    await makeDueAt(oldest.id, new Date("2001-01-01T09:00:00Z"));
    await makeDueAt(middle.id, new Date("2001-01-02T09:00:00Z"));
    await makeDueAt(newest.id, new Date("2001-01-03T09:00:00Z"));

    const all = await store.dueRoutines(10);
    expect(all.map((row) => row.id).slice(0, 3)).toEqual([
      oldest.id,
      middle.id,
      newest.id,
    ]);
    expect(all[0]?.nextRunAt).toBeInstanceOf(Date);

    const limited = await store.dueRoutines(2);
    expect(limited.map((row) => row.id)).toEqual([oldest.id, middle.id]);
  });

  test("excludes a routine that is switched off", async () => {
    const { owner, routine } = await makeRoutine();
    await store.setEnabled(owner.id, routine.id, false);
    await makeDueAt(routine.id, new Date("2001-01-01T09:00:00Z"));

    const due = await store.dueRoutines(50);
    expect(due.map((row) => row.id)).not.toContain(routine.id);
  });

  test("excludes a routine whose next run is still ahead", async () => {
    const { routine } = await makeRoutine();
    // The create path already put this in the future; the point is that nothing rounds it down.
    const due = await store.dueRoutines(50);
    expect(due.map((row) => row.id)).not.toContain(routine.id);

    await makeDueAt(routine.id, new Date(Date.now() + 60 * 60 * 1000));
    const stillAhead = await store.dueRoutines(50);
    expect(stillAhead.map((row) => row.id)).not.toContain(routine.id);
  });
});

describe("opening and closing a run", () => {
  test("a finished run stamps finished_at and leaves the error null", async () => {
    const { routine } = await makeRoutine();

    const { runId } = await store.insertRun(routine.id);
    const [inFlight] = await database
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, runId));
    // Null status is the in-flight state, which is why the column is nullable.
    expect(inFlight?.status).toBeNull();
    expect(inFlight?.finishedAt).toBeNull();
    expect(inFlight?.startedAt).toBeInstanceOf(Date);

    await store.finishRun(runId, "succeeded");

    const [finished] = await database
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, runId));
    expect(finished?.status).toBe("succeeded");
    expect(finished?.finishedAt).toBeInstanceOf(Date);
    expect(finished?.error).toBeNull();
  });

  test("caps a long error rather than storing whatever a failure produced", async () => {
    const { routine } = await makeRoutine();
    const { runId } = await store.insertRun(routine.id);

    await store.finishRun(runId, "failed", "x".repeat(600));

    const [finished] = await database
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, runId));
    expect(finished?.status).toBe("failed");
    expect(finished?.error).toHaveLength(MAX_RUN_ERROR);
    expect(MAX_RUN_ERROR).toBe(400);
  });

  test("the page's last run reads the newest of several", async () => {
    const { owner, routine } = await makeRoutine();
    const first = await store.insertRun(routine.id);
    await store.finishRun(first.runId, "failed", "the first one");
    const second = await store.insertRun(routine.id);
    await store.finishRun(second.runId, "succeeded");

    const [summary] = await store.listFor(owner.id);
    expect(summary?.lastRun?.status).toBe("succeeded");
    expect(summary?.lastRun?.finishedAt).toBeInstanceOf(Date);
  });
});

/**
 * The fatigue rule counts the failures at the tail, and this file pins what a `skipped` run does to
 * that tail: A SKIP IS NOT A FAILURE AND DOES NOT BREAK THE STREAK. A skip means the channel was
 * gone, not that the turn failed, so it is not counted; and it does not reset the count either,
 * because a routine whose channel flaps must not be able to escape the fatigue rule by skipping
 * between its failures.
 */
describe("counting the failures at the tail", () => {
  async function finish(
    routineId: string,
    status: "succeeded" | "failed" | "skipped",
  ) {
    const { runId } = await store.insertRun(routineId);
    await store.finishRun(
      runId,
      status,
      status === "failed" ? "it threw" : undefined,
    );
  }

  test("counts up, resets on a success, and is not broken by a skip", async () => {
    const { routine } = await makeRoutine();

    expect(await store.consecutiveFailures(routine.id)).toBe(0);

    await finish(routine.id, "succeeded");
    expect(await store.consecutiveFailures(routine.id)).toBe(0);

    await finish(routine.id, "failed");
    expect(await store.consecutiveFailures(routine.id)).toBe(1);

    await finish(routine.id, "failed");
    await finish(routine.id, "failed");
    expect(await store.consecutiveFailures(routine.id)).toBe(3);

    await finish(routine.id, "succeeded");
    expect(await store.consecutiveFailures(routine.id)).toBe(0);
  });

  test("a skip between failures neither counts nor resets", async () => {
    const { routine } = await makeRoutine();

    await finish(routine.id, "failed");
    await finish(routine.id, "skipped");
    await finish(routine.id, "failed");

    expect(await store.consecutiveFailures(routine.id)).toBe(2);
  });

  test("an in-flight run is not an outcome", async () => {
    const { routine } = await makeRoutine();
    await finish(routine.id, "failed");
    await store.insertRun(routine.id);

    expect(await store.consecutiveFailures(routine.id)).toBe(1);
  });
});
