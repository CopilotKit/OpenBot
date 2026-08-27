/**
 * One sweep: notice which routines are due, and fire whatever this pod can claim.
 *
 * Run from a CronJob rather than from a timer inside the API, for the reason the culler states: every
 * replica would fire its own timer and each would independently decide that the 09:00 summary is due.
 * Deleting old audit rows twice is harmless, which is why the retention sweep may work that way;
 * posting somebody's morning summary three times is not, and neither is spending three turns' worth
 * of tokens on it.
 *
 * Exits non-zero only when a phase itself could not run — no database, no secret, no server to hand a
 * run to. A single firing that failed is reported and left on the queue for the next sweep, because a
 * routine that fires a minute late has lost nothing, and a failing CronJob that pages somebody at 3am
 * should mean something worse than that.
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { createRoutineStore } from "../src/routines/store";
import {
  dispatchClaimedRoutines,
  offerDueRoutines,
  ROUTINE_FIRE_KIND,
} from "../src/routines/sweep";
import { createWorkQueue } from "../src/work/queue";

const config = loadConfig(process.env);

/*
 * Refused up front rather than at the first dispatch.
 *
 * A sweep that cannot authenticate its handoff will open a run row for every due routine and collect
 * a 401 for each one: every firing recorded as attempted, none of them carried out, and the only
 * evidence a line in the server's audit trail. Saying so once, loudly, before anything is claimed is
 * the difference between a CronJob that failed and a deployment where routines quietly do nothing.
 */
const workerSharedSecret = config.workerSharedSecret;
if (!workerSharedSecret) {
  throw new Error(
    "WORKER_SHARED_SECRET is not set, so this sweep cannot authenticate itself to /internal/routines/run and no routine could be fired.",
  );
}

/*
 * Read from the environment rather than from `DeploymentConfig`, on purpose.
 *
 * Where this process can reach its own API server is a fact about where this process runs — a pod in
 * a namespace, a laptop on localhost — not a fact about the deployment, which is what that config
 * describes. A CronJob in another namespace and a developer's shell want different values for the
 * same deployment, so it belongs to the process's environment.
 */
const serverInternalUrl = process.env.SERVER_INTERNAL_URL;
if (!serverInternalUrl) {
  throw new Error(
    "SERVER_INTERNAL_URL is not set, so this sweep does not know where to hand a routine run.",
  );
}

const database = createDatabase(config.databaseUrl);
const queue = createWorkQueue(database);
const routineStore = createRoutineStore(database);

// A name for the lease, so a stuck claim can be traced back to the pod that took it.
const owner = `routines/${process.env.HOSTNAME ?? randomUUID().slice(0, 8)}`;

/**
 * Hand one opened run to the server, which owns everything about running it.
 *
 * The run id is all that crosses: the server resolves the routine, the owner and the channel from it,
 * so nothing a caller says here can decide whose routine gets run. A 202 means accepted, not
 * finished — the run row carries the outcome — and anything else throws, which is what puts the work
 * item back on the queue for another go.
 */
async function dispatch(routineRunId: string): Promise<void> {
  const response = await fetch(`${serverInternalUrl}/internal/routines/run`, {
    method: "POST",
    headers: {
      // The whole header string is what the server compares, so the casing and the one space are the
      // credential's format rather than a style choice.
      authorization: `Bearer ${workerSharedSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ routineRunId }),
    // Mirrors worker/src/index.ts's dispatch: a wedged server must not stall the sweep, even under
    // the CronJob's own activeDeadlineSeconds.
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 202) {
    // The status is in the sentence, because it is the whole diagnosis: 401 is the secret, 404 is a
    // server with no runner mounted, 5xx is the server itself. That sentence ends up on the work
    // item's `last_error`, which is where somebody looks when a routine stopped firing.
    throw new Error(
      `the server answered ${response.status} rather than 202 when handed a routine run`,
    );
  }
}

try {
  const options = { routineStore, queue, dispatch, owner };
  /*
   * Both halves in one pass, offering first: the items this offer puts on the queue are claimable by
   * the consume below, so a routine due right now fires in this sweep rather than in the next one.
   * Neither half needs the other to have run — another replica's offer is claimed here just the same.
   */
  const { offered } = await offerDueRoutines(options);
  const report = await dispatchClaimedRoutines(options);
  /*
   * Sweep what is done with for a day. NOT OPTIONAL.
   *
   * A finished row is what stops a key being run twice, so it has to outlive the run by long enough
   * for a late replica to collide with it — and no longer, because a queue is not an archive. The
   * half that is easy to forget is the other one: an item at its attempt cap is not finished and is
   * reaped by nothing else, so without this its key stays wedged for ever and that routine can never
   * be offered for that minute again. `server/src/work/queue.ts:262-274` documents that bug at
   * length; the culler pays the same rent at `cull-idle-computers.ts:71-74`.
   */
  const purged = await queue.purge({
    kind: ROUTINE_FIRE_KIND,
    olderThanMs: 24 * 60 * 60 * 1000,
  });
  console.info(
    JSON.stringify({
      type: "routine-sweep",
      offered,
      considered: report.considered,
      fired: report.fired,
      skipped: report.skipped,
      purged,
    }),
  );
} finally {
  await database.$client.end({ timeout: 5 });
}
