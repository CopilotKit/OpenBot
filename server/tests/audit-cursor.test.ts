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
 * A cursor of the shape every page marker has: base64url JSON holding an object.
 *
 * The cursor is the trail's own, and the trail is in Intelligence: it names the last row's moment to
 * the microsecond and its id, bound to the filters that made it, and Intelligence decides whether it
 * can continue from it. What this server can refuse before any round trip is only what no cursor can
 * be, so this is what passes here; `audit-cursor.integration.test.ts` drives the cursors that pass
 * this and still cannot be read (an id that is no uuid, a `createdAt` that is a number) through the
 * route to the real trail, where they answer 400.
 */
function validCursor(): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      o: "2026-08-13T12:00:00.000000Z",
      i: "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
      b: "binding",
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

  test("a cursor that holds no object is refused here, before anything is asked", () => {
    /*
     * Every cursor this endpoint issues is base64url JSON holding an object. One holding anything else
     * — a number, a string, a list, null — was hand-edited or truncated, and is refused here rather
     * than sent to the trail. Fields of the wrong shape inside an object (an id that is no uuid, a
     * `createdAt` that is a number and once read as 1970) are the trail's to refuse; those cases are
     * in `audit-cursor.integration.test.ts`, against the real one.
     */
    for (const page of [
      7,
      "6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11",
      ["6f1b7f28-6b2d-4d1b-9a2a-1c0b4b2c8a11", "2026-08-13T12:00:00.000Z"],
      null,
      true,
    ]) {
      const cursor = cursorOf(page);
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

      // The value is named so a red run says which shape got through rather than only that one did.
      expect(`${JSON.stringify(page)}: ${outcome}`).toBe(
        `${JSON.stringify(page)}: refused as a query error`,
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
