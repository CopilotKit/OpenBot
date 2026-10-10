import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createSignInRoutes } from "../src/passwords/routes";

/**
 * Guess-rate budgets on the sign-in routes.
 *
 * `POST /:id/submit` and `POST /:id/use-saved` both verify something guessable — the
 * typed password and, worse, the short numeric second-factor code — with no bound on
 * attempts: one request per guess, forever. These budgets bound each person to a few
 * dozen code attempts per window and refuse the rest with 429, while reads and state
 * transitions on the person's own requests are untouched.
 */

function testApp(clock: { now: number }) {
  const service = {
    request: async () => ({ id: "req-1" }),
    get: async () => ({ id: "req-1", status: "open" }),
    pending: async () => [],
    submit: async () => ({ ok: true }),
    useSaved: async () => ({ ok: true }),
  };
  const requireUser = async (
    context: {
      set: (key: "actor", value: AppVariables["actor"]) => void;
      req: { header: (name: string) => string | undefined };
    },
    next: () => Promise<void>,
  ) => {
    const actor = context.req.header("x-actor") ?? "owner";
    context.set("actor", {
      id: actor,
      email: `${actor}@openbot.test`,
    } as AppVariables["actor"]);
    await next();
  };
  const root = new Hono<{ Variables: AppVariables }>();
  root.route(
    "/api/sign-in-requests",
    createSignInRoutes(
      service as never,
      requireUser as never,
      async () => true,
      {
        submit: { windowMs: 60_000, max: 2 },
        request: { windowMs: 60_000, max: 1 },
        now: () => clock.now,
      },
    ),
  );
  return root;
}

const post = (path: string, body: unknown, actor?: string) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(actor ? { "x-actor": actor } : {}),
    },
    body: JSON.stringify(body),
  });

describe("sign-in code attempt budgets", () => {
  test("two code attempts pass and the third is refused with a Retry-After", async () => {
    const app = testApp({ now: 1_000_000 });
    const attempt = () =>
      app.request(
        post("/api/sign-in-requests/req-1/submit", {
          password: "Tr0ub4dor&3-never-show-me",
          code: "000000",
        }),
      );
    expect((await attempt()).status).toBe(200);
    expect((await attempt()).status).toBe(200);
    const refused = await attempt();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
  });

  test("submit and use-saved share one code budget, and the refusal echoes nothing", async () => {
    const app = testApp({ now: 1_000_000 });
    const secret = "Tr0ub4dor&3-never-show-me";
    expect(
      (
        await app.request(
          post("/api/sign-in-requests/req-1/submit", {
            password: secret,
            code: "000000",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          post("/api/sign-in-requests/req-1/use-saved", {
            loginId: "login-1",
            code: "000001",
          }),
        )
      ).status,
    ).toBe(200);
    // The shared budget is spent: a third code guess, on either route, is refused —
    // and the refusal is one fixed sentence carrying neither the password nor the code.
    const refused = await app.request(
      post("/api/sign-in-requests/req-1/submit", {
        password: secret,
        code: "000002",
      }),
    );
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toMatch(/Too many attempts/);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain("000002");
  });

  test("request creation has its own budget and reads are never limited", async () => {
    const app = testApp({ now: 1_000_000 });
    expect(
      (
        await app.request(
          post("/api/sign-in-requests", { botId: "bot", site: "example.com" }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          post("/api/sign-in-requests", { botId: "bot", site: "example.com" }),
        )
      ).status,
    ).toBe(429);
    // Reads of the person's own requests are not a guessing surface and stay open.
    expect(
      (await app.request("http://127.0.0.1/api/sign-in-requests")).status,
    ).toBe(200);
    expect(
      (await app.request("http://127.0.0.1/api/sign-in-requests/req-1")).status,
    ).toBe(200);
  });

  test("budgets belong to the actor, and the window passing re-opens them", async () => {
    const clock = { now: 1_000_000 };
    const app = testApp(clock);
    const submit = (actor: string) =>
      app.request(
        post(
          "/api/sign-in-requests/req-1/submit",
          { password: "x", code: "000000" },
          actor,
        ),
      );
    expect((await submit("guesser")).status).toBe(200);
    expect((await submit("guesser")).status).toBe(200);
    expect((await submit("guesser")).status).toBe(429);
    expect((await submit("bystander")).status).toBe(200);
    clock.now += 61_000;
    expect((await submit("guesser")).status).toBe(200);
  });
});
