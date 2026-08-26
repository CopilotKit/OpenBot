import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createRoutineRoutes } from "../src/routines/routes";
import {
  RoutineNotFoundError,
  RoutineRefusedError,
  type RoutineStore,
  type RoutineSummary,
} from "../src/routines/store";

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

function summary(overrides: Partial<RoutineSummary> = {}): RoutineSummary {
  return {
    id: "routine-1",
    agentId: "agent-1",
    instruction: "Post the weather every weekday morning.",
    schedule: "Weekdays at 09:00",
    timezone: "UTC",
    enabled: true,
    nextRunAt: new Date("2026-08-27T09:00:00.000Z"),
    channelId: "channel-1",
    channelName: "Assistant channel",
    channelDeleted: false,
    lastRun: {
      status: "succeeded",
      finishedAt: new Date("2026-08-26T09:00:00.000Z"),
    },
    ...overrides,
  };
}

type StoreCall = [method: keyof RoutineStore, ...arguments_: unknown[]];

function fakeStore(
  overrides: Partial<RoutineStore> = {},
): RoutineStore & { calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const base: RoutineStore = {
    async create() {
      throw new Error("not used by these tests");
    },
    async listFor(ownerUserId) {
      calls.push(["listFor", ownerUserId]);
      return [summary()];
    },
    async update() {
      throw new Error("not used by these tests");
    },
    async remove(ownerUserId, id) {
      calls.push(["remove", ownerUserId, id]);
    },
    async setEnabled(ownerUserId, id, enabled) {
      calls.push(["setEnabled", ownerUserId, id, enabled]);
    },
    async dueRoutines() {
      return [];
    },
    async advanceNextRun() {
      return false;
    },
    async insertRun() {
      return { runId: "routine_run-1" };
    },
    async runContext() {
      return null;
    },
    async routineForFiring() {
      return null;
    },
    async finishRun() {},
    async consecutiveFailures() {
      return 0;
    },
  };

  return Object.assign(base, overrides, { calls });
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
  Promise.resolve(context.json({ error: "denied" }, 401));

function appFor(
  store: RoutineStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createRoutineRoutes(store, middleware));
  return app;
}

async function json(response: Response) {
  return response.json();
}

describe("GET /", () => {
  test("lists the caller's own routines as words, not cron", async () => {
    const store = fakeStore();
    const response = await appFor(store).request("http://openbot.test/");

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      routines: [
        {
          id: "routine-1",
          schedule: "Weekdays at 09:00",
          timezone: "UTC",
          instruction: "Post the weather every weekday morning.",
          channel: { id: "channel-1", name: "Assistant channel", gone: false },
          enabled: true,
          nextRunAt: "2026-08-27T09:00:00.000Z",
          lastRun: { status: "succeeded", at: "2026-08-26T09:00:00.000Z" },
        },
      ],
    });
    expect(store.calls).toEqual([["listFor", actor.id]]);
  });

  test("carries no lastRun when the routine has never fired", async () => {
    const store = fakeStore({
      listFor: async () => [summary({ lastRun: null })],
    });
    const response = await appFor(store).request("http://openbot.test/");

    expect((await json(response)).routines[0].lastRun).toBeNull();
  });

  test("an open run stays an object with a null status, never collapsed to null", async () => {
    const store = fakeStore({
      listFor: async () => [
        summary({ lastRun: { status: null, finishedAt: null } }),
      ],
    });
    const response = await appFor(store).request("http://openbot.test/");

    expect((await json(response)).routines[0].lastRun).toEqual({
      status: null,
      at: null,
    });
  });

  test("a channel with no name and gone reads as gone with a null name", async () => {
    const store = fakeStore({
      listFor: async () => [
        summary({ channelName: null, channelDeleted: true }),
      ],
    });
    const response = await appFor(store).request("http://openbot.test/");

    expect((await json(response)).routines[0].channel).toEqual({
      id: "channel-1",
      name: null,
      gone: true,
    });
  });

  test("the DTO carries the schedule as words and never a cron field", async () => {
    const store = fakeStore();
    const response = await appFor(store).request("http://openbot.test/");
    const body = await json(response);

    expect(body.routines[0].schedule).toBe("Weekdays at 09:00");
    expect(JSON.stringify(body)).not.toContain("cron");
  });

  test("refuses without a session, before the store is asked", async () => {
    const store = fakeStore();
    const response = await appFor(store, denied).request(
      "http://openbot.test/",
    );

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

describe("PUT /:id/enabled", () => {
  test("switches a routine on or off through the authenticated actor", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/routine-1/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ enabled: false });
    expect(store.calls).toEqual([["setEnabled", actor.id, "routine-1", false]]);
  });

  test.each([
    ["{", "enabled must be true or false."],
    [JSON.stringify({}), "enabled must be true or false."],
    [JSON.stringify({ enabled: "yes" }), "enabled must be true or false."],
    [JSON.stringify({ enabled: 1 }), "enabled must be true or false."],
  ])("rejects a malformed body: %p", async (body, error) => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/routine-1/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      },
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error });
    expect(store.calls).toEqual([]);
  });

  test("another owner's routine reads exactly like one that does not exist", async () => {
    const store = fakeStore({
      setEnabled: async () => {
        throw new RoutineNotFoundError();
      },
    });
    const missingStore = fakeStore({
      setEnabled: async () => {
        throw new RoutineNotFoundError();
      },
    });

    const notMine = await appFor(store).request(
      "http://openbot.test/somebody-elses-routine/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    const missing = await appFor(missingStore).request(
      "http://openbot.test/no-such-routine/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    const notMineBody = await json(notMine);
    expect(notMineBody).toEqual(await json(missing));
    expect(notMineBody).toEqual({ error: "That routine does not exist." });
  });

  test("carries a store refusal's sentence verbatim as a 400", async () => {
    const store = fakeStore({
      setEnabled: async () => {
        throw new RoutineRefusedError(
          "You already have 20 routines switched on. Switch one off before adding another.",
        );
      },
    });
    const response = await appFor(store).request(
      "http://openbot.test/routine-1/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({
      error:
        "You already have 20 routines switched on. Switch one off before adding another.",
    });
  });

  test("refuses without a session, before the store is asked", async () => {
    const store = fakeStore();
    const response = await appFor(store, denied).request(
      "http://openbot.test/routine-1/enabled",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });
});

describe("DELETE /:id", () => {
  test("stops a routine through the authenticated actor", async () => {
    const store = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/routine-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(204);
    expect(store.calls).toEqual([["remove", actor.id, "routine-1"]]);
  });

  test("another owner's routine reads exactly like one that does not exist", async () => {
    const notMineStore = fakeStore({
      remove: async () => {
        throw new RoutineNotFoundError();
      },
    });
    const missingStore = fakeStore({
      remove: async () => {
        throw new RoutineNotFoundError();
      },
    });

    const notMine = await appFor(notMineStore).request(
      "http://openbot.test/somebody-elses-routine",
      { method: "DELETE" },
    );
    const missing = await appFor(missingStore).request(
      "http://openbot.test/no-such-routine",
      { method: "DELETE" },
    );

    expect(notMine.status).toBe(404);
    expect(missing.status).toBe(404);
    const notMineBody = await json(notMine);
    expect(notMineBody).toEqual(await json(missing));
    expect(notMineBody).toEqual({ error: "That routine does not exist." });
  });

  test("refuses without a session, before the store is asked", async () => {
    const store = fakeStore();
    const response = await appFor(store, denied).request(
      "http://openbot.test/routine-1",
      { method: "DELETE" },
    );

    expect(response.status).toBe(401);
    expect(store.calls).toEqual([]);
  });
});
