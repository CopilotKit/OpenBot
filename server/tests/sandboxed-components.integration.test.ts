import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createSandboxedStore } from "../src/components/sandboxed";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import { components, sandboxedComponents } from "../src/db/schema";

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
