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
  routineRuns,
  routines,
  users,
  workItems,
} from "../src/db/schema";
import { MINIMUM_INTERVAL_MS } from "../src/routines/schedule";
import { createRoutineStore } from "../src/routines/store";
import {
  DEFAULT_GRACE_MS,
  dispatchClaimedRoutines,
  offerDueRoutines,
  ROUTINE_FIRE_KIND,
} from "../src/routines/sweep";
import { createWorkQueue, DEFAULT_MAX_ATTEMPTS } from "../src/work/queue";
import { TEST_POOL } from "./support/database";

/**
 * Both halves of the sweep against a real PostgreSQL and the real `work_items` queue.
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
 * file tests is which firings the sweep decides are worth offering, and — for the consuming half —
 * whether the consumer honours the booleans the queue hands back: a `renew` that says the lease has
 * gone, a `finish` that says the item was not ours, an attempt count that has reached its cap.
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
 * `offerDueRoutines` never calls it — it only puts work on the queue — so a dispatch that started
 * happening in the offering phase shows up here as a recorded call rather than as nothing. What the
 * consuming phase hands it is a run id, which is the only thing `/internal/routines/run` is told.
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

/** Every run row this routine has, in-flight ones included: `status` is null until something ends. */
async function runsFor(routineId: string) {
  return await database
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, routineId));
}

/**
 * One routine, due at `due`, offered by a sweep that thinks it is `at`.
 *
 * The offer is made by the real `offerDueRoutines` rather than by a hand-written insert, so what the
 * consuming half claims is the row and the payload production would give it — including
 * `scheduledFor`, which the consumer re-checks against the grace window before it fires anything.
 */
async function offerFiring(routineId: string, due: Date, at: Date) {
  await makeDueAt(routineId, due);
  await offerDueRoutines(sweepOptions({ now: () => at }));
}

/**
 * Age a queued firing by hand.
 *
 * The queue names every moment of its own in SQL, so a test cannot wait for a lease to lapse or for
 * a release delay to pass; it writes the timestamp the queue would have arrived at. That is a test
 * driving the clock, not a test reimplementing the queue: what is asserted afterwards is still the
 * queue's own answer to `claim`, `renew` and `purge`.
 */
async function backdate(
  key: string,
  values: Partial<typeof workItems.$inferInsert>,
) {
  await database
    .update(workItems)
    .set(values)
    .where(and(eq(workItems.kind, ROUTINE_FIRE_KIND), eq(workItems.key, key)));
}

test("the grace window stays under the schedule floor, as a compile/test-time fact rather than prose", () => {
  // Two consecutive occurrences of one routine must never both be inside the grace window — that
  // would make a routine's own next firing look like a re-offer of a stale one. The floor between
  // two occurrences is `MINIMUM_INTERVAL_MS`, so the grace window has to stay strictly under it.
  expect(DEFAULT_GRACE_MS).toBeLessThan(MINIMUM_INTERVAL_MS);
});

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
 * A routine whose stamp is a month behind must not fire once per missed occurrence when the worker
 * comes back: a person would get thirty summaries of thirty days ago. And it must not drain one
 * occurrence per pass either — that kept a fifteen-minute routine silent a further fortnight after a
 * month of downtime, because stepping through ~2,900 missed occurrences at one per five-minute sweep
 * is itself two weeks. One pass makes the clock current, silently.
 */
describe("draining a stale stamp instead of replaying it", () => {
  test("a month-old firing is caught up to current in one pass, and a two-minute-old one fires", async () => {
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

    // Advanced past the whole backlog in one move: the next occurrence is computed from the pass's
    // own moment, not one day along a thirty-one-day drain, so the routine is silent for the missed
    // month and then simply current. (Whether it is still "due" is Postgres's real clock's judgement,
    // which is why this asserts the landing point rather than a second pass over a 2001 stamp.)
    const after = await readRoutine(stale.id);
    expect(after?.nextRunAt.getTime()).toBeGreaterThan(staleFrom.getTime());
    expect(after?.nextRunAt.toISOString()).toBe("2001-02-02T09:00:00.000Z");
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
 * One poisoned routine is one person's problem, not everybody's — and not silently for ever.
 *
 * A cron the schedule module refuses makes `advanceNextRun` throw. An unguarded loop would take the
 * whole pass down with it, for every other person's routine too; and a loop that only warned would
 * read the same row as due on every pass for ever, burning one of the pass's slots while its owner
 * saw a routine that quietly stopped. So the pass survives it, says so, and switches the routine off
 * with the reason written where the routines page reads it.
 */
describe("surviving a routine that cannot be scheduled", () => {
  test("a poisoned cron is warned about, switched off with its reason on the page, and the next routine still offered", async () => {
    const { owner: poisonedOwner, routine: poisoned } =
      await makeRoutine("Unschedulable.");
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
    // routine was switched off.
    const complaint = lines.find((line) => line.includes(poisoned.id));
    expect(complaint).toBeDefined();
    expect(JSON.parse(complaint as string).routineId).toBe(poisoned.id);

    /*
     * SWITCHED OFF, NOT LEFT TO WEDGE. The clock could not move, so left enabled this row would be
     * read as due and thrown over on every pass for ever — invisible to its owner, who would see a
     * routine that simply stopped. Disabled, it stops burning a due slot, and the skipped run row is
     * the announcement: the sweep has no channel to speak in, so the page's last-run column is where
     * the owner learns why.
     */
    const after = await readRoutine(poisoned.id);
    expect(after?.enabled).toBe(false);
    expect(after?.nextRunAt.getTime()).toBe(
      new Date("2001-01-01T09:25:00Z").getTime(),
    );
    const [summary] = await store.listFor(poisonedOwner.id);
    expect(summary?.enabled).toBe(false);
    expect(summary?.lastRun?.status).toBe("skipped");

    // That single firing is the entire blast radius: pin it as exactly one `work_items` row, the
    // offer that preceded the throw, rather than leaving it inferred from the warning alone.
    expect(await firingsFor(poisoned.id)).toHaveLength(1);
  });

  /**
   * The wedge that motivated the deterministic floor: `45,55 8 * * *` used to be ACCEPTED when
   * created between the pair (the next two occurrences sampled 23h50m apart), and then the first
   * advance handed the schedule an `after` of 08:45, saw the ten-minute pair, and threw — on every
   * pass, for ever, while the routine silently never fired again. Creation now refuses it, so the
   * row is written directly to stand for the ones already in the wild.
   */
  test("a sub-floor cron already in the table is switched off instead of wedging the sweep", async () => {
    const { owner, routine } = await makeRoutine("Grandfathered in.");
    await database
      .update(routines)
      .set({ cron: "45,55 8 * * *" })
      .where(eq(routines.id, routine.id));
    await makeDueAt(routine.id, new Date("2001-01-01T08:45:00Z"));

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await offerDueRoutines(
        sweepOptions({ now: () => new Date("2001-01-01T08:46:00Z") }),
      );
    } finally {
      warn.mockRestore();
    }

    const [summary] = await store.listFor(owner.id);
    expect(summary?.enabled).toBe(false);
    expect(summary?.lastRun?.status).toBe("skipped");
    // The reason on the run row is the schedule's own sentence, so the owner (and their Bot) can
    // propose a schedule that works rather than guess at what broke.
    const runs = await runsFor(routine.id);
    expect(runs[0]?.error).toContain("15 minutes");

    // And a disabled routine is not due: the pass after this one no longer spends a slot on it.
    expect((await store.dueRoutines(50)).map((row) => row.id)).not.toContain(
      routine.id,
    );
  });
});

/**
 * The consuming half: a claimed item becomes a run, and the queue's booleans are believed.
 *
 * Every branch below is about the gap between the offer and the firing. The item was put on the
 * queue by another replica at another time, and by the time this one claims it the routine may have
 * been switched off, deleted, or the occurrence may simply have gone stale while the item sat behind
 * a backlog. The queue answers those questions with booleans — `renew`, `finish`, `release` — and a
 * consumer that treats them as formalities is a consumer that fires twice.
 */
describe("consuming a claimed firing", () => {
  const at = (moment: string) => () => new Date(moment);

  test("a claimed firing is dispatched once, finished, and never claimed again", async () => {
    const { routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );

    const report = await dispatchClaimedRoutines(
      sweepOptions({ now: at("2001-01-01T09:26:00Z") }),
    );

    expect(report.fired).toEqual([routine.id]);
    expect(report.skipped).toEqual([]);
    // The run row is what the dispatch is told about, and it owns the outcome from here: opened with
    // no status, because null is the in-flight state.
    const runs = await runsFor(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBeNull();
    expect(dispatched).toEqual([runs[0]?.id]);

    // Marked, not deleted: the finished row is what a late replica's re-offer collides with.
    const [row] = await firingsFor(routine.id);
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.claimedBy).toBeNull();

    // And the next sweep claims nothing, so the person gets one run rather than one per sweep.
    const second = await dispatchClaimedRoutines(
      sweepOptions({ now: at("2001-01-01T09:27:00Z") }),
    );
    expect(second.considered).toBe(0);
    expect(dispatched).toHaveLength(1);
    expect(await runsFor(routine.id)).toHaveLength(1);
  });

  test("a dispatch that throws pushes the firing out, and it comes back with its attempts grown", async () => {
    const { routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );

    const report = await dispatchClaimedRoutines(
      sweepOptions({
        now: at("2001-01-01T09:26:00Z"),
        dispatch: async () => {
          throw new Error("the server answered 503");
        },
      }),
    );

    expect(report.fired).toEqual([]);
    expect(report.skipped[0]?.routineId).toBe(routine.id);
    expect(report.skipped[0]?.reason).toContain("503");

    /*
     * The run row this attempt opened stays open FOR NOW, on purpose: a dispatch that timed out may
     * be a dispatch a wedged server accepted anyway, with a detached turn coming back for this very
     * row, and only age can tell that apart from abandonment. The reaper closes it once it is older
     * than any turn could still be running — the age-scoped test further down pins that half.
     */
    const runs = await runsFor(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBeNull();

    /*
     * THE ROW, NOT THE RETURN VALUE. A consumer that reported a failure and finished the item anyway
     * would pass any assertion made on the report alone, and the firing would be gone for good.
     */
    const [row] = await firingsFor(routine.id);
    expect(row?.finishedAt).toBeNull();
    expect(row?.claimedBy).toBeNull();
    expect(row?.attempts).toBe(1);
    // The reason stays on the row, so an item that eventually runs out of attempts says why.
    expect(row?.lastError).toContain("503");
    // Pushed out rather than retried in the same pass: whatever refused this will probably refuse it
    // again in the next second.
    expect(row?.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Claimable again once the delay has passed, and the second hand-out says it is a second one.
    await backdate(row?.key as string, {
      runAt: new Date("2001-01-01T09:27:00Z"),
    });
    const [again] = await queue.claim({
      kind: ROUTINE_FIRE_KIND,
      owner: "sweep-test",
      leaseMs: 30_000,
    });
    expect(again?.key).toBe(row?.key);
    expect(again?.attempts).toBe(2);
  });

  test("a routine switched off between the offer and the firing is finished without dispatching", async () => {
    const { owner, routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );
    await store.setEnabled(owner.id, routine.id, false);

    const report = await dispatchClaimedRoutines(
      sweepOptions({ now: at("2001-01-01T09:26:00Z") }),
    );

    expect(report.fired).toEqual([]);
    expect(report.skipped[0]?.routineId).toBe(routine.id);
    expect(dispatched).toEqual([]);
    expect(await runsFor(routine.id)).toHaveLength(0);
    // Finished rather than released: re-running cannot make a switched-off routine want to fire.
    const [row] = await firingsFor(routine.id);
    expect(row?.finishedAt).not.toBeNull();
  });

  test("a routine deleted between the offer and the firing is finished without dispatching", async () => {
    const { owner, routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );
    // A hard delete, which is what `remove` does — and it takes the routine's runs with it.
    await store.remove(owner.id, routine.id);

    const report = await dispatchClaimedRoutines(
      sweepOptions({ now: at("2001-01-01T09:26:00Z") }),
    );

    expect(report.fired).toEqual([]);
    expect(report.skipped[0]?.routineId).toBe(routine.id);
    expect(dispatched).toEqual([]);
    // Finished, not released: no number of retries will make a deleted routine exist.
    const [row] = await firingsFor(routine.id);
    expect(row?.finishedAt).not.toBeNull();
  });

  /**
   * THE WINDOW IS ENFORCED AGAIN AT FIRING TIME, not only at offering time.
   *
   * The offer refused anything staler than the grace window, but the queue's own machinery can
   * outlive that window: a backlogged sweep, or five releases at a minute each, and the item is
   * claimed long after the occurrence it names. Firing it then posts "here is your morning summary"
   * in the afternoon, which is exactly what the stale-stamp policy exists to prevent.
   */
  test("a firing claimed after its window has passed is finished without dispatching, and leaves no run row", async () => {
    const { routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      // Offered one minute late, well inside the window. Nothing here is a stale offer.
      new Date("2001-01-01T09:26:00Z"),
    );

    // Claimed twenty minutes after the occurrence, which is outside the default ten.
    const report = await dispatchClaimedRoutines(
      sweepOptions({ now: at("2001-01-01T09:45:00Z") }),
    );

    expect(report.fired).toEqual([]);
    expect(report.skipped[0]?.routineId).toBe(routine.id);
    expect(dispatched).toEqual([]);
    /*
     * NO ORPHAN. The check sits beside the deleted/disabled branch, before `insertRun`, so a skipped
     * firing leaves nothing in `routine_runs` — a run row with no outcome and nothing coming to give
     * it one would show on the routines page as a firing that started and never ended.
     */
    expect(await runsFor(routine.id)).toHaveLength(0);
    // Finished rather than released: re-delivery cannot make a past occurrence current.
    const [row] = await firingsFor(routine.id);
    expect(row?.finishedAt).not.toBeNull();

    // The window is still a setting, so a caller that wants the late firing can have it.
    await makeDueAt(routine.id, new Date("2001-02-01T09:25:00Z"));
    await offerDueRoutines(
      sweepOptions({ now: () => new Date("2001-02-01T09:26:00Z") }),
    );
    const generous = await dispatchClaimedRoutines(
      sweepOptions({
        now: at("2001-02-01T09:45:00Z"),
        graceMs: 30 * 60_000,
      }),
    );
    expect(generous.fired).toEqual([routine.id]);
  });

  /**
   * THE LESSON FROM `culler.ts:141-151`, which is why the renew comes before anything else.
   *
   * A batch is many and a lease is one. The first consumer claims, is slow, and its lease lapses;
   * another replica takes the item and runs it. If the first then dispatched what it was holding,
   * the person would get the same summary twice — and worse, the first would `finish` an item that
   * belongs to the second, taking the lease away from a run that is still going.
   */
  test("a consumer whose lease has gone neither dispatches nor finishes the item that is now somebody else's", async () => {
    const { routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );
    const [offered] = await firingsFor(routine.id);
    const now = at("2001-01-01T09:26:00Z");

    const dispatchedBySecond: string[] = [];
    const finishedByFirst: string[] = [];
    let second: Awaited<ReturnType<typeof dispatchClaimedRoutines>> | undefined;

    /*
     * The first consumer's claim succeeds and then it stalls: the lease is written into the past and
     * a whole second consumer runs the item to completion before the first gets to its own loop.
     * Standing in for a slow pass rather than reimplementing one — everything after this point is
     * still the queue's own answer.
     */
    const stalling = {
      ...queue,
      claim: async (input: Parameters<typeof queue.claim>[0]) => {
        const claimed = await queue.claim(input);
        await backdate(offered?.key as string, {
          leaseUntil: new Date("2001-01-01T00:00:00Z"),
        });
        second = await dispatchClaimedRoutines(
          sweepOptions({
            owner: "consumer-second",
            now,
            dispatch: async (runId: string) => {
              dispatchedBySecond.push(runId);
            },
          }),
        );
        return claimed;
      },
      finish: async (input: Parameters<typeof queue.finish>[0]) => {
        finishedByFirst.push(input.key);
        return await queue.finish(input);
      },
    };

    const first = await dispatchClaimedRoutines(
      sweepOptions({
        owner: "consumer-first",
        queue: stalling,
        now,
        dispatch: async (runId: string) => {
          dispatched.push(`first:${runId}`);
        },
      }),
    );

    // The second consumer did the work, exactly once.
    expect(second?.fired).toEqual([routine.id]);
    expect(dispatchedBySecond).toHaveLength(1);
    expect(await runsFor(routine.id)).toHaveLength(1);

    // The first stopped at `renew`, which is not an error: the item is being handled, just not here.
    expect(first.considered).toBe(1);
    expect(first.fired).toEqual([]);
    expect(first.skipped[0]?.routineId).toBe(routine.id);
    expect(dispatched).toEqual([]);
    // And it never called `finish`, so it could not have taken the item off a run in flight.
    expect(finishedByFirst).toEqual([]);
  });

  /**
   * At the cap the item stops being claimed, so this loop never sees that routine again: every
   * sweep looks clean while one person's routine silently never fires. The row carries the count and
   * the reason for anybody who queries the table; the warning is for whoever reads the logs.
   */
  test("at the attempt cap the firing stops being claimed, and the giving up is said out loud", async () => {
    const { routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );

    const lines: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args) => {
      lines.push(String(args[0]));
    });
    try {
      await dispatchClaimedRoutines(
        sweepOptions({
          now: at("2001-01-01T09:26:00Z"),
          // One go, so the first failure is also the last.
          maxAttempts: 1,
          dispatch: async () => {
            throw new Error("the server answered 503");
          },
        }),
      );
    } finally {
      warn.mockRestore();
    }

    const complaint = lines.find((line) => line.includes(routine.id));
    expect(complaint).toBeDefined();
    const said = JSON.parse(complaint as string);
    expect(said.routineId).toBe(routine.id);
    expect(said.attempts).toBe(1);
    expect(said.reason).toContain("503");

    /*
     * And it is the cap that stops it, not the release delay: the delay is put in the past first, so
     * a claim that still refuses the item is refusing it for having run out of goes.
     */
    const [row] = await firingsFor(routine.id);
    await backdate(row?.key as string, {
      runAt: new Date("2001-01-01T09:27:00Z"),
    });
    expect(
      await queue.claim({
        kind: ROUTINE_FIRE_KIND,
        owner: "sweep-test",
        leaseMs: 30_000,
        maxAttempts: 1,
      }),
    ).toEqual([]);
  });

  /**
   * NO RUN ROW STAYS OPEN FOR EVER AFTER THE CAP. `insertRun` runs before `dispatch` on every
   * attempt, so a dispatch that throws on the very last attempt leaves an open (`status` null) run
   * row: the item stops being claimed at the cap and the queue's own machinery has nothing to do
   * with `routine_runs`. Nothing closes that row at the give-up itself — a timed-out dispatch may be
   * a turn a wedged server accepted, and only age can tell — but the reaper closes it on a later
   * pass, so `listFor` (the routines page's read) stops showing "running now" for a routine that
   * never ran. At Helm defaults the old give-up branch was unreachable in time anyway (five 1-minute
   * retries against a 10-minute grace), so these rows used to leak for ever.
   */
  test("a run row leaked at the attempt cap is closed by a later pass, so the page stops reading 'running'", async () => {
    const { owner, routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await dispatchClaimedRoutines(
        sweepOptions({
          now: at("2001-01-01T09:26:00Z"),
          maxAttempts: 1,
          dispatch: async () => {
            throw new Error("the server answered 503");
          },
        }),
      );

      // Old enough that no turn could still be running it; the reaper compares on the database's
      // clock, so the age is written rather than waited for.
      const [leaked] = await runsFor(routine.id);
      await database
        .update(routineRuns)
        .set({ startedAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(routineRuns.id, leaked?.id as string));

      await dispatchClaimedRoutines(
        sweepOptions({ now: at("2001-01-01T09:40:00Z") }),
      );
    } finally {
      warn.mockRestore();
    }

    // No run row for this routine is left open once the reaper has passed.
    const runs = await runsFor(routine.id);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.status !== null)).toBe(true);

    // The page-facing read agrees, and it reads "skipped", not "failed": the turn never ran, so the
    // routine's own failure streak must not grow — ten flapping dispatches used to read as ten turn
    // failures, enough to trip the fatigue rule and switch a perfectly healthy routine off.
    const [summary] = await store.listFor(owner.id);
    expect(summary?.lastRun?.status).toBe("skipped");
    expect(summary?.lastRun?.finishedAt).toBeInstanceOf(Date);
    expect(await store.consecutiveFailures(routine.id)).toBe(0);
  });

  /**
   * THE NET MUST NOT CATCH THE NEIGHBOUR'S FISH. An earlier firing of the same routine can be
   * genuinely mid-turn while a later firing runs out of dispatch attempts: the dispatch call aborts
   * at 30 seconds, but the server's detached turn keeps running for minutes and finishes its row
   * itself. The old give-up cleanup closed EVERY open run of the routine, that one included, so the
   * real turn's finish then no-oped against an already-"failed" row and an honest success was
   * recorded as a failure. Cleanup is age-scoped now, and a fresh row is by definition one a turn
   * may still be running.
   */
  test("giving up leaves a genuinely in-flight run from an earlier firing untouched", async () => {
    const { routine } = await makeRoutine();
    // The earlier firing: already dispatched, its turn still running on the server, its row open.
    const inFlight = await store.insertRun(routine.id);

    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await dispatchClaimedRoutines(
        sweepOptions({
          now: at("2001-01-01T09:26:00Z"),
          maxAttempts: 1,
          dispatch: async () => {
            throw new Error("the server answered 503");
          },
        }),
      );
    } finally {
      warn.mockRestore();
    }

    // Nothing was mislabelled at the give-up: both rows are still open, because both are young
    // enough to be turns some server is running.
    const runs = await runsFor(routine.id);
    expect(runs.find((run) => run.id === inFlight.runId)?.status).toBeNull();

    // The in-flight turn now completes, and its outcome lands rather than no-oping against a row
    // the give-up already closed — which is exactly what the old cleanup caused.
    await store.finishRun(inFlight.runId, "succeeded");
    expect(
      (await runsFor(routine.id)).find((run) => run.id === inFlight.runId)
        ?.status,
    ).toBe("succeeded");

    // And once the abandoned attempt's row is old enough that no turn could still be running it,
    // the reaper closes it — as skipped, never touching the finished run beside it.
    const attempt = runs.find((run) => run.id !== inFlight.runId);
    await database
      .update(routineRuns)
      .set({ startedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(routineRuns.id, attempt?.id as string));
    const warnAgain = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await dispatchClaimedRoutines(
        sweepOptions({ now: at("2001-01-01T09:40:00Z") }),
      );
    } finally {
      warnAgain.mockRestore();
    }
    const after = await runsFor(routine.id);
    expect(after.find((run) => run.id === attempt?.id)?.status).toBe("skipped");
    expect(after.find((run) => run.id === inFlight.runId)?.status).toBe(
      "succeeded",
    );
  });

  /**
   * A firing abandoned mid-retry must not strand its run rows. An attempt fails inside the grace
   * window and its item is released; by the time the item is claimed again the window has passed and
   * the firing is finished as stale. The grace-skip itself opens nothing and closes nothing — the
   * open row may be a turn a wedged server accepted, and only age can tell — but the reaper closes
   * it once it is old enough, so nothing about the abandoned firing reads "running now" for ever.
   */
  test("a firing abandoned by the grace window does not strand its earlier attempt's run row", async () => {
    const { routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );

    // Attempt one, inside the window: the dispatch throws and the item is pushed out for retry.
    await dispatchClaimedRoutines(
      sweepOptions({
        now: at("2001-01-01T09:26:00Z"),
        dispatch: async () => {
          throw new Error("the server answered 503");
        },
      }),
    );
    // The retry delay is written into the past so the next pass can claim the item at all, and the
    // leaked row is aged past the reaper's cutoff the same way — the clock is driven, not waited on.
    const [row] = await firingsFor(routine.id);
    await backdate(row?.key as string, {
      runAt: new Date("2001-01-01T09:27:00Z"),
    });
    const [leaked] = await runsFor(routine.id);
    await database
      .update(routineRuns)
      .set({ startedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(routineRuns.id, leaked?.id as string));

    // Attempt two, claimed twenty minutes after the occurrence: outside the window, so the firing
    // is finished without dispatching — and the same pass's reaper closes the leaked row.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let report: Awaited<ReturnType<typeof dispatchClaimedRoutines>>;
    try {
      report = await dispatchClaimedRoutines(
        sweepOptions({ now: at("2001-01-01T09:45:00Z") }),
      );
    } finally {
      warn.mockRestore();
    }
    expect(report.fired).toEqual([]);
    expect(report.skipped[0]?.routineId).toBe(routine.id);

    // Nothing about this firing is still open: attempt one's row is closed as skipped — no turn ran,
    // so the fatigue rule must not count it — and attempt two never opened one.
    const runs = await runsFor(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("skipped");
    expect(await store.consecutiveFailures(routine.id)).toBe(0);
    const [finished] = await firingsFor(routine.id);
    expect(finished?.finishedAt).not.toBeNull();
  });

  /**
   * THE REAPER, for the row no retry ever comes back for. The server 202s the dispatch, the queue
   * item is finished, and then the server dies mid-turn: its run row stays open with nothing in the
   * system holding a reference to it — the page reads "running now" for a run no process is running.
   * The sweep's consuming pass is on a clock anyway, so it is the thing that mops these up.
   */
  test("a run abandoned by a dead server is closed by the next pass, as skipped, with an honest reason", async () => {
    const { owner, routine } = await makeRoutine();
    const { runId } = await store.insertRun(routine.id);
    // Aged past the reaper's cutoff (twice the server's five-minute turn timeout) by hand: the run
    // was opened by a server that died eleven minutes ago.
    await database
      .update(routineRuns)
      .set({ startedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(routineRuns.id, runId));

    // Nothing is claimed in this pass; the reaper alone does the work.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let report: Awaited<ReturnType<typeof dispatchClaimedRoutines>>;
    try {
      report = await dispatchClaimedRoutines(sweepOptions());
    } finally {
      warn.mockRestore();
    }
    expect(report.considered).toBe(0);

    const runs = await runsFor(routine.id);
    expect(runs[0]?.status).toBe("skipped");
    expect(runs[0]?.error).toContain("never finished this run");
    const [summary] = await store.listFor(owner.id);
    expect(summary?.lastRun?.status).toBe("skipped");
    expect(summary?.lastRun?.finishedAt).toBeInstanceOf(Date);
  });

  /**
   * BOTH KINDS OF DONE WITH, which is the half `queue.ts:262-274` documents as having been forgotten.
   *
   * A finished row has to outlive the run long enough for a late replica to collide with it, and
   * then go. An item at its attempt cap is not finished and is reaped by nothing else, so without
   * this its key stays wedged for ever and that routine can never be offered for that minute again.
   */
  test("the purge takes the finished firing and the one that gave up, once each is past the window", async () => {
    const { routine: done } = await makeRoutine("Finished cleanly.");
    const { routine: gaveUp } = await makeRoutine("Out of attempts.");
    await offerFiring(
      done.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );
    await dispatchClaimedRoutines(
      sweepOptions({ now: at("2001-01-01T09:26:00Z") }),
    );
    /*
     * The finished routine's clock is parked out of reach before the second offer.
     *
     * `dueRoutines` asks Postgres what is due, so a routine whose stamp the first offer advanced to
     * another day in 2001 is still due by the real clock, and the second offer would queue a second
     * firing of it. That is the offering half behaving as designed against ancient stamps; what this
     * test wants is one finished row and one that gave up, so it says which routine each pass is
     * about rather than working around the overlap afterwards.
     */
    await makeDueAt(done.id, new Date("2999-01-01T09:00:00Z"));
    await offerFiring(
      gaveUp.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );
    // The giving-up warning is asserted in its own test above; here it is only noise.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await dispatchClaimedRoutines(
        sweepOptions({
          now: at("2001-01-01T09:26:00Z"),
          maxAttempts: 1,
          dispatch: async () => {
            throw new Error("the server answered 503");
          },
        }),
      );
    } finally {
      warn.mockRestore();
    }

    const window = 24 * 60 * 60 * 1000;
    // Inside the window both rows stay: a finished row too young to have been collided with is the
    // whole reason `finish` marks rather than deletes.
    expect(
      await queue.purge({
        kind: ROUTINE_FIRE_KIND,
        olderThanMs: window,
        maxAttempts: 1,
      }),
    ).toBe(0);
    expect(await firingsFor(done.id)).toHaveLength(1);
    expect(await firingsFor(gaveUp.id)).toHaveLength(1);

    const aged = new Date(Date.now() - 2 * window);
    const [doneRow] = await firingsFor(done.id);
    const [gaveUpRow] = await firingsFor(gaveUp.id);
    await backdate(doneRow?.key as string, { finishedAt: aged });
    // The one that gave up has no `finished_at` to age at all — its `updated_at` is what dates it,
    // which is precisely why it used to be reaped by nothing.
    await backdate(gaveUpRow?.key as string, { updatedAt: aged });

    expect(
      await queue.purge({
        kind: ROUTINE_FIRE_KIND,
        olderThanMs: window,
        maxAttempts: 1,
      }),
    ).toBe(2);
    expect(await firingsFor(done.id)).toHaveLength(0);
    expect(await firingsFor(gaveUp.id)).toHaveLength(0);
  });

  /**
   * The cap the consumer warns at has to be the cap the queue stops claiming at.
   *
   * A consumer with its own number warns on the wrong pass: too low and it complains every pass
   * while the item is still being retried, too high and it never complains at all — the item stops
   * being claimed and nothing anywhere says so.
   */
  test("with no cap given, the consumer gives up on the pass the queue's own default stops handing it out", async () => {
    const { routine } = await makeRoutine();
    await offerFiring(
      routine.id,
      new Date("2001-01-01T09:25:00Z"),
      new Date("2001-01-01T09:26:00Z"),
    );
    const [offered] = await firingsFor(routine.id);
    // One short of the queue's default, so this claim is the last one the queue will allow.
    await backdate(offered?.key as string, {
      attempts: DEFAULT_MAX_ATTEMPTS - 1,
    });

    const lines: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args) => {
      lines.push(String(args[0]));
    });
    try {
      await dispatchClaimedRoutines(
        sweepOptions({
          now: at("2001-01-01T09:26:00Z"),
          dispatch: async () => {
            throw new Error("the server answered 503");
          },
        }),
      );
    } finally {
      warn.mockRestore();
    }

    const complaint = lines.find((line) => line.includes(routine.id));
    expect(complaint).toBeDefined();
    expect(JSON.parse(complaint as string).attempts).toBe(DEFAULT_MAX_ATTEMPTS);

    await backdate(offered?.key as string, {
      runAt: new Date("2001-01-01T09:27:00Z"),
    });
    expect(
      await queue.claim({
        kind: ROUTINE_FIRE_KIND,
        owner: "sweep-test",
        leaseMs: 30_000,
      }),
    ).toEqual([]);
  });
});
