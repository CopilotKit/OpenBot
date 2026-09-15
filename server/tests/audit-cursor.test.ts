import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { AuditQueryError, auditQueryFromUrl } from "../src/audit";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const config = loadConfig({ ...testEnvironment() });

const adminAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "admin", email: "admin@openbot.test" },
    }),
  },
};

/**
 * A cursor of the shape this endpoint actually issues.
 *
 * THE ID IS A UUID BECAUSE THE COLUMN IS. `audit_events.id` is `uuid`, the only id a cursor can
 * carry is one `createAuditReader` read back off a row, and the comparison it is put into —
 * `lt(auditEvents.id, cursor.id)` — is the database parsing it as a uuid. This fixture used to say
 * `"event-1"`, which no page of this trail ever produced and which PostgreSQL answers with
 * `invalid input syntax for type uuid`, so the file's own idea of a valid cursor was one the
 * endpoint would have failed on.
 */
function validCursor(): string {
  return Buffer.from(
    JSON.stringify({
      id: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
      createdAt: "2026-08-13T12:00:00.000Z",
    }),
  ).toString("base64url");
}

/** A cursor carrying whatever a caller hand-edited into it. */
function cursorOf(page: unknown): string {
  return Buffer.from(JSON.stringify(page)).toString("base64url");
}

describe("audit cursor validation", () => {
  test("a corrupt cursor is a query error, not a server failure", () => {
    expect(() =>
      auditQueryFromUrl(
        new URL("http://openbot.local/api/admin/audit-events?cursor=!!bogus!!"),
      ),
    ).toThrow(AuditQueryError);
    expect(() =>
      auditQueryFromUrl(
        new URL(
          "http://openbot.local/api/admin/audit-events?cursor=bm90LWpzb24=",
        ),
      ),
    ).toThrow(/cursor must be a valid audit page cursor/);
  });

  test("a cursor whose id no uuid column could parse is refused here rather than by PostgreSQL", () => {
    /*
     * THE CHECK USED TO BE THAT THE ID WAS TRUTHY, which admits everything except the shapes JSON
     * rarely produces. `id` goes into `lt(auditEvents.id, cursor.id)` against a `uuid` column, so
     * a string that is not a uuid — and a number, which is truthy and not a string at all — is the
     * database being handed something it cannot parse: `invalid input syntax for type uuid`,
     * raised from inside `createAuditReader.list`, which is NOT an `AuditQueryError` and so leaves
     * the admin route as a 500.
     *
     * WHICH IS THE EXACT CASE THE GUARD IN `auditQueryFromUrl` EXISTS FOR. Its own comment says a
     * corrupt cursor is a caller error answering 400, and it was enforcing that for a cursor that
     * is not base64, not JSON, or missing the field — and not for one that carries a field of the
     * wrong shape. A stale bookmark from another deployment's trail is exactly the second.
     *
     * ASKED OF THE SHAPE, NOT OF EXISTENCE, so what the route promises is what the query builder
     * can actually be given. `audit-cursor.integration.test.ts` drives the same cursor through the
     * route against a real database, which is where the 500 was visible.
     */
    for (const id of [
      "event-1",
      "6f1b7f28-6b2d-4d1b-9a2a",
      7,
      true,
      { value: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11" },
      ["6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11"],
    ]) {
      const cursor = cursorOf({ id, createdAt: "2026-08-13T12:00:00.000Z" });
      const outcome = (() => {
        try {
          auditQueryFromUrl(
            new URL(
              `http://openbot.local/api/admin/audit-events?cursor=${cursor}`,
            ),
          );
          return "the cursor was accepted";
        } catch (error) {
          return error instanceof AuditQueryError
            ? "refused as a query error"
            : `refused as ${(error as Error).name}`;
        }
      })();

      // The id is named so a red run says which shape got through rather than only that one did.
      expect(`${JSON.stringify(id)}: ${outcome}`).toBe(
        `${JSON.stringify(id)}: refused as a query error`,
      );
    }
  });

  test("a cursor whose createdAt is a number is refused rather than read as epoch milliseconds", () => {
    /*
     * `Date.parse` TAKES A STRING, AND IT WILL MAKE ONE OUT OF WHATEVER IT IS GIVEN. `2020` becomes
     * `"2020"`, which parses as a year — so the guard passed — and the query builder then reads the
     * same field with `new Date(cursor.createdAt)`, which for a NUMBER is epoch milliseconds:
     * 2020ms after 1970. The page is then silently taken from the wrong end of the trail, with a
     * 200 and no sign anything was misread, which is the worse half of this whole class.
     *
     * So the field is required to BE a date string, rather than merely to survive being turned into
     * one. The year-shaped number is in the loop because it is the one that passed.
     */
    for (const createdAt of [
      2020,
      1_760_000_000_000,
      { iso: "2026-08-13T12:00:00.000Z" },
      ["2026-08-13T12:00:00.000Z"],
      true,
      null,
    ]) {
      const cursor = cursorOf({
        id: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
        createdAt,
      });
      const outcome = (() => {
        try {
          auditQueryFromUrl(
            new URL(
              `http://openbot.local/api/admin/audit-events?cursor=${cursor}`,
            ),
          );
          return "the cursor was accepted";
        } catch (error) {
          return error instanceof AuditQueryError
            ? "refused as a query error"
            : `refused as ${(error as Error).name}`;
        }
      })();

      expect(`${JSON.stringify(createdAt)}: ${outcome}`).toBe(
        `${JSON.stringify(createdAt)}: refused as a query error`,
      );
    }
  });

  test("a well-formed cursor still parses", () => {
    const query = auditQueryFromUrl(
      new URL(
        `http://openbot.local/api/admin/audit-events?cursor=${validCursor()}&limit=10`,
      ),
    );
    expect(query.cursor).toBe(validCursor());
    expect(query.limit).toBe(10);
  });

  test("the admin route answers 400 for a corrupt cursor instead of 500", async () => {
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      {
        list: async () => {
          throw new Error("must not reach the store with a bad cursor");
        },
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?cursor=!!bogus!!",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "cursor must be a valid audit page cursor",
    });
  });

  test("the admin route still pages with a valid cursor", async () => {
    const queries: unknown[] = [];
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      {
        list: async (query) => {
          queries.push(query);
          return { events: [], nextCursor: undefined };
        },
      },
    );

    const response = await app.request(
      `http://openbot.local/api/admin/audit-events?cursor=${validCursor()}`,
    );

    expect(response.status).toBe(200);
    expect(queries).toHaveLength(1);
  });
});
