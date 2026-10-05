import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditReader } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * What a hand-edited cursor does to the admin trail, asked of the database that parses it.
 *
 * `audit-cursor.test.ts` pins the refusal itself and runs against a stub reader, which is the wrong
 * witness for this one: a stub takes any cursor at all, so the failure it cannot show is the only
 * failure there was. `audit_events.id` is a `uuid`, the cursor's `id` goes into
 * `lt(auditEvents.id, cursor.id)`, and an id that is not a uuid is PostgreSQL raising `invalid
 * input syntax for type uuid` from inside `createAuditReader.list` — past the route's
 * `AuditQueryError` catch, which knows only about the sentence `decodeCursor` throws, and out as a
 * 500 on a request whose only fault was a stale bookmark.
 *
 * So this drives the real cursor through the real route over the real database, and asserts the
 * STATUS CODE, because the status code is the whole difference between "you sent something I cannot
 * read" and "this deployment is broken".
 */

const config = loadConfig({ ...testEnvironment() });

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);

const adminAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "admin", email: "admin@openbot.test" },
    }),
  },
};

function adminApp() {
  return createApp(
    config,
    adminAuth,
    { rolesForUser: async () => ["admin"] },
    createAuditReader(database),
  );
}

function cursorOf(page: unknown): string {
  return Buffer.from(JSON.stringify(page)).toString("base64url");
}

describe("a cursor the trail's own columns have to parse", () => {
  test("an id no uuid column can read answers 400, not 500", async () => {
    const response = await adminApp().request(
      `http://openbot.local/api/admin/audit-events?cursor=${cursorOf({
        id: "event-1",
        createdAt: "2026-08-13T12:00:00.000Z",
      })}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "cursor must be a valid audit page cursor",
    });
  });

  test("an id that is not a string at all answers 400, not 500", async () => {
    // Truthy, which is all the guard used to ask of it, and bound into a uuid comparison unchanged.
    const response = await adminApp().request(
      `http://openbot.local/api/admin/audit-events?cursor=${cursorOf({
        id: 7,
        createdAt: "2026-08-13T12:00:00.000Z",
      })}`,
    );

    expect(response.status).toBe(400);
  });

  test("a cursor the endpoint itself would issue still pages", async () => {
    /*
     * THE LIMIT ON THE REFUSAL, against the reader that builds the query rather than a stub that
     * records it: a uuid id and an ISO timestamp — which is exactly what `encodeCursor` writes out
     * of a row — still reaches the database and answers a page.
     */
    const response = await adminApp().request(
      `http://openbot.local/api/admin/audit-events?cursor=${cursorOf({
        id: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
        createdAt: "2026-08-13T12:00:00.000Z",
      })}&limit=1`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("events");
  });
});

/**
 * Walking the trail with the cursor the endpoint itself hands out.
 *
 * `created_at` keeps microseconds and a JavaScript `Date` keeps milliseconds, so a cursor built from
 * the row as the driver returns it names a moment slightly before the row it was taken from. Rows
 * written in the same millisecond as the last one on a page then compare as newer than the cursor
 * and never come back on any page.
 */
describe("a cursor over rows written within one millisecond", () => {
  const reader = createAuditReader(database);

  /** Rows in one statement, so they share `now()`, at the given microsecond offsets into its millisecond. */
  async function rowsAt(targetId: string, micros: number[]) {
    return database
      .insert(auditEvents)
      .values(
        micros.map((offset) => ({
          eventType: "configuration.changed",
          targetType: "audit_cursor_test",
          targetId,
          payload: {},
          createdAt: sql`date_trunc('milliseconds', now()) + ${offset}::int * interval '1 microsecond'`,
        })),
      )
      .returning({ id: auditEvents.id });
  }

  async function walk(targetId: string) {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await reader.list({
        targetId,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...result.events.map((event) => event.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return seen;
  }

  test("reaches every row, newest first, when they are microseconds apart", async () => {
    const targetId = `cursor-precision-${crypto.randomUUID()}`;
    const [newest, middle, oldest] = await rowsAt(targetId, [789, 456, 123]);

    expect(await walk(targetId)).toEqual([newest?.id, middle?.id, oldest?.id]);
  });

  test("reaches every row when they share one instant", async () => {
    const targetId = `cursor-precision-${crypto.randomUUID()}`;
    const rows = await rowsAt(targetId, [456, 456, 456]);
    // One instant, so the id alone orders them, descending as the reader does.
    const expected = rows
      .map((row) => row.id)
      .sort()
      .reverse();

    expect(await walk(targetId)).toEqual(expected);
  });
});
