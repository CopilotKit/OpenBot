import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AuditReader } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import type { PolicyStore } from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";

/**
 * The dry-run answers from history, so its window is the answer.
 *
 * The route used to read `typeof limit === "number" ? limit : 200` and clamp, which meant
 * `"abc"`, `null` and `true` silently became 200, `Infinity` silently became 500, fractions
 * were silently truncated, and `NaN` became `NaN` and travelled into `auditReader.list`.
 * A what-if answered from the wrong slice of history is worse than no answer.
 */

const ADMIN = { id: "u1", email: "admin@openbot.test", role: "admin" } as const;
const POLICY = { mode: "enforce", deny: [], allow: [] };

function app(seen: { limit?: number }[]) {
  const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN });
    await next();
  };
  const auditReader = {
    list: async (query: { limit?: number }) => {
      seen.push({
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      });
      return { events: [], nextCursor: undefined };
    },
  } as unknown as AuditReader;
  const routes = createComputerRoutes(
    {} as never,
    {} as PolicyStore,
    asActor,
    async () => false,
    undefined,
    auditReader,
  );
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/computers",
    routes,
  );
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /api/computers/policy-dry-run limit", () => {
  test("an absent limit still replays the default window", async () => {
    const seen: { limit?: number }[] = [];
    const response = await app(seen).request(
      "http://t/api/computers/policy-dry-run",
      post({ policy: POLICY }),
    );

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ limit: 200 }]);
  });

  test.each([[1], [200], [500]])(
    "a limit of %s reaches the reader",
    async (limit) => {
      const seen: { limit?: number }[] = [];
      const response = await app(seen).request(
        "http://t/api/computers/policy-dry-run",
        post({ policy: POLICY, limit }),
      );

      expect(response.status).toBe(200);
      expect(seen).toEqual([{ limit }]);
    },
  );

  test.each([
    ["a string", "200"],
    ["null", null],
    ["true", true],
    ["an object", {}],
    ["an array", [200]],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["a negative", -5],
    ["above the ceiling", 501],
    ["a fraction", 200.5],
    ["an empty string", ""],
  ])("rejects %s with 400 and never reads history", async (_name, limit) => {
    const seen: { limit?: number }[] = [];
    const response = await app(seen).request(
      "http://t/api/computers/policy-dry-run",
      post({ policy: POLICY, limit }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "limit must be a whole number between 1 and 500.",
    });
    expect(seen).toEqual([]);
  });

  test("a malformed policy still answers 400 before the limit is read", async () => {
    const seen: { limit?: number }[] = [];
    const response = await app(seen).request(
      "http://t/api/computers/policy-dry-run",
      post({ policy: { mode: "nope" }, limit: "abc" }),
    );

    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  });
});
