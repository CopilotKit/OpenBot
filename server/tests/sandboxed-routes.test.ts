import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createSandboxedRoutes } from "../src/components/sandboxed-routes";

/**
 * A component's title is what a person picks it out of the grid by, and what a Bot is told the
 * component is called. A title of spaces leaves both with nothing to read, and the slug's own
 * pattern check cannot catch it: the two are separate fields.
 *
 * The sibling endpoints already refuse one. `POST /api/servers/custom` and `POST /api/skills` both
 * take the trimmed value or answer 400; this route was the third of that shape.
 */

const ADMIN = {
  id: "u1",
  email: "admin@openbot.test",
  role: "admin",
} as const;

function app(role: "admin" | "user" = "admin") {
  const saved: Array<{ slug: string; title: string }> = [];

  const store = {
    list: async () => [],
    published: async () => [],
    save: async (input: { slug: string; title: string }) => {
      saved.push({ slug: input.slug, title: input.title });
      return { name: input.slug, title: input.title };
    },
  } as never;

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN, role });
    await next();
  };

  return {
    saved,
    hono: new Hono().route(
      "/api/sandboxed",
      createSandboxedRoutes(store, requireUser),
    ),
  };
}

const post = (body: Record<string, unknown>) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("saving a sandboxed component", () => {
  test("refuses a title that is only whitespace", async () => {
    const { saved, hono } = app();

    const response = await hono.request(
      "http://t/api/sandboxed",
      post({ slug: "weather_card", title: "   " }),
    );

    expect(response.status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("refuses a missing title, as it always did", async () => {
    const { saved, hono } = app();

    const response = await hono.request(
      "http://t/api/sandboxed",
      post({ slug: "weather_card" }),
    );

    expect(response.status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("stores a padded title without its padding", async () => {
    const { saved, hono } = app();

    const response = await hono.request(
      "http://t/api/sandboxed",
      post({ slug: "weather_card", title: "  Weather card  " }),
    );

    expect(response.status).toBe(200);
    expect(saved).toEqual([{ slug: "weather_card", title: "Weather card" }]);
  });

  test("leaves an ordinary title alone", async () => {
    const { saved, hono } = app();

    await hono.request(
      "http://t/api/sandboxed",
      post({ slug: "weather_card", title: "Weather card" }),
    );

    expect(saved).toEqual([{ slug: "weather_card", title: "Weather card" }]);
  });
});
