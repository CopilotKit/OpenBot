/**
 * Suspending computers nobody is using.
 *
 * A `Sandbox` has `shutdownTime`, an absolute expiry, which is not the question anybody is asking:
 * "nobody has touched this for thirty minutes" is. So this asks that one, and it has to survive the
 * replica that started it, which is why the work is claimed and leased out of PostgreSQL rather than
 * held in a timer.
 *
 * NOTHING HERE TOUCHES A BROWSER. Deciding whether a computer is idle by dialling it would wake the
 * computer, so every idle Bot anything asked about would come back up and the bill would never fall.
 * That is the known, invisible way to lose scale-to-zero: everything works, nothing ever suspends.
 * Idleness is read from the audit trail, which is a record of what a Bot did rather than a question
 * put to the thing that did it.
 */
import { and, inArray, like, sql } from "drizzle-orm";
import type { ComputerProvider } from "../computer/provider";
import type { Database } from "../db/client";
import { auditEvents } from "../db/schema";
import { DEFAULT_MAX_ATTEMPTS, type WorkQueue } from "./queue";

export const CULL_KIND = "computer.suspend";

export type CullerOptions = {
  database: Database;
  queue: WorkQueue;
  provider: ComputerProvider;
  /** A computer untouched for this long is idle. */
  idleAfterMs: number;
  /** Who this replica is, for the lease. */
  owner: string;
  leaseMs?: number;
  /** How many goes an item gets before it stops being offered. */
  maxAttempts?: number;
  now?: () => Date;
};

export type CullReport = {
  considered: number;
  suspended: string[];
  skipped: { botId: string; reason: string }[];
};

/**
 * Which Bots have a computer running, and when each was last asked to do anything.
 *
 * The audit trail is the source: every acting call writes a row before the computer is touched, so
 * "last used" is already recorded, server-side, and survives a restart. A computer that has never
 * acted has no row and reads as idle since it started, which is the answer wanted.
 */
async function lastActedAt(
  database: Database,
  botIds: string[],
): Promise<Map<string, Date>> {
  if (botIds.length === 0) return new Map();
  /*
   * The Bot is in the payload rather than in a column, so the grouping key is an expression. Written
   * through the query builder rather than as one raw string, because a list parameter has to be
   * bound as a list: handed to `= any($1)` as a JavaScript array it arrives as one opaque value and
   * the query fails rather than matching nothing, which at least says so.
   */
  const bot = sql<string>`${auditEvents.payload}->>'bot'`;
  const rows = await database
    .select({ bot, last: sql<string>`max(${auditEvents.createdAt})` })
    .from(auditEvents)
    .where(and(like(auditEvents.eventType, "computer.%"), inArray(bot, botIds)))
    .groupBy(bot);

  return new Map(
    rows
      .filter((row) => row.bot)
      .map((row) => [row.bot, new Date(row.last)] as const),
  );
}

/**
 * Offer every idle computer for suspension.
 *
 * Offering rather than suspending: the decision and the act are separated so that whichever replica
 * runs this does not have to be the one that carries it out, and so a suspension that fails halfway
 * is retried by whoever picks the item up next rather than lost with the process that noticed.
 */
export async function offerIdleComputers(
  options: CullerOptions,
): Promise<{ offered: string[] }> {
  const now = options.now?.() ?? new Date();
  const computers = await options.provider.list();
  const running = computers.filter((computer) => computer.status === "running");
  const used = await lastActedAt(
    options.database,
    running.map((computer) => computer.botId),
  );

  const offered: string[] = [];
  for (const computer of running) {
    const since =
      used.get(computer.botId) ??
      (computer.startedAt ? new Date(computer.startedAt) : undefined);
    // No row and no start time means nothing is known about it, and suspending on no evidence is
    // how somebody's session disappears mid-task. Left alone.
    if (!since) continue;
    if (now.getTime() - since.getTime() < options.idleAfterMs) continue;
    await options.queue.offer({
      kind: CULL_KIND,
      key: computer.botId,
      payload: { botId: computer.botId, idleSince: since.toISOString() },
    });
    offered.push(computer.botId);
  }
  return { offered };
}

/**
 * Carry out whatever suspensions this replica can claim.
 *
 * Re-checked at the moment of acting, because the decision was made by another replica at another
 * time and a person may have started working in between. Suspending a computer somebody is using is
 * worse than leaving an idle one running for another five minutes.
 */
export async function suspendClaimedComputers(
  options: CullerOptions,
): Promise<CullReport> {
  const leaseMs = options.leaseMs ?? 60_000;
  const claimed = await options.queue.claim({
    kind: CULL_KIND,
    owner: options.owner,
    leaseMs,
    limit: 20,
    ...(options.maxAttempts === undefined
      ? {}
      : { maxAttempts: options.maxAttempts }),
  });

  const report: CullReport = {
    considered: claimed.length,
    suspended: [],
    skipped: [],
  };

  for (const item of claimed) {
    const botId = String(item.payload.botId ?? item.key);
    /*
     * Renewed before each one, because the batch is twenty and the lease is one.
     *
     * Twenty suspensions is twenty calls to an API server, and nothing renewed while they ran: on a
     * slow cluster the lease expired part-way down the list and another replica claimed the tail
     * this one was still working through. A lease nobody renews is a timer, and a timer is what this
     * queue exists not to be.
     *
     * False means it is already somebody else's. Stopping is then the correct answer, not an error:
     * the item is being handled, just not here.
     */
    if (
      !(await options.queue.renew({
        kind: CULL_KIND,
        key: item.key,
        owner: options.owner,
        leaseMs,
      }))
    ) {
      report.skipped.push({
        botId,
        reason: "the lease went to another replica",
      });
      continue;
    }
    try {
      const now = options.now?.() ?? new Date();
      const used = await lastActedAt(options.database, [botId]);
      const since = used.get(botId);
      if (since && now.getTime() - since.getTime() < options.idleAfterMs) {
        // Somebody came back. Drop the item rather than releasing it, because the next sweep will
        // offer it again if it goes quiet, and a released one would just be reclaimed and re-checked.
        await options.queue.finish({
          kind: CULL_KIND,
          key: item.key,
          owner: options.owner,
        });
        report.skipped.push({
          botId,
          reason: "used again before it was suspended",
        });
        continue;
      }

      await options.provider.stop(botId);
      await options.queue.finish({
        kind: CULL_KIND,
        key: item.key,
        owner: options.owner,
      });
      report.suspended.push(botId);
    } catch (error) {
      /*
       * Released rather than dropped, and pushed out rather than retried immediately: a cluster that
       * refused this once will probably refuse it again in the next second, and a computer left
       * running costs money rather than losing anything.
       */
      const reason =
        error instanceof Error ? error.message : "could not be suspended";
      await options.queue.release({
        kind: CULL_KIND,
        key: item.key,
        owner: options.owner,
        delayMs: 5 * 60_000,
        reason,
      });
      /*
       * Said out loud when it gives up, because otherwise it stops silently.
       *
       * At the cap the item is no longer claimed, so this loop simply never sees that Bot again and
       * every sweep looks clean while one computer stays awake indefinitely. The row carries the
       * count and the reason for anybody who queries it; this is for the person reading the logs.
       */
      if (item.attempts >= (options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        console.warn(
          JSON.stringify({
            type: "computer-cull-gave-up",
            botId,
            attempts: item.attempts,
            reason,
          }),
        );
      }
      report.skipped.push({ botId, reason });
    }
  }

  return report;
}
