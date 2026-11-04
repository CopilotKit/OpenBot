import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { localLocks } from "../src/db/schema";
import {
  extendLocalLock,
  LocalLockTimeoutError,
  releaseLocalLock,
  tryLocalLock,
  withLocalLock,
} from "../src/work/local-lock";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The lock that guards read-Intelligence-then-write sequences, against a real PostgreSQL: one holder
 * at a time, a dead holder's lock frees itself by expiring, and only the holder can release or extend.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const names: string[] = [];
const fresh = () => {
  const name = `test-lock-${randomUUID()}`;
  names.push(name);
  return name;
};

afterAll(async () => {
  for (const name of names)
    await database.delete(localLocks).where(eq(localLocks.name, name));
  await database.$client.close();
});

describe("local locks", () => {
  test("one holder at a time, and the holder can take it again", async () => {
    const name = fresh();
    expect(await tryLocalLock(database, name, "a", 30_000)).toBe(true);
    expect(await tryLocalLock(database, name, "b", 30_000)).toBe(false);
    expect(await tryLocalLock(database, name, "a", 30_000)).toBe(true);
    await releaseLocalLock(database, name, "b");
    expect(await tryLocalLock(database, name, "b", 30_000)).toBe(false);
    await releaseLocalLock(database, name, "a");
    expect(await tryLocalLock(database, name, "b", 30_000)).toBe(true);
  });

  test("a holder that never releases frees the name when its time runs out", async () => {
    const name = fresh();
    expect(await tryLocalLock(database, name, "dead", 30_000)).toBe(true);
    await database
      .update(localLocks)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(localLocks.name, name));
    expect(await extendLocalLock(database, name, "other", 30_000)).toBe(false);
    expect(await tryLocalLock(database, name, "other", 30_000)).toBe(true);
    expect(await extendLocalLock(database, name, "dead", 30_000)).toBe(false);
  });

  test("withLocalLock runs racing work one after the other", async () => {
    const name = fresh();
    let inside = 0;
    let most = 0;
    const work = async () => {
      inside += 1;
      most = Math.max(most, inside);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inside -= 1;
    };
    await Promise.all(
      Array.from({ length: 5 }, () => withLocalLock(database, name, work)),
    );
    expect(most).toBe(1);
    const [left] = await database
      .select()
      .from(localLocks)
      .where(eq(localLocks.name, name));
    expect(left).toBeUndefined();
  });

  test("a waiter that cannot get the lock in time is told so", async () => {
    const name = fresh();
    expect(await tryLocalLock(database, name, "holder", 30_000)).toBe(true);
    await expect(
      withLocalLock(database, name, async () => "never", { waitMs: 50 }),
    ).rejects.toBeInstanceOf(LocalLockTimeoutError);
  });
});
