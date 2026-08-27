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
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../server/src/db/client";
import { createRoutineStore } from "../../server/src/routines/store";
import {
  ROUTINE_FIRE_KIND,
  dispatchClaimedRoutines,
  offerDueRoutines,
  type RoutineSweepOptions,
} from "../../server/src/routines/sweep";
import { createWorkQueue } from "../../server/src/work/queue";
import { workerStatus } from "./status";

console.info(`OpenBot worker status: ${workerStatus().status}`);

/*
 * Refused up front, for the reason `fire-routines.ts` refuses up front: a loop that started anyway
 * would open a run row for every routine it offers itself and collect a 401 on every dispatch,
 * forever, with the only evidence a line in the server's audit trail. Said once, loudly, before the
 * first tick, is the difference between a worker that failed to start and a deployment where
 * routines quietly do nothing.
 */
const workerSharedSecret = process.env.WORKER_SHARED_SECRET;
if (!workerSharedSecret) {
  throw new Error(
    "WORKER_SHARED_SECRET is not set, so this worker cannot authenticate itself to /internal/routines/run and no routine could be fired.",
  );
}

/*
 * Read from the environment rather than from `DeploymentConfig`/`loadConfig`, and deliberately so.
 *
 * `loadConfig` demands the whole server deployment's configuration — Intelligence credentials, key
 * encryption, auth — because it answers "what can this deployment do". This process is handed exactly
 * three settings by `scripts/start.sh` (`DATABASE_URL`, `SERVER_INTERNAL_URL`,
 * `WORKER_SHARED_SECRET`); calling `loadConfig(process.env)` here would refuse to start over
 * settings this loop has no opinion about and does not need. Where this process can reach its own API
 * server is a fact about where this process runs, same as `fire-routines.ts` argues for
 * `SERVER_INTERNAL_URL` alone — this file extends that reasoning to the secret and the database too.
 */
const serverInternalUrl = process.env.SERVER_INTERNAL_URL;
if (!serverInternalUrl) {
  throw new Error(
    "SERVER_INTERNAL_URL is not set, so this worker does not know where to hand a routine run.",
  );
}

/*
 * Refused for the same reason as the two checks above: a loop that started anyway would hand
 * `createDatabase` an empty connection string and fail on the first query with no indication of
 * what was actually missing.
 */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set, so this worker has no database to read routines from or claim them in.",
  );
}

const database = createDatabase(databaseUrl);
const queue = createWorkQueue(database);
const routineStore = createRoutineStore(database);

// A name for the lease, so a stuck claim can be traced back to the process that took it. Mirrors
// `fire-routines.ts`: `HOSTNAME` is not set by bash, so without the random fallback every worker
// started by `scripts/start.sh` would share the owner "routines/laptop" and `ours()` could no
// longer tell one worker's lease apart from another's.
const owner = `routines/${process.env.HOSTNAME ?? randomUUID().slice(0, 8)}`;

/**
 * Hand one opened run to the server, which owns everything about running it.
 *
 * Identical to `fire-routines.ts`'s `dispatch`: the run id is all that crosses, the header string
 * (casing and the one space included) is the whole credential the server compares, and anything but
 * a 202 throws — naming the status, because that is the whole diagnosis a person reading
 * `last_error` needs.
 */
async function dispatch(routineRunId: string): Promise<void> {
  const response = await fetch(`${serverInternalUrl}/internal/routines/run`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${workerSharedSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ routineRunId }),
    // The `for(;;)` loop below has no CronJob around it at all, so nothing bounds this call from
    // outside the process the way `activeDeadlineSeconds` bounds the CronJob's job; a wedged server
    // must not stall the only thing firing routines.
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 202) {
    throw new Error(
      `the server answered ${response.status} rather than 202 when handed a routine run`,
    );
  }
}

const options: RoutineSweepOptions = { routineStore, queue, dispatch, owner };

/** How often both sweep phases run. A laptop's clock, standing in for the CronJob's schedule. */
const TICK_MS = 30_000;

/*
 * How often the queue is purged of finished (and wedged) `routine.fire` items, in ticks rather than
 * milliseconds, so the two cadences cannot drift apart by editing one constant and not the other.
 *
 * Once every 120 ticks — roughly hourly at a 30-second tick — not once a tick. `queue.purge` deletes
 * rows older than the 24-hour window it is given below; running that DELETE every 30 seconds is three
 * orders of magnitude more query load than the window needs, for a retention job whose whole job is
 * to keep a day's worth of history. Hourly still purges comfortably inside the 24h window, with
 * enormous room to spare if a tick is ever missed.
 */
const PURGE_EVERY_N_TICKS = 120;
const PURGE_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let tick = 0;

async function runOneTick(): Promise<void> {
  tick += 1;

  /*
   * Both sweep phases, in one try/catch: this is the phase that runs every tick, and the one
   * `fire-routines.ts` lets throw. Here it does not — it is logged and the loop moves on to the next
   * tick 30 seconds later, per the file header above. A routine due right now that was missed by a
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
  if (tick === 1 || tick % PURGE_EVERY_N_TICKS === 0) {
    try {
      const purged = await queue.purge({
        kind: ROUTINE_FIRE_KIND,
        olderThanMs: PURGE_OLDER_THAN_MS,
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
  // Loop for ever, one tick every TICK_MS, awaiting each tick fully before scheduling the next so two
  // ticks are never in flight at once.
  for (;;) {
    await runOneTick();
    await sleep(TICK_MS);
  }
}

void main();
