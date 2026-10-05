/**
 * One sweep: delete attachments somebody staged and never sent.
 *
 * Attach a file, change your mind and close the tab, and that row sits in `attachments` forever —
 * no message ever pointed back at it, just bytes with an `attached_at` that stayed null.
 * `attachedAt` is set the moment an attachment is actually sent, so a null attachment old enough
 * that the tab is long closed is not spoken for by anything and is safe to delete.
 *
 * Run from a CronJob rather than from a timer inside the API, for the reason the computer culler
 * beside it states: every replica would fire its own timer and each would decide, independently,
 * to sweep. Unlike that culler, this needs no lease and no claimed-by-this-pod bookkeeping —
 * deleting a staged attachment twice is harmless, because the second sweep finds nothing left to
 * delete.
 *
 * Exits non-zero only when the sweep itself could not run: no database to reach, or an argument
 * that could not be parsed. A staged attachment that is a minute past the window and swept on the
 * next run instead has lost nothing.
 */
import { and, isNull, lt, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../src/db/client";
import { attachments } from "../src/db/schema";

/** How long a staged attachment is kept, absent a CLI argument saying otherwise. */
const DEFAULT_OLDER_THAN_HOURS = 24;

/**
 * How many rows one statement may delete.
 *
 * Big enough that an ordinary sweep — a handful of abandoned uploads an hour — is a single
 * statement and the loop below runs twice, and small enough that the row locks, the WAL record and
 * the returned id array of one statement all stay bounded no matter how far behind the sweep is.
 */
const DEFAULT_BATCH_SIZE = 1_000;

/**
 * Delete every attachment that was staged and never sent, and is old enough that nobody is coming
 * back for it.
 *
 * `isNull(attachments.attachedAt)` rather than a truthiness check on the column, on purpose: a
 * truthiness check in application code would treat every falsy value as staged, but the column
 * being compared is a timestamp, so the only value that trips it is one that was never set at all
 * — which sounds safe until the query is written the same way and a driver hands back `null` for
 * every row where the comparison itself was mis-stated, sweeping every attachment ever sent in the
 * deployment rather than none of them. `IS NULL` is also the exact predicate
 * `attachments_staged_idx` was built on, so this delete is an index scan rather than a sequential
 * one.
 *
 * IN BATCHES, NOT IN ONE STATEMENT. This used to be a single unbounded `DELETE ... RETURNING id`,
 * which has two failure modes that only appear on the deployment least able to absorb them — one
 * that arrives here with a backlog, because the sweep was switched off, or the release predates it.
 * The transaction holds a row lock on every doomed row for its whole length, and the driver
 * materialises one id per deleted row purely so this function can read `.length`. Cut off by the
 * CronJob's `activeDeadlineSeconds` at any point, that statement rolls back entirely and the next
 * run redoes the same doomed work, forever. Batching turns the ceiling from a wedge into a pause:
 * each batch is its own transaction when this runs on a pool, so a sweep that is killed halfway has
 * still deleted everything it got through, and the next one starts from there.
 *
 * `for update skip locked` inside the subquery so a row somebody is sending RIGHT NOW — the update
 * that sets `attachedAt` holds a lock on it — is stepped over rather than waited on. Under
 * `read committed` the delete would re-check the predicate and skip such a row anyway; skipping it
 * up front means one slow send cannot hold the whole sweep. A batch shortened by skipped rows ends
 * the loop early, which costs nothing: those rows are still staged, still past the window, and the
 * next sweep takes them.
 *
 * THE BATCH SIZE IS CHECKED RATHER THAN TRUSTED, and `??` is the reason it has to be. That operator
 * defaults an ABSENT value and a null one, and nothing else: `batchSize: 0` is a number, so it is
 * taken, and the loop above cannot come out of it. `limit 0` returns no rows, the delete removes
 * none, and the termination test is `0 < 0` — false — so the sweep issues that same pair of
 * statements for as long as the process lives. Only a caller of this function can reach it; the CLI
 * below never passes a batch size, which is why the CronJob has never wedged on this and why the
 * tests that drive the CLI could not have caught it.
 *
 * The neighbouring values are each wrong in their own way, all measured against this deployment's
 * Postgres 16 through this same query builder rather than reasoned about:
 *
 * - `0.5` is the same endless loop wearing a friendlier face. `LIMIT` takes a bigint and a float8 is
 *   rounded to reach one, so a half becomes `limit 0` — a value nobody would read as "no rows" that
 *   behaves exactly like zero.
 * - A NEGATIVE SIZE IS THE WORST OF THEM, and not for the reason it looks like. Postgres refuses
 *   `LIMIT -1` outright, but this never reaches Postgres as a limit at all: drizzle emits no `limit`
 *   clause whatsoever for a negative one, so the statement becomes the single unbounded
 *   `DELETE ... RETURNING id` over the entire backlog that the paragraph above exists to prevent —
 *   every doomed row locked for one transaction, every id materialised — and the loop still never
 *   ends, because no `batch.length` is ever `< -1`. `NaN` takes that same clause-dropping path,
 *   drizzle's guard being `>= 0` and every comparison with `NaN` being false.
 * - A fraction at or above one does terminate, and is refused anyway. `1.5` rounds up to `limit 2`,
 *   so each statement deletes two rows and is then tested with `2 < 1.5`: a full batch that reads as
 *   a short one, ending the sweep one batch early on every run. A ceiling on the row locks and the
 *   WAL of one statement is not a number to accept a rounding of.
 *
 * A refusal rather than a silent correction — no clamping to 1, no rounding up. Every one of these
 * is a caller saying something it does not mean about a statement that DELETES, and the clamped
 * sweep would do bounded, plausible, wrong work while the caller kept believing its own number.
 *
 * `${hours}::float8 * interval '1 hour'` RATHER THAN `make_interval(hours => ${hours})`. The
 * argument is an operator's number of hours, from a chart value or a command line, and
 * `make_interval` takes an `int`: `make_interval(hours => 0.5)` is not a rounding, it is
 * `function make_interval(hours => double precision) does not exist` — verified against Postgres 16
 * — so `attachments.culler.olderThanHours: 0.5` in the chart made EVERY hourly sweep die, with the
 * error naming a function nobody set. Multiplying an interval accepts the same integers with the
 * same result and gives a fractional window the meaning it obviously has: 0.5 is thirty minutes.
 */
export async function cullStagedAttachments(
  database: Database,
  options: { olderThanHours: number; batchSize?: number },
): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError(
      "cullStagedAttachments needs a batch size that is a whole number of at least 1; " +
        // `String`, not `JSON.stringify`: the two values most worth naming here, `NaN` and
        // `Infinity`, are both `null` once JSON has been through them.
        `got ${String(batchSize)}. Anything else either deletes the whole backlog in one ` +
        "unbounded statement or leaves the sweep looping on batches it can never finish.",
    );
  }
  const cutoff = sql`now() - ${options.olderThanHours}::float8 * interval '1 hour'`;

  let deleted = 0;
  for (;;) {
    const doomed = database
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(isNull(attachments.attachedAt), lt(attachments.createdAt, cutoff)),
      )
      // Oldest first, so a sweep that is cut off has reclaimed the rows nobody could still want.
      .orderBy(attachments.createdAt)
      .limit(batchSize)
      .for("update", { skipLocked: true });

    const batch = await database
      .delete(attachments)
      .where(sql`${attachments.id} in ${doomed}`)
      .returning({ id: attachments.id });

    deleted += batch.length;
    if (batch.length < batchSize) {
      return deleted;
    }
  }
}

if (import.meta.main) {
  const [, , rawHours] = process.argv;
  const olderThanHours = Number(rawHours ?? DEFAULT_OLDER_THAN_HOURS);
  if (!Number.isFinite(olderThanHours) || olderThanHours <= 0) {
    throw new Error(
      "cull-staged-attachments takes an optional number of hours as " +
        `its one argument; got ${JSON.stringify(rawHours)}.`,
    );
  }

  /*
   * `DATABASE_URL`, AND NOTHING ELSE. NOT `loadConfig`.
   *
   * This used to call `loadConfig(process.env)` and read one field of the result,
   * `config.databaseUrl`. That builds the whole `DeploymentConfig` first, which refuses to return
   * without `KEY_ENCRYPTION_KEY`, the three Intelligence addressing values, and a complete identity
   * provider or `OPENBOT_SINGLE_USER`. So a sweep that deletes rows and touches no ciphertext,
   * no model and no session died at start-up with `KEY_ENCRYPTION_KEY must be configured`, and the
   * documented external-cron path in `docs/deployment.md` — "it needs only DATABASE_URL" — was
   * simply false. It worked under Helm only because that CronJob injected five credentials it had
   * no use for, in the pod with the least reason of any to hold them.
   *
   * NO VALIDATION IS LOST BY DROPPING `loadConfig`, which is the thing to check before believing
   * this: `loadConfig` does `required(environment, "DATABASE_URL")`, a non-empty-after-trim test and
   * no more. Every check that makes a connection string legible — a `%` in the password that starts
   * no escape, a URL with no host, a URL naming no database — lives in `addressOf` inside
   * `createDatabase`, below, and applies to exactly this call.
   *
   * REJECTED: teaching `config.ts` a narrower loader. `loadConfig` is the API server's boot
   * contract and the two sibling cron scripts genuinely want it — `fire-routines.ts` needs
   * `workerSharedSecret`, `cull-idle-computers.ts` needs `computer.idleAfterMs`. The convention this
   * follows instead is `scripts/migrate.ts`, the other script whose whole need is a database: it
   * reads `DATABASE_URL` from the environment and says so in one sentence when it is missing.
   */
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be configured before sweeping staged attachments",
    );
  }
  const database = createDatabase(databaseUrl);

  try {
    const deleted = await cullStagedAttachments(database, {
      olderThanHours,
    });
    console.info(JSON.stringify({ type: "attachment-cull", deleted }));
  } finally {
    await database.$client.end({ timeout: 5 });
  }
}
