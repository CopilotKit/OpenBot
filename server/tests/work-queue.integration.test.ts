import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { createWorkQueue } from "../src/work/queue";
import { TEST_POOL } from "./support/database";

/**
 * The one mechanism suspending idle computers, running routines and handing work between Bots all
 * need, driven against a real PostgreSQL rather than a fake.
 *
 * A fake cannot answer the only question worth asking here. `for update skip locked` is a promise
 * the database makes about two transactions racing, and a stub that returns rows in order would pass
 * every test below while the real thing handed one item to two replicas.
 */
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const queue = createWorkQueue(database);
const kind = `test.${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.delete(workItems).where(eq(workItems.kind, kind));
  await database.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await database.delete(workItems).where(eq(workItems.kind, kind));
});

describe("claiming durable work", () => {
  test("one replica takes a due item, and it comes back with what it is about", async () => {
    await queue.offer({ kind, key: "bot-a", payload: { botId: "bot-a" } });

    const claimed = await queue.claim({
      kind,
      owner: "replica-1",
      leaseMs: 30_000,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.key).toBe("bot-a");
    expect(claimed[0]?.payload).toEqual({ botId: "bot-a" });
    // First time out, so whatever runs this knows it has certainly not run before.
    expect(claimed[0]?.attempts).toBe(1);
  });

  test("a second replica does not get an item the first is holding", async () => {
    await queue.offer({ kind, key: "bot-a" });

    const first = await queue.claim({
      kind,
      owner: "replica-1",
      leaseMs: 30_000,
    });
    const second = await queue.claim({
      kind,
      owner: "replica-2",
      leaseMs: 30_000,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  /*
   * THE TEST THIS FILE EXISTS FOR.
   *
   * Ten replicas reaching for ten items at the same moment must between them take each item once.
   * Anything less than `skip locked` fails here: plain `for update` serialises and one transaction
   * waits behind another, and no locking at all hands the same row to several claimants, which for a
   * routine is the same run billed N times.
   */
  test("ten replicas racing for ten items take each of them exactly once", async () => {
    const keys = Array.from({ length: 10 }, (_, index) => `bot-${index}`);
    for (const key of keys) await queue.offer({ kind, key });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        queue.claim({
          kind,
          owner: `replica-${index}`,
          leaseMs: 30_000,
          limit: 3,
        }),
      ),
    );

    const taken = results.flat().map((item) => item.key);
    expect(taken).toHaveLength(10);
    expect(new Set(taken).size).toBe(10);
  });

  test("a lease that stopped being renewed comes back to whoever asks next", async () => {
    await queue.offer({ kind, key: "bot-a" });
    // Claimed by a replica that then dies: nothing renews, and the lease is already in the past.
    await queue.claim({ kind, owner: "replica-1", leaseMs: -1 });

    const recovered = await queue.claim({
      kind,
      owner: "replica-2",
      leaseMs: 30_000,
    });

    expect(recovered).toHaveLength(1);
    /*
     * Second time out, which is the number that matters. Whatever picks this up has to be able to
     * tell "this never started" from "this started and we lost the process", because the second may
     * already have called a tool and spent money.
     */
    expect(recovered[0]?.attempts).toBe(2);
  });

  test("renewing keeps a claim, and cannot steal one back after it was lost", async () => {
    await queue.offer({ kind, key: "bot-a" });
    await queue.claim({ kind, owner: "replica-1", leaseMs: -1 });
    await queue.claim({ kind, owner: "replica-2", leaseMs: 30_000 });

    // Replica 1 wakes up and tries to keep a claim that is no longer its own.
    const stale = await queue.renew({
      kind,
      key: "bot-a",
      owner: "replica-1",
      leaseMs: 30_000,
    });
    const current = await queue.renew({
      kind,
      key: "bot-a",
      owner: "replica-2",
      leaseMs: 30_000,
    });

    expect(stale).toBe(false);
    expect(current).toBe(true);
  });

  test("offering the same work twice leaves one item", async () => {
    /*
     * Idempotence, which is where every recovery path stops being a duplicate-run path. A routine
     * due at 07:00 is offered by every replica that wakes; the key carries the minute, so they are
     * all offering the same thing.
     */
    await queue.offer({ kind, key: "routine:daily:2026-08-24T07:00" });
    await queue.offer({ kind, key: "routine:daily:2026-08-24T07:00" });
    await queue.offer({ kind, key: "routine:daily:2026-08-24T07:00" });

    const rows = await database
      .select({ key: workItems.key })
      .from(workItems)
      .where(eq(workItems.kind, kind));
    expect(rows).toHaveLength(1);
  });

  test("an item that is not due yet is not claimed", async () => {
    await queue.offer({
      kind,
      key: "later",
      runAt: new Date(Date.now() + 60_000),
    });

    expect(
      await queue.claim({ kind, owner: "replica-1", leaseMs: 30_000 }),
    ).toHaveLength(0);
  });

  /*
   * The idempotence this table promises has to survive completion.
   *
   * Finishing used to delete the row, so the insert a re-offer was supposed to collide with had
   * nothing left to collide with: a routine due at 07:00 that had already run was handed straight
   * back to the next replica to wake late, and ran twice. Every recovery path was a duplicate-run
   * path.
   */
  test("a finished item stays, so re-offering the same key runs nothing", async () => {
    await queue.offer({ kind, key: "bot-a" });
    await queue.claim({ kind, owner: "replica-1", leaseMs: 30_000 });
    expect(await queue.finish({ kind, key: "bot-a", owner: "replica-1" })).toBe(
      true,
    );

    await queue.offer({ kind, key: "bot-a" });

    expect(
      await queue.claim({ kind, owner: "replica-2", leaseMs: 30_000 }),
    ).toHaveLength(0);
  });

  test("finished rows are swept once they are past their retention", async () => {
    await queue.offer({ kind, key: "bot-a" });
    await queue.claim({ kind, owner: "replica-1", leaseMs: 30_000 });
    await queue.finish({ kind, key: "bot-a", owner: "replica-1" });

    expect(await queue.purge({ kind, olderThanMs: 60_000 })).toBe(0);
    expect(await queue.purge({ kind, olderThanMs: 0 })).toBe(1);
  });

  test("releasing frees the item and holds it back for a while", async () => {
    await queue.offer({ kind, key: "bot-a" });
    await queue.claim({ kind, owner: "replica-1", leaseMs: 30_000 });
    await queue.release({
      kind,
      key: "bot-a",
      owner: "replica-1",
      delayMs: 60_000,
    });

    // Free, but not yet due, so nobody picks it straight back up and spins on it.
    expect(
      await queue.claim({ kind, owner: "replica-2", leaseMs: 30_000 }),
    ).toHaveLength(0);
  });

  /*
   * Both of these are the same bug from two ends: the lease says who may act on an item, and only
   * `renew` used to ask. A replica whose lease had quietly gone could delete or reschedule work
   * another replica was in the middle of doing.
   */
  test("a replica that lost its lease cannot finish somebody else's work", async () => {
    await queue.offer({ kind, key: "bot-a" });
    await queue.claim({ kind, owner: "replica-1", leaseMs: 1 });
    await Bun.sleep(30);
    await queue.claim({ kind, owner: "replica-2", leaseMs: 30_000 });

    expect(await queue.finish({ kind, key: "bot-a", owner: "replica-1" })).toBe(
      false,
    );

    const [row] = await database
      .select({ by: workItems.claimedBy, done: workItems.finishedAt })
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "bot-a")));
    expect(row?.by).toBe("replica-2");
    expect(row?.done).toBeNull();
  });

  test("a replica that lost its lease cannot reschedule somebody else's work", async () => {
    await queue.offer({ kind, key: "bot-a" });
    await queue.claim({ kind, owner: "replica-1", leaseMs: 1 });
    await Bun.sleep(30);
    await queue.claim({ kind, owner: "replica-2", leaseMs: 30_000 });

    expect(
      await queue.release({
        kind,
        key: "bot-a",
        owner: "replica-1",
        delayMs: 60_000,
      }),
    ).toBe(false);

    const [row] = await database
      .select({ by: workItems.claimedBy })
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "bot-a")));
    expect(row?.by).toBe("replica-2");
  });

  /*
   * Two clocks pretending to be one.
   *
   * The lease was computed as `Date.now() + leaseMs` on the replica and compared against `now()` in
   * Postgres. A node behind the database wrote a live lease that arrived already expired, and the
   * next replica to look took the item out from under it. Both ran it. Every moment is named in SQL
   * now, so a wrong local clock cannot produce one.
   */
  test("a replica whose clock is behind still holds a real lease", async () => {
    await queue.offer({ kind, key: "bot-a" });

    const realNow = Date.now;
    Date.now = () => realNow() - 90_000;
    try {
      await queue.claim({ kind, owner: "replica-1", leaseMs: 60_000 });
    } finally {
      Date.now = realNow;
    }

    expect(
      await queue.claim({ kind, owner: "replica-2", leaseMs: 60_000 }),
    ).toHaveLength(0);
  });

  /*
   * A permanently failing item has to stop somewhere a person can see, rather than retrying until
   * somebody notices, which on a queue with no dashboard is never.
   */
  test("an item stops being offered once it runs out of attempts", async () => {
    await queue.offer({ kind, key: "bot-a" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [item] = await queue.claim({
        kind,
        owner: "replica-1",
        leaseMs: 30_000,
        maxAttempts: 3,
      });
      expect(item?.attempts).toBe(attempt + 1);
      await queue.release({
        kind,
        key: "bot-a",
        owner: "replica-1",
        delayMs: 0,
        reason: "the cluster said no",
      });
    }

    expect(
      await queue.claim({
        kind,
        owner: "replica-1",
        leaseMs: 30_000,
        maxAttempts: 3,
      }),
    ).toHaveLength(0);

    // Still here, with its count and its reason, which is the terminal state rather than a silence.
    const [row] = await database
      .select({ attempts: workItems.attempts, why: workItems.lastError })
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "bot-a")));
    expect(row?.attempts).toBe(3);
    expect(row?.why).toBe("the cluster said no");
  });
});
