/**
 * The clock. Once a minute it asks every enabled routine whether its moment has come.
 *
 * A minute, not a second, because the smallest thing a routine can be scheduled for is a minute and
 * a tighter loop would only buy precision nobody asked for at the cost of a query per second for the
 * life of the process. It does mean a routine fires within a minute of its time rather than on it,
 * which is stated here rather than discovered: a schedule of "eight o'clock" is a promise about the
 * hour, not about the second.
 *
 * Three things this has to survive, none of them exceptional:
 *
 *  - Two ticks overlapping. A run that takes longer than a minute is ordinary, and the tick that
 *    lands while it is going must not start a second one. The claim is a database write with a
 *    unique index behind it, so the loser of a race is told rather than left guessing.
 *  - A routine deleted mid-run. The rows go with it, the finishing write updates nothing, and this
 *    carries on. A person deleting a routine has asked for it to be gone; the process must not
 *    disagree by failing.
 *  - A window nobody was awake for. Recorded as missed rather than run late. See schedule.ts.
 *
 * Errors are logged and swallowed at the tick boundary. One routine that cannot resolve its Bot, or
 * one database blip, must not stop every other routine in the deployment from ever running again,
 * which is what an unhandled rejection in a `setInterval` amounts to.
 */
import type { RoutineRunner } from "./runner";
import { decideScheduleAction } from "./schedule";
import type { DueCandidate, RoutineStore, RoutineTrigger } from "./store";
import { deliveryPrompt } from "./webhooks";

/** A minute. Long enough to be cheap, short enough that "eight o'clock" means eight o'clock. */
export const DEFAULT_TICK_MS = 60_000;

/**
 * How long a run may have been going before this process concludes nobody is coming back for it.
 *
 * The runner stops a run of its own accord long before this, so the only rows this can reach are
 * ones whose process is gone: killed mid-browse, rolled during a deploy, a machine that lost power.
 * Such a row keeps the one-live-run index for its routine forever, and a routine holding that index
 * never runs again by any route at all.
 *
 * An hour rather than something tighter because the cost of being wrong is asymmetric. Too long and
 * a wedged routine stays wedged for an extra half hour; too short and this deployment starts
 * declaring its own healthy long runs dead while they are still working, which would be a fault
 * invented by the thing meant to be repairing one.
 */
export const STALE_RUN_MS = 60 * 60_000;

export type SchedulerOptions = {
  store: RoutineStore;
  runner: RoutineRunner;
  tickMs?: number;
  /** How old a run must be before it is treated as abandoned. See {@link STALE_RUN_MS}. */
  staleRunMs?: number;
  /**
   * How a run's conversation is named.
   *
   * Supplied rather than generated here so an unattended run's id comes from the same namespace as
   * everything else this deployment mints and cannot be confused with another deployment's. It names
   * the conversation; it does not create or keep one. See channels/thread-identity.ts, and the note
   * on `routine_runs.thread_id` for what an unattended run does and does not leave behind.
   */
  threadIdFor: (routineId: string) => string;
  /** Said out loud, in one place, so a deployment's log has one shape for scheduler news. */
  log?: (entry: Record<string, unknown>) => void;
};

/**
 * What became of an attempt to start something.
 *
 * `busy` is not a failure and is not reported as one. A routine that is already running is the
 * correct outcome of pressing Run now twice, and of a webhook that fires while the last delivery is
 * still being worked on; the caller says so plainly rather than showing an error or, worse, starting
 * a second run.
 */
export type StartOutcome = "started" | "busy" | "unknown";

export type Scheduler = {
  /** One pass. Exported so a test can drive the clock instead of waiting for it. */
  tick: (now?: Date) => Promise<void>;
  start: () => void;
  stop: () => void;
  /** Run one routine now, on somebody's say-so. */
  runNow: (
    routineId: string,
    actor: { id: string; userId?: string },
  ) => Promise<StartOutcome>;
  /**
   * Run what a delivery asked for.
   *
   * The one place the two shapes of trigger are told apart, so the receiver does not have to know
   * about routines and the routes do not have to know about deliveries.
   */
  runFromWebhook: (work: {
    triggerId: string;
    routineId: string | null;
    agentId: string | null;
    prompt: string | null;
    ownerUserId: string;
    body: unknown;
    eventType: string | null;
  }) => Promise<boolean>;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const staleRunMs = options.staleRunMs ?? STALE_RUN_MS;
  const log = options.log ?? defaultLog;
  let timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Which prompt-carrying triggers are being worked on right now.
   *
   * These are the deliveries with no routine behind them and therefore no run row, which means the
   * unique index that serialises everything else in this file has nothing to hold. Without something
   * here, a sender retrying in a loop starts one unattended agent run per delivery, each holding a
   * model stream and driving a browser, with nothing anywhere in the product to stop it.
   *
   * In this process only, and that limit is real: two server processes sharing a database would each
   * allow one. It is still the right shape, because it is the same promise the routine-backed path
   * makes — one at a time, and a delivery that arrives while the last one is going is told so — and
   * because the alternative to an imperfect ceiling here is no ceiling at all.
   */
  const runningTriggers = new Set<string>();
  /**
   * Whether a tick is still going.
   *
   * A guard on top of the database's, not instead of it. This one stops a slow pass being overtaken
   * by the next interval inside this process; the unique index is what holds when there are two
   * processes, which is the case this flag cannot see and must not be relied on for.
   */
  let ticking = false;

  /**
   * Start the work and let it finish on its own.
   *
   * Deliberately not awaited by the tick. A routine that browses for four minutes would otherwise
   * hold the tick open and stop every other routine's window being noticed, which turns one slow
   * routine into a deployment whose schedule quietly stops working.
   */
  async function begin(
    routine: DueCandidate,
    trigger: RoutineTrigger,
    actor: { id: string; userId?: string },
    /** What to put to the Bot, when it is not simply the routine's own prompt. */
    prompt = routine.prompt,
  ): Promise<boolean> {
    const threadId = options.threadIdFor(routine.id);
    const run = await options.store.startRun({
      routineId: routine.id,
      trigger,
      threadId,
      actor,
    });
    // Somebody else has it. The ordinary outcome of two ticks overlapping, and not a failure.
    if (!run) return false;

    void (async () => {
      try {
        const outcome = await options.runner.run({
          agentId: routine.agentId,
          prompt,
          threadId,
          // The owner's authority, and nobody watching. Both facts travel to the gateway: the trail
          // names the person, and a rule can refuse the action because they are not there.
          actor: {
            id: routine.ownerUserId,
            userId: routine.ownerUserId,
            unattended: true,
          },
        });
        await options.store.finishRun({
          runId: run.id,
          routineId: routine.id,
          status: "completed",
          summary: outcome.summary,
          actor,
        });
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "The run did not finish.";
        log({
          type: "routine-run-failed",
          routine: routine.id,
          name: routine.name,
          error: reason,
        });
        // Recorded as failed rather than left running forever. A run stuck in `running` holds the
        // one-at-a-time index and the routine never fires again, so the failure has to be written
        // even when writing it is the second thing that has gone wrong.
        await options.store
          .finishRun({
            runId: run.id,
            routineId: routine.id,
            status: "failed",
            error: reason,
            actor,
          })
          .catch((writeFailure: unknown) => {
            log({
              type: "routine-run-not-recorded",
              routine: routine.id,
              error:
                writeFailure instanceof Error
                  ? writeFailure.message
                  : String(writeFailure),
              note: "The run failed and the failure could not be written down.",
            });
          });
      }
    })();
    return true;
  }

  async function tick(now: Date = new Date()): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      /*
       * Before anything is decided, because a routine wedged by a dead process is a routine this
       * pass would otherwise skip in silence for the rest of the deployment's life. Its own actor,
       * so the trail says the clock closed the row rather than naming somebody who was not there.
       */
      const reaped = await options.store.reapStaleRuns({
        startedBefore: new Date(now.getTime() - staleRunMs),
        actor: { id: "scheduler" },
      });
      if (reaped > 0) {
        log({
          type: "routine-runs-reaped",
          runs: reaped,
          note: "Runs left behind by a process that stopped. The routines they held can run again.",
        });
      }

      const candidates = await options.store.dueCandidates();
      for (const routine of candidates) {
        if (!routine.schedule) {
          // A schedule nothing can read is left alone rather than guessed at. The routine stays
          // visible on the page so its owner can fix or delete it, and nothing fires meanwhile.
          log({
            type: "routine-schedule-unreadable",
            routine: routine.id,
            name: routine.name,
          });
          continue;
        }
        // A run already in flight takes its window with it. Skipping here saves a doomed insert;
        // the index is what actually guarantees it.
        if (routine.activeRun) continue;

        const decision = decideScheduleAction(routine.schedule, {
          now,
          lastRunAt: routine.lastRunAt,
          // A routine cannot have missed a window it did not exist for. Without this every routine
          // written after its own time of day records a miss within a minute of being created.
          createdAt: routine.createdAt,
        });
        // The scheduler acts on its own behalf, so the trail says the clock did this rather than
        // attributing it to a person who was asleep. The owner is still named on every action the
        // run takes, because that is whose authority it carries.
        const actor = { id: "scheduler", userId: routine.ownerUserId };

        if (decision.action === "missed") {
          await options.store.recordMissed({
            routineId: routine.id,
            dueAt: decision.dueAt,
            actor,
          });
          continue;
        }
        if (decision.action === "run") {
          await begin(routine, "schedule", actor);
        }
      }
    } catch (error) {
      // One bad pass, not the end of the loop. The interval is still running and the next tick tries
      // again; a rejection escaping here would take the whole schedule down for the life of the
      // process and leave nothing but an unhandled-rejection line to explain it.
      log({
        type: "routine-tick-failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start: () => {
      if (timer) return;
      timer = setInterval(() => void tick(), tickMs);
      // The loop must not be the reason the process stays alive. Without this a scheduler would keep
      // a finished process from exiting, which is the sort of thing that is discovered in a
      // container that will not shut down.
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },

    runNow: async (routineId, actor) => {
      const routine = await options.store.candidate(routineId);
      // `unknown` rather than a thrown error, because the routine may simply have been deleted
      // between the page being drawn and the button being pressed, which is not an incident.
      if (!routine) return "unknown";
      return (await begin(routine, "manual", actor)) ? "started" : "busy";
    },

    runFromWebhook: async (work) => {
      const actor = { id: "webhook", userId: work.ownerUserId };

      if (work.routineId) {
        const routine = await options.store.candidate(work.routineId);
        if (!routine) return false;
        return begin(
          routine,
          "webhook",
          actor,
          deliveryPrompt(routine.prompt, work.body, work.eventType),
        );
      }

      /*
       * A trigger that carries its own prompt has no routine, so it has no run row.
       *
       * The table's foreign key is not the reason; the reason is that there is nothing for a run to
       * be a run OF. What this costs is worth naming: these deliveries have no entry in the run
       * history, so a person cannot look up what happened the way they can for a routine. What they
       * do have is the audit trail, which records the delivery and then every action the Bot takes,
       * so nothing is invisible. A trigger that needs history should name a routine.
       *
       * They are serialised all the same. One at a time per trigger, held in this process because
       * there is no row to hold it: whoever has the secret can otherwise post in a loop and start an
       * unattended agent run per delivery, and the honest description of that is a public URL that
       * spends this deployment's model budget and drives its browser as fast as it can be called.
       * The sender is told 409 rather than being ignored, so a retry means something.
       */
      if (!work.agentId || !work.prompt) return false;
      if (runningTriggers.has(work.triggerId)) return false;
      runningTriggers.add(work.triggerId);

      const threadId = options.threadIdFor(work.triggerId);
      void options.runner
        .run({
          agentId: work.agentId,
          prompt: deliveryPrompt(work.prompt, work.body, work.eventType),
          threadId,
          actor: {
            id: work.ownerUserId,
            userId: work.ownerUserId,
            unattended: true,
          },
        })
        .catch((error: unknown) => {
          log({
            type: "routine-webhook-run-failed",
            trigger: work.triggerId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        // Released however the run ended, including the ways it ended badly. A failure that left the
        // trigger marked busy would answer every later delivery with 409 for the life of the
        // process, which is the wedged routine this file works to avoid, wearing a different hat.
        .finally(() => {
          runningTriggers.delete(work.triggerId);
        });
      return true;
    },
  };
}

function defaultLog(entry: Record<string, unknown>) {
  console.error(JSON.stringify(entry));
}
