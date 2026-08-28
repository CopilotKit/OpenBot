/**
 * One sweep: notice which computers have gone idle, and suspend whatever this pod can claim.
 *
 * Run from a CronJob rather than from a timer inside the API. Every replica would fire its own timer
 * and each would decide, independently, to suspend the same computer. Deleting old audit rows twice
 * is harmless, which is why the retention sweep may work that way; taking a browser away from
 * somebody who has just come back is not.
 *
 * Exits non-zero only when the sweep itself could not run. A computer that refused to suspend is
 * reported and left for the next sweep, because a computer still running costs money rather than
 * losing anything, and a failing CronJob that pages somebody at 3am should mean something worse.
 */
import { randomUUID } from "node:crypto";
import { createComputerProvider } from "../src/computer/provider";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  CULL_KIND,
  offerIdleComputers,
  suspendClaimedComputers,
} from "../src/work/culler";
import { createWorkQueue } from "../src/work/queue";

const config = loadConfig(process.env);
if (!config.computer) {
  throw new Error(
    "No computer provider is configured, so there are no computers to suspend.",
  );
}
if (config.computer.provider !== "sandbox") {
  throw new Error(
    `The culler only has something to do where each Bot has its own computer, and this deployment uses the "${config.computer.provider}" provider.`,
  );
}

const database = createDatabase(config.databaseUrl);
const queue = createWorkQueue(database);
const provider = createComputerProvider(config.computer);

// A name for the lease, so a stuck claim can be traced back to the pod that took it.
const owner = `culler/${process.env.HOSTNAME ?? randomUUID().slice(0, 8)}`;

try {
  const options = {
    database,
    queue,
    provider,
    idleAfterMs: config.computer.idleAfterMs,
    owner,
  };
  const { offered } = await offerIdleComputers(options);
  const report = await suspendClaimedComputers(options);
  /*
   * Sweep what has been done for a day.
   *
   * A finished row is what stops the same key being run twice, so it has to outlive the run by long
   * enough for any late replica to collide with it. It does not have to outlive that by a week: a
   * queue is not an archive, and the audit trail is where "what happened" lives.
   */
  const purged = await queue.purge({
    kind: CULL_KIND,
    olderThanMs: 24 * 60 * 60 * 1000,
    /*
     * A FINISHED SUSPENSION IS KEPT FOR THE IDLE WINDOW, NOT FOR A DAY.
     *
     * The key is the Bot id, so the row left behind by a suspension is what the next one collides
     * with: a computer resumed, used, and left alone again was offered every sweep and swallowed
     * every time, and stayed awake until the row aged out a day later. Nobody saw it, because a
     * sweep that offers work and suspends nothing looks exactly like a fleet that is busy.
     *
     * The idle window is the right length because it is the same clock the offer runs on: a Bot
     * cannot qualify as idle again until this long after its last action, by which point its row has
     * gone. A day is still right for the other half, where the window is the backoff before a
     * suspension that keeps failing is tried again.
     */
    finishedOlderThanMs: config.computer.idleAfterMs,
  });
  console.info(
    JSON.stringify({
      type: "computer-cull",
      offered,
      suspended: report.suspended,
      skipped: report.skipped,
      purged,
    }),
  );
} finally {
  await database.$client.end({ timeout: 5 });
}
