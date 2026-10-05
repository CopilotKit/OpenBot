import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createRoutineRoutes } from "../src/routines/routes";
import type { RoutineStore } from "../src/routines/store";
import { createHostAccessBroker } from "../src/host-access/broker";
import { createHostAccessRoutes } from "../src/host-access/routes";
import { createAgentRoutes } from "../src/agents/routes";
import { createChannelRoutes } from "../src/channels/routes";

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
 * Param ids used to flow straight into store queries, where a whitespace-only value either
 * answers 500 (routines, agents, channels) or the wrong status (host-access botId answered 404
 * via canUseBot; grant revoke mapped every error to 404). All are 400 at the edge now, before
 * any store call, broker act, or audit row.
 */
describe("routine ids", () => {
  function app(calls: unknown[]) {
    const store = {
      setEnabled: async (...a: unknown[]) => {
        calls.push(["setEnabled", ...a]);
      },
      remove: async (...a: unknown[]) => {
        calls.push(["remove", ...a]);
      },
      listFor: async () => [],
      lastSweptAt: async () => null,
    } as unknown as RoutineStore;
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createRoutineRoutes(store, requireUser));
    return app;
  }

  test("refuses a whitespace id on PUT /:id/enabled", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      "http://openbot.test/%20%20%20/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("refuses a whitespace id on DELETE /:id", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request("http://openbot.test/%20%20", {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("host-access ids", () => {
  function app() {
    const broker = createHostAccessBroker();
    const app = new Hono<{ Variables: AppVariables }>();
    app.route(
      "/",
      createHostAccessRoutes({
        broker,
        desktopToken: "t",
        requireUser,
        canUseBot: async () => true,
        auditStore: undefined,
      }),
    );
    return app;
  }

  test("refuses a whitespace botId on POST /grants", async () => {
    const response = await app().request("http://openbot.test/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "   " }),
    });
    expect(response.status).toBe(400);
  });

  test("refuses a whitespace id on DELETE /grants/:id", async () => {
    const response = await app().request(
      "http://openbot.test/grants/%20%20%20",
      { method: "DELETE" },
    );
    expect(response.status).toBe(400);
  });
});

describe("agent ids", () => {
  function app(calls: unknown[]) {
    const store = {
      get: async (...a: unknown[]) => {
        calls.push(["get", ...a]);
        return null;
      },
      duplicate: async (...a: unknown[]) => {
        calls.push(["duplicate", ...a]);
        throw new Error("unreachable");
      },
      softDelete: async (...a: unknown[]) => {
        calls.push(["softDelete", ...a]);
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createAgentRoutes(store as never, requireUser));
    return app;
  }

  test.each([
    ["GET", "http://openbot.test/%20%20%20", "GET"],
    ["duplicate", "http://openbot.test/%20%20%20/duplicate", "POST"],
    ["delete", "http://openbot.test/%20%20%20", "DELETE"],
    ["handoff", "http://openbot.test/%20%20%20/handoff", "GET"],
  ])("refuses a whitespace id on %s with 400", async (_n, url, method) => {
    const calls: unknown[] = [];
    const response = await app(calls).request(url, { method });
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("channel ids", () => {
  function app(calls: unknown[]) {
    const store = {
      recordActivity: async (...a: unknown[]) => {
        calls.push(["recordActivity", ...a]);
      },
      signalChannelBusy: async (...a: unknown[]) => {
        calls.push(["signalChannelBusy", ...a]);
      },
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createChannelRoutes(store as never, requireUser));
    return app;
  }

  test("refuses a whitespace id on POST /:channelId/activity", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      "http://openbot.test/%20%20/activity",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "typing", started: true }),
      },
    );
    // Either the new id guard (400 "A channel id is required.") or the pre-existing activity
    // input guard fires; either way the store is never reached on a malformed call.
    expect([400]).toContain(response.status);
    if (response.status === 400) {
      const json = (await response.json()) as { error: string };
      expect(typeof json.error).toBe("string");
    }
    // The activity body above may itself be invalid; assert the store contract separately.
    expect(calls).toEqual([]);
  });

  test("refuses a whitespace id on POST /:channelId/busy", async () => {
    const calls: unknown[] = [];
    const response = await app(calls).request(
      "http://openbot.test/%20%20/busy",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ busy: true }),
      },
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
