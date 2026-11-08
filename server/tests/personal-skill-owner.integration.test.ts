import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { skills } from "../src/db/schema/plugins";
import { setEdition } from "../src/edition";
import { ensurePersonalSkillsOwned } from "../src/plugins/personal-defaults";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * Whose a skill written in the personal edition is, against the real database and the real route.
 *
 * Settings > Skills there is the page Admin > Skills is, and it saves with `global`, an
 * administrator writing for everybody. The one person is the administrator, so every skill they
 * wrote was stored as nobody's, and a Bot's "Your skills", which lists the person's own, read "No
 * skills yet" beside a Bot that held the skill.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const store = createPluginStore({
  brokerProvider: "composio",
  database,
  auditStore,
  credentials: createCredentialStore(database),
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const suite = randomUUID().slice(0, 8);
/** The personal edition's one person, as `DEV_ACTOR` is: an administrator. */
const person = {
  id: `personal-person-${suite}`,
  email: `personal-person-${suite}@example.test`,
  role: "admin" as const,
};
const slug = (name: string) => `${name}-${suite}`;

const routes = () =>
  createPluginRoutes(
    store as never,
    async (context, next) => {
      context.set("actor", person as never);
      await next();
    },
    async () => true,
  );

/** What Settings > Skills sends: `new-skill-page.tsx` saves `{ ...values, global: true }`. */
const writeOnSettings = (name: string) =>
  routes().request("/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug: slug(name),
      title: name,
      summary: `${name} summary`,
      instructions: "Read the tide table and say when it turns.",
      global: true,
    }),
  });

/** A row as a build before this fix left it, or as the package seeds one. */
const seed = (
  name: string,
  values: { origin: "yours" | "catalogue"; installedBy: string | null },
) =>
  database.insert(skills).values({
    id: slug(name),
    slug: slug(name),
    ownerUserId: null,
    title: name,
    summary: "",
    instructions: "As written.",
    ...values,
  });

const owner = (name: string) => store.skillOwner(slug(name));

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: person.id, email: person.email, name: person.id });
});

afterEach(() => setEdition("team"));

afterAll(async () => {
  setEdition("team");
  await database.delete(skills).where(like(skills.slug, `%-${suite}`));
  await database.delete(users).where(eq(users.id, person.id));
  await database.$client.close();
});

test("a skill written on Settings > Skills in the personal edition is the person's", async () => {
  setEdition("personal");
  const response = await writeOnSettings("tide-report");

  expect(response.status).toBe(200);
  expect(await owner("tide-report")).toBe(person.id);
  // And the list a Bot's "Your skills" reads says so.
  const listed = (await (await routes().request("/")).json()) as {
    skills: { slug: string; ownerUserId: string | null }[];
  };
  expect(
    listed.skills.find((skill) => skill.slug === slug("tide-report"))
      ?.ownerUserId,
  ).toBe(person.id);
});

test("in the team edition an administrator's skill for everybody is still the deployment's", async () => {
  setEdition("team");
  const response = await writeOnSettings("standup");

  expect(response.status).toBe(200);
  expect(await owner("standup")).toBeNull();

  await database.delete(skills).where(inArray(skills.slug, [slug("standup")]));
});

test("a start in the personal edition gives the person the skills they wrote before this", async () => {
  // Written on Settings > Skills by a build before this fix: nobody's, and installed by the person.
  await seed("harbour-log", { origin: "yours", installedBy: person.email });
  // Shipped with OpenBot, as the package seeds it.
  await seed("find-a-document", { origin: "catalogue", installedBy: null });
  // Shipped, then edited here: an edit keeps the owner it had, so it stays OpenBot's.
  await seed("find-a-page", { origin: "yours", installedBy: null });

  setEdition("personal");
  const owned = await ensurePersonalSkillsOwned(database, person, auditStore);

  expect(owned).toEqual([slug("harbour-log")]);
  expect(await owner("harbour-log")).toBe(person.id);
  expect(await owner("find-a-document")).toBeNull();
  expect(await owner("find-a-page")).toBeNull();

  // Once is enough: the next start finds nothing to give.
  expect(await ensurePersonalSkillsOwned(database, person, auditStore)).toEqual(
    [],
  );
});

test("the team edition's start leaves a skill nobody owns alone", async () => {
  await seed("everyone", { origin: "yours", installedBy: person.email });

  setEdition("team");
  expect(await ensurePersonalSkillsOwned(database, person, auditStore)).toEqual(
    [],
  );
  expect(await owner("everyone")).toBeNull();

  await database.delete(skills).where(inArray(skills.slug, [slug("everyone")]));
});
