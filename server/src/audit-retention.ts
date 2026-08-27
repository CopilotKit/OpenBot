/**
 * How long this deployment keeps its audit trail.
 *
 * Every click, keystroke, scroll, tool call, refusal, command and sign-in is a row, so the trail
 * becomes the largest table in the deployment within weeks of real use and nothing in the product
 * ever removed one. That is two problems wearing one hat. The table outgrows its disk, and an
 * enterprise buyer asking "what is your retention policy" had no answer to be given: the honest one
 * was "we keep everything forever and you cannot express anything else".
 *
 * Off unless configured. Deleting somebody's audit trail because a default said so is the worse
 * failure of the two, and a deployment that has not thought about retention should keep everything
 * until it has.
 *
 * The trail stays append-only. The database refuses every delete unless the transaction declares a
 * retention window, and refuses any row inside that window whatever it is set to, so "we removed the
 * rows about the incident" is still impossible and an UPDATE still is under every condition. See
 * migration 0007.
 *
 * One server sweeps, not all of them, decided by a Postgres advisory lock. Without it, N servers run
 * the same delete over the same rows every hour: N times the work for one outcome, on the one table
 * every action writes to.
 */
import postgres from "postgres";
import {
  FRAME_RETENTION_MS,
  type PageFrameStore,
} from "./computer/page-frames";

/**
 * The advisory lock this takes, as an arbitrary but fixed number.
 *
 * Session-scoped, on a connection this module owns for the length of the sweep. It cannot go through
 * the shared pool: a session lock belongs to one connection, so a pool would happily take it on one
 * and try to release it on another, and the lock would leak until that connection died.
 */
const SWEEP_LOCK = 4_192_004;

/**
 * How many rows one delete removes.
 *
 * Batched because the alternative is a single statement holding locks on millions of rows on the
 * table every action writes to. A deployment that has never swept has years to remove and should not
 * take its own audit trail offline doing it.
 */
const BATCH = 5_000;

/** How many batches one sweep runs before leaving the rest for the next one. */
const MAX_BATCHES = 200;

export type RetentionResult = {
  /** Null when another server was already sweeping. Distinguished from having deleted nothing. */
  deleted: number | null;
};

/**
 * Remove audit rows older than the retention window.
 *
 * Returns what it did so a caller can log it. Its own connection, released whatever happens.
 */
export async function sweepAuditTrail(
  databaseUrl: string,
  retentionDays: number,
): Promise<RetentionResult> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    return { deleted: null };
  }

  const connection = postgres(databaseUrl, { max: 1 });

  try {
    const [lock] = await connection`
      select pg_try_advisory_lock(${SWEEP_LOCK}) as held
    `;
    if (!lock?.held) return { deleted: null };

    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await connection.begin(async (tx) => {
        /*
         * Declared to the trigger, transaction-locally.
         *
         * Retention is the one narrow exception to an append-only table and it has to say so. `true`
         * makes the setting local to this transaction, so the permission cannot outlive the
         * statement that asked for it.
         */
        await tx`select set_config('openbot.audit_retention_days', ${String(retentionDays)}, true)`;

        /*
         * `ctid` rather than a plain `delete ... where created_at <`.
         *
         * The subquery picks a bounded set using the `created_at` index and the delete removes
         * exactly those, so each statement is short and the table stays writable between them.
         */
        return await tx`
          delete from audit_events where ctid in (
            select ctid from audit_events
            where created_at < now() - (${retentionDays} || ' days')::interval
            limit ${BATCH}
          )
        `;
      });

      const count = removed.count ?? 0;
      deleted += count;
      if (count < BATCH) break;
    }

    return { deleted };
  } finally {
    // Ending the connection releases the lock with it, so a sweep that threw halfway does not leave
    // the lock held and every later sweep skipped.
    await connection.end({ timeout: 5 }).catch(() => undefined);
  }
}

export type RetentionSweeper = { stop: () => void };

/**
 * Sweep on an interval, starting shortly after boot.
 *
 * Not immediately at boot: a deployment rolling several servers would have all of them contend for
 * the lock in the same second, and the one that wins would compete with start-up for the database.
 */
export function startRetentionSweeps(
  databaseUrl: string,
  retentionDays: number | undefined,
  // Swept whatever the audit policy is: their only other caller runs in `computers.mode: sandbox` alone.
  pageFrames?: PageFrameStore,
  options: { intervalMs?: number; firstRunMs?: number } = {},
): RetentionSweeper {
  const sweepsAudit = Boolean(retentionDays && retentionDays >= 1);
  if (!sweepsAudit && !pageFrames) return { stop: () => undefined };

  const intervalMs = options.intervalMs ?? 60 * 60_000;
  const firstRunMs = options.firstRunMs ?? 60_000;
  const timers: ReturnType<typeof setInterval>[] = [];

  const run = () => {
    if (pageFrames) {
      void pageFrames
        .purge(FRAME_RETENTION_MS)
        .then((removed) => {
          if (removed === 0) return;
          console.info(JSON.stringify({ type: "page-frames-swept", removed }));
        })
        .catch((error) => {
          console.error(
            JSON.stringify({
              type: "page-frames-sweep-failed",
              note: "Old turn screenshots were not removed. Nothing is broken; the table is larger than it should be.",
              error: String(error),
            }),
          );
        });
    }
    if (!sweepsAudit || !retentionDays) return;
    void sweepAuditTrail(databaseUrl, retentionDays)
      .then(({ deleted }) => {
        if (deleted === null || deleted === 0) return;
        console.info(
          JSON.stringify({
            type: "audit-retention-swept",
            deleted,
            retentionDays,
          }),
        );
      })
      .catch((error) => {
        console.error(
          JSON.stringify({
            type: "audit-retention-failed",
            note: "Old audit rows were not removed. The trail is intact; it is only larger than the policy asks for.",
            error: String(error),
          }),
        );
      });
  };

  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    // Housekeeping should not hold the process open.
    repeating.unref?.();
    timers.push(repeating);
  }, firstRunMs);
  first.unref?.();

  return {
    stop: () => {
      clearTimeout(first);
      for (const timer of timers) clearInterval(timer);
    },
  };
}
