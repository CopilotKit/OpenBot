import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createRateLimiter } from "../src/rate-limit";

/**
 * The sliding-window limiter behind the guess-rate budgets.
 *
 * Sign-in code verification had no bound on attempts at all, so the property that
 * matters is the boring one: the first `max` requests in a window pass, the next is
 * refused with 429 and a `Retry-After`, the window passing re-opens the budget, and
 * one key's guessing never spends another's.
 */

function testApp(
  options: { windowMs: number; max: number },
  clock: { now: number },
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    const actor = context.req.header("x-actor") ?? "user-1";
    context.set("actor", {
      id: actor,
      email: `${actor}@openbot.test`,
    } as AppVariables["actor"]);
    await next();
  });
  app.use("*", createRateLimiter({ ...options, now: () => clock.now }));
  app.get("/guarded", (context) => context.json({ ok: true }));
  app.get("/unguarded", (context) => context.json({ ok: true }));
  return app;
}

const get = (app: Hono, path: string, actor?: string) =>
  app.request(
    `http://openbot.local${path}`,
    actor ? { headers: { "x-actor": actor } } : undefined,
  );

describe("createRateLimiter", () => {
  test("the first max requests pass and the next is refused with a Retry-After", async () => {
    const clock = { now: 1_000_000 };
    const app = testApp({ windowMs: 60_000, max: 2 }, clock);
    expect((await get(app, "/guarded")).status).toBe(200);
    expect((await get(app, "/guarded")).status).toBe(200);
    const refused = await get(app, "/guarded");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    const body = (await refused.json()) as { error: string };
    expect(body.error).toMatch(/Try again in 60 seconds/);
  });

  test("the window passing re-opens the budget, and Retry-After counts down", async () => {
    const clock = { now: 1_000_000 };
    const app = testApp({ windowMs: 60_000, max: 1 }, clock);
    expect((await get(app, "/guarded")).status).toBe(200);
    expect((await get(app, "/guarded")).status).toBe(429);
    clock.now += 59_000;
    const almost = await get(app, "/guarded");
    expect(almost.status).toBe(429);
    expect(almost.headers.get("Retry-After")).toBe("1");
    clock.now += 1_000;
    expect((await get(app, "/guarded")).status).toBe(200);
  });

  test("one key's guessing never spends another's budget", async () => {
    const clock = { now: 1_000_000 };
    const app = testApp({ windowMs: 60_000, max: 1 }, clock);
    expect((await get(app, "/guarded", "guesser")).status).toBe(200);
    expect((await get(app, "/guarded", "guesser")).status).toBe(429);
    expect((await get(app, "/guarded", "bystander")).status).toBe(200);
  });

  test("expired buckets are pruned, so idle keys do not accumulate", async () => {
    const clock = { now: 1_000_000 };
    const app = testApp({ windowMs: 60_000, max: 1 }, clock);
    for (const actor of ["a", "b", "c"]) {
      expect((await get(app, "/guarded", actor)).status).toBe(200);
    }
    // Every bucket is now stale. If prune never ran, each of these would still count
    // the old attempt and refuse; instead all three pass on a clean window.
    clock.now += 61_000;
    for (const actor of ["a", "b", "c"]) {
      expect((await get(app, "/guarded", actor)).status).toBe(200);
    }
  });
});
