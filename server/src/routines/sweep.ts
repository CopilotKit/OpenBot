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
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "../work/queue";
import type { RoutineStore } from "./store";

export const ROUTINE_FIRE_KIND = "routine.fire";

/** How many due routines one pass will look at. Bounded, because a pass has to end. */
const DEFAULT_LIMIT = 50;

/**
 * How long a claimed firing is leased for, and renewed by, while it is being dispatched.
 *
 * A minute: a dispatch is one HTTP call to this deployment's own server, which either answers or
 * fails long before that, and a firing whose owner died is worth picking up again quickly. It is
 * renewed before every item, so the length bounds one dispatch rather than the whole batch.
 */
const DEFAULT_LEASE_MS = 60_000;

/**
 * How long a firing that could not be dispatched waits before anybody tries again.
 *
 * A minute, for the culler's reason: whatever refused this will probably refuse it again in the next
 * second, and the queue's attempt cap is what stops the waiting going on for ever.
 */
const DISPATCH_RETRY_DELAY_MS = 60_000;

/**
 * How late a firing may be and still be worth having.
 *
 * Ten minutes: several sweep intervals plus a slow pass, so a firing delayed by a deploy, a restart
 * or a busy queue is still delivered rather than silently dropped — and comfortably under the
 * fifteen-minute floor a routine's schedule may have (`MINIMUM_INTERVAL_MS` in `./schedule`), so the
 * window can never call two consecutive occurrences of one routine current at the same time.
 */
export const DEFAULT_GRACE_MS = 10 * 60_000;

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
  /** How many goes one firing gets before it stops being offered. Default the queue's default attempt cap. */
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
 * `fired` is "a run was opened and the dispatch was accepted", not "the routine succeeded": the run
 * row in `routine_runs` owns the outcome from the moment the dispatch resolves, and this report is
 * the sweep's own account of its pass rather than a summary of anybody's turn.
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
       * routine's clock never moved again: it would be read as due and warned about on every pass
       * thereafter, but OFFERED only while its stamp is still inside `graceMs` — once the stamp ages
       * past the grace window, the guard above skips the offer before this throw is ever reached. So
       * the grace policy (the window worth having, above) is what bounds this failure mode to one
       * firing: harmless and loud, but invisible to anybody not reading logs.
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

/**
 * Which routine a claimed item is about.
 *
 * The payload is the answer, and the key is the fallback for a row written before the payload was:
 * the key is `<routineId>:<minute>` and a routine id carries no colon, so everything up to the first
 * one is the routine. A firing whose routine cannot be named at all would be a firing nothing could
 * report, which is why this never returns undefined.
 */
function routineIdOf(item: { key: string; payload: Record<string, unknown> }) {
  const fromPayload = item.payload.routineId;
  if (typeof fromPayload === "string" && fromPayload.length > 0) {
    return fromPayload;
  }
  const colon = item.key.indexOf(":");
  return colon === -1 ? item.key : item.key.slice(0, colon);
}

/**
 * Phase two: claimed items become dispatched firings, with the queue's booleans honoured.
 *
 * EVERY BRANCH HERE IS ABOUT THE GAP BETWEEN THE OFFER AND THE FIRING. Another replica decided this
 * should fire, at another time, and by now the routine may be switched off, deleted, or the
 * occurrence may have gone stale while the item waited behind a backlog. So the world is re-read at
 * the moment of acting — the culler's discipline, for the culler's reason — and the queue's own
 * answers are believed: a `renew` that says no means the item is somebody else's, and a `finish` that
 * says no means it stopped being ours while we were working.
 *
 * `finish` and `release` mean different things and are not interchangeable. `release` is for a
 * dispatch that could have worked and might work next time; `finish` is for a firing that will never
 * be worth having, however many times it comes back.
 */
export async function dispatchClaimedRoutines(
  options: RoutineSweepOptions,
): Promise<RoutineSweepReport> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const claimed = await options.queue.claim({
    kind: ROUTINE_FIRE_KIND,
    owner: options.owner,
    leaseMs,
    limit: options.limit ?? DEFAULT_LIMIT,
    // Passed through only when asked for, so the queue's own default stays the one default.
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
  });

  const report: RoutineSweepReport = {
    considered: claimed.length,
    fired: [],
    skipped: [],
  };

  for (const item of claimed) {
    const routineId = routineIdOf(item);

    /*
     * Renewed before acting, because the batch is many and the lease is one.
     *
     * This is the lesson at `server/src/work/culler.ts:141-151` verbatim: twenty API calls with
     * nothing renewed while they ran, the lease expiring part-way down the list, and another replica
     * claiming the tail this one was still working through. A lease nobody renews is a timer, and a
     * timer is what this queue exists not to be.
     *
     * False means it is already somebody else's, and then the only correct answer is to leave it
     * entirely alone: no dispatch, because that replica is already running this firing and a second
     * dispatch is a second message to a person; and no `finish`, because finishing somebody else's
     * item takes the lease away from a run that is still going.
     */
    if (
      !(await options.queue.renew({
        kind: ROUTINE_FIRE_KIND,
        key: item.key,
        owner: options.owner,
        leaseMs,
      }))
    ) {
      report.skipped.push({
        routineId,
        reason: "the lease went to another replica",
      });
      continue;
    }

    try {
      /*
       * RE-READ, because the offer was another replica's judgement at another time. A person who
       * switched a routine off a minute after it was offered, or deleted it, has said what they want;
       * firing it anyway posts a message they have asked not to receive.
       *
       * Finished rather than released in both cases: no number of retries will make a deleted routine
       * exist, and a switched-off one does not want its queued firing carried out later either. The
       * next occurrence is offered afresh if it is switched back on.
       */
      const routine = await options.routineStore.routineForFiring(routineId);
      if (!routine?.enabled) {
        const reason = routine
          ? "switched off between the offer and the firing"
          : "deleted between the offer and the firing";
        await finishOrSay(options, item.key, routineId, reason);
        report.skipped.push({ routineId, reason });
        continue;
      }

      /*
       * AND THE WINDOW AGAIN, HERE, before any run row exists.
       *
       * The offer already enforced this window at offer time, and that is not enough: the queue's
       * redelivery machinery can outlive it. A backlogged queue, or five releases at a minute each,
       * and the item is claimed well after the occurrence it names — "here is your morning summary",
       * in the afternoon, which is exactly what the stale-stamp policy above exists to prevent. So it
       * is re-checked at the moment of acting, which is the culler's precedent ("Somebody came back",
       * `culler.ts:~170`): the decision was made elsewhere and the world has moved since.
       *
       * BESIDE the deleted/disabled branch and before `insertRun`, so a skipped firing leaves no
       * `routine_runs` row: a run opened with no outcome and nothing coming to give it one shows on
       * the routines page as a firing that started and never ended.
       *
       * Finished, not released, for the same reason as above: re-delivery cannot make a past
       * occurrence current. A missing or unreadable stamp is not treated as stale — the offer is the
       * only writer of this payload and always writes one, so there is no window to enforce rather
       * than a window that has passed, and dropping the firing on a payload this file wrote would be
       * inventing a reason to lose it.
       */
      const now = options.now?.() ?? new Date();
      const stamp = item.payload.scheduledFor;
      const scheduledFor =
        typeof stamp === "string" ? new Date(stamp) : undefined;
      if (
        scheduledFor &&
        !Number.isNaN(scheduledFor.getTime()) &&
        now.getTime() - scheduledFor.getTime() > graceMs
      ) {
        const reason = "claimed too long after the occurrence it was due for";
        await finishOrSay(options, item.key, routineId, reason);
        report.skipped.push({ routineId, reason });
        continue;
      }

      /*
       * The run row first, then the dispatch, because the dispatch is told a run id and nothing else.
       * From the moment it resolves the run row owns the outcome: the queue's retries are for
       * DISPATCH failures only, and a turn that failed is final for this firing — the fatigue rule
       * owns that, not this loop.
       */
      const { runId } = await options.routineStore.insertRun(routineId);
      await options.dispatch(runId);
      if (
        !(await options.queue.finish({
          kind: ROUTINE_FIRE_KIND,
          key: item.key,
          owner: options.owner,
        }))
      ) {
        /*
         * The dispatch happened, so this is `fired` either way; but a `finish` that says no says the
         * lease lapsed while the call was in flight, which means another replica may claim this same
         * minute and dispatch it again. Said out loud, because it is the shape of a duplicate run and
         * nothing else in the system will mention it.
         */
        console.warn(
          JSON.stringify({
            type: "routine-fire-redelivery-possible",
            routineId,
            runId,
            reason:
              "the lease had gone by the time the dispatch came back, so the firing may be redelivered",
          }),
        );
      }
      report.fired.push(routineId);
    } catch (error) {
      /*
       * ONE FIRING'S FAILURE IS ONE FIRING'S FAILURE, exactly as in the offering half above: an
       * unguarded throw here would take everybody else's claimed firings down with it, on every
       * pass, for as long as the one bad item exists.
       *
       * Released rather than finished, and pushed out rather than retried in this pass: a server
       * that refused this dispatch will probably refuse it again in the next second, and the queue's
       * attempt cap is what bounds the retrying.
       */
      const reason =
        error instanceof Error ? error.message : "could not be dispatched";
      let released = false;
      try {
        released = await options.queue.release({
          kind: ROUTINE_FIRE_KIND,
          key: item.key,
          owner: options.owner,
          delayMs: DISPATCH_RETRY_DELAY_MS,
          reason,
        });
      } catch (releaseError) {
        // Best-effort: an item that could not even be released has a lease that will lapse on its
        // own, and the pass still has other firings to get through.
        console.warn(
          JSON.stringify({
            type: "routine-fire-release-failed",
            routineId,
            reason: String(releaseError),
          }),
        );
      }
      /*
       * Said out loud when it gives up, because otherwise it stops silently.
       *
       * At the cap the item is no longer claimed, so this loop simply never sees that routine again
       * and every sweep looks clean while one person's routine never fires. The row carries the count
       * and the reason for anybody who queries the table; this is for whoever reads the logs.
       */
      if (item.attempts >= maxAttempts) {
        /*
         * THE ROW THIS GIVE-UP LEAKED. Every attempt opened a run row before it dispatched
         * (`insertRun` above), and a dispatch that throws never reaches `finishRun` — so an item at
         * the cap is not just off the queue, it is one or more `routine_runs` rows stuck open with no
         * status. `listFor` shows the newest one, so without this the routines page reads "running
         * now" for a routine that never ran at all, forever. Closed before the warning so the row is
         * never left open even if the log line itself fails.
         */
        const closed = await options.routineStore.failOpenRuns(
          routineId,
          reason,
        );
        console.warn(
          JSON.stringify({
            type: "routine-fire-gave-up",
            routineId,
            key: item.key,
            attempts: item.attempts,
            reason,
            closedRuns: closed,
          }),
        );
      } else if (!released) {
        // Not ours any more, which means somebody else holds it: worth a line, because a release that
        // did nothing leaves this pass's failure recorded nowhere on the row.
        console.warn(
          JSON.stringify({
            type: "routine-fire-release-lost",
            routineId,
            key: item.key,
            reason,
          }),
        );
      }
      report.skipped.push({ routineId, reason });
    }
  }

  return report;
}

/**
 * Finish a firing nobody wants, and say so if it was not ours to finish.
 *
 * The boolean is the truth about ownership rather than a formality: false means the lease went while
 * this pass was deciding, so the routine was NOT stopped from firing here — whoever holds it now will
 * make its own decision, and this one should say what it saw rather than retry into a race.
 */
async function finishOrSay(
  options: RoutineSweepOptions,
  key: string,
  routineId: string,
  reason: string,
): Promise<void> {
  const finished = await options.queue.finish({
    kind: ROUTINE_FIRE_KIND,
    key,
    owner: options.owner,
  });
  if (!finished) {
    console.warn(
      JSON.stringify({
        type: "routine-fire-finish-lost",
        routineId,
        key,
        reason,
      }),
    );
  }
}
