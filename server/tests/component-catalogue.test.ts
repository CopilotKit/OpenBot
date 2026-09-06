import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import type { CatalogueEntry, ComponentStore } from "../src/components/store";

/**
 * What a build's announcement is allowed to put in the catalogue.
 *
 * A component's `name` is its identity: `syncCatalogue` compares it against the names already
 * published, `decide` and `listForAgent` look it up by it, and a grant names it. A name that
 * differs from another only by the spaces around it is therefore a second, separate component that
 * nobody granted and no Bot can be held back from by the name people actually use.
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
    announce: (components: unknown[]) =>
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

describe("a build announcing what it can draw", () => {
  test("publishes an ordinary component unchanged", async () => {
    const { published, announce } = harness();
    await announce([entry()]);
    expect(published).toEqual([
      {
        name: "weatherPanel",
        title: "Weather",
        kind: "panel",
        description: "The forecast where the reader is.",
      },
    ]);
  });

  test("publishes a padded name as the name, not as a second component", async () => {
    // The guard already asks whether the name is more than whitespace; it asks that of the trimmed
    // string and then publishes the untrimmed one, so " weatherPanel " and "weatherPanel" are two
    // catalogue rows and only one of them is the component anybody grants.
    const { published, announce } = harness();
    await announce([entry({ name: " weatherPanel " })]);
    expect(published[0]?.name).toBe("weatherPanel");
  });

  test("publishes a padded title and description as the reader will see them", async () => {
    const { published, announce } = harness();
    await announce([
      entry({ title: "  Weather\t", description: "\n The forecast. " }),
    ]);
    expect(published[0]?.title).toBe("Weather");
    expect(published[0]?.description).toBe("The forecast.");
  });

  test("publishes a padded kind as the kind", async () => {
    const { published, announce } = harness();
    await announce([entry({ kind: " panel " })]);
    expect(published[0]?.kind).toBe("panel");
  });

  test("still refuses an entry that is only whitespace", async () => {
    const { published, announce } = harness();
    await announce([entry({ name: "   " })]);
    expect(published).toEqual([]);
  });

  test("still refuses a list that is not a list", async () => {
    const { announce } = harness();
    const response = await announce(undefined as unknown as unknown[]);
    expect(response.status).toBe(400);
  });
});
