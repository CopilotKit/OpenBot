import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createRoutineRoutes } from "../src/routines/routes";
import { createRoutineRunner } from "../src/routines/runner";
import { RoutineRefusedError, type RoutineStore } from "../src/routines/store";

const actor = { id: "user-1", email: "m@openbot.test", role: "user" } as const;
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

function app(
  store: Partial<RoutineStore>,
  ran: string[],
  audits: unknown[] = [],
) {
  const hono = new Hono<{ Variables: AppVariables }>();
  hono.route(
    "/",
    createRoutineRoutes(store as RoutineStore, requireUser, {
      runner: { run: async (id) => void ran.push(id) },
      auditStore: { insert: async (entry) => void audits.push(entry) },
    }),
  );
  return hono;
}

test("Run now opens a run as the caller, hands it to the real runner, and audits it", async () => {
  const ran: string[] = [];
  const audits: unknown[] = [];
  const calls: unknown[][] = [];
  const response = await app(
    {
      async startManualRun(ownerUserId, id) {
        calls.push([ownerUserId, id]);
        return { runId: "routine_run_9" };
      },
    },
    ran,
    audits,
  ).request("http://openbot.test/routine-1/run", { method: "POST" });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    accepted: true,
    runId: "routine_run_9",
  });
  expect(calls).toEqual([["user-1", "routine-1"]]);
  expect(ran).toEqual(["routine_run_9"]);
  expect(audits[0]).toMatchObject({
    eventType: "routines.run_requested",
    targetId: "routine-1",
  });
});

test("Run now on a paused routine is refused and nothing runs", async () => {
  const ran: string[] = [];
  const response = await app(
    {
      async startManualRun() {
        throw new RoutineRefusedError(
          "This routine is paused, and paused routines never run. Switch it on first.",
        );
      },
    },
    ran,
  ).request("http://openbot.test/routine-1/run", { method: "POST" });
  expect(response.status).toBe(400);
  expect(ran).toEqual([]);
});

test("run history maps an open run to running and serializes times", async () => {
  const response = await app(
    {
      async listRuns() {
        return [
          {
            id: "r2",
            status: null,
            startedAt: new Date("2026-09-29T10:00:00Z"),
            finishedAt: null,
            error: null,
          },
          {
            id: "r1",
            status: "failed",
            startedAt: new Date("2026-09-29T09:00:00Z"),
            finishedAt: new Date("2026-09-29T09:01:00Z"),
            error: "boom",
          },
        ];
      },
    },
    [],
  ).request("http://openbot.test/routine-1/runs");
  expect(await response.json()).toEqual({
    runs: [
      {
        id: "r2",
        status: "running",
        startedAt: "2026-09-29T10:00:00.000Z",
        finishedAt: null,
        error: null,
      },
      {
        id: "r1",
        status: "failed",
        startedAt: "2026-09-29T09:00:00.000Z",
        finishedAt: "2026-09-29T09:01:00.000Z",
        error: "boom",
      },
    ],
  });
});

test("the runner fails closed: a paused routine's run is skipped without a turn", async () => {
  const finished: unknown[][] = [];
  let turns = 0;
  const runner = createRoutineRunner({
    routineStore: {
      async runContext() {
        return {
          routineId: "routine-1",
          ownerUserId: "user-1",
          agentId: "bot-1",
          channelId: "channel-1",
          instruction: "x",
          enabled: false,
        };
      },
      async finishRun(...args: unknown[]) {
        finished.push(args);
      },
    } as unknown as RoutineStore,
    channelStore: {} as never,
    runTurn: async () => {
      turns += 1;
      return { replyText: "" };
    },
  });
  await runner.run("routine_run_1");
  expect(turns).toBe(0);
  expect(finished).toEqual([
    ["routine_run_1", "skipped", "the routine is paused"],
  ]);
});
