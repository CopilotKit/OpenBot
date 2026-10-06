import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import type { AppVariables } from "../src/auth/guards";
import { createComputerRoutes } from "../src/computer/routes";
import { loadConfig } from "../src/config";
import type { RoutineRunner } from "../src/routines/runner";
import type { IntentRouter } from "../src/routing/classify";
import { createRoutingRoutes } from "../src/routing/routes";
import { createCoworkerRoutingService } from "../src/routing/service";
import { testEnvironment } from "./support/environment";

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: "user-1",
    email: "user@openbot.test",
    role: "admin",
  });
  await next();
};

/**
 * Unbounded `text` becomes the model prompt in the router. A multi-megabyte body would force a
 * timeout or OOM; over 10000 characters is now a 400 before the roster is read or the model is
 * asked.
 */
describe("POST /api/route text cap", () => {
  function app(calls: unknown[]) {
    const store = { list: async () => [] };
    const router = {
      route: async (...a: unknown[]) => {
        calls.push(a);
        return { chosen: "bot-1" };
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createRoutingRoutes(
        createCoworkerRoutingService({
          store: store as unknown as AgentProfileStore,
          router: router as unknown as IntentRouter,
        }),
        requireUser,
      ),
    );
    return app;
  }

  test("refuses oversized text with 400 and never routes", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(10001) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A message of at most 10000 characters is required.",
    });
    expect(calls).toEqual([]);
  });

  test("accepts a message at the cap boundary", async () => {
    const calls: unknown[] = [];
    // Empty roster -> 409 "No coworker is available.", which still proves the text passed the
    // cap and reached the router path.
    const response = await app(calls).request("http://openbot.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(10000) }),
    });
    expect(response.status).toBe(409);
  });
});

const SECRET = "worker-shared-secret";

function internalApp(runner: RoutineRunner | undefined) {
  const args: Parameters<typeof createApp> = [
    loadConfig({ ...testEnvironment(), WORKER_SHARED_SECRET: SECRET }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runner,
  ];
  return createApp(...args);
}

/**
 * `""` is a string and used to answer 202 Accepted while the worker swallowed the failure.
 * Only a non-empty run id is accepted for dispatch now.
 */
describe("POST /internal/routines/run id", () => {
  test.each([
    ["empty", ""],
    ["whitespace", "   "],
  ])(
    "refuses a %s routineRunId with 400 and never runs",
    async (_n, routineRunId) => {
      const calls: string[] = [];
      const app = internalApp({
        run: (id: string) => {
          calls.push(id);
          return Promise.resolve();
        },
      });
      const response = await app.request(
        "http://openbot.local/internal/routines/run",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SECRET}`,
          },
          body: JSON.stringify({ routineRunId }),
        },
      );
      expect(response.status).toBe(400);
      expect(calls).toEqual([]);
    },
  );
});

/**
 * Blank or overlong frame params can never name a stored frame. Refused here instead of
 * becoming junk reads against the frame table.
 */
describe("GET /api/computers/:botId/page-frame/:toolCallId", () => {
  function app(calls: unknown[]) {
    const pageFrames = {
      load: async (...a: unknown[]) => {
        calls.push(a);
        return null;
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createComputerRoutes(
        {} as never,
        {} as never,
        requireUser,
        async () => true,
        pageFrames as never,
      ),
    );
    return app;
  }

  test("returns null frame on the happy path", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      "http://openbot.test/bot-1/page-frame/turn-1",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ frame: null });
    expect(calls).toEqual([["bot-1", "turn-1"]]);
  });

  test("refuses an overlong toolCallId with 400 and never reads", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      `http://openbot.test/bot-1/page-frame/${"t".repeat(201)}`,
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
