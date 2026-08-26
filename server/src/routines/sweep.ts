/**
 * Turning "this routine is due" into exactly one firing, on a clock, across replicas.
 *
 * TWO HALVES, LIKE `server/src/work/culler.ts`, and separated for its reason: deciding what should
 * fire is not the same act as firing it. This half reads the ledger and puts an item on the shared
 * queue; the next one claims those items and dispatches them. So whichever replica noticed does not
 * have to be the one that carries it out, and a dispatch that dies halfway is picked up by whoever
 * claims it next rather than lost with the process that saw it was due.
 *
 * Two free functions over one options type rather than a factory, again like the culler, so the two
 * halves cannot drift about what a lease, an owner or a limit means: there is one description of the
 * things they share, and both read it.
 *
 * THE OFFER KEY IS THE WHOLE IDEMPOTENCE STORY. It carries the minute the firing was due, so three
 * replicas waking at 09:00 produce one work item and one run. That holds only while every replica
 * renders that minute identically, which is why the format is pinned in one function below and
 * asserted literally in `server/tests/routine-sweep.integration.test.ts`.
 *
 * NO CLAIM OR LEASE MACHINERY HERE, and none on the routines table. `server/src/work/queue.ts`
 * already owns `for update skip locked`, leases named on the database's clock and an attempt count.
 * A second half-right copy grown next to it is the duplicated firing mechanism #235 exists to
 * prevent.
 */
import type { WorkQueue } from "../work/queue";
import type { RoutineStore } from "./store";

export const ROUTINE_FIRE_KIND = "routine.fire";

/** How many due routines one pass will look at. Bounded, because a pass has to end. */
const DEFAULT_LIMIT = 50;

/**
 * How late a firing may be and still be worth having.
 *
 * Ten minutes: several sweep intervals plus a slow pass, so a firing delayed by a deploy, a restart
 * or a busy queue is still delivered rather than silently dropped — and comfortably under the
 * fifteen-minute floor a routine's schedule may have (`MINIMUM_INTERVAL_MS` in `./schedule`), so the
 * window can never call two consecutive occurrences of one routine current at the same time.
 */
const DEFAULT_GRACE_MS = 10 * 60_000;

export type RoutineSweepOptions = {
  routineStore: RoutineStore;
  /** The shared `work_items` queue. Not a second queue, and not a timer. */
  queue: WorkQueue;
  /** POST /internal/routines/run. Throws on anything that is not a 202. */
  dispatch: (routineRunId: string) => Promise<void>;
  /** Who this process is, for the lease. A name, so a stuck claim traces back to a pod. */
  owner: string;
  /** Lease for a claimed firing; phase two is what applies it. Default 60_000. */
  leaseMs?: number;
  /** How many goes one firing gets before it stops being offered. Default `DEFAULT_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** How many due routines one pass considers. Default 50. */
  limit?: number;
  /** How late a firing may be and still be offered. Default ten minutes; see the policy below. */
  graceMs?: number;
  now?: () => Date;
};

/**
 * What one pass of phase two did.
 *
 * Declared here with the options it shares because PHASE TWO ARRIVES NEXT — the half that claims
 * these items, opens a run row and dispatches it. Nothing in this file returns one yet.
 */
export type RoutineSweepReport = {
  considered: number;
  fired: string[];
  skipped: { routineId: string; reason: string }[];
};

/**
 * The minute a firing was due, rendered the same way by every replica.
 *
 * `2026-08-26T09:30Z`: ISO, truncated to the minute, always UTC, no seconds and no fractional part.
 * This string is half of the offer key, so THE FORMAT IS THE IDEMPOTENCE — two sweeps that render one
 * due moment differently offer two items and a person gets two runs of the same routine. Changing it
 * also orphans every key already in `work_items`, which is why the tests assert it literally rather
 * than recomputing it.
 *
 * Truncated rather than rounded, so a stamp never renders as a minute it is not in, and UTC by
 * construction: `toISOString` has no local component, so a replica in another zone cannot name the
 * same moment differently.
 */
function minuteKey(due: Date): string {
  // "2026-08-26T09:30:00.000Z" -> "2026-08-26T09:30" -> back with the zone it never left.
  return `${due.toISOString().slice(0, 16)}Z`;
}

/**
 * Phase one: due routines become idempotent work items, and `next_run_at` moves exactly once.
 *
 * WHICH CLOCK, given that everything around this names its moments in SQL. Both moments that decide
 * anything come from the database: `dueRoutines` compares `next_run_at <= now()` inside Postgres, so
 * what is due is Postgres's judgement, and the stamp this keys the offer on and hands the
 * compare-and-set is the value Postgres gave back. The one process-clock reading is `now` here, used
 * only to measure the width of the grace window below — a window minutes wide, against a stamp the
 * database chose, so sub-second skew cannot change an answer. A badly skewed node could admit or
 * suppress a firing near the boundary; it cannot double-fire one, because the key and the CAS are
 * both the database's. That is the difference between this and a lease, which is why a lease is
 * never computed here. The option exists so tests can put a stamp anywhere they like.
 */
export async function offerDueRoutines(
  options: RoutineSweepOptions,
): Promise<{ offered: string[] }> {
  const now = options.now?.() ?? new Date();
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const due = await options.routineStore.dueRoutines(
    options.limit ?? DEFAULT_LIMIT,
  );

  const offered: string[] = [];
  for (const routine of due) {
    /*
     * ONE ROUTINE'S FAILURE IS ONE ROUTINE'S FAILURE. A cron the parser cannot read — a row written
     * before a validation existed, a hand-edited value — makes `advanceNextRun` throw, and an
     * unguarded loop would take the whole pass down with it: everybody else's routines, on every
     * pass, for as long as the bad row exists. So each routine is its own attempt, and the pass
     * carries on.
     */
    try {
      /*
       * A STALE STAMP IS NOT A BACKLOG TO REPLAY. `advanceNextRun` moves the clock one occurrence on
       * from the stamp it was given, so a routine whose stamp is a month behind — a deployment that
       * ran with no worker, a worker that was down — comes back due on the next pass, and the pass
       * after that, once per missed occurrence, each with its own offer key and its own real firing.
       * Turn the worker on after a quiet month and a person gets thirty summaries of thirty days ago.
       *
       * So this loop offers only firings that are still worth having: a stamp within GRACE of now.
       * For anything later than that, advance WITHOUT offering and say nothing — the occurrence is
       * past and nobody wants it now — and let successive passes drain the stamp silently until it is
       * current. The store deliberately does not decide this: it moves the clock one step and reports
       * whether it won, and which steps are worth firing is this file's policy.
       *
       * Draining costs a slot of `limit` per pass per stale routine, which is the price of a bounded
       * pass; the routines still current are read on the same passes, because the ordering is by due
       * stamp and a stale one leaves the list as soon as its clock catches up.
       */
      const lateBy = now.getTime() - routine.nextRunAt.getTime();
      if (lateBy <= graceMs) {
        /*
         * OFFERED BEFORE THE CLOCK MOVES. A crash between the two leaves the stamp where it was, so
         * the next pass reads the same stamp, renders the same key and collides: the firing happens
         * once and nothing is lost. Advancing first and offering second loses that firing outright —
         * the stamp is gone and nothing remembers what it was for.
         */
        await options.queue.offer({
          kind: ROUTINE_FIRE_KIND,
          key: `${routine.id}:${minuteKey(routine.nextRunAt)}`,
          payload: {
            routineId: routine.id,
            scheduledFor: routine.nextRunAt.toISOString(),
          },
        });
        offered.push(routine.id);
      }
      // False means another sweep advanced it first, which is fine either way: the firing was offered
      // under the same key by both, so it still happens once.
      await options.routineStore.advanceNextRun(routine.id, routine.nextRunAt);
    } catch (error) {
      /*
       * Said out loud, with the routine in it. A pass that swallowed this would look clean while one
       * routine's clock never moved again: it would be read as due, warned about and re-offered under
       * the same key on every pass thereafter — harmless, but invisible to anybody not reading logs.
       */
      console.warn(
        JSON.stringify({
          type: "routine-sweep-offer-failed",
          routineId: routine.id,
          scheduledFor: routine.nextRunAt.toISOString(),
          reason:
            error instanceof Error ? error.message : "could not be offered",
        }),
      );
    }
  }

  return { offered };
}
