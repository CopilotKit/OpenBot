import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createComponentRoutes } from "../src/components/routes";
import { createSandboxedStore } from "../src/components/sandboxed";
import { createComponentStore } from "../src/components/store";
import { createDatabase } from "../src/db/client";
import { auditEvents, components, sandboxedComponents } from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The Published switch on a playground component is the same switch as every other component's, but
 * publishing one is not the same act. The source lives beside the governance row, and a publication
 * that writes only the governance row offers every Bot a component that cannot draw.
 *
 * These tests cross the real route and both stores against Postgres. A mocked store could prove the
 * route called something; it could not prove the two rows commit together, the revision is stable on
 * a retry, or a failed governance write leaves the source unpublished.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const componentStore = createComponentStore(database);
const sandboxedStore = createSandboxedStore(database, auditStore);
const fixtureNames = new Set<string>();

const ADMIN = {
  id: `user_${randomUUID().slice(0, 8)}`,
  email: "admin@openbot.test",
  role: "admin",
} as const;

const asAdmin: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", { ...ADMIN });
  await next();
};

const routes = new Hono().route(
  "/components",
  createComponentRoutes(
    componentStore,
    asAdmin,
    auditStore,
    async () => true,
    sandboxedStore,
  ),
);

function fixture(label: string) {
  const slug = `${label}_${randomUUID().slice(0, 8)}`;
  const name = `custom_${slug}`;
  fixtureNames.add(name);
  return { slug, name };
}

function postPublication(name: string, published: boolean) {
  return routes.request(
    `http://t/components/${encodeURIComponent(name)}/publication`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ published }),
    },
  );
}

async function saveDraft(
  slug: string,
  html = "<p>draft</p>",
  description = "Draws the draft.",
) {
  return sandboxedStore.save({
    slug,
    title: "A test card",
    description,
    html,
    css: "p { color: red }",
    jsFunctions: "",
    argumentSchema: { type: "object" },
    sampleArguments: {},
    by: ADMIN.email,
  });
}

async function governanceOf(name: string) {
  const [row] = await database
    .select()
    .from(components)
    .where(eq(components.name, name));
  return row;
}

async function sourceOf(name: string) {
  const [row] = await database
    .select()
    .from(sandboxedComponents)
    .where(eq(sandboxedComponents.name, name));
  return row;
}

afterEach(async () => {
  for (const name of fixtureNames) {
    await database
      .delete(sandboxedComponents)
      .where(eq(sandboxedComponents.name, name));
    await database.delete(components).where(eq(components.name, name));
  }
  fixtureNames.clear();
});

describe("the generic Published switch on a sandboxed component", () => {
  test("publishes the source and the governance row together", async () => {
    const { slug, name } = fixture("publish");
    await saveDraft(slug);

    const response = await postPublication(name, true);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ published: true });
    const source = await sourceOf(name);
    const governance = await governanceOf(name);
    expect(source?.published).toBeTrue();
    expect(source?.publishedHtml).toBe("<p>draft</p>");
    expect(governance?.published).toBeTrue();
    expect(governance?.publishedDescription).toBe("Draws the draft.");
  });

  test("refuses a sandboxed governance row with no source", async () => {
    const { name } = fixture("missing");
    await database.insert(components).values({
      name,
      title: "A missing source",
      kind: "sandboxed",
      draftDescription: "Draws something.",
      published: false,
      updatedBy: ADMIN.email,
    });

    const response = await postPublication(name, true);

    expect(response.status).toBe(409);
    expect((await governanceOf(name))?.published).toBeFalse();
  });

  test("refuses a draft with empty HTML", async () => {
    const { slug, name } = fixture("empty");
    await saveDraft(slug, "   ");

    const response = await postPublication(name, true);

    expect(response.status).toBe(409);
    expect((await governanceOf(name))?.published).toBeFalse();
    const source = await sourceOf(name);
    expect(source?.published).toBeFalse();
    expect(source?.publishedHtml).toBeNull();
  });

  test("refuses a draft with no description", async () => {
    const { slug, name } = fixture("descriptionless");
    await saveDraft(slug, "<p>draft</p>", "   ");

    const response = await postPublication(name, true);

    expect(response.status).toBe(409);
    expect((await governanceOf(name))?.published).toBeFalse();
    expect((await sourceOf(name))?.published).toBeFalse();
  });

  test("a repeated publish keeps one revision and one audit event", async () => {
    const { slug, name } = fixture("repeat");
    await saveDraft(slug);

    expect((await postPublication(name, true)).status).toBe(200);
    expect((await postPublication(name, true)).status).toBe(200);

    expect((await sourceOf(name))?.revision).toBe(1);
    const events = await database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, name));
    expect(
      events.filter((event) => event.eventType === "component.published"),
    ).toHaveLength(1);
  });

  test("a failure after the source write rolls the whole publish back", async () => {
    const { slug, name } = fixture("rollback");
    await saveDraft(slug);
    const functionName = `reject_${name}`;
    const triggerName = `reject_${name}`;

    await database.execute(
      sql.raw(`
        CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.name = '${name}' THEN
            RAISE EXCEPTION 'forced publication failure';
          END IF;
          RETURN NEW;
        END
        $$;
        CREATE TRIGGER ${triggerName}
          BEFORE UPDATE ON components
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `),
    );

    try {
      await expect(sandboxedStore.publish(name, ADMIN.email)).rejects.toThrow();

      const source = await sourceOf(name);
      const governance = await governanceOf(name);
      expect(source?.published).toBeFalse();
      expect(source?.publishedHtml).toBeNull();
      expect(source?.revision).toBe(0);
      expect(governance?.published).toBeFalse();
    } finally {
      await database.execute(
        sql.raw(`DROP TRIGGER ${triggerName} ON components`),
      );
      await database.execute(sql.raw(`DROP FUNCTION ${functionName}()`));
    }
  });

  test("unpublish withdraws the source and the governance row together", async () => {
    const { slug, name } = fixture("unpublish");
    await saveDraft(slug);
    await sandboxedStore.publish(name, ADMIN.email);

    const response = await postPublication(name, false);

    expect(response.status).toBe(200);
    expect((await sourceOf(name))?.published).toBeFalse();
    expect((await governanceOf(name))?.published).toBeFalse();
    expect(
      (await sandboxedStore.published()).map((row) => row.name),
    ).not.toContain(name);
  });
});
