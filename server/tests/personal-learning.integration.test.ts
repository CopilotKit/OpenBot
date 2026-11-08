import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createCredentialStore } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import { enterpriseSettings } from "../src/db/schema/admin";
import { agents, auditEvents, users } from "../src/db/schema/core";
import { agentProfiles } from "../src/db/schema/coworker";
import { learningSettings } from "../src/db/schema/learning";
import { pluginGrants, skills } from "../src/db/schema/plugins";
import { setEdition } from "../src/edition";
import { createLearningRuntime } from "../src/learning/runtime";
import { createLearningSettingsStore } from "../src/learning/settings";
import {
  ensurePersonalLearning,
  ensurePersonalSkills,
  personalDefaultsDeps,
  withPersonalDefaults,
} from "../src/plugins/personal-defaults";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The personal edition against the real database: every Bot takes part in Automatic Learning and
 * offers every skill, on a fresh install, on an upgraded one whose settings left Bots out, and for
 * a Bot made later. The team edition's choices are left as they are.
 *
 * "Takes part" is read the way a run and Admin read it: the settings store, then the Learning
 * runtime's own answer for the Bot (`status`, which names the container its conversations go to and
 * whose Skills it is given; null for a Bot left out).
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const owner = `personal-learning-owner-${suite}`;
const assistant = `personal-learning-assistant-${suite}`;
const researcher = `personal-learning-researcher-${suite}`;
const later = `personal-learning-later-${suite}`;
const bots = [assistant, researcher, later];
const standup = `standup-${suite}`;
const triage = `triage-${suite}`;
const DEFAULT = { containerId: "openbot" };

const real = personalDefaultsDeps(database);
/** The real reads, narrowed to this suite's Bots and skills so nobody else's are touched. */
const deps = {
  ...real,
  bots: async () =>
    (await real.bots()).filter((id) => id.startsWith("personal-learning-")),
  skills: async () =>
    (await real.skills()).filter((slug) => slug.endsWith(suite)),
};
const auditStore = createAuditStore(database);
const store = withPersonalDefaults(
  createPluginStore({
    database,
    auditStore,
    credentials: createCredentialStore(database),
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    brokerProvider: "composio",
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
  }),
  deps,
);
const settings = createLearningSettingsStore(database);
// `status` reads only the settings and its own registries; it never calls Intelligence.
const runtime = createLearningRuntime({
  store: settings,
  client: {} as CopilotKitIntelligence,
});

/** The container a Bot learns into and takes Skills from, or null when it is left out. */
const learnsInto = async (bot: string) => {
  const status = await runtime.status(bot);
  return status.configured ? (status.containerId ?? null) : null;
};

const offers = async (bot: string) =>
  [...(await real.heldSkills(bot))]
    .filter((slug) => slug.endsWith(suite))
    .sort();

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

/** Saved settings as a deployment left them: what an upgrade starts from. */
async function saveSettings(value: LearningSettings) {
  await database
    .insert(learningSettings)
    .values({ id: "current", settings: value })
    .onConflictDoUpdate({
      target: learningSettings.id,
      set: { settings: value },
    });
}

const storedSettings = async () =>
  (
    await database
      .select({ settings: learningSettings.settings })
      .from(learningSettings)
      .where(eq(learningSettings.id, "current"))
  )[0]?.settings;

/** The one settings row is the whole deployment's: kept aside for this file and put back after. */
let before: LearningSettings | undefined;

beforeAll(async () => {
  before = await storedSettings();
  await database
    .delete(learningSettings)
    .where(eq(learningSettings.id, "current"));
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test` });
  await addBot(assistant);
  await addBot(researcher);
  await writeSkill(standup);
  await writeSkill(triage);
  setEdition("personal");
});

afterEach(() => setEdition("personal"));

afterAll(async () => {
  setEdition("team");
  await database
    .delete(learningSettings)
    .where(eq(learningSettings.id, "current"));
  if (before) await saveSettings(before);
  await database
    .delete(pluginGrants)
    .where(
      and(eq(pluginGrants.kind, "skill"), inArray(pluginGrants.agentId, bots)),
    );
  await database
    .delete(enterpriseSettings)
    .where(like(enterpriseSettings.key, `personal_skills_given:%-${suite}`));
  await database.delete(skills).where(like(skills.slug, `%-${suite}`));
  await database.delete(agents).where(inArray(agents.id, bots));
  await database.delete(users).where(eq(users.id, owner));
  await database.$client.close();
});

test("a fresh personal install: every Bot learns into the default container and offers every skill", async () => {
  // What automatic assignment saves on a first start once the default container is there.
  expect(await settings.adoptDefault(DEFAULT)).toBe(true);
  await ensurePersonalSkills(store, deps);
  expect(await ensurePersonalLearning(deps, auditStore)).toEqual([]);
  for (const bot of [assistant, researcher]) {
    expect(await learnsInto(bot)).toBe("openbot");
    expect(await offers(bot)).toEqual([standup, triage].sort());
  }
});

test("an upgraded install: Bots its settings left out take part again at the next start", async () => {
  // A database a team deployment used, with an admin's choices in it, started as the personal edition.
  await saveSettings({
    enabled: true,
    defaultTarget: DEFAULT,
    agents: {
      [assistant]: null,
      [researcher]: { containerId: "research" },
      [later]: null,
    },
  });
  expect(await learnsInto(assistant)).toBeNull();

  const included = await ensurePersonalLearning(deps, auditStore);

  expect(included).toEqual([assistant, later].sort());
  expect(await learnsInto(assistant)).toBe("openbot");
  // A Bot given a container of its own keeps it: that is still taking part.
  expect(await learnsInto(researcher)).toBe("research");
  expect(await offers(assistant)).toEqual([standup, triage].sort());
  // Every other saved key is kept.
  expect(await storedSettings()).toEqual({
    enabled: true,
    defaultTarget: DEFAULT,
    agents: { [researcher]: { containerId: "research" } },
  });
  const trail = await database
    .select({
      initiatorKind: auditEvents.initiatorKind,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "configuration.changed"),
        eq(auditEvents.targetType, "learning"),
        sql`${auditEvents.payload}->>'change' = 'every_bot_included_personal'`,
      ),
    );
  expect(
    trail.filter((entry) =>
      JSON.stringify(entry.payload).includes(`"${assistant}"`),
    ),
  ).toEqual([
    {
      initiatorKind: "deployment",
      payload: {
        change: "every_bot_included_personal",
        bots: [assistant, later].sort(),
      },
    },
  ]);

  // Nothing left out, nothing written: a second start leaves the row as it is.
  expect(await ensurePersonalLearning(deps, auditStore)).toEqual([]);
});

test("a Bot made later learns and offers every skill from its first run, even if it was left out", async () => {
  await addBot(later);
  // Left out by a team edition's settings while the personal edition was already running.
  await saveSettings({
    enabled: true,
    defaultTarget: DEFAULT,
    agents: { [later]: null },
  });
  await store.listForAgent(later);
  expect(await learnsInto(later)).toBe("openbot");
  expect(await offers(later)).toEqual([standup, triage].sort());
});

test("a skill switched off for one Bot stays off; Learning stays on", async () => {
  await store.revoke("skill", triage, assistant, "me@example.test");
  await ensurePersonalSkills(store, deps);
  await ensurePersonalLearning(deps, auditStore);
  await store.listForAgent(assistant);
  expect(await offers(assistant)).toEqual([standup]);
  expect(await learnsInto(assistant)).toBe("openbot");
});

test("the team edition keeps an admin's choice to leave a Bot out", async () => {
  setEdition("team");
  await saveSettings({
    enabled: true,
    defaultTarget: DEFAULT,
    agents: { [assistant]: null },
  });
  expect(await ensurePersonalLearning(deps, auditStore)).toEqual([]);
  await store.listForAgent(assistant);
  expect(await learnsInto(assistant)).toBeNull();
  expect((await storedSettings())?.agents).toEqual({ [assistant]: null });
});
