/**
 * Claiming durable work, so several replicas can share it without a coordinator.
 *
 * `select ... for update skip locked` inside a transaction: each replica takes rows nobody else
 * holds and never waits behind another's. No leader election, no single point of failure, and a
 * replica added is throughput added rather than contention added.
 *
 * A claim carries a lease. While the work runs its owner renews; one that stops being renewed is
 * free again the moment anything looks, so recovery needs no process to notice a death, only the
 * next claim to read the clock.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { workItems } from "../db/schema";

export type WorkItem = {
  kind: string;
  key: string;
  payload: Record<string, unknown>;
  /**
   * How many times this has been handed out, including now.
   *
   * ONE MEANS IT HAS CERTAINLY NOT RUN. More than one means a previous owner stopped renewing, and
   * may already have called a tool or spent money before it did. A caller that cannot tell those
   * apart cannot safely retry anything with an outside effect, so this is a number rather than a
   * state folded into failure.
   */
  attempts: number;
};

export type WorkQueue = {
  /** Put work on the queue, or leave what is there. Idempotent on (kind, key). */
  offer: (item: {
    kind: string;
    key: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
  }) => Promise<void>;
  /** Take up to `limit` due items, leased to `owner`. */
  claim: (input: {
    kind: string;
    owner: string;
    leaseMs: number;
    limit?: number;
  }) => Promise<WorkItem[]>;
  /** Keep a claim alive while the work runs. False means it was already taken away. */
  renew: (input: {
    kind: string;
    key: string;
    owner: string;
    leaseMs: number;
  }) => Promise<boolean>;
  /** Done. The row goes, so the same key can be offered again later. */
  finish: (input: { kind: string; key: string }) => Promise<void>;
  /** Not done, and worth another go after `delayMs`. */
  release: (input: {
    kind: string;
    key: string;
    delayMs: number;
  }) => Promise<void>;
};

export function createWorkQueue(database: Database): WorkQueue {
  return {
    async offer({ kind, key, payload = {}, runAt }) {
      await database
        .insert(workItems)
        .values({ kind, key, payload, ...(runAt ? { runAt } : {}) })
        /*
         * Nothing on conflict, deliberately.
         *
         * The key is the identity of the work, so a second offer of the same thing is the same
         * thing, not a new one. For a routine the key carries the minute it was due, which is what
         * makes "three replicas woke at 07:00" produce one run instead of three.
         */
        .onConflictDoNothing();
    },

    async claim({ kind, owner, leaseMs, limit = 1 }) {
      return database.transaction(async (transaction) => {
        /*
         * `skip locked` is what makes this concurrent rather than merely correct. Without it a
         * second replica blocks on the first replica's rows and the queue serialises; with it, it
         * walks past them and takes the next free ones.
         */
        const due = await transaction.execute(sql`
          select "kind", "key"
          from "work_items"
          where "kind" = ${kind}
            and "run_at" <= now()
            and ("lease_until" is null or "lease_until" <= now())
          order by "run_at" asc
          limit ${limit}
          for update skip locked
        `);

        const rows = (
          Array.isArray(due) ? due : ((due as { rows?: unknown[] })?.rows ?? [])
        ) as {
          kind: string;
          key: string;
        }[];
        if (rows.length === 0) return [];

        const claimed: WorkItem[] = [];
        for (const row of rows) {
          const [updated] = await transaction
            .update(workItems)
            .set({
              claimedBy: owner,
              leaseUntil: new Date(Date.now() + leaseMs),
              attempts: sql`${workItems.attempts} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(eq(workItems.kind, row.kind), eq(workItems.key, row.key)),
            )
            .returning({
              kind: workItems.kind,
              key: workItems.key,
              payload: workItems.payload,
              attempts: workItems.attempts,
            });
          if (updated) {
            claimed.push({
              kind: updated.kind,
              key: updated.key,
              payload: (updated.payload ?? {}) as Record<string, unknown>,
              attempts: updated.attempts,
            });
          }
        }
        return claimed;
      });
    },

    async renew({ kind, key, owner, leaseMs }) {
      const [renewed] = await database
        .update(workItems)
        .set({
          leaseUntil: new Date(Date.now() + leaseMs),
          updatedAt: new Date(),
        })
        /*
         * Only while still ours. A lease that expired and was taken by somebody else must not be
         * renewed back out from under them, which would put two replicas on one item believing they
         * each held it.
         */
        .where(
          and(
            eq(workItems.kind, kind),
            eq(workItems.key, key),
            eq(workItems.claimedBy, owner),
          ),
        )
        .returning({ key: workItems.key });
      return Boolean(renewed);
    },

    async finish({ kind, key }) {
      await database
        .delete(workItems)
        .where(and(eq(workItems.kind, kind), eq(workItems.key, key)));
    },

    async release({ kind, key, delayMs }) {
      // Freed and pushed out, rather than deleted: the work still wants doing, just not immediately
      // and not by whoever just gave up on it.
      await database
        .update(workItems)
        .set({
          claimedBy: null,
          leaseUntil: null,
          runAt: new Date(Date.now() + delayMs),
          updatedAt: new Date(),
        })
        .where(and(eq(workItems.kind, kind), eq(workItems.key, key)));
    },
  };
}
