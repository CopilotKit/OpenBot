/**
 * A named lock across replicas that holds no database connection while it is held.
 *
 * WHY NOT AN ADVISORY OR ROW LOCK. The data these sequences guard lives in Intelligence now, so the
 * sequence is "read Intelligence, decide, write Intelligence". An advisory or `for update` lock would
 * have to keep an OpenBot transaction (or a pooled connection) open across those calls, which is the
 * one thing no code here may do: a slow Intelligence would then hold the pool hostage.
 *
 * HOW. Taking the lock is one statement on the database's clock: insert the name, or take it over when
 * its holder's time has passed. Releasing deletes it only if this holder still has it. A holder that
 * dies frees the name when its time runs out, so `ttlMs` must comfortably exceed how long the guarded
 * work can take; work that may run longer renews with `extend`.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { localLocks } from "../db/schema";

export class LocalLockTimeoutError extends Error {
  constructor(name: string, waitedMs: number) {
    super(`Could not take the lock "${name}" within ${waitedMs} ms.`);
    this.name = "LocalLockTimeoutError";
  }
}

type Executor = Pick<Database, "execute" | "delete" | "update">;

/** One attempt. True when this holder now has the lock. */
export async function tryLocalLock(
  database: Executor,
  name: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  const rows = await database.execute(sql`
    insert into local_locks (name, holder, expires_at)
    values (${name}, ${holder}, now() + (${ttlMs} * interval '1 millisecond'))
    on conflict (name) do update
      set holder = excluded.holder, expires_at = excluded.expires_at
      where local_locks.expires_at < now() or local_locks.holder = excluded.holder
    returning name
  `);
  return rowCount(rows) > 0;
}

/** Push this holder's expiry out again. False when the lock has already gone to someone else. */
export async function extendLocalLock(
  database: Executor,
  name: string,
  holder: string,
  ttlMs: number,
): Promise<boolean> {
  const moved = await database
    .update(localLocks)
    .set({ expiresAt: sql`now() + (${ttlMs} * interval '1 millisecond')` })
    .where(and(eq(localLocks.name, name), eq(localLocks.holder, holder)))
    .returning({ name: localLocks.name });
  return moved.length > 0;
}

export async function releaseLocalLock(
  database: Executor,
  name: string,
  holder: string,
): Promise<void> {
  await database
    .delete(localLocks)
    .where(and(eq(localLocks.name, name), eq(localLocks.holder, holder)));
}

/**
 * Run `work` holding `name`, waiting for it up to `waitMs`. Released afterwards whatever happens.
 *
 * Each call is its own holder, so two pieces of work in one process exclude each other too.
 */
export async function withLocalLock<T>(
  database: Executor,
  name: string,
  work: () => Promise<T>,
  options: { ttlMs?: number; waitMs?: number } = {},
): Promise<T> {
  const ttlMs = options.ttlMs ?? 30_000;
  const waitMs = options.waitMs ?? 15_000;
  const holder = crypto.randomUUID();
  const started = Date.now();
  let pauseMs = 10;
  while (!(await tryLocalLock(database, name, holder, ttlMs))) {
    if (Date.now() - started > waitMs)
      throw new LocalLockTimeoutError(name, waitMs);
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    pauseMs = Math.min(pauseMs * 2, 250);
  }
  try {
    return await work();
  } finally {
    await releaseLocalLock(database, name, holder).catch((error: unknown) => {
      // It expires on its own; a failed release only delays the next taker by the ttl.
      console.warn(
        JSON.stringify({
          type: "local-lock-release-failed",
          name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  if (Array.isArray(rows)) return rows.length;
  const count = (result as { count?: number; rowCount?: number } | null)?.count;
  return typeof count === "number" ? count : 0;
}
