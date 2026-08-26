import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAttentionStore } from "../src/attention/store";
import { createDatabase } from "../src/db/client";
import { attentionResolutions } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const store = createAttentionStore(database);

/** Rows this file wrote, removed on the way out. Resolutions are not the trail; they may be. */
const written: string[] = [];

afterAll(async () => {
  if (written.length > 0) {
    await database
      .delete(attentionResolutions)
      .where(inArray(attentionResolutions.auditEventId, written));
  }
  await database.$client.close();
});

describe("attention resolutions", () => {
  test("the first resolver wins and the second is told who did", async () => {
    const eventId = randomUUID();
    written.push(eventId);

    const first = await store.resolve(eventId, "person-a");
    expect(first.alreadyResolved).toBe(false);
    expect(first.resolvedBy).toBe("person-a");

    // The race, replayed: the unique index answers, not a check-then-write.
    const second = await store.resolve(eventId, "person-b");
    expect(second.alreadyResolved).toBe(true);
    expect(second.resolvedBy).toBe("person-a");
  });

  test("resolvedAmong answers exactly the resolved subset", async () => {
    const resolved = randomUUID();
    const pending = randomUUID();
    written.push(resolved);

    await store.resolve(resolved, "person-a");
    const answer = await store.resolvedAmong([resolved, pending]);
    expect(answer.has(resolved)).toBe(true);
    expect(answer.has(pending)).toBe(false);
  });

  test("an empty ask does not touch the database", async () => {
    expect((await store.resolvedAmong([])).size).toBe(0);
  });
});
