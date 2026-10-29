import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { workItems } from "../src/db/schema";
import { createWorkQueue, type SerialOrder } from "../src/work/queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The one mechanism suspending idle computers, running routines and handing work between Bots all
 * need, driven against a real PostgreSQL rather than a fake.
 *
 * A fake cannot answer the only question worth asking here. `for update skip locked` is a promise
 * the database makes about two transactions racing, and a stub that returns rows in order would pass
 * every test below while the real thing handed one item to two replicas.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const queue = createWorkQueue(database);
const kind = `test.${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await database.delete(workItems).where(eq(workItems.kind, kind));
  await database.$client.end({ timeout: 5 });
});

beforeEach(async () => {
  await database.delete(workItems).where(eq(workItems.kind, kind));
});

async function liveKeys(taskId: string) {
  const rows = await database
    .select({ key: workItems.key })
    .from(workItems)
    .where(
      and(
        eq(workItems.kind, kind),
        sql`${workItems.payload}->>'taskId' = ${taskId}`,
        sql`${workItems.finishedAt} is null and ${workItems.leaseUntil} > now()`,
      ),
    );
  return rows.map((row) => row.key);
}

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

  test("finishing keeps what the work came to on its payload, as an object, only while it is ours", async () => {
    await queue.offer({ kind, key: "bot-a", payload: { botId: "bot-a" } });
    await queue.claim({ kind, owner: "replica-1", leaseMs: 30_000 });
    const ending = { messageId: "run-1:reply", asks: true };
    expect(
      await queue.finish({
        kind,
        key: "bot-a",
        owner: "replica-2",
        payload: { ending: { messageId: "stale", asks: false } },
      }),
    ).toBe(false);
    expect(
      await queue.finish({
        kind,
        key: "bot-a",
        owner: "replica-1",
        payload: { ending },
      }),
    ).toBe(true);
    const [row] = await database
      .select({
        payload: workItems.payload,
        asks: sql<string>`${workItems.payload}->'ending'->>'asks'`,
      })
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "bot-a")));
    expect(row).toEqual({
      payload: { botId: "bot-a", ending },
      asks: "true",
    });
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
   * Nobody else has it yet, and it is still not the old owner's: on its last attempt nothing will
   * claim it again, so a late heartbeat, finish or release is all that could still change the row,
   * and a serialised sibling may already be running in its place.
   */
  test("a lease that ran out is not its owner's to renew, finish or release", async () => {
    await queue.offer({ kind, key: "bot-a" });
    await queue.claim({ kind, owner: "replica-1", leaseMs: -1 });

    const mine = { kind, key: "bot-a", owner: "replica-1" };
    expect(await queue.renew({ ...mine, leaseMs: 30_000 })).toBe(false);
    expect(await queue.finish(mine)).toBe(false);
    expect(await queue.release({ ...mine, delayMs: 0 })).toBe(false);

    const [row] = await database
      .select()
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "bot-a")));
    expect(row).toMatchObject({
      claimedBy: "replica-1",
      attempts: 1,
      finishedAt: null,
    });
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

  /*
   * The two kinds of done, on their own clocks.
   *
   * They were one number, which a queue whose work repeats cannot afford: a finished row only has to
   * outlast a sweep, and a row that gave up is kept because that window is also the backoff before
   * anything tries the work again. Sharing it meant the culler either wedged its own key for a day
   * or retried a broken suspension every few minutes.
   */
  test("a finished row and one that gave up are swept on separate windows", async () => {
    await queue.offer({ kind, key: "done" });
    await queue.claim({ kind, owner: "replica-1", leaseMs: 30_000 });
    await queue.finish({ kind, key: "done", owner: "replica-1" });

    await queue.offer({ kind, key: "gave-up" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await queue.claim({
        kind,
        owner: "replica-1",
        leaseMs: 30_000,
        maxAttempts: 3,
      });
      await queue.release({
        kind,
        key: "gave-up",
        owner: "replica-1",
        delayMs: 0,
        reason: "the cluster said no",
      });
    }

    // The finished one goes on its own short window; the one that gave up keeps its long one.
    expect(
      await queue.purge({
        kind,
        olderThanMs: 60_000,
        finishedOlderThanMs: 0,
        maxAttempts: 3,
      }),
    ).toBe(1);
    const [left] = await database
      .select({ key: workItems.key })
      .from(workItems)
      .where(eq(workItems.kind, kind));
    expect(left?.key).toBe("gave-up");

    // And omitting it leaves both halves on the one window, which is what every other caller does.
    expect(await queue.purge({ kind, olderThanMs: 0, maxAttempts: 3 })).toBe(1);
  });
});

/**
 * The fan-out cap, under the only conditions that matter.
 *
 * A model asked to do several things emits several tool calls in one turn and they run at once. A
 * cap checked before the write holds only while nothing else is writing, so all of them pass it:
 * each reads a count taken before any of the others had committed. This needs no cluster and no
 * unusual timing, which is why it must be driven against a real database rather than a stub that
 * awaits one call at a time.
 */
describe("offering at most so many under one prefix", () => {
  test("five at once cannot get past a cap of three", async () => {
    const run = `${randomUUID()}:`;

    const results = await Promise.all(
      ["one", "two", "three", "four", "five"].map((word) =>
        queue.offer({
          kind,
          key: `${run}${word}`,
          atMost: { keyPrefix: run, max: 3 },
        }),
      ),
    );

    expect(results.filter((result) => result === "queued")).toHaveLength(3);
    expect(results.filter((result) => result === "refused")).toHaveLength(2);
    const written = await database
      .select({ key: workItems.key })
      .from(workItems)
      .where(eq(workItems.kind, kind));
    expect(written).toHaveLength(3);
  });

  /*
   * A retried offer of work that is already queued is not a new hop, and must not be reported as
   * refused by the cap: the caller asked for it to be on the queue and it is.
   */
  test("the same key again is not counted against the cap", async () => {
    const run = `${randomUUID()}:`;
    const cap = { keyPrefix: run, max: 1 };

    expect(await queue.offer({ kind, key: `${run}a`, atMost: cap })).toBe(
      "queued",
    );
    // The same key again is work already queued, not a second piece of work — and not something the
    // cap should refuse either. A caller that reports it as new promises an answer nobody will give.
    expect(await queue.offer({ kind, key: `${run}a`, atMost: cap })).toBe(
      "already",
    );
    expect(await queue.offer({ kind, key: `${run}b`, atMost: cap })).toBe(
      "refused",
    );
  });

  test("without a cap nothing is refused", async () => {
    const run = `${randomUUID()}:`;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => queue.offer({ kind, key: `${run}${n}` })),
    );
    expect(results.every((result) => result === "queued")).toBe(true);
  });
});

describe("one at a time in a group", () => {
  test("task replies survive a worker restart and concurrent claims keep each task in order", async () => {
    for (const key of ["initial", "reply-1", "reply-2"])
      await queue.offer({
        kind,
        key,
        payload: { taskId: "task-a", text: key },
      });
    const [a, b] = await Promise.all([
      queue.claim({ kind, owner: "a", leaseMs: 30_000, serialBy: "taskId" }),
      queue.claim({ kind, owner: "b", leaseMs: 30_000, serialBy: "taskId" }),
    ]);
    expect([...a, ...b].map((item) => item.key)).toEqual(["initial"]);
    const owner = a.length ? "a" : "b";
    await queue.finish({ kind, key: "initial", owner });
    // New process, same durable queue: no browser or prior worker keeps the replies alive.
    const restarted = createWorkQueue(database);
    for (const key of ["reply-1", "reply-2"]) {
      const [next] = await restarted.claim({
        kind,
        owner: "restart",
        leaseMs: 30_000,
        serialBy: "taskId",
      });
      expect(next?.key).toBe(key);
      expect(next?.payload.text).toBe(key);
      expect(
        await queue.claim({
          kind,
          owner: "other",
          leaseMs: 30_000,
          serialBy: "taskId",
        }),
      ).toEqual([]);
      await restarted.finish({ kind, key, owner: "restart" });
    }
  });

  test("a delayed older insertion cannot overlap a newer reply already running", async () => {
    await queue.offer({ kind, key: "newer", payload: { taskId: "same-task" } });
    expect(
      await queue.claim({
        kind,
        owner: "first",
        leaseMs: 30_000,
        serialBy: "taskId",
      }),
    ).toHaveLength(1);
    // An insert transaction can start earlier and commit after the newer row was claimed.
    await database.insert(workItems).values({
      kind,
      key: "older",
      payload: { taskId: "same-task" },
      createdAt: new Date(Date.now() - 10_000),
    });
    await queue.offer({
      kind,
      key: "unrelated",
      payload: { taskId: "another-task" },
    });
    // The blocked older row must not consume the only slot and starve another task.
    expect(
      (
        await queue.claim({
          kind,
          owner: "second",
          leaseMs: 30_000,
          limit: 1,
          serialBy: "taskId",
        })
      ).map((item) => item.key),
    ).toEqual(["unrelated"]);
    expect(
      await queue.claim({
        kind,
        owner: "second",
        leaseMs: 30_000,
        serialBy: "taskId",
      }),
    ).toEqual([]);
    await queue.finish({ kind, key: "newer", owner: "first" });
    expect(
      (
        await queue.claim({
          kind,
          owner: "second",
          leaseMs: 30_000,
          serialBy: "taskId",
        })
      )[0]?.key,
    ).toBe("older");
  });

  test("an expired final-attempt lease cannot revive after its next sibling starts", async () => {
    const claim = { kind, leaseMs: 30_000, maxAttempts: 2, serialBy: "taskId" };
    await queue.offer({ kind, key: "first", payload: { taskId: "same-task" } });
    await queue.offer({ kind, key: "next", payload: { taskId: "same-task" } });
    await queue.claim({ ...claim, owner: "original" });
    await queue.release({ kind, key: "first", owner: "original", delayMs: 0 });
    expect(await queue.claim({ ...claim, owner: "original" })).toMatchObject([
      { key: "first", attempts: 2 },
    ]);
    expect(await liveKeys("same-task")).toEqual(["first"]);
    expect(await queue.claim({ ...claim, owner: "replacement" })).toEqual([]);
    expect(
      await queue.renew({ kind, key: "first", owner: "original", leaseMs: -1 }),
    ).toBe(true);
    expect(await liveKeys("same-task")).toEqual([]);
    expect(await queue.claim({ ...claim, owner: "replacement" })).toMatchObject(
      [{ key: "next", attempts: 1 }],
    );
    expect(
      await queue.renew({
        kind,
        key: "first",
        owner: "original",
        leaseMs: 30_000,
      }),
    ).toBe(false);
    expect(await liveKeys("same-task")).toEqual(["next"]);
    const [expired] = await database
      .select()
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "first")));
    expect(expired).toMatchObject({
      claimedBy: "original",
      attempts: 2,
      finishedAt: null,
    });
    const [next] = await database
      .select()
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "next")));
    await queue.release({
      kind,
      key: "first",
      owner: "original",
      delayMs: 0,
      unstarted: true,
    });
    const afterRefund = await database
      .select()
      .from(workItems)
      .where(eq(workItems.kind, kind));
    expect(afterRefund.find((row) => row.key === "first")).toEqual(expired);
    expect(afterRefund.find((row) => row.key === "next")).toEqual(next);
    await queue.finish({ kind, key: "next", owner: "replacement" });
    expect(await queue.claim({ ...claim, owner: "later" })).toEqual([]);
  });

  test.each([1, 2])(
    "an expired newer sibling lease allows the delayed older reply at maxAttempts %i",
    async (maxAttempts) => {
      await queue.offer({
        kind,
        key: "newer",
        payload: { taskId: "same-task" },
      });
      await queue.claim({
        kind,
        owner: "first",
        leaseMs: 30_000,
        maxAttempts,
        serialBy: "taskId",
      });
      await database.insert(workItems).values({
        kind,
        key: "older",
        payload: { taskId: "same-task" },
        createdAt: new Date(Date.now() - 10_000),
      });
      // A live sibling blocks even on its last attempt, regardless of insertion order.
      expect(
        await queue.claim({
          kind,
          owner: "second",
          leaseMs: 30_000,
          limit: 1,
          maxAttempts,
          serialBy: "taskId",
        }),
      ).toEqual([]);
      await queue.renew({ kind, key: "newer", owner: "first", leaseMs: -1 });
      expect(
        (
          await queue.claim({
            kind,
            owner: "second",
            leaseMs: 30_000,
            limit: 1,
            maxAttempts,
            serialBy: "taskId",
          })
        ).map((item) => item.key),
      ).toEqual(["older"]);
      expect(await liveKeys("same-task")).toEqual(["older"]);
      expect(
        await queue.renew({
          kind,
          key: "newer",
          owner: "first",
          leaseMs: 30_000,
        }),
      ).toBe(false);
      expect(await liveKeys("same-task")).toEqual(["older"]);
      expect(
        await queue.renew({
          kind,
          key: "older",
          owner: "second",
          leaseMs: 30_000,
        }),
      ).toBe(true);
      expect(await liveKeys("same-task")).toEqual(["older"]);
    },
  );

  /*
   * Two kinds in one order, as a conversation's own turns and the answers to questions asked in it
   * can share one: each kind finds its group its own way, an older row of either kind keeps its
   * place, and a row out of attempts by its own kind's cap stops holding the group.
   */
  test("kinds that share an order take turns by age, each by its own attempt cap", async () => {
    const answers = `${kind}.answer`;
    const order: SerialOrder = {
      name: kind,
      kinds: { [kind]: 2, [answers]: 1 },
      groupOf: (row) =>
        sql`case when ${row}.kind = ${answers} then ${row}.payload->'question'->>'taskId' else ${row}.payload->>'taskId' end`,
    };
    const keys = (items: { key: string }[]) => items.map((item) => item.key);
    const claimTurn = () =>
      queue.claim({
        kind,
        owner: "worker",
        leaseMs: 30_000,
        maxAttempts: 2,
        serialBy: order,
      });
    const claimAnswer = () =>
      queue.claim({
        kind: answers,
        owner: "answerer",
        leaseMs: 30_000,
        maxAttempts: 1,
        serialBy: order,
      });
    const answer = (key: string) =>
      queue.offer({
        kind: answers,
        key,
        payload: { question: { taskId: "same-task" } },
      });
    try {
      await answer("answer");
      await queue.offer({
        kind,
        key: "turn",
        payload: { taskId: "same-task" },
      });
      await queue.offer({
        kind,
        key: "elsewhere",
        payload: { taskId: "another-task" },
      });
      // The older answer holds the turn back, and holds back nothing else.
      expect(keys(await claimTurn())).toEqual(["elsewhere"]);
      expect(await claimTurn()).toEqual([]);
      // Running, it still does.
      expect(keys(await claimAnswer())).toEqual(["answer"]);
      expect(await claimTurn()).toEqual([]);
      // Its one attempt failed. Out of attempts, it no longer holds the group.
      await queue.release({
        kind: answers,
        key: "answer",
        owner: "answerer",
        delayMs: 0,
        reason: "fetch failed",
      });
      expect(keys(await claimTurn())).toEqual(["turn"]);
      // A running turn holds back an answer that arrives behind it, until it finishes.
      await answer("later-answer");
      expect(await claimAnswer()).toEqual([]);
      await queue.finish({ kind, key: "turn", owner: "worker" });
      expect(keys(await claimAnswer())).toEqual(["later-answer"]);
    } finally {
      await database.delete(workItems).where(eq(workItems.kind, answers));
    }
  });
});

describe("giving back a claim that never started", () => {
  test("unstarted claims defer without spending attempts, and only their owner can refund once", async () => {
    await queue.offer({ kind, key: "busy", payload: { messageId: "reply-1" } });
    for (let conflict = 0; conflict < 4; conflict++) {
      const [item] = await queue.claim({
        kind,
        owner: "worker",
        leaseMs: 30_000,
        maxAttempts: 2,
      });
      expect(item).toMatchObject({
        attempts: 1,
        payload: { messageId: "reply-1" },
      });
      expect(
        await queue.release({
          kind,
          key: "busy",
          owner: "stale-worker",
          delayMs: 0,
          unstarted: true,
        }),
      ).toBe(false);
      expect(
        await queue.release({
          kind,
          key: "busy",
          owner: "worker",
          delayMs: 0,
          unstarted: true,
        }),
      ).toBe(true);
      expect(
        await queue.release({
          kind,
          key: "busy",
          owner: "worker",
          delayMs: 0,
          unstarted: true,
        }),
      ).toBe(false);
    }
    const [delivered] = await queue.claim({
      kind,
      owner: "worker",
      leaseMs: 30_000,
      maxAttempts: 2,
    });
    expect(delivered?.attempts).toBe(1);
    await queue.release({
      kind,
      key: "busy",
      owner: "worker",
      delayMs: 0,
      reason: "provider failed",
    });
    const [retry] = await queue.claim({
      kind,
      owner: "worker",
      leaseMs: 30_000,
      maxAttempts: 2,
    });
    expect(retry?.attempts).toBe(2);
    await queue.release({
      kind,
      key: "busy",
      owner: "worker",
      delayMs: 0,
      unstarted: true,
    });
    const [deferred] = await database
      .select()
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "busy")));
    expect(deferred).toMatchObject({
      attempts: 1,
      lastError: "provider failed",
    });
    await queue.claim({
      kind,
      owner: "worker",
      leaseMs: 30_000,
      maxAttempts: 2,
    });
    await queue.release({
      kind,
      key: "busy",
      owner: "worker",
      delayMs: 0,
      reason: "provider failed again",
    });
    expect(
      await queue.claim({
        kind,
        owner: "worker",
        leaseMs: 30_000,
        maxAttempts: 2,
      }),
    ).toEqual([]);
  });

  test("a deferred claim keeps its backoff and cannot refund a replacement owner's attempt", async () => {
    await queue.offer({ kind, key: "replacement" });
    await queue.claim({ kind, owner: "old-worker", leaseMs: -1 });
    await queue.claim({ kind, owner: "new-worker", leaseMs: 30_000 });
    expect(
      await queue.release({
        kind,
        key: "replacement",
        owner: "old-worker",
        delayMs: 0,
        unstarted: true,
      }),
    ).toBe(false);
    const [owned] = await database
      .select()
      .from(workItems)
      .where(and(eq(workItems.kind, kind), eq(workItems.key, "replacement")));
    expect(owned).toMatchObject({ claimedBy: "new-worker", attempts: 2 });
    expect(
      await queue.release({
        kind,
        key: "replacement",
        owner: "new-worker",
        delayMs: 60_000,
        unstarted: true,
      }),
    ).toBe(true);
    expect(
      await queue.claim({ kind, owner: "next-worker", leaseMs: 30_000 }),
    ).toEqual([]);
  });
});
