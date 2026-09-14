import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createSandboxedRoutes } from "../src/components/sandboxed-routes";

/**
 * The playground save writes text and jsonb columns, so its types are the database's.
 *
 * Only `slug` and `title` were checked. `description`, `html`, `css` and `jsFunctions`
 * flowed in as `?? ""` and `argumentSchema`/`sampleArguments` as `?? {}`, so a number,
 * an array or a JSON string travelled into a text/jsonb column and came back as an
 * unhandled 500. Absent still means the default; a present value must be its type.
 */

const ADMIN = {
  id: "u1",
  email: "admin@openbot.test",
  role: "admin",
} as const;

type Saved = {
  slug: string;
  title: string;
  description: unknown;
  html: unknown;
  css: unknown;
  jsFunctions: unknown;
  argumentSchema: unknown;
  sampleArguments: unknown;
};

function harness() {
  const saved: Saved[] = [];
  const store = {
    list: async () => [],
    published: async () => [],
    save: async (input: Saved) => {
      saved.push(input);
      return { name: input.slug, title: input.title };
    },
  } as never;

  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...ADMIN });
    await next();
  };

  const hono = new Hono().route(
    "/api/sandboxed",
    createSandboxedRoutes(store, requireUser),
  );
  return { saved, hono };
}

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const BASE = { slug: "weather_card", title: "Weather card" };

describe("saving a sandboxed component's optional fields", () => {
  test("stores defaults when only the required fields arrive", async () => {
    const { saved, hono } = harness();
    const response = await hono.request("http://t/api/sandboxed", post(BASE));

    expect(response.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      slug: "weather_card",
      title: "Weather card",
      description: "",
      html: "",
      css: "",
      jsFunctions: "",
      argumentSchema: {},
      sampleArguments: {},
    });
  });

  test("stores well-typed optional fields as given", async () => {
    const { saved, hono } = harness();
    const response = await hono.request(
      "http://t/api/sandboxed",
      post({
        ...BASE,
        description: "Shows the sky.",
        html: "<div/>",
        css: ".a{}",
        jsFunctions: "export const x = 1;",
        argumentSchema: { type: "object" },
        sampleArguments: { city: "Berlin" },
      }),
    );

    expect(response.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      description: "Shows the sky.",
      argumentSchema: { type: "object" },
      sampleArguments: { city: "Berlin" },
    });
  });

  test.each([
    ["description", 123],
    ["description", null],
    ["description", {}],
    ["description", ["text"]],
    ["html", 42],
    ["html", false],
    ["css", 0],
    ["css", null],
    ["jsFunctions", 7],
    ["jsFunctions", {}],
  ])(
    "refuses a non-string %s with 400 and saves nothing",
    async (field, value) => {
      const { saved, hono } = harness();
      const response = await hono.request(
        "http://t/api/sandboxed",
        post({ ...BASE, [field]: value }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `The component ${field} must be text.`,
      });
      expect(saved).toHaveLength(0);
    },
  );

  test.each([
    ["argumentSchema", "not-an-object"],
    ["argumentSchema", 42],
    ["argumentSchema", null],
    ["argumentSchema", []],
    ["argumentSchema", [{ type: "object" }]],
    ["sampleArguments", "city=Berlin"],
    ["sampleArguments", 7],
    ["sampleArguments", null],
    ["sampleArguments", []],
  ])(
    "refuses a non-object %s with 400 and saves nothing",
    async (field, value) => {
      const { saved, hono } = harness();
      const response = await hono.request(
        "http://t/api/sandboxed",
        post({ ...BASE, [field]: value }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `The component ${field} must be an object.`,
      });
      expect(saved).toHaveLength(0);
    },
  );

  test("a full body with one bad field still saves nothing", async () => {
    const { saved, hono } = harness();
    const response = await hono.request(
      "http://t/api/sandboxed",
      post({
        ...BASE,
        description: "Shows the sky.",
        html: "<div/>",
        css: ".a{}",
        jsFunctions: "export const x = 1;",
        argumentSchema: { type: "object" },
        sampleArguments: "city=Berlin",
      }),
    );

    expect(response.status).toBe(400);
    expect(saved).toHaveLength(0);
  });
});
