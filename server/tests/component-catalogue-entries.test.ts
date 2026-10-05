import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import type { CatalogueEntry, ComponentStore } from "../src/components/store";

/**
 * A build's announcement is a claim about what exists, so a malformed entry is a 400.
 *
 * The route used to drop entries that failed the shape check and answer 200 with the rest,
 * so `{"components": [{"name": 123}, "oops", null]}` returned `{added: []}` — the same body
 * as "already in sync". A deploy that typo'd a field published nothing and was told success.
 * An empty list still means "nothing to announce" and answers 200; anything present must
 * be complete, and the error names its index.
 */

const asSignedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { id: "u1", email: "someone@openbot.test" });
  return next();
};

function harness() {
  const published: CatalogueEntry[] = [];
  const store = {
    syncCatalogue: async (entries: CatalogueEntry[]) => {
      published.push(...entries);
      return { added: entries.map((entry) => entry.name) };
    },
  } as unknown as ComponentStore;

  const app = new Hono().route(
    "/components",
    createComponentRoutes(store, asSignedIn, undefined, async () => true),
  );

  return {
    published,
    announce: (components: unknown) =>
      app.request("http://openbot.local/components/catalogue", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ components }),
      }),
  };
}

function entry(over: Record<string, unknown> = {}) {
  return {
    name: "weatherPanel",
    title: "Weather",
    kind: "panel",
    description: "The forecast where the reader is.",
    ...over,
  };
}

describe("announcing a catalogue with malformed entries", () => {
  test("an empty list still syncs to nothing with 200", async () => {
    const { published, announce } = harness();
    const response = await announce([]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ added: [] });
    expect(published).toEqual([]);
  });

  test("a two-entry list with one malformed entry syncs neither", async () => {
    const { published, announce } = harness();
    const response = await announce([entry(), entry({ kind: {} })]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Component at index 1 needs a name, a title, a kind and a description.",
    });
    expect(published).toEqual([]);
  });

  test.each([
    ["a number", 123],
    ["a string", "oops"],
    ["null", null],
    ["an array", []],
  ])("refuses a non-object entry %s at its index", async (_name, bad) => {
    const { published, announce } = harness();
    const response = await announce([entry(), bad]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Component at index 1 needs a name, a title, a kind and a description.",
    });
    expect(published).toEqual([]);
  });

  test.each([
    ["a numeric name", { name: 123 }],
    ["a null title", { title: null }],
    ["a blank kind", { kind: "   " }],
    ["an empty description", { description: "" }],
    ["a missing description", { description: undefined }],
    ["an object kind", { kind: {} }],
  ])("refuses an entry with %s at index 0", async (_name, over) => {
    const { published, announce } = harness();
    const clean = entry();
    const body = { ...clean };
    for (const [key, value] of Object.entries(over)) {
      if (value === undefined) delete body[key as keyof typeof body];
      else (body as Record<string, unknown>)[key] = value;
    }
    const response = await announce([body]);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Component at index 0 needs a name, a title, a kind and a description.",
    });
    expect(published).toEqual([]);
  });

  test("three valid entries still publish together", async () => {
    const { published, announce } = harness();
    const response = await announce([
      entry(),
      entry({ name: "newsPanel", title: "News" }),
      entry({ name: "clockPanel", title: "Clock" }),
    ]);
    expect(response.status).toBe(200);
    expect(published.map((row) => row.name)).toEqual([
      "weatherPanel",
      "newsPanel",
      "clockPanel",
    ]);
  });
});
