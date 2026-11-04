import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createAuditReader } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { seedAuditEvents, useTestAuditTrail } from "./support/audit";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * What a hand-edited cursor does to the admin trail, asked of the trail that parses it.
 *
 * `audit-cursor.test.ts` pins the refusal of cursors no page could issue and runs against a stub
 * reader, which is the wrong witness for this one: a stub takes any cursor at all, so the failure it
 * cannot show is the only failure there was. The trail is Intelligence's, and so is the cursor: it
 * names the last row's moment and id, and Intelligence reads both. A cursor whose id is not a uuid,
 * or whose `createdAt` is a number, used to reach PostgreSQL as `invalid input syntax for type uuid`
 * or as a page from fifty years away, past the route's `AuditQueryError` catch and out as a 500 (or
 * worse, a 200) on a request whose only fault was a stale bookmark.
 *
 * So this drives the real cursor through the real route to the real Intelligence, and asserts the
 * STATUS CODE, because the status code is the whole difference between "you sent something I cannot
 * read" and "this deployment is broken".
 */

const config = loadConfig({ ...testEnvironment() });
useTestAuditTrail();

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

  test("every shape of hand-edited cursor answers 400, never 500 or a page from the wrong end", async () => {
    /*
     * The shapes `audit-cursor.test.ts` used to refuse here, before any query: the trail's cursor is
     * Intelligence's now, so these are refused by Intelligence, and must still leave as the same 400
     * with the same sentence. A number for `createdAt` is the one that once answered 200 with a page
     * from 1970.
     */
    const cases = [
      ...[
        "event-1",
        "6f1b7f28-6b2d-4d1b-9a2a",
        7,
        true,
        { value: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11" },
        ["6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11"],
      ].map((id) => ({ id, createdAt: "2026-08-13T12:00:00.000Z" })),
      ...[
        2020,
        1_760_000_000_000,
        { iso: "2026-08-13T12:00:00.000Z" },
        ["2026-08-13T12:00:00.000Z"],
        true,
        null,
      ].map((createdAt) => ({
        id: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
        createdAt,
      })),
      // The shape this endpoint used to issue: a bookmark from before the trail moved.
      {
        id: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
        createdAt: "2026-08-13T12:00:00.000Z",
      },
    ];
    for (const page of cases) {
      const response = await adminApp().request(
        `http://openbot.local/api/admin/audit-events?cursor=${cursorOf(page)}`,
      );
      expect(`${JSON.stringify(page)}: ${response.status}`).toBe(
        `${JSON.stringify(page)}: 400`,
      );
      await expect(response.json()).resolves.toEqual({
        error: "cursor must be a valid audit page cursor",
      });
    }
  });

  test("a cursor the endpoint itself issued still pages", async () => {
    /*
     * THE LIMIT ON THE REFUSAL, against the real trail rather than a stub that records it: the cursor
     * the endpoint hands out reaches Intelligence and answers the next page.
     */
    const targetId = `cursor-issued-${crypto.randomUUID()}`;
    await seedAuditEvents(
      [1, 2].map(() => ({
        eventType: "configuration.changed",
        targetType: "audit_cursor_test",
        targetId,
      })),
    );
    const first = await adminApp().request(
      `http://openbot.local/api/admin/audit-events?targetId=${targetId}&limit=1`,
    );
    expect(first.status).toBe(200);
    const { nextCursor } = (await first.json()) as { nextCursor?: string };
    expect(nextCursor).toEqual(expect.any(String));

    const response = await adminApp().request(
      `http://openbot.local/api/admin/audit-events?targetId=${targetId}&cursor=${nextCursor}&limit=1`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
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

  /** Rows sharing one millisecond, at the given microsecond offsets into it, newest first back. */
  async function rowsAt(targetId: string, micros: number[]) {
    const millisecond = new Date().toISOString().slice(0, 23);
    const ids = await seedAuditEvents(
      micros.map((offset) => ({
        eventType: "configuration.changed",
        targetType: "audit_cursor_test",
        targetId,
        occurredAt: `${millisecond}${String(offset).padStart(3, "0")}Z`,
      })),
    );
    return ids.map((id) => ({ id }));
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

afterAll(async () => {
  await database.$client.close();
});
