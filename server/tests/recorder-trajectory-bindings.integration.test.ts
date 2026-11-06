import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { recorderTrajectoryBindings } from "../src/db/schema/recorder";
import { createTrajectoryBindingStore } from "../src/recorder/trajectory-bindings";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createTrajectoryBindingStore(database);
const prefix = `trajectory-bindings-${randomUUID()}`;
const person = `${prefix}-person`;
const other = `${prefix}-other`;

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
  ]);
  await database.insert(recorderTrajectoryBindings).values([...mine, theirs]);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [person, other]));
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
});
