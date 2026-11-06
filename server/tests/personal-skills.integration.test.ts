import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema/admin";
import { agents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { pluginGrants, skills } from "../src/db/schema/plugins";
import { setEdition } from "../src/edition";
import {
  ensurePersonalSkills,
  personalDefaultsDeps,
  skillsGivenSetting,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The personal edition's skills against the real database: every Bot is given every skill once, a
 * new skill goes to every Bot, and a skill switched off for one Bot stays off.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `personal-skills-owner-${suite}`;
const first = `personal-skills-first-${suite}`;
const later = `personal-skills-later-${suite}`;
const standup = `standup-${suite}`;
const triage = `triage-${suite}`;
const fresh = `fresh-${suite}`;

/** The real reads, narrowed to this suite's Bots and skills so nobody else's are touched. */
const real = personalDefaultsDeps(database);
const deps = {
  ...real,
  bots: async () =>
    (await real.bots()).filter((id) => id.startsWith("personal-skills-")),
  skills: async () =>
    (await real.skills()).filter((slug) => slug.endsWith(suite)),
};
const store = withPersonalDefaults(
  createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    brokerProvider: "composio",
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  }),
  deps,
);

async function addBot(id: string) {
  await database
    .insert(agents)
    .values({ id, name: id, type: "built_in", configuration: {} });
  await database.insert(agentProfiles).values({
    agentId: id,
    ownerUserId: owner,
    title: id,
    roleDescription: "Assist",
    avatarSeed: id,
    visibility: "private",
  });
}

async function writeSkill(slug: string) {
  await store.installSkill({
    slug,
    title: slug,
    summary: "",
    instructions: "Do the thing.",
    ownerUserId: null,
    by: "me@example.test",
  });
}

const offers = async (bot: string) =>
  [...(await real.heldSkills(bot))]
    .filter((slug) => slug.endsWith(suite))
    .sort();

beforeAll(async () => {
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await addBot(first);
  // Two skills written before the personal edition gave skills to every Bot.
  await writeSkill(standup);
  await writeSkill(triage);
  setEdition("personal");
});

afterEach(() => setEdition("personal"));

afterAll(async () => {
  setEdition("team");
  const bots = [first, later];
  await database
    .delete(pluginGrants)
    .where(
      and(eq(pluginGrants.kind, "skill"), inArray(pluginGrants.agentId, bots)),
    );
  await database
    .delete(enterpriseSettings)
    .where(
      like(
        enterpriseSettings.key,
        `personal_skills_given:personal-skills-%${suite}`,
      ),
    );
  await database.delete(skills).where(like(skills.slug, `%-${suite}`));
  await database.delete(agents).where(inArray(agents.id, bots));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

test("a start gives every Bot the skills there are, and writes down that it did", async () => {
  await ensurePersonalSkills(store, deps);
  expect(await offers(first)).toEqual([standup, triage].sort());
  expect(await real.skillsGiven(first)).toBe(true);
  const [row] = await database
    .select()
    .from(enterpriseSettings)
    .where(eq(enterpriseSettings.key, skillsGivenSetting(first)));
  expect(row).toBeDefined();
});

test("a skill switched off for a Bot stays off after the next start and run", async () => {
  await store.revoke("skill", triage, first, "me@example.test");
  await ensurePersonalSkills(store, deps);
  await store.listForAgent(first);
  expect(await offers(first)).toEqual([standup]);
});

test("a new skill goes to every Bot", async () => {
  await writeSkill(fresh);
  expect(await offers(first)).toEqual([fresh, standup].sort());
});

test("a Bot made later gets every skill the first time it is listed", async () => {
  await addBot(later);
  await store.listForAgent(later);
  expect(await offers(later)).toEqual([fresh, standup, triage].sort());
});
