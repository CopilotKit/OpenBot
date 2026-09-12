import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq, inArray, notInArray, sql } from "drizzle-orm";
import { cullStagedAttachments } from "../scripts/cull-staged-attachments";
import { createDatabase, type Database } from "../src/db/client";
import { attachments, channels, users } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);

const testPrefix = `attachment-sweeper-${randomUUID()}`;
const createdAttachmentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
  for (const id of createdAttachmentIds.splice(0)) {
    await database.delete(attachments).where(eq(attachments.id, id));
  }
  for (const id of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, id));
  }
  for (const id of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, id));
  }
});

afterAll(async () => {
  await database.$client.close();
});

/** A user and a channel to hang an attachment off of, nothing more. */
async function seedChannel() {
  const userId = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
  });
  createdUserIds.push(userId);

  const channelId = `${testPrefix}-channel-${randomUUID()}`;
  await database.insert(channels).values({
    id: channelId,
    name: "Attachment Sweeper Test Channel",
    description: "Sweep target channel.",
  });
  createdChannelIds.push(channelId);

  return { userId, channelId };
}

/**
 * How far in the past, as an interval Postgres will build from any number.
 *
 * NOT `make_interval(days => …)`, which is what this used to be. That takes an `int`, so the moment
 * a test wants an age of less than a day — which the fractional-window test below does, because a
 * half-hour window can only be demonstrated against rows aged in minutes — the helper fails with
 * `function make_interval(days => double precision) does not exist` rather than backdating
 * anything. Multiplying an interval takes whole numbers and fractions alike, and it is the same
 * expression the culler itself now uses to build its cutoff.
 */
function ago(hours: number) {
  return sql`now() - ${hours}::float8 * interval '1 hour'`;
}

/**
 * An attachment, backdated by editing `created_at` after the insert.
 *
 * `attachedAt` stays whatever the caller asks for, including null for a row that was staged and
 * never sent. `createdAt` cannot be set through `insert` the way `attachedAt` can — the column
 * defaults to `now()` at insert time — so it is pushed into the past with a direct `update`
 * afterwards, the same way `page-frame-retention.integration.test.ts` backdates a capture time.
 *
 * An age is given in days or in hours, whichever reads better at the call site: "a year old" is
 * `daysAgo: 365`, and "forty-five minutes ago" is `hoursAgo: 0.75`.
 */
async function stagedAttachment(options: {
  channelId: string;
  userId: string;
  daysAgo?: number;
  hoursAgo?: number;
  attachedDaysAgo?: number;
}) {
  const ageHours = options.hoursAgo ?? (options.daysAgo ?? 0) * 24;
  const [inserted] = await database
    .insert(attachments)
    .values({
      channelId: options.channelId,
      uploadedBy: options.userId,
      name: "test.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 3,
      bytes: Buffer.from([0x01, 0x02, 0x03]),
      attachedAt:
        options.attachedDaysAgo === undefined
          ? null
          : ago(options.attachedDaysAgo * 24),
    })
    .returning();
  createdAttachmentIds.push(inserted.id);

  await database
    .update(attachments)
    .set({ createdAt: ago(ageHours) })
    .where(eq(attachments.id, inserted.id));

  return inserted.id;
}

/** Thrown to roll a sweep back; never seen by a test. */
const ROLLBACK = new Error("attachment sweeper test rollback");

type Sweep = {
  /** How many rows the sweep deleted, of the rows THIS TEST created and no others. */
  deleted: number;
  /** Which of this test's rows the sweep left behind. */
  survivors: Set<string>;
  /**
   * How many `DELETE` statements the culler issued to do it.
   *
   * The one observable difference between a sweep that batches and a sweep that does not: both
   * delete the same rows and return the same count, and only this says whether one statement held
   * a lock on every doomed row at once. The harness's own narrowing delete is not counted — it is
   * issued against the transaction directly, and only the culler is handed the counting wrapper.
   */
  statements: number;
};

/**
 * The transaction, with every `delete()` it is asked for counted.
 *
 * Every member is bound to the real transaction rather than left to be called on the proxy, because
 * drizzle's session objects carry state that must be read with `this` pointing at the real object;
 * handing them a proxy as `this` is how a wrapper like this one turns into an unrelated failure
 * somewhere inside the driver.
 */
function countingDeletes(
  transaction: object,
  count: { statements: number },
): Database {
  return new Proxy(transaction, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      const bound = value.bind(target);
      if (property !== "delete") {
        return bound;
      }
      return (...args: unknown[]) => {
        count.statements += 1;
        return bound(...args);
      };
    },
  }) as unknown as Database;
}

/**
 * One sweep, run inside a transaction that is always rolled back, over a table first narrowed to
 * the rows this test created.
 *
 * `cullStagedAttachments` deletes across the whole `attachments` table and returns how many rows it
 * removed, so a bare `expect(deleted).toBe(1)` is an assertion about every other row in whatever
 * database the suite is pointed at: it holds only while nobody else has a staged attachment past
 * the window, and it reads `Expected: 1  Received: 2` the moment somebody does — by which point the
 * sweep that produced the 2 has PERMANENTLY DELETED that person's row. Both halves are fixed here,
 * not one.
 *
 * The narrowing delete removes every attachment row this test did not create, so afterwards the only
 * rows the culler can possibly find are this test's and the number it returns is exact rather than
 * shared: no test ordering, no leftover fixture and no unrelated developer row can move it. EVERY
 * row rather than only the staged ones, deliberately — narrowing to what the culler is SUPPOSED to
 * match would leave the count global again for exactly the mutations this test exists to catch, and
 * `expect(deleted).toBe(1)` would fail with a number that depends on the database rather than on the
 * bug.
 *
 * The transaction is then rolled back, so neither the narrowing delete nor the sweep itself outlives
 * the assertion — this test destroys nothing, including the rows it borrowed to narrow. Which is why
 * `survivors` is read INSIDE the transaction: after the rollback every row is back, and a read taken
 * outside it could only ever say "still there".
 */
async function sweep(options: {
  olderThanHours: number;
  batchSize?: number;
}): Promise<Sweep> {
  if (createdAttachmentIds.length === 0) {
    throw new Error("sweep() is meaningless before the test has created a row");
  }

  let outcome: Sweep | undefined;
  try {
    await database.transaction(async (transaction) => {
      await transaction
        .delete(attachments)
        .where(notInArray(attachments.id, createdAttachmentIds));

      const count = { statements: 0 };
      const deleted = await cullStagedAttachments(
        // A transaction is a `Database` for everything the culler does with one — it selects and
        // deletes — but drizzle types the two separately.
        countingDeletes(transaction, count),
        options,
      );

      const rows = await transaction
        .select({ id: attachments.id })
        .from(attachments)
        .where(inArray(attachments.id, createdAttachmentIds));

      outcome = {
        deleted,
        survivors: new Set(rows.map((row) => row.id)),
        statements: count.statements,
      };
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  if (!outcome) throw new Error("the sweep transaction never ran its body");
  return outcome;
}

describe("sweeping staged attachments", () => {
  test("a staged attachment older than the window is swept", async () => {
    const { userId, channelId } = await seedChannel();
    const id = await stagedAttachment({ channelId, userId, daysAgo: 2 });

    const { deleted, survivors } = await sweep({ olderThanHours: 6 });

    expect(deleted).toBe(1);
    expect(survivors.has(id)).toBe(false);
  });

  // The one that catches a truthiness bug: `attachedAt` is a real, year-old timestamp here, and a
  // check written as `!attachedAt` rather than `IS NULL` would never see it, because a truthy
  // check would have to be wrong the other way — treating this row as staged — for it to be swept.
  // That is exactly the mistake this predicate must not make.
  test("a sent attachment a year old is never swept", async () => {
    const { userId, channelId } = await seedChannel();
    const id = await stagedAttachment({
      channelId,
      userId,
      daysAgo: 365,
      attachedDaysAgo: 365,
    });

    const { deleted, survivors } = await sweep({ olderThanHours: 6 });

    expect(deleted).toBe(0);
    expect(survivors.has(id)).toBe(true);
  });

  test("a staged attachment inside the window is left alone", async () => {
    const { userId, channelId } = await seedChannel();
    const id = await stagedAttachment({ channelId, userId, daysAgo: 0 });

    const { deleted, survivors } = await sweep({ olderThanHours: 6 });

    expect(deleted).toBe(0);
    expect(survivors.has(id)).toBe(true);
  });

  // Half an hour is a window an operator can ask for: `attachments.culler.olderThanHours` in the
  // chart is handed to this straight, and 0.5 there used to make every hourly sweep die with
  // `function make_interval(hours => double precision) does not exist` — the whole sweep wedged, and
  // the error naming a Postgres function rather than the value anybody set. It is a window, not an
  // integer, so it is checked as one: forty-five minutes is past a half-hour window and fifteen
  // minutes is not.
  test("a window of half an hour means thirty minutes", async () => {
    const { userId, channelId } = await seedChannel();
    const past = await stagedAttachment({ channelId, userId, hoursAgo: 0.75 });
    const inside = await stagedAttachment({
      channelId,
      userId,
      hoursAgo: 0.25,
    });

    const { deleted, survivors } = await sweep({ olderThanHours: 0.5 });

    expect(deleted).toBe(1);
    expect(survivors.has(past)).toBe(false);
    expect(survivors.has(inside)).toBe(true);
  });

  // The sweep must not be one statement over the whole backlog: that holds a row lock on every
  // doomed row for the length of the transaction, materialises one returned id per row, and is
  // rolled back in its entirety when the CronJob's `activeDeadlineSeconds` kills it — so a
  // deployment too far behind to finish inside the ceiling redoes the same doomed work every hour
  // and never deletes anything. Three rows and a batch of one: four statements, because the loop
  // stops at the first batch that comes back short, and the third full batch cannot be known to be
  // the last one until a fourth finds nothing.
  test("the delete is issued in batches, not as one statement", async () => {
    const { userId, channelId } = await seedChannel();
    const ids = [
      await stagedAttachment({ channelId, userId, daysAgo: 2 }),
      await stagedAttachment({ channelId, userId, daysAgo: 3 }),
      await stagedAttachment({ channelId, userId, daysAgo: 4 }),
    ];

    const { deleted, survivors, statements } = await sweep({
      olderThanHours: 6,
      batchSize: 1,
    });

    expect(deleted).toBe(3);
    expect(statements).toBe(4);
    for (const id of ids) {
      expect(survivors.has(id)).toBe(false);
    }
  });
});

/**
 * A `Database` that fails the instant anything is asked of it.
 *
 * The batch-size checks below are about what the sweep does BEFORE its first statement, and they
 * cannot be written against a real database: the values they pass are the ones that make the loop
 * never end, so a test that let one reach Postgres would not fail, it would HANG — holding a
 * transaction open and issuing deletes in a tight loop against a database this suite shares with
 * every other agent on this machine. A bounded red is the whole point, so nothing here connects.
 *
 * The message names the property that was touched, so a regression reads as "the sweep reached the
 * database (.select)" rather than as an undefined-is-not-a-function from somewhere inside drizzle.
 */
function untouchableDatabase(): Database {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `the sweep reached the database (.${String(property)}) with a batch size it should have refused`,
        );
      },
    },
  ) as unknown as Database;
}

/**
 * The batch size, refused when it is one the loop could never come out of.
 *
 * `batchSize` is optional and defaulted with `??`, which catches an absent value and a null one and
 * NOTHING ELSE — zero is a number, so it is taken. Only callers of the exported function can supply
 * one; the CLI never does, which is why the CronJob has never hit this and why no test did either.
 *
 * Each of these was measured against this deployment's Postgres 16 through the same query builder
 * the sweep uses, rather than reasoned about:
 *
 * - `0` builds `limit $1` with `0`, which returns no rows, so the delete removes none and the
 *   termination test is `0 < 0` — false. The loop issues that pair of statements forever.
 * - `0.5` is worse in the way that matters, because it LOOKS like it would at least delete
 *   something: `LIMIT` takes a bigint, a float8 is rounded to reach one, and 0.5 rounds to zero.
 *   Same two statements, same endless loop, from a value nobody would read as "none".
 * - A negative size does not merely fail to limit: drizzle emits NO `limit` clause at all for one
 *   (Postgres would itself refuse `LIMIT -1`), so the sweep becomes the single unbounded
 *   `DELETE ... RETURNING id` over the whole backlog that batching exists to prevent — every doomed
 *   row locked for the length of one transaction, every id materialised — and THEN loops forever
 *   too, because no `batch.length` is ever `< -1`.
 * - `NaN` takes the same no-`limit` path, for the same reason: drizzle's guard is `>= 0`, and every
 *   comparison against `NaN` is false.
 * - A fraction at or above one terminates, so it is the mild case, and it is still refused. `1.5`
 *   rounds up to a `LIMIT 2`, so the sweep deletes two rows per statement while testing
 *   `2 < 1.5` — a full batch that reads as a short one, ending the sweep a batch early every time.
 *   A ceiling on row locks and WAL per statement is not a number to accept an approximation of.
 *
 * Asserted as a rejection with a named value rather than as "it did not hang", because a timeout is
 * the one thing this must never be: a test that proves the bug by waiting is a test that wedges CI.
 */
describe("a batch size the sweep cannot finish on", () => {
  const refused: [string, number][] = [
    ["zero", 0],
    ["a half, which Postgres rounds to zero", 0.5],
    ["negative, which drops the limit clause entirely", -1],
    ["a fraction, which is a limit nobody asked for", 1.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ];

  for (const [description, batchSize] of refused) {
    test(`${description} is refused before a statement is issued`, async () => {
      await expect(
        cullStagedAttachments(untouchableDatabase(), {
          olderThanHours: 6,
          batchSize,
        }),
      ).rejects.toThrow(/batch size.*whole number of at least 1/s);
    });
  }

  // The boundary on the other side of the refusal: one row per statement is the smallest sweep that
  // can still make progress, and the batching test above depends on it being allowed.
  test("a batch size of one is not refused", async () => {
    await expect(
      cullStagedAttachments(untouchableDatabase(), {
        olderThanHours: 6,
        batchSize: 1,
      }),
    ).rejects.toThrow(/the sweep reached the database/);
  });
});

/**
 * The sweep's documented contract: `DATABASE_URL` and nothing else.
 *
 * Run as a real process rather than by importing the module, because the thing under test is what
 * the script does BEFORE it deletes anything — an in-process call to `cullStagedAttachments` cannot
 * fail the way this failed, which is at start-up, in `loadConfig`, with `KEY_ENCRYPTION_KEY must be
 * configured`. `docs/deployment.md` tells an operator to run exactly this from an external cron and
 * that it needs only the database; the Helm CronJob is not that path and injected five credentials
 * this sweep has no use for. So the environment handed to the child is the documented one, built
 * from nothing rather than inherited, and the assertion is that the process succeeds.
 *
 * A WINDOW OF 1,000,000 HOURS, AND THAT NUMBER IS LOAD-BEARING. This is the one test here that runs
 * the culler for real rather than inside a rolled-back transaction, against a database other agents
 * and other suites are using at the same time. A cutoff in the year 1912 is one no row in any of
 * their fixtures can be older than, so the sweep proves it booted and connected while deleting
 * nothing whatsoever. Never lower it.
 */
test("the sweep boots with DATABASE_URL and no other configuration", () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "scripts/cull-staged-attachments.ts",
      String(1_000_000),
    ],
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderr = result.stderr.toString();
  const stdout = result.stdout.toString();
  expect(stderr).not.toContain("KEY_ENCRYPTION_KEY");
  expect({ code: result.exitCode, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ type: "attachment-cull", deleted: 0 });
});
