/**
 * Carrying `audit_outbox` to Intelligence.
 *
 * IN ORDER, IN BATCHES, DELETED ONLY ONCE STORED. A pass reads the oldest rows by `seq`, up to 500 and
 * a few megabytes, sends each kind as one batch, and deletes a row only after Intelligence has said it
 * holds that row's id. A pass that dies between the send and the delete sends the batch again next
 * time, which Intelligence stores once: the ids were chosen when the rows were written.
 *
 * ONE REPLICA AT A TIME, WITH NO HELD TRANSACTION. Passes take the named lock in `local_locks`
 * (`work/local-lock.ts`) and renew it after every batch; a replica that dies holding it frees it when
 * it expires. Two drainers that did overlap would still lose and duplicate nothing: both sends are the
 * same ids, and a delete by `seq` that finds the row gone deletes nothing.
 *
 * WHEN. Woken shortly after every write in this process, on an interval for writes another replica
 * made, and on demand (`flush`) before a read, so a person sees what they just did. While Intelligence
 * cannot be reached it backs off, up to a minute, and says so on every attempt with the size of the
 * backlog: nothing is lost while it waits, but nothing reaches the trail either, and that has to be
 * visible.
 *
 * A ROW INTELLIGENCE REFUSES. A batch refused as invalid is split until the refused row is alone; that
 * row is kept with `refused_at` and the reason, said loudly, and not sent again. Everything else goes.
 */
import { asc, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditOutbox } from "../db/schema";
import {
  extendLocalLock,
  releaseLocalLock,
  tryLocalLock,
} from "../work/local-lock";
import {
  type AuditTrailClient,
  AuditTrailClientError,
  type RecordKind,
} from "./client";
import { onOutboxWritten } from "./outbox";

/** The lock every replica's drainer takes. */
export const AUDIT_DRAIN_LOCK = "audit-outbox-drain";

/** Most records one batch carries, as Intelligence takes them. */
export const AUDIT_DRAIN_BATCH = 500;

/** Most bytes one batch carries. Intelligence takes 8 MB; half leaves room for the envelope. */
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

/** Refusal codes that mean this row, as written, can never be stored. */
const ROW_REFUSALS = new Set([
  "AUDIT_VALIDATION_ERROR",
  "MODEL_USAGE_VALIDATION_ERROR",
]);

export type DrainResult = {
  delivered: number;
  refused: number;
  /** Another replica held the lock, so this pass did nothing. */
  busy: boolean;
};

export type AuditDrainer = {
  /** Drain on writes and on the interval, until `stop`. */
  start: () => void;
  stop: () => Promise<void>;
  /** A write happened: drain soon. */
  nudge: () => void;
  /**
   * Drain what is in the outbox now, waiting a while for another replica's pass. Throws when
   * Intelligence cannot take it.
   */
  flush: (options?: {
    waitMs?: number;
    budgetMs?: number;
  }) => Promise<DrainResult>;
};

type OutboxRow = {
  seq: number;
  kind: RecordKind;
  id: string;
  occurredAt: string;
  record: Record<string, unknown>;
};

export function createAuditDrainer(options: {
  database: Database;
  client: AuditTrailClient;
  intervalMs?: number;
  nudgeDelayMs?: number;
  lockTtlMs?: number;
  maxBackoffMs?: number;
  batchSize?: number;
}): AuditDrainer {
  const { database, client } = options;
  const intervalMs = options.intervalMs ?? 2_000;
  const nudgeDelayMs = options.nudgeDelayMs ?? 25;
  const lockTtlMs = options.lockTtlMs ?? 30_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  const batchSize = Math.min(
    options.batchSize ?? AUDIT_DRAIN_BATCH,
    AUDIT_DRAIN_BATCH,
  );
  const holder = crypto.randomUUID();

  let tail: Promise<unknown> = Promise.resolve();
  let queued = false;
  let failures = 0;
  let retryAt = 0;
  let stopped = true;
  let interval: ReturnType<typeof setInterval> | undefined;
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  let stopHearing: (() => void) | undefined;

  /** One pass at a time in this process; the lock does the same across replicas. */
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  }

  async function readBatch(): Promise<OutboxRow[]> {
    const rows = await database
      .select({
        seq: auditOutbox.seq,
        kind: auditOutbox.kind,
        id: sql<string>`${auditOutbox.id}::text`,
        occurredAt: sql<string>`to_char(${auditOutbox.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        record: auditOutbox.record,
      })
      .from(auditOutbox)
      .where(isNull(auditOutbox.refusedAt))
      .orderBy(asc(auditOutbox.seq))
      .limit(batchSize);
    const batch: OutboxRow[] = [];
    let bytes = 0;
    for (const row of rows) {
      const size = JSON.stringify(row.record).length + 200;
      if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
      batch.push({ ...row, seq: Number(row.seq) });
      bytes += size;
    }
    return batch;
  }

  const toWire = (row: OutboxRow) => ({
    ...row.record,
    id: row.id,
    occurredAt: row.occurredAt,
  });

  async function remove(rows: OutboxRow[]) {
    await database.delete(auditOutbox).where(
      inArray(
        auditOutbox.seq,
        rows.map((row) => row.seq),
      ),
    );
  }

  /** Send one kind's rows; delete what was stored, set aside what can never be. */
  async function send(
    kind: RecordKind,
    rows: OutboxRow[],
  ): Promise<{ delivered: number; refused: number }> {
    try {
      const stored = await client.store(
        kind,
        // The record was built for this kind when it was written (`audit.ts`, `settings-store.ts`).
        rows.map(toWire) as unknown as Parameters<AuditTrailClient["store"]>[1],
      );
      if (stored !== rows.length) {
        throw new Error(
          `Intelligence holds ${stored} of the ${rows.length} ${kind} records just sent; none are removed from the outbox until it holds all of them.`,
        );
      }
      await remove(rows);
      return { delivered: rows.length, refused: 0 };
    } catch (error) {
      if (
        !(error instanceof AuditTrailClientError) ||
        !error.refused ||
        !ROW_REFUSALS.has(error.code ?? "")
      ) {
        throw error;
      }
      if (rows.length > 1) {
        const half = Math.ceil(rows.length / 2);
        const first = await send(kind, rows.slice(0, half));
        const second = await send(kind, rows.slice(half));
        return {
          delivered: first.delivered + second.delivered,
          refused: first.refused + second.refused,
        };
      }
      const [row] = rows;
      if (!row) return { delivered: 0, refused: 0 };
      await database
        .update(auditOutbox)
        .set({ refusedAt: new Date(), refusal: error.message.slice(0, 500) })
        .where(inArray(auditOutbox.seq, [row.seq]));
      console.error(
        JSON.stringify({
          type: "audit-outbox-refused",
          note: "Intelligence refused this record as invalid, so it is not in the trail. It is kept in audit_outbox with the reason and will not be sent again.",
          kind,
          id: row.id,
          seq: row.seq,
          eventType: row.record.eventType,
          error: error.message,
        }),
      );
      return { delivered: 0, refused: 1 };
    }
  }

  async function pass(waitMs: number, budgetMs: number | null) {
    const started = Date.now();
    let pauseMs = 10;
    while (
      !(await tryLocalLock(database, AUDIT_DRAIN_LOCK, holder, lockTtlMs))
    ) {
      if (Date.now() - started >= waitMs)
        return { delivered: 0, refused: 0, busy: true };
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
      pauseMs = Math.min(pauseMs * 2, 250);
    }
    const result: DrainResult = { delivered: 0, refused: 0, busy: false };
    try {
      for (;;) {
        if (budgetMs !== null && Date.now() - started > budgetMs) break;
        const rows = await readBatch();
        if (rows.length === 0) break;
        for (const kind of ["event", "action", "usage"] as const) {
          const ofKind = rows.filter((row) => row.kind === kind);
          if (ofKind.length === 0) continue;
          const sent = await send(kind, ofKind);
          result.delivered += sent.delivered;
          result.refused += sent.refused;
        }
        // Lost to another replica (this one stalled past the lock's time): stop, it carries on.
        if (
          !(await extendLocalLock(
            database,
            AUDIT_DRAIN_LOCK,
            holder,
            lockTtlMs,
          ))
        )
          break;
      }
    } finally {
      await releaseLocalLock(database, AUDIT_DRAIN_LOCK, holder).catch(
        () => undefined,
      );
    }
    return result;
  }

  async function backlog(): Promise<number | null> {
    try {
      const [row] = await database
        .select({ n: sql<number>`count(*)::int` })
        .from(auditOutbox)
        .where(isNull(auditOutbox.refusedAt));
      return row?.n ?? 0;
    } catch {
      return null;
    }
  }

  async function pending(): Promise<boolean> {
    const rows = await database
      .select({ seq: auditOutbox.seq })
      .from(auditOutbox)
      .where(isNull(auditOutbox.refusedAt))
      .limit(1);
    return rows.length > 0;
  }

  function recovered(result: DrainResult) {
    if (failures === 0 || result.busy) return;
    console.info(
      JSON.stringify({
        type: "audit-outbox-recovered",
        note: "Intelligence is taking the audit trail again; the backlog is being sent.",
        afterFailures: failures,
        delivered: result.delivered,
      }),
    );
    failures = 0;
    retryAt = 0;
  }

  async function backgroundPass() {
    if (stopped || Date.now() < retryAt) return;
    try {
      if (!(await pending())) return;
      recovered(await pass(0, null));
    } catch (error) {
      failures += 1;
      const delay = Math.min(maxBackoffMs, 1_000 * 2 ** (failures - 1));
      retryAt = Date.now() + delay;
      console.error(
        JSON.stringify({
          type: "audit-outbox-undelivered",
          note: "The audit trail could not be sent to Intelligence. Nothing is lost: it waits in audit_outbox and is sent once Intelligence answers. Until then the Admin audit page does not show it.",
          backlog: await backlog(),
          failures,
          retryInMs: delay,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  function schedule() {
    if (queued || stopped) return;
    queued = true;
    void exclusive(async () => {
      queued = false;
      await backgroundPass();
    });
  }

  function nudge() {
    if (stopped || nudgeTimer) return;
    nudgeTimer = setTimeout(() => {
      nudgeTimer = undefined;
      schedule();
    }, nudgeDelayMs);
    nudgeTimer.unref?.();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      stopHearing = onOutboxWritten(nudge);
      interval = setInterval(schedule, intervalMs);
      interval.unref?.();
      schedule();
    },
    async stop() {
      stopped = true;
      stopHearing?.();
      if (interval) clearInterval(interval);
      if (nudgeTimer) clearTimeout(nudgeTimer);
      await tail;
    },
    nudge,
    flush(flushOptions = {}) {
      return exclusive(async () => {
        // Nothing waiting means everything written before this call is already in Intelligence.
        if (!(await pending()))
          return { delivered: 0, refused: 0, busy: false };
        const result = await pass(
          flushOptions.waitMs ?? 10_000,
          flushOptions.budgetMs ?? 15_000,
        );
        recovered(result);
        return result;
      });
    },
  };
}
