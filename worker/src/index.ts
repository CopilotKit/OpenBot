/**
 * The local stand-in for the routines CronJob: `server/scripts/fire-routines.ts`, looped.
 *
 * That script runs one sweep and exits — a CronJob outside the process is what makes it recurring,
 * and a failed run is meant to page somebody. A laptop running the dev stack has no CronJob around
 * it, so this file supplies the recurrence itself, in-process, by importing the very same sweep
 * (`offerDueRoutines`, `dispatchClaimedRoutines`) and the same stores/queue construction. It never
 * spawns the script as a child process — shelling out to run it every 30 seconds would be a second,
 * divergent implementation of what a sweep is, with its own bugs to keep in sync with the first.
 *
 * WHY THIS LOOP MUST NOT DIE ON THE FIRST DB BLIP, unlike the script it wraps: `fire-routines.ts`
 * lets a phase's exception propagate so the CronJob's run is marked failed and a person is paged —
 * that is correct there, because a fresh pod is one `kubectl` restart away and paging is cheap
 * compared to routines silently going stale. This process has no restart policy watching it; it is
 * somebody's laptop, left running. A worker that exited because Postgres hiccuped for two seconds
 * would need a human to notice and restart it, which is worse than a worker that logs the failure and
 * tries again on the next tick. So every phase below gets its own try/catch, and nothing here ever
 * lets a phase's error reach the top and take the process down.
 */
import { createDatabase } from "../../server/src/db/client";
import { createRoutineStore } from "../../server/src/routines/store";
import {
  ROUTINE_FIRE_KIND,
  dispatchClaimedRoutines,
  offerDueRoutines,
  type RoutineSweepOptions,
} from "../../server/src/routines/sweep";
import { createWorkQueue } from "../../server/src/work/queue";
import { loadWorkerEnv, routineRunUrl } from "./env";
import { type FetchLike, dispatchWithRetry } from "./retry";
import { createShutdownController, interruptibleSleep } from "./shutdown";
import { workerStatus } from "./status";

console.info(`OpenBot worker status: ${workerStatus().status}`);

/*
 * The worker's settings, parsed and validated in one place (`./env`).
 *
 * Refused up front, for the reason `fire-routines.ts` refuses up front: a loop that
 * started anyway would open a run row for every routine it offers itself and collect
 * a 401 on every dispatch, forever, with the only evidence a line in the server's
 * audit trail. Said once, loudly, before the first tick, is the difference between a
 * worker that failed to start and a deployment where routines quietly do nothing.
 *
 * Read from the environment rather than from `DeploymentConfig`/`loadConfig`, and
 * deliberately so. `loadConfig` demands the whole server deployment's configuration —
 * Intelligence credentials, key encryption, auth — because it answers "what can this
 * deployment do". This process is handed its settings by `scripts/start.sh`
 * (`DATABASE_URL`, `SERVER_INTERNAL_URL`, `WORKER_SHARED_SECRET` and the optional
 * `WORKER_*` cadence knobs); calling `loadConfig(process.env)` here would refuse to
 * start over settings this loop has no opinion about and does not need.
 */
const {
  workerSharedSecret,
  serverInternalUrl,
  databaseUrl,
  owner,
  tickMs,
  purgeEveryNTicks,
  purgeOlderThanMs,
  dispatchRetries,
  dispatchTimeoutMs,
  dispatchRetryBaseMs,
} = loadWorkerEnv();

const database = createDatabase(databaseUrl);
const queue = createWorkQueue(database);
const routineStore = createRoutineStore(database);

/**
 * Hand one opened run to the server, which owns everything about running it.
 *
 * Identical to `fire-routines.ts`'s `dispatch` except for the retry: the run id is
 * all that crosses, the header string (casing and the one space included) is the
 * whole credential the server compares, and anything but a 202 throws — naming the
 * status, because that is the whole diagnosis a person reading `last_error` needs.
 * Transient answers (408/429/502/503/504) and transport failures are retried with
 * exponential backoff inside the handoff; a 400/401/404 throws immediately, because
 * repeating a handoff the deployment refused only fills the audit trail.
 */
async function dispatch(routineRunId: string): Promise<void> {
  await dispatchWithRetry(
    fetch as unknown as FetchLike,
    routineRunUrl(serverInternalUrl),
    {
      authorization: `Bearer ${workerSharedSecret}`,
      "content-type": "application/json",
    },
    JSON.stringify({ routineRunId }),
    {
      retries: dispatchRetries,
      timeoutMs: dispatchTimeoutMs,
      baseMs: dispatchRetryBaseMs,
    },
  );
}

const options: RoutineSweepOptions = { routineStore, queue, dispatch, owner };

/*
 * How often the queue is purged of finished (and wedged) `routine.fire` items, in ticks rather than
 * milliseconds, so the two cadences cannot drift apart by editing one constant and not the other.
 *
 * Every `purgeEveryNTicks` ticks — roughly hourly at the default 30-second tick — not once a tick.
 * `queue.purge` deletes rows older than the window it is given; running that DELETE every tick is
 * three orders of magnitude more query load than the window needs, for a retention job whose whole
 * job is to keep a day's worth of history. Hourly still purges comfortably inside the 24h window,
 * with enormous room to spare if a tick is ever missed. Both numbers are `WORKER_*` overrides now,
 * so a quiet laptop can sweep less often without changing what the purge keeps.
 */

const shutdown = createShutdownController();

let tick = 0;

async function runOneTick(): Promise<void> {
  tick += 1;

  /*
   * Both sweep phases, in one try/catch: this is the phase that runs every tick, and the one
   * `fire-routines.ts` lets throw. Here it does not — it is logged and the loop moves on to the next
   * tick, per the file header above. A routine due right now that was missed by a
   * failed tick is still due on the next one; nothing about being late loses it (see `DEFAULT_GRACE_MS`
   * in `../../server/src/routines/sweep.ts`).
   */
  try {
    const { offered } = await offerDueRoutines(options);
    const report = await dispatchClaimedRoutines(options);
    console.info(
      JSON.stringify({
        type: "routine-sweep",
        offered,
        considered: report.considered,
        fired: report.fired,
        skipped: report.skipped,
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "routine-sweep-tick-failed",
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // The purge phase, on its own much longer cadence and its own try/catch: a purge failure this hour
  // is worth logging and retrying next hour, not a reason to stop offering and firing routines.
  // Also on the very first tick: a laptop restarted every 40 minutes would otherwise never survive
  // to tick 120, and would never reap.
  if (tick === 1 || tick % purgeEveryNTicks === 0) {
    if (shutdown.shutdownRequested) return;
    try {
      const purged = await queue.purge({
        kind: ROUTINE_FIRE_KIND,
        olderThanMs: purgeOlderThanMs,
      });
      console.info(JSON.stringify({ type: "routine-sweep-purge", purged }));
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "routine-sweep-purge-failed",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

async function main(): Promise<void> {
  const uninstall = shutdown.install();
  try {
    // Loop until SIGTERM/SIGINT, awaiting each tick fully before scheduling the next so two
    // ticks are never in flight at once. The sleep wakes early on shutdown so the container
    // does not sit out its whole grace period after the tick already finished.
    for (;;) {
      if (shutdown.shutdownRequested) break;
      await runOneTick();
      if (shutdown.shutdownRequested) break;
      const slept = await interruptibleSleep(
        tickMs,
        () => shutdown.shutdownRequested,
      );
      if (!slept) break;
    }
    console.info(JSON.stringify({ type: "worker-shutdown-complete", tick }));
  } finally {
    uninstall();
  }
}

// Guarded so importing this module (in tests, or from another entrypoint) does not open
// a database, start sweeping, and hang the process: only the worker entrypoint loops.
if (import.meta.main) {
  void main();
}
