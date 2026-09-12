import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createRoutineRoutes, SWEEP_SILENCE_MS } from "../src/routines/routes";
import type { RoutineStore } from "../src/routines/store";

const actor = { id: "user-1", email: "a@openbot.test", role: "user" } as const;

function app(lastSweptAt: Date | null) {
  const store = {
    listFor: async () => [],
    lastSweptAt: async () => lastSweptAt,
  } as unknown as RoutineStore;

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor as never);
    await next();
  };

  return new Hono().route("/", createRoutineRoutes(store, requireUser));
}

async function sweepOf(lastSweptAt: Date | null) {
  const response = await app(lastSweptAt).request("/");
  const body = (await response.json()) as {
    sweep: { lastSweptAt: string | null; working: boolean };
  };
  return body.sweep;
}

describe("whether anything is firing routines at all", () => {
  test("says nothing is working when no sweep has ever run", async () => {
    expect(await sweepOf(null)).toEqual({ lastSweptAt: null, working: false });
  });

  test("says it is working while a sweep is recent", async () => {
    const sweep = await sweepOf(new Date(Date.now() - 60_000));
    expect(sweep.working).toBe(true);
    expect(sweep.lastSweptAt).not.toBeNull();
  });

  test("says nothing is working once a worker has gone quiet", async () => {
    const quiet = new Date(Date.now() - SWEEP_SILENCE_MS - 60_000);
    const sweep = await sweepOf(quiet);
    expect(sweep.working).toBe(false);
    expect(sweep.lastSweptAt).toBe(quiet.toISOString());
  });

  test("a routine's own page still answers when the sweep cannot be read", async () => {
    const store = {
      listFor: async () => [],
      lastSweptAt: async () => {
        throw new Error("the database said no");
      },
    } as unknown as RoutineStore;
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", actor as never);
      await next();
    };
    const response = await new Hono()
      .route("/", createRoutineRoutes(store, requireUser))
      .request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sweep: { working: boolean } };
    expect(body.sweep.working).toBe(false);
  });
});
