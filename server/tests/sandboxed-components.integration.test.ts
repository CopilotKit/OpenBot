import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import {
  createSandboxedStore,
  SandboxedNotFoundError,
} from "../src/components/sandboxed";
import { createDatabase } from "../src/db/client";
import {
  agents,
  componentExclusions,
  componentFunctions,
  components,
  sandboxedComponents,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * A component authored in a browser can be edited freely and still reach nobody until it is
 * published, and its governance is the same governance as a compiled component's.
 *
 * These tests pin the draft gate. Publishing without a rebuild is what this table is
 * for, and it is also what puts an editor one keystroke away from changing what every Bot draws in
 * production. If a draft could ever be drawn, the feature would be a liability rather than a
 * capability, so that is asserted directly rather than inferred from the shape of the code.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8).replace(/-/g, "");
const slug = `test_card_${suite}`;
const name = `custom_${slug}`;

const store = createSandboxedStore(database, createAuditStore(database));

afterAll(async () => {
  await database
    .delete(sandboxedComponents)
    .where(eq(sandboxedComponents.name, name));
  await database.delete(components).where(eq(components.name, name));
});

describe("authoring a component without a rebuild", () => {
  test("a saved draft is on the grant grid and is drawn by nobody", async () => {
    const saved = await store.save({
      slug,
      title: "A test card",
      description: "Draws a test card.",
      html: "<p>draft</p>",
      css: "p { color: red }",
      jsFunctions: "",
      argumentSchema: { type: "object" },
      sampleArguments: { a: 1 },
      by: "admin@openbot.local",
    });

    expect(saved.name).toBe(name);
    expect(saved.published).toBe(false);

    // On the grant grid, so an administrator can decide about it before it can be drawn rather than
    // after. Unpublished and granted to nobody, which is how a compiled component arrives too.
    const [governance] = await database
      .select()
      .from(components)
      .where(eq(components.name, name));
    expect(governance?.kind).toBe("sandboxed");
    expect(governance?.published).toBe(false);
    expect(governance?.publishedDescription).toBeNull();

    // And nothing to draw with. This is the assertion that matters.
    const published = await store.published();
    expect(published.map((row) => row.name)).not.toContain(name);
  });

  test("publishing releases the source and the description together", async () => {
    const published = await store.publish(name, "admin@openbot.local");
    expect(published.published).toBe(true);
    expect(published.publishedHtml).toBe("<p>draft</p>");
    expect(published.revision).toBe(1);

    const drawable = await store.published();
    expect(drawable.find((row) => row.name === name)?.html).toBe(
      "<p>draft</p>",
    );

    // The argument schema travels with the source. Without it the tool is registered with no
    // parameters, so the model is told the component takes nothing and calls it with nothing.
    expect(drawable.find((row) => row.name === name)?.argumentSchema).toEqual({
      type: "object",
    });

    // Both halves, because either on its own is an invalid publication state: a description with no markup
    // offers the model a component that draws the old version, and markup with no description leaves
    // a component no model is ever told about.
    const [governance] = await database
      .select()
      .from(components)
      .where(eq(components.name, name));
    expect(governance?.published).toBe(true);
    expect(governance?.publishedDescription).toBe("Draws a test card.");
  });

  test("editing after publishing changes the draft and not what is drawn", async () => {
    await store.save({
      slug,
      title: "A test card",
      description: "Draws a test card.",
      html: "<p>edited</p>",
      css: "p { color: red }",
      jsFunctions: "",
      argumentSchema: { type: "object" },
      sampleArguments: { a: 1 },
      by: "admin@openbot.local",
    });

    const drawable = await store.published();
    // Still the published version. An edit is not a deployment.
    expect(drawable.find((row) => row.name === name)?.html).toBe(
      "<p>draft</p>",
    );

    const [record] = (await store.list()).filter((row) => row.name === name);
    expect(record.hasUnpublishedChanges).toBe(true);
  });

  test("a name that is not a name is refused", async () => {
    await expect(
      store.save({
        slug: "Not A Slug",
        title: "x",
        description: "",
        html: "",
        css: "",
        jsFunctions: "",
        argumentSchema: {},
        sampleArguments: {},
        by: "admin@openbot.local",
      }),
    ).rejects.toThrow();
  });

  test("deleting takes the governance row with it", async () => {
    await store.remove(name, "admin@openbot.local");
    const [governance] = await database
      .select()
      .from(components)
      .where(eq(components.name, name));
    // A governance row pointing at a component with no source is the "catalogue disagrees with the
    // build" state the components table exists to make visible.
    expect(governance).toBeUndefined();
  });
});

/**
 * What this surface may delete.
 *
 * `components` is shared with the compiled catalogue, so a delete by name on this endpoint could
 * reach a row the playground never authored. `save` refuses a name that is not a slug and `publish`
 * refuses a name with no draft behind it; `remove` did neither, which is the asymmetry these pin.
 */
describe("deleting a name this surface does not own", () => {
  const compiled = `chart_test_${suite}`;
  const bot = `agent_test_${suite}`;

  beforeAll(async () => {
    await database
      .insert(agents)
      .values({ id: bot, name: bot, type: "remote_ag_ui", configuration: {} })
      .onConflictDoNothing();
    // A component the build ships, as `syncCatalogue` would have written it.
    await database.insert(components).values({
      name: compiled,
      title: "A compiled chart",
      kind: "chart",
      draftDescription: "Drawn by the build.",
      publishedDescription: "Drawn by the build.",
      published: true,
      publishedAt: new Date(),
      updatedBy: "the build",
    });
    // One Bot held back from it. This row is the whole of the decision: a published component is
    // available to every Bot unless it exists.
    await database.insert(componentExclusions).values({
      componentName: compiled,
      agentId: bot,
      withheldBy: "admin@openbot.local",
    });
    await database.insert(componentFunctions).values({
      componentName: compiled,
      functionName: "listRecentOrders",
      grantedBy: "admin@openbot.local",
    });
  });

  afterAll(async () => {
    await database.delete(components).where(eq(components.name, compiled));
    await database.delete(agents).where(eq(agents.id, bot));
  });

  test("refuses a compiled component's name instead of deleting its governance", async () => {
    await expect(store.remove(compiled, "admin@openbot.local")).rejects.toThrow(
      SandboxedNotFoundError,
    );

    const [governance] = await database
      .select()
      .from(components)
      .where(eq(components.name, compiled));
    expect(governance).toBeDefined();
    expect(governance?.published).toBe(true);
  });

  test("leaves the withholding that would otherwise have been released", async () => {
    // The half that fails OPEN, and the reason this is worth a guard rather than a tidy-up. Losing
    // this row does not hide the component from the Bot, it releases it to the Bot — and the next
    // catalogue announcement rewrites the component as published, because that is how one the build
    // ships arrives. A deliberate "not this Bot" would come back as "every Bot".
    const withheld = await database
      .select()
      .from(componentExclusions)
      .where(eq(componentExclusions.componentName, compiled));
    expect(withheld).toHaveLength(1);
  });

  test("leaves the function grants, which the cascade would also have taken", async () => {
    // This half fails closed, so it is a capability lost rather than one gained. Asserted anyway:
    // a component that silently stops being able to read is still a component that stopped working.
    const granted = await database
      .select()
      .from(componentFunctions)
      .where(eq(componentFunctions.componentName, compiled));
    expect(granted).toHaveLength(1);
  });

  test("refuses a name nothing was ever authored under", async () => {
    // Answered rather than reported as success. `{ ok: true }` for a name that was never there reads
    // as "the thing you named is gone", which is the one thing it does not establish.
    await expect(
      store.remove(`custom_never_${suite}`, "admin@openbot.local"),
    ).rejects.toThrow(SandboxedNotFoundError);
  });

  test("still deletes a governance row whose source is already gone", async () => {
    /*
     * The orphan, and the reason the guard asks about `kind` rather than about the source row.
     *
     * `remove` deletes from two tables and not in one transaction, so a failure between them leaves
     * exactly this: a governance row of this surface's own kind with nothing behind it. It is the
     * "catalogue disagrees with the build" state, it belongs to this surface, and gating on the
     * source row instead would have left it with no way to be cleared.
     */
    const orphan = `custom_orphan_${suite}`;
    await database.insert(components).values({
      name: orphan,
      title: "A draft whose source went",
      kind: "sandboxed",
      draftDescription: "Authored here.",
      published: false,
      updatedBy: "admin@openbot.local",
    });

    await store.remove(orphan, "admin@openbot.local");

    const [gone] = await database
      .select()
      .from(components)
      .where(eq(components.name, orphan));
    expect(gone).toBeUndefined();
  });
});
