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

function validCursor(): string {
  return Buffer.from(
    JSON.stringify({ id: "event-1", createdAt: "2026-08-13T12:00:00.000Z" }),
  ).toString("base64url");
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
