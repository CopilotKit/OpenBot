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
import { RoutineRefusedError, type RoutineStore } from "./store";

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

/**
 * How long a run row may sit open with no outcome before a pass declares it abandoned.
 *
 * A server that dies mid-turn strands its run row for ever: the queue item was finished on the 202,
 * so no retry comes back for it, and nothing else writes that row — the routines page reads
 * "running now" for a run no process is running. Twice the server's own turn timeout
 * (`DEFAULT_TURN_TIMEOUT_MS` in `./run-turn`, five minutes), so a slow-but-alive turn is never
 * closed out from under the server still running it. A local constant rather than an import because
 * the sweep runs as a CronJob and must not drag the runtime's import graph — the Intelligence
 * client and everything behind it — into that process.
 */
const ABANDONED_RUN_MS = 10 * 60_000;

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
       * A STALE STAMP IS NOT A BACKLOG TO REPLAY. A routine whose stamp is a month behind — a
       * deployment that ran with no worker, a worker that was down — must not fire once per missed
       * occurrence when the worker comes back: turn it on after a quiet month and a person would get
       * thirty summaries of thirty days ago.
       *
       * So this loop offers only firings that are still worth having: a stamp within GRACE of now.
       * For anything later than that, advance WITHOUT offering and compute the next occurrence from
       * NOW rather than from the stale stamp, so one pass makes the clock current. Stepping one
       * occurrence per pass instead — the earlier shape — kept a fifteen-minute routine silent a
       * further fortnight after a month of downtime, because draining ~2,900 missed occurrences at
       * one per five-minute sweep is itself two weeks. The store deliberately does not decide this:
       * which stamps are worth firing, and where a stale clock should land, are this file's policy.
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
        // False means another sweep advanced it first, which is fine either way: the firing was
        // offered under the same key by both, so it still happens once.
        await options.routineStore.advanceNextRun(
          routine.id,
          routine.nextRunAt,
        );
      } else {
        // The CAS still compares against the stale stamp it read — only the landing point moves.
        await options.routineStore.advanceNextRun(
          routine.id,
          routine.nextRunAt,
          now,
        );
      }
    } catch (error) {
      /*
       * A refusal from the store here is the schedule's own: `advanceNextRun` recomputes the next
       * occurrence, and a cron the schedule module refuses — a row written before a validation
       * existed, a hand-edited value — throws on every pass for ever. Left alone, that routine's
       * clock never moves, it burns one of this pass's `limit` slots each time, and its owner sees a
       * routine that silently stopped. Deterministic refusals do not heal, so the routine is
       * switched off and the reason written where the routines page reads it — the sweep has no
       * channel to announce itself in, the way the runner's fatigue switch-off does. Queue and
       * database errors are NOT this: they heal, so those routines are left enabled for the next
       * pass to try again.
       */
      if (error instanceof RoutineRefusedError) {
        try {
          await options.routineStore.markUnschedulable(
            routine.id,
            error.message,
          );
        } catch (markError) {
          // Best-effort: a switch-off that failed leaves the loud warning below, and the next pass
          // will be back here to try the switch-off again.
          console.warn(
            JSON.stringify({
              type: "routine-sweep-disable-failed",
              routineId: routine.id,
              reason: String(markError),
            }),
          );
        }
      }
      // Said out loud, with the routine in it: a pass that swallowed this would look clean while
      // one routine was switched off, or failed to be.
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

  /*
   * THE REAPER, before any firing is considered. It closes the run rows nothing in the system will
   * ever come back for: a server that died mid-turn (the queue item was finished on the 202, so no
   * retry returns for that row), and the rows opened by dispatch attempts that threw (the loop below
   * deliberately does not close those itself — see the comment at the dispatch). Without it those
   * rows read "running now" on the routines page for ever. Age-scoped rather than identity-scoped,
   * because age is the one signal that distinguishes an abandoned row from a turn some server is
   * still running; the cutoff sits above the turn timeout so a live turn always finishes its own row
   * first. Best-effort with its own catch, because a reaper that cannot run must not stop this pass
   * from firing what is due.
   */
  try {
    const reaped = await options.routineStore.reapAbandonedRuns(
      ABANDONED_RUN_MS,
      "the server never finished this run; it may have restarted mid-turn, or the run may never have been dispatched",
    );
    if (reaped > 0) {
      console.warn(JSON.stringify({ type: "routine-runs-reaped", reaped }));
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "routine-run-reap-failed",
        reason: String(error),
      }),
    );
  }

  for (const item of claimed) {
    // The offer above is the only writer of these items and always names the routine in the
    // payload; the key is the last-resort stand-in for a row written by hand, the culler's idiom.
    const routineId = String(item.payload.routineId ?? item.key);

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
      /*
       * A dispatch that throws leaves the row this attempt opened with no status, AND NOTHING HERE
       * CLOSES IT — the reaper above does, once the row is older than any turn could still be
       * running. That restraint is deliberate: a dispatch that timed out is not a dispatch that
       * failed, because the abort tears down the sweep's side of the call while the server may
       * already have accepted it and detached the turn — a turn that will come back minutes later
       * and finish this very row. `finishRun` finishes once, so closing the row now would turn that
       * turn's real outcome into a silent no-op; the earlier shape of this cleanup ("close every
       * open run of the routine at the give-up") mislabelled exactly such in-flight runs as failed.
       * Age is the only signal the sweep has that no server is coming back for a row, so age is the
       * scope the closing uses.
       */
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
        // The run rows the attempts opened are NOT closed here: one of them may be a turn a wedged
        // server accepted after the dispatch timed out, and only age can tell (see the comment at
        // the dispatch). The reaper closes them on a later pass; this branch only has to say so.
        console.warn(
          JSON.stringify({
            type: "routine-fire-gave-up",
            routineId,
            key: item.key,
            attempts: item.attempts,
            reason,
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
