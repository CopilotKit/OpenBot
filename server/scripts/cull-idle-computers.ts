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
  console.info(
    JSON.stringify({
      type: "computer-cull",
      offered,
      suspended: report.suspended,
      skipped: report.skipped,
    }),
  );
} finally {
  await database.$client.end({ timeout: 5 });
}
