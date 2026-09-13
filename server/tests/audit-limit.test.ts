import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { AuditQueryError, auditQueryFromUrl } from "../src/audit";
import { loadConfig } from "../src/config";
import { PAGE_LIMIT_ERROR } from "../src/paging";
import { testEnvironment } from "./support/environment";

/**
 * The audit trail's page size, held to the same rule as every other list.
 *
 * `auditQueryFromUrl` matched `/^\d+$/` but fell back to 50 on anything else, so
 * `?limit=abc`, `?limit=12abc`, `?limit=3.9` and `?limit=-5` all silently returned the
 * default page while `?from=garbage` on the same endpoint answered 400. The channel and
 * people lists already answer 400 through `parsePageLimit`; this endpoint was the odd one.
 */

const config = loadConfig({ ...testEnvironment() });

const adminAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: "admin", email: "admin@openbot.test" },
    }),
  },
};

function query(search: string) {
  return auditQueryFromUrl(
    new URL(`http://openbot.local/api/admin/audit-events${search}`),
  );
}

describe("audit-events limit validation", () => {
  test("an absent limit still reads the default page", () => {
    expect(query("").limit).toBe(50);
  });

  test("a blank limit still reads the default page", () => {
    expect(query("?limit=").limit).toBe(50);
    expect(query("?limit=%20%20").limit).toBe(50);
  });

  test.each([[1], [10], [50], [100]])("a limit of %s still parses", (limit) => {
    expect(query(`?limit=${limit}`).limit).toBe(limit);
  });

  test("a well-formed but huge limit is clamped to the audit maximum", () => {
    expect(query("?limit=99999").limit).toBe(100);
  });

  test("a padded limit is read for its digits", () => {
    expect(query("?limit=%20%2010%20%20").limit).toBe(10);
  });

  test.each([
    ["letters", "abc"],
    ["a mixed typo", "12abc"],
    ["a decimal", "3.9"],
    ["a negative", "-5"],
    ["a hex literal", "0x10"],
    ["a plus sign", "+10"],
  ])("a limit of %s is a query error naming the parameter", (_name, limit) => {
    expect(() => query(`?limit=${encodeURIComponent(limit)}`)).toThrow(
      AuditQueryError,
    );
    expect(() => query(`?limit=${encodeURIComponent(limit)}`)).toThrow(
      PAGE_LIMIT_ERROR,
    );
  });

  test("the admin route answers 400 for a malformed limit and never reads", async () => {
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      {
        list: async () => {
          throw new Error("must not reach the store with a bad limit");
        },
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?limit=12abc",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: PAGE_LIMIT_ERROR,
    });
  });

  test("the admin route still pages with a valid limit", async () => {
    const queries: { limit?: number }[] = [];
    const app = createApp(
      config,
      adminAuth,
      { rolesForUser: async () => ["admin"] },
      {
        list: async (received) => {
          queries.push({ limit: (received as { limit: number }).limit });
          return { events: [], nextCursor: undefined };
        },
      },
    );

    const response = await app.request(
      "http://openbot.local/api/admin/audit-events?limit=10",
    );

    expect(response.status).toBe(200);
    expect(queries).toEqual([{ limit: 10 }]);
  });
});
