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
 *
 * WHOSE CLOCK. The database's, everywhere, and this is the load-bearing part. Leases used to be
 * computed as `Date.now() + leaseMs` on the replica and compared against `now()` in Postgres, which
 * is two clocks pretending to be one: a node ninety seconds behind wrote a sixty-second lease that
 * Postgres considered expired on arrival, and the next replica to look took the item straight out
 * from under the first. Both then ran it. Every time this file names a moment it names it in SQL.
 */
import { and, eq, gte, isNull, like, lt, or, sql } from "drizzle-orm";
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

/**
 * How many times one item may be handed out before it stops being offered.
 *
 * Without a cap a permanently failing item is retried until somebody notices, which on a queue with
 * no dashboard is never. At the cap it stops being claimed and stays in the table with its count and
 * its last error, which is a terminal state a person can query rather than a silence.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

export type WorkQueue = {
  /**
   * Put work on the queue, or leave what is there. Idempotent on (kind, key).
   *
   * `"queued"` is new work. `"already"` is the same key again — the caller asked for this work to be
   * queued and it is, but it is NOT a second piece of work, and a caller that reports it as one is
   * announcing something that will not happen. `"refused"` is `atMost` saying no.
   *
   * Three answers rather than a boolean because two of them used to be true: a hop offered under a
   * key that already existed was reported to the model as handed over, while the row it named had
   * long since been delivered and finished. Nothing was queued and nobody was ever going to run it.
   */
  offer: (item: {
    kind: string;
    key: string;
    payload?: Record<string, unknown>;
    runAt?: Date;
    /**
     * Refuse this if the prefix is already that full.
     *
     * COUNTED AND WRITTEN AS ONE STEP, which is the whole reason it lives here rather than in the
     * caller. Counting first and offering second is a cap that holds only while nothing else is
     * offering: a model that emits five tool calls in one turn runs all five at once, each reads a
     * count taken before any of the others had written, and all five pass a cap of three. The
     * failure needs no cluster and no unusual timing; it is what asking for several things at once
     * looks like.
     */
    atMost?: { keyPrefix: string; max: number };
  }) => Promise<"queued" | "already" | "refused">;
  /** Take up to `limit` due items, leased to `owner`. */
  claim: (input: {
    kind: string;
    owner: string;
    leaseMs: number;
    limit?: number;
    maxAttempts?: number;
  }) => Promise<WorkItem[]>;
  /** Keep a claim alive while the work runs. False means it was already taken away. */
  renew: (input: {
    kind: string;
    key: string;
    owner: string;
    leaseMs: number;
  }) => Promise<boolean>;
  /**
   * Done. False means the lease had already gone to somebody else, so this was not ours to finish.
   */
  finish: (input: {
    kind: string;
    key: string;
    owner: string;
  }) => Promise<boolean>;
  /** Not done, and worth another go after `delayMs`. False means it was no longer ours. */
  release: (input: {
    kind: string;
    key: string;
    owner: string;
    delayMs: number;
    reason?: string;
  }) => Promise<boolean>;
  /**
   * Drop what is done with, older than the retention window. Returns how many went.
   *
   * Both kinds of done: finished, and given up on. An item at its attempt cap is not finished and was
   * reaped by nothing, so its key stayed occupied for ever and the work could never be offered again.
   *
   * TWO KINDS OF DONE, TWO WINDOWS. They are the same length only by coincidence. A finished row is
   * kept so a late offer of the same key collides with it, which needs to outlast a sweep; a row that
   * gave up is kept because the window is also the backoff before anything tries again, which wants
   * to be long. Kept as one number, a queue whose work repeats has to choose which of those to be
   * wrong about. `finishedOlderThanMs` defaults to `olderThanMs`, so a caller that has only one
   * answer keeps the behaviour it had.
   */
  purge: (input: {
    kind: string;
    olderThanMs: number;
    finishedOlderThanMs?: number;
    maxAttempts?: number;
  }) => Promise<number>;
};

/**
 * A literal prefix, safe to put in a `like`.
 *
 * `%` and `_` are wildcards there, and a key is allowed to contain both. Without this a run whose id
 * held an underscore would count rows belonging to other runs, and a fan-out cap that counts the
 * wrong rows is a cap that refuses the wrong hops.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** A moment `ms` from now, named in SQL so it is the database's clock and not the caller's. */
function fromNow(ms: number) {
  return sql`now() + make_interval(secs => ${ms / 1000})`;
}

export function createWorkQueue(database: Database): WorkQueue {
  /**
   * Still ours, and still wanting doing.
   *
   * `finish` and `release` used to match on the key alone, so a replica whose lease had quietly
   * expired could delete or reschedule an item another replica was in the middle of executing. Only
   * `renew` got this right; all three ask the same question now.
   */
  const ours = (kind: string, key: string, owner: string) =>
    and(
      eq(workItems.kind, kind),
      eq(workItems.key, key),
      eq(workItems.claimedBy, owner),
      isNull(workItems.finishedAt),
    );

  return {
    async offer({ kind, key, payload = {}, runAt, atMost }) {
      const write = async (transaction: Database) =>
        transaction
          .insert(workItems)
          .values({ kind, key, payload, ...(runAt ? { runAt } : {}) })
          /*
           * Nothing on conflict, deliberately.
           *
           * The key is the identity of the work, so a second offer of the same thing is the same
           * thing, not a new one. For a routine the key carries the minute it was due, which is what
           * makes "three replicas woke at 07:00" produce one run instead of three. A finished row
           * still counts as a conflict, which is what makes that true after the run as well as during
           * it.
           */
          .onConflictDoNothing()
          // Returning the key, so a caller can tell work it just queued from work that was already
          // there. Nothing is written on conflict, so this comes back empty for a duplicate.
          .returning({ key: workItems.key });

      if (!atMost) {
        const [written] = await write(database);
        return written ? "queued" : "already";
      }

      return database.transaction(async (transaction) => {
        /*
         * Everything offered under this prefix, one at a time, across every replica.
         *
         * An advisory lock rather than a stricter isolation level, because the thing being counted
         * is rows another transaction has not committed yet: under `read committed` two concurrent
         * offers each see a count taken before the other wrote, and both pass. The lock is held for
         * the transaction and taken on the prefix, so it serialises one run's own hops and nothing
         * else on the queue waits behind them.
         */
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`${kind}:${atMost.keyPrefix}`}))`,
        );
        const [row] = await transaction
          .select({ total: sql<number>`count(*)::int` })
          .from(workItems)
          .where(
            and(
              eq(workItems.kind, kind),
              like(workItems.key, `${escapeLike(atMost.keyPrefix)}%`),
            ),
          );
        /*
         * The same key again is not a new one. Counted as already there rather than refused, or a
         * retried offer of work that is on the queue would report the cap as the reason it is not.
         */
        const already = await transaction
          .select({ key: workItems.key })
          .from(workItems)
          .where(and(eq(workItems.kind, kind), eq(workItems.key, key)))
          .limit(1);
        if (already.length > 0) return "already";
        if ((row?.total ?? 0) >= atMost.max) return "refused";
        const [written] = await write(transaction as unknown as Database);
        return written ? "queued" : "already";
      });
    },

    async claim({
      kind,
      owner,
      leaseMs,
      limit = 1,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
    }) {
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
            and "finished_at" is null
            and "attempts" < ${maxAttempts}
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
              leaseUntil: fromNow(leaseMs),
              attempts: sql`${workItems.attempts} + 1`,
              updatedAt: sql`now()`,
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
        .set({ leaseUntil: fromNow(leaseMs), updatedAt: sql`now()` })
        /*
         * Only while still ours. A lease that expired and was taken by somebody else must not be
         * renewed back out from under them, which would put two replicas on one item believing they
         * each held it.
         */
        .where(ours(kind, key, owner))
        .returning({ key: workItems.key });
      return Boolean(renewed);
    },

    async finish({ kind, key, owner }) {
      const [finished] = await database
        .update(workItems)
        /*
         * Marked, not deleted. The row is what a later offer of the same key collides with, and
         * deleting it handed that key back to anybody who re-offered it: the recovery path was also
         * a duplicate-run path. Swept later by `purge`.
         */
        .set({
          finishedAt: sql`now()`,
          claimedBy: null,
          leaseUntil: null,
          updatedAt: sql`now()`,
        })
        .where(ours(kind, key, owner))
        .returning({ key: workItems.key });
      return Boolean(finished);
    },

    async release({ kind, key, owner, delayMs, reason }) {
      // Freed and pushed out, rather than finished: the work still wants doing, just not immediately
      // and not by whoever just gave up on it. The reason stays on the row so an item that runs out
      // of attempts says why rather than simply stopping.
      const [released] = await database
        .update(workItems)
        .set({
          claimedBy: null,
          leaseUntil: null,
          runAt: fromNow(delayMs),
          updatedAt: sql`now()`,
          ...(reason === undefined ? {} : { lastError: reason }),
        })
        .where(ours(kind, key, owner))
        .returning({ key: workItems.key });
      return Boolean(released);
    },

    async purge({
      kind,
      olderThanMs,
      finishedOlderThanMs = olderThanMs,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
    }) {
      const cutoff = fromNow(-olderThanMs);
      const finishedCutoff = fromNow(-finishedOlderThanMs);
      const gone = await database
        .delete(workItems)
        .where(
          and(
            eq(workItems.kind, kind),
            or(
              lt(workItems.finishedAt, finishedCutoff),
              /*
               * AND THE ONES THAT GAVE UP, which is the half this forgot.
               *
               * An item at its attempt cap is not finished, so it was reaped by nothing: `claim`
               * skipped it, `purge` did not match it, and `offer` cannot replace a row that is still
               * there. Its key was wedged for good. The culler keys on the Bot id, so five failed
               * suspends meant that Bot never scaled to zero again, silently and for ever.
               *
               * Reaped on the same window rather than kept, because the window is also how long it
               * waits before anything tries again: whatever was broken has had a day to be fixed,
               * and the next sweep offers the work afresh. The audit trail is where "this failed"
               * lives; this table is what still wants doing.
               */
              and(
                gte(workItems.attempts, maxAttempts),
                lt(workItems.updatedAt, cutoff),
              ),
            ),
          ),
        )
        .returning({ key: workItems.key });
      return gone.length;
    },
  };
}
