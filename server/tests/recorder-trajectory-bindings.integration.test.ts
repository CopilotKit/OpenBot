import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { recorderTrajectoryBindings } from "../src/db/schema/recorder";
import {
  createTrajectoryBindingStore,
  InvalidCursorError,
} from "../src/recorder/trajectory-bindings";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createTrajectoryBindingStore(database);
const prefix = `trajectory-bindings-${randomUUID()}`;
const person = `${prefix}-person`;
const other = `${prefix}-other`;
const micro = `${prefix}-micro`;

/** Oldest first; all within one second so the paging has to use the milliseconds. */
const mine = Array.from({ length: 5 }, (_, index) => ({
  trajectoryId: randomUUID(),
  userId: person,
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0, index * 7)),
}));
const theirs = {
  trajectoryId: randomUUID(),
  userId: other,
  createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0, 100)),
};
const newestFirst = [...mine].reverse().map((row) => row.trajectoryId);

beforeAll(async () => {
  await database.insert(users).values([
    { id: person, email: `${person}@example.test`, name: "Person" },
    { id: other, email: `${other}@example.test`, name: "Other" },
    { id: micro, email: `${micro}@example.test`, name: "Micro" },
  ]);
  await database.insert(recorderTrajectoryBindings).values([...mine, theirs]);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [person, other, micro]));
  await database.$client.close();
});

describe("pageForUser", () => {
  test("a person's rows come newest first, a page at a time", async () => {
    const first = await store.pageForUser(person, null, 2);
    expect(first.ids.map((row) => row.trajectoryId)).toEqual(
      newestFirst.slice(0, 2),
    );
    expect(first.ids[0]?.createdAt).toEqual(mine[4]?.createdAt as Date);
    expect(first.nextCursor).not.toBeNull();
  });

  test("the cursor round-trips across three pages, with none skipped or repeated", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await store.pageForUser(person, cursor, 2);
      seen.push(...page.ids.map((row) => row.trajectoryId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(newestFirst);
  });

  test("another person's rows never appear", async () => {
    const page = await store.pageForUser(person, null, 50);
    expect(page.ids.map((row) => row.trajectoryId)).not.toContain(
      theirs.trajectoryId,
    );
    expect(page.nextCursor).toBeNull();
  });

  test("a cursor that will not decode throws a RangeError", async () => {
    await expect(store.pageForUser(person, "not-a-cursor")).rejects.toThrow(
      RangeError,
    );
    const noId = Buffer.from("2026-01-01T00:00:00.000Z|").toString("base64url");
    await expect(store.pageForUser(person, noId)).rejects.toThrow(
      "Invalid cursor",
    );
  });

  test("a cursor with a year Postgres cannot take is a RangeError, not a failed query", async () => {
    const far = Buffer.from(
      `+010000-01-01T00:00:00.000Z|${randomUUID()}`,
    ).toString("base64url");
    await expect(store.pageForUser(person, far)).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
    const early = Buffer.from(
      `-000001-01-01T00:00:00.000Z|${randomUUID()}`,
    ).toString("base64url");
    await expect(store.pageForUser(person, early)).rejects.toThrow(
      "Invalid cursor",
    );
  });

  test("rows written within one millisecond are neither skipped nor repeated", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await database.insert(recorderTrajectoryBindings).values(
      ids.map((trajectoryId, index) => ({
        trajectoryId,
        userId: micro,
        createdAt: sql`${`2026-01-02 12:00:00.000${index + 1}00+00`}::timestamptz`,
      })),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await store.pageForUser(micro, cursor, 1);
      seen.push(...page.ids.map((row) => row.trajectoryId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toEqual([...ids].sort().reverse());
  });
});

describe("bind, isBoundTo and boundTo", () => {
  test("the first person to bind a trajectory owns it; anyone else is refused", async () => {
    const trajectoryId = randomUUID();
    expect(await store.bind({ trajectoryId, userId: person })).toBe(true);
    expect(await store.bind({ trajectoryId, userId: person })).toBe(true);
    expect(await store.bind({ trajectoryId, userId: other })).toBe(false);
    expect(await store.isBoundTo(trajectoryId, person)).toBe(true);
    expect(await store.isBoundTo(trajectoryId, other)).toBe(false);
    expect(await store.isBoundTo(randomUUID(), person)).toBe(false);
  });

  test("boundTo answers which of many ids are this person's, in one query", async () => {
    const unbound = randomUUID();
    const found = await store.boundTo(person, [
      mine[0]?.trajectoryId as string,
      theirs.trajectoryId,
      unbound,
      mine[1]?.trajectoryId as string,
    ]);
    expect([...found].sort()).toEqual(
      [mine[0]?.trajectoryId, mine[1]?.trajectoryId].sort(),
    );
    expect((await store.boundTo(person, [])).size).toBe(0);
  });
});
