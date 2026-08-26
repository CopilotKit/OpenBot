import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
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
  routines,
  users,
  workItems,
} from "../src/db/schema";
import { createRoutineStore } from "../src/routines/store";
import { ROUTINE_FIRE_KIND, offerDueRoutines } from "../src/routines/sweep";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL } from "./support/database";

/**
 * The sweep's first half against a real PostgreSQL and the real `work_items` queue.
 *
 * A fake queue cannot answer the only question worth asking here. The whole reason a routine fires
 * once when three replicas wake at 09:00 is a primary key on `(kind, key)` and
 * `on conflict do nothing`, which is a promise the database makes; a stub that remembered what it
 * had been offered would pass every test below while production produced three runs.
 *
 * THIS FILE OWNS `ROUTINE_FIRE_KIND`. Unlike `work-queue.integration.test.ts`, which invents a
 * per-file kind, the kind under test here is a shared constant, so the rows cannot be namespaced
 * away — the cleanup below deletes every row of that kind. A second test file that offers this kind
 * would race this one and both would flake. Put such tests here.
 *
 * NO CLAIM, LEASE OR OWNERSHIP INTERNALS ARE TESTED HERE. `for update skip locked`, leases named on
 * the database's clock and the attempt count belong to `work-queue.integration.test.ts`. What this
 * file tests is which firings the sweep decides are worth offering, and that the key it offers them
 * under makes a repeat harmless.
 */
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
const queue = createWorkQueue(database);

const testPrefix = `routine-sweep-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

/** Every day at 09:00 UTC: comfortably above the floor, and one occurrence is one day. */
const DAILY = "0 9 * * *";

/**
 * The dispatch half of the options, recorded rather than dialled.
 *
 * Nothing in this commit calls it — `offerDueRoutines` only puts work on the queue — but the option
 * is wired so the file is ready for the half that claims those items, and so a dispatch that
 * started happening in this phase would show up as a recorded call rather than as nothing.
 */
const dispatched: string[] = [];
const dispatch = async (routineRunId: string) => {
  dispatched.push(routineRunId);
};

function sweepOptions(overrides: Record<string, unknown> = {}) {
  return {
    routineStore: store,
    queue,
    dispatch,
    owner: "sweep-test",
    ...overrides,
  } as Parameters<typeof offerDueRoutines>[0];
}

beforeEach(async () => {
  dispatched.length = 0;
  await database.delete(workItems).where(eq(workItems.kind, ROUTINE_FIRE_KIND));
});

afterEach(async () => {
  // Routines first, so a failure part-way through cleanup leaves nothing pointing at rows this file
  // is about to delete.
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
  await database.delete(workItems).where(eq(workItems.kind, ROUTINE_FIRE_KIND));
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Routine Sweep Test User",
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

/** A person, a Bot, the one channel they share, and a routine on it. */
async function makeRoutine(instruction = "Summarise the day.") {
  const owner = await createUser();
  const agentId = await createAgent(owner);
  const channel = await createChannel(owner, [agentId]);
  const routine = await store.create({
    ownerUserId: owner.id,
    agentId,
    channelId: channel.id,
    instruction,
    cron: DAILY,
  });
  return { owner, agentId, channel, routine };
}

/**
 * The create path always computes a future stamp, so a due-in-the-past row is written directly.
 *
 * THE STAMPS IN THIS FILE ARE DELIBERATELY ANCIENT, and the `now` option is moved to match them.
 * `dueRoutines` is not owner-scoped and orders oldest-due first, so a test that asserts on ordering
 * or on a limit has to be sure its own rows sort ahead of anything else in the database; and the
 * grace policy is measured against `now`, so the injected clock is what makes "two minutes late" and
 * "a month late" mean anything in a row stamped in 2001.
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
  // Read back rather than trusting the Date we wrote: the stamp the sweep keys on is Postgres's.
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

/** Every queued firing of one routine, whatever minute it was keyed on. */
async function firingsFor(routineId: string) {
  return await database
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, ROUTINE_FIRE_KIND),
        like(workItems.key, `${routineId}:%`),
      ),
    );
}

describe("offering the firings that are due", () => {
  /**
   * THE TEST THIS FILE EXISTS FOR. Three replicas wake on the same minute and read the same due
   * row; the person gets one run. Nothing in the sweep coordinates that — the offer key carries the
   * minute, so the second and third offers collide on the primary key, and the compare-and-set on
   * `next_run_at` means only one of them moves the clock.
   */
  test("two sweeps racing on one due routine offer it exactly once", async () => {
    const { routine } = await makeRoutine();
    const from = await makeDueAt(routine.id, new Date("2001-01-01T09:25:00Z"));
    const now = () => new Date("2001-01-01T09:26:00Z");

    const outcomes = await Promise.all([
      offerDueRoutines(sweepOptions({ now })),
      offerDueRoutines(sweepOptions({ now })),
    ]);

    // Both sweeps saw it as due and both offered it, which is the honest report: each did put the
    // work on the queue. What must be single is the row, and the clock.
    for (const outcome of outcomes) {
      expect(outcome.offered).toContain(routine.id);
    }
    expect(await firingsFor(routine.id)).toHaveLength(1);

    const after = await readRoutine(routine.id);
    expect(after?.nextRunAt.getTime()).toBeGreaterThan(from.getTime());
    // One occurrence on from the stamp it was given, not two: a second advance would have moved it
    // to the 3rd of January.
    expect(after?.nextRunAt.toISOString()).toBe("2001-01-02T09:00:00.000Z");
  });

  /**
   * The key format is a compatibility surface, not an implementation detail: it is the identity of a
   * firing, already written into rows in `work_items`. Asserted literally so a later change to the
   * truncation is a failing test here rather than a routine that fires twice in production.
   */
  test("the offer key is the routine and the minute it was due", async () => {
    const { routine } = await makeRoutine();
    await makeDueAt(routine.id, new Date("2001-01-01T09:25:00Z"));

    await offerDueRoutines(
      sweepOptions({ now: () => new Date("2001-01-01T09:26:00Z") }),
    );

    const [firing] = await firingsFor(routine.id);
    expect(firing?.kind).toBe(ROUTINE_FIRE_KIND);
    expect(firing?.key).toBe(`${routine.id}:2001-01-01T09:25Z`);
    expect(firing?.payload).toEqual({
      routineId: routine.id,
      scheduledFor: "2001-01-01T09:25:00.000Z",
    });
  });

  /**
   * The crash between the offer and the advance, which is why the offer comes first.
   *
   * The stamp is put back by hand to stand for the sweep that died before it could move the clock —
   * or the replica that lost the compare-and-set. Either way the next pass reads the same stamp,
   * renders the same key, and adds nothing: the firing is not lost and it is not doubled.
   */
  test("a second pass over the same stamp adds no row, before or after the run", async () => {
    const { routine } = await makeRoutine();
    const from = await makeDueAt(routine.id, new Date("2001-01-01T09:25:00Z"));
    const now = () => new Date("2001-01-01T09:26:00Z");

    await offerDueRoutines(sweepOptions({ now }));
    expect(await firingsFor(routine.id)).toHaveLength(1);

    await makeDueAt(routine.id, from);
    await offerDueRoutines(sweepOptions({ now }));
    expect(await firingsFor(routine.id)).toHaveLength(1);

    /*
     * AND AFTER THE FIRING HAS HAPPENED, which is the half that is easy to lose. `finish` marks the
     * row rather than deleting it, so a finished row still counts as a conflict
     * (`server/src/work/queue.ts:120-133`) — deleting it would hand the key back and make the
     * recovery path a duplicate-run path. The claim here is setup for that state, not a test of
     * claiming.
     */
    const [claimed] = await queue.claim({
      kind: ROUTINE_FIRE_KIND,
      owner: "sweep-test",
      leaseMs: 30_000,
    });
    expect(
      await queue.finish({
        kind: ROUTINE_FIRE_KIND,
        key: claimed?.key as string,
        owner: "sweep-test",
      }),
    ).toBe(true);

    await makeDueAt(routine.id, from);
    await offerDueRoutines(sweepOptions({ now }));

    const firings = await firingsFor(routine.id);
    expect(firings).toHaveLength(1);
    expect(firings[0]?.finishedAt).not.toBeNull();
  });

  test("a routine that is switched off, or not due yet, is not offered", async () => {
    const { owner: offOwner, routine: off } =
      await makeRoutine("Switched off.");
    await store.setEnabled(offOwner.id, off.id, false);
    await makeDueAt(off.id, new Date("2001-01-01T09:25:00Z"));

    const { routine: ahead } = await makeRoutine("Still ahead.");
    // The create path already put this in the future; nothing rounds it down.
    const aheadStamp = (await readRoutine(ahead.id))?.nextRunAt as Date;

    const { offered } = await offerDueRoutines(
      sweepOptions({ now: () => new Date("2001-01-01T09:26:00Z") }),
    );

    expect(offered).not.toContain(off.id);
    expect(offered).not.toContain(ahead.id);
    expect(await firingsFor(off.id)).toHaveLength(0);
    expect(await firingsFor(ahead.id)).toHaveLength(0);
    // And neither clock moved: a routine nobody offered is a routine nobody advanced.
    expect((await readRoutine(off.id))?.nextRunAt.getTime()).toBe(
      new Date("2001-01-01T09:25:00Z").getTime(),
    );
    expect((await readRoutine(ahead.id))?.nextRunAt.getTime()).toBe(
      aheadStamp.getTime(),
    );
  });

  test("the limit bounds one pass, and the rest wait for the next", async () => {
    const first = (await makeRoutine("First.")).routine;
    const second = (await makeRoutine("Second.")).routine;
    const third = (await makeRoutine("Third.")).routine;
    await makeDueAt(first.id, new Date("2001-01-01T09:25:00Z"));
    await makeDueAt(second.id, new Date("2001-01-01T09:26:00Z"));
    await makeDueAt(third.id, new Date("2001-01-01T09:27:00Z"));

    const { offered } = await offerDueRoutines(
      sweepOptions({ limit: 2, now: () => new Date("2001-01-01T09:28:00Z") }),
    );

    // Oldest due first, so a backlog drains in the order it built up.
    expect(offered).toEqual([first.id, second.id]);
    expect(await firingsFor(third.id)).toHaveLength(0);
    expect((await readRoutine(third.id))?.nextRunAt.getTime()).toBe(
      new Date("2001-01-01T09:27:00Z").getTime(),
    );
  });
});

/**
 * A STALE STAMP IS NOT A BACKLOG TO REPLAY.
 *
 * `advanceNextRun` moves the clock one occurrence on from the stamp it was given, so a routine whose
 * stamp is a month behind comes back due pass after pass, once per missed occurrence. Turn the
 * worker on after a quiet month and a person gets thirty summaries of thirty days ago; a 15-minute
 * routine idle a year would be some thirty-five thousand firings. The stamp still has to drain, so
 * the pass advances it — it just says nothing while it does.
 */
describe("draining a stale stamp instead of replaying it", () => {
  test("a month-old firing is advanced without being offered, and a two-minute-old one fires", async () => {
    const { routine: stale } = await makeRoutine("A month behind.");
    const { routine: fresh } = await makeRoutine("Two minutes late.");
    const staleFrom = await makeDueAt(
      stale.id,
      new Date("2001-01-01T09:00:00Z"),
    );
    await makeDueAt(fresh.id, new Date("2001-02-01T08:58:00Z"));

    const { offered } = await offerDueRoutines(
      sweepOptions({ now: () => new Date("2001-02-01T09:00:00Z") }),
    );

    expect(offered).toEqual([fresh.id]);
    expect(await firingsFor(stale.id)).toHaveLength(0);
    expect(await firingsFor(fresh.id)).toHaveLength(1);

    // Advanced all the same, one occurrence on, so successive passes drain it silently rather than
    // reading it as due for ever.
    const after = await readRoutine(stale.id);
    expect(after?.nextRunAt.getTime()).toBeGreaterThan(staleFrom.getTime());
    expect(after?.nextRunAt.toISOString()).toBe("2001-01-02T09:00:00.000Z");
  });

  test("the grace window is a setting, so a caller can say what counts as worth having", async () => {
    const { routine } = await makeRoutine();
    await makeDueAt(routine.id, new Date("2001-01-01T09:00:00Z"));

    // Twenty minutes late. Outside the default window, inside a thirty-minute one.
    const now = () => new Date("2001-01-01T09:20:00Z");
    await offerDueRoutines(sweepOptions({ now }));
    expect(await firingsFor(routine.id)).toHaveLength(0);

    await makeDueAt(routine.id, new Date("2001-01-01T09:00:00Z"));
    const { offered } = await offerDueRoutines(
      sweepOptions({ now, graceMs: 30 * 60_000 }),
    );
    expect(offered).toContain(routine.id);
    expect(await firingsFor(routine.id)).toHaveLength(1);
  });
});

/**
 * One poisoned routine is one person's problem, not everybody's.
 *
 * A cron the parser cannot read makes `advanceNextRun` throw, and an unguarded loop would take the
 * whole pass down with it — for every other person's routine too, on every pass, for as long as the
 * bad row exists. The one routine nobody can schedule must not be able to stop the sweep.
 */
describe("surviving a routine that cannot be scheduled", () => {
  test("a poisoned cron is warned about and the next routine is still offered", async () => {
    const { routine: poisoned } = await makeRoutine("Unschedulable.");
    const { routine: healthy } = await makeRoutine("Perfectly fine.");
    // Only a direct write can make this row: `create` and `update` both refuse a cron the schedule
    // module cannot read, which is exactly why the bad row has to be simulated rather than created.
    await database
      .update(routines)
      .set({ cron: "not a cron" })
      .where(eq(routines.id, poisoned.id));
    // The poisoned one is due FIRST, so a pass that dies on it never reaches the healthy one.
    await makeDueAt(poisoned.id, new Date("2001-01-01T09:25:00Z"));
    await makeDueAt(healthy.id, new Date("2001-01-01T09:26:00Z"));

    // Captured as it is written rather than read off the spy afterwards, so restoring the real
    // `console.warn` cannot take the evidence with it.
    const lines: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args) => {
      lines.push(String(args[0]));
    });
    let offered: string[] = [];
    try {
      ({ offered } = await offerDueRoutines(
        sweepOptions({ now: () => new Date("2001-01-01T09:27:00Z") }),
      ));
    } finally {
      warn.mockRestore();
    }

    expect(offered).toContain(healthy.id);
    expect(await firingsFor(healthy.id)).toHaveLength(1);

    // Said out loud, with the routine in it: a sweep that swallowed this would look clean while one
    // routine never advanced again.
    const complaint = lines.find((line) => line.includes(poisoned.id));
    expect(complaint).toBeDefined();
    expect(JSON.parse(complaint as string).routineId).toBe(poisoned.id);

    // The poisoned routine's clock could not move, so it stays due and stays being warned about —
    // loudly and harmlessly, because the offer key is the same one every pass.
    expect((await readRoutine(poisoned.id))?.nextRunAt.getTime()).toBe(
      new Date("2001-01-01T09:25:00Z").getTime(),
    );
  });
});
