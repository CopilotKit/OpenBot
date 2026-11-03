/**
 * An upgrading deployment's Learning settings and pointers move into Intelligence once, at boot, and nothing is lost.
 *
 * Each case is a deployment of its own: a database created here and migrated with this repository's migrations,
 * holding rows the way the previous release's stores wrote them (`learning_settings`, `learning_thread_bindings`,
 * `learning_person_spaces`, `learning_skill_sharing`, `learning_open_skills`, `recorder_trajectory_bindings`). The copy
 * runs against the real test Intelligence. What it must hold: every row crosses and the server reads it back as it
 * read it locally; running it again, or from two replicas at once, writes nothing twice; what Intelligence already
 * holds stands; a row Intelligence refuses stops the boot and names it; once done it never runs again.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LearningSettings } from "@openbot/shared/learning";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import { intelligenceCopies, users } from "../src/db/schema";
import {
  learningOpenSkills,
  learningPersonSpaces,
  learningSettings,
  learningSkillSharing,
  learningThreadBindings,
} from "../src/db/schema/learning";
import { recorderTrajectoryBindings } from "../src/db/schema/recorder";
import { createLearningSettingsStore } from "../src/learning/settings";
import { createLearningSharingStore } from "../src/learning/sharing";
import {
  copyLocalLearningToIntelligence,
  LEARNING_COPY_NAME,
  LearningCopyMismatchError,
} from "../src/learning/upgrade";
import { createTrajectoryBindingStore } from "../src/recorder/trajectory-bindings";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import {
  removeLearningPeople,
  resetLearningSettings,
  testLearningIntelligence,
} from "./support/learning";

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");
const created: string[] = [];
const opened: Database[] = [];
const people: string[] = [];
const intelligence = testLearningIntelligence();

async function freshDeployment(): Promise<Database> {
  const name = `openbot_learning_copy_${suite}_${created.length}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  try {
    await applyMigrations(client, migrations);
  } finally {
    await client.end({ timeout: 5 });
  }
  const database = createDatabase(url.href, TEST_POOL);
  opened.push(database);
  return database;
}

const SETTINGS: LearningSettings = {
  enabled: true,
  defaultTarget: { containerId: "upgrade-default", revision: "3" },
  agents: {
    support: { containerId: "support" },
    excluded: null,
  },
};

/** A deployment as the previous release left it: its stores' own inserts, row for row. */
async function seed(database: Database) {
  const id = (name: string) => {
    const value = `${name}-${randomUUID()}`;
    people.push(value);
    return value;
  };
  const ada = id("ada");
  const grace = id("grace");
  const carol = id("carol");
  await database.insert(users).values(
    [ada, grace, carol].map((person) => ({
      id: person,
      email: `${person}@example.test`,
    })),
  );
  // Admin, Automatic Learning (settings.ts `write`).
  await database
    .insert(learningSettings)
    .values({ id: "current", settings: SETTINGS });
  // Each thread's first run (settings.ts `bindThread`), an explicit unassigned one included.
  const threads = [
    {
      userId: ada,
      threadId: randomUUID(),
      agentId: "support",
      containerId: "support",
    },
    {
      userId: ada,
      threadId: `legacy-${randomUUID()}`,
      agentId: "bot",
      containerId: null,
    },
    {
      userId: grace,
      threadId: randomUUID(),
      agentId: "bot",
      containerId: "upgrade-default",
    },
  ];
  await database.insert(learningThreadBindings).values(threads);
  // Spaces seen to exist (personal-space.ts `confirm`).
  const seenAt = new Date("2026-06-01T10:00:00.000Z");
  await database.insert(learningPersonSpaces).values([
    { userId: ada, containerId: `user-${ada.slice(-12)}`, createdAt: seenAt },
    { userId: grace, containerId: `user-${grace.slice(-12)}` },
  ]);
  // Sharing choices (sharing.ts `setMode`, `setSkillOpen`): Carol's picks were kept when she closed them.
  await database.insert(learningSkillSharing).values([
    { userId: ada, mode: "open" },
    { userId: grace, mode: "choose" },
    { userId: carol, mode: "closed" },
  ]);
  await database.insert(learningOpenSkills).values([
    { userId: grace, skillName: "drafting" },
    { userId: grace, skillName: "refunds" },
    { userId: carol, skillName: "kept-pick" },
  ]);
  // Recorder trajectories (trajectory-bindings.ts `bind`).
  const trajectories = [
    { trajectoryId: randomUUID(), userId: ada },
    { trajectoryId: randomUUID(), userId: grace },
  ];
  await database.insert(recorderTrajectoryBindings).values(trajectories);
  return { ada, grace, carol, threads, trajectories, seenAt };
}

beforeEach(async () => {
  await resetLearningSettings();
});

afterEach(async () => {
  for (const database of opened.splice(0)) await database.$client.close();
  await removeLearningPeople(people.splice(0));
}, 30_000);

afterAll(async () => {
  await resetLearningSettings();
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 60_000);

describe("the Learning upgrade copy", () => {
  test("copies every row, and the server reads each from Intelligence as it read it locally", async () => {
    const database = await freshDeployment();
    const local = await seed(database);

    expect(
      await copyLocalLearningToIntelligence(database, intelligence),
    ).toEqual({
      kind: "copied",
      settings: true,
      threads: 3,
      spaces: 2,
      sharing: 3,
      trajectories: 2,
    });

    // The Admin settings, through the store every run reads.
    expect(await createLearningSettingsStore(intelligence).read()).toEqual(
      SETTINGS,
    );
    // Each thread keeps its container: a later first-run decision gets the copied one, null included.
    const settings = createLearningSettingsStore(intelligence);
    for (const thread of local.threads) {
      expect(
        await settings.bindThread({
          ...thread,
          agentId: "other",
          containerId: "moved",
        }),
      ).toBe(thread.containerId);
    }
    // Spaces seen to exist, with when they were first seen.
    const adaSpace = await intelligence.personalSpace(local.ada);
    expect(adaSpace.learningContainerId).toBe(`user-${local.ada.slice(-12)}`);
    expect(adaSpace.confirmedAt).toBe(local.seenAt.toISOString());
    expect(
      (await intelligence.personalSpace(local.grace)).learningContainerId,
    ).toBe(`user-${local.grace.slice(-12)}`);
    // Sharing choices, with the picks a closed choice kept.
    const sharing = createLearningSharingStore(intelligence);
    expect(await sharing.read(local.ada)).toEqual({
      mode: "open",
      openSkills: [],
    });
    expect(await sharing.read(local.grace)).toEqual({
      mode: "choose",
      openSkills: ["drafting", "refunds"],
    });
    expect(await sharing.read(local.carol)).toEqual({
      mode: "closed",
      openSkills: ["kept-pick"],
    });
    // Whose each trajectory is: a pass from its person binds, from anyone else is refused.
    const bindings = createTrajectoryBindingStore(intelligence);
    for (const row of local.trajectories) {
      expect(await bindings.isBoundTo(row.trajectoryId, row.userId)).toBe(true);
      expect(
        await createTrajectoryBindingStore(intelligence).bind({
          trajectoryId: row.trajectoryId,
          userId: local.carol,
        }),
      ).toBe(false);
    }
    // Recorded, so it never runs again.
    expect(
      await database
        .select()
        .from(intelligenceCopies)
        .where(eq(intelligenceCopies.name, LEARNING_COPY_NAME)),
    ).toEqual([
      expect.objectContaining({ name: LEARNING_COPY_NAME, copied: 11 }),
    ]);
  }, 60_000);

  test("running from two replicas at once, and again after, writes nothing twice", async () => {
    const database = await freshDeployment();
    const local = await seed(database);
    const outcomes = await Promise.all([
      copyLocalLearningToIntelligence(database, intelligence),
      copyLocalLearningToIntelligence(database, intelligence),
    ]);
    for (const outcome of outcomes)
      expect(outcome.kind).not.toBe("done-before");
    expect(
      await copyLocalLearningToIntelligence(database, intelligence),
    ).toEqual({
      kind: "done-before",
    });
    // One assignment per thread, one save of the settings, one confirm per space.
    for (const person of [local.ada, local.grace]) {
      const mine = local.threads.filter((thread) => thread.userId === person);
      expect(
        (await intelligence.threadAssignments(person))
          .map((row) => row.threadId)
          .sort(),
      ).toEqual(mine.map((thread) => thread.threadId).sort());
    }
    const assignments = await intelligence.agentAssignments();
    expect(assignments.settings).toEqual(SETTINGS);
    expect(assignments.savedAt).not.toBeNull();
    expect(
      (await createLearningSharingStore(intelligence).read(local.grace))
        .openSkills,
    ).toEqual(["drafting", "refunds"]);
    expect(
      (await intelligence.personalSpace(local.ada)).learningContainerId,
    ).not.toBeNull();
  }, 60_000);

  test("what Intelligence already holds stands: saved settings, a sharing choice, a trajectory's owner", async () => {
    const database = await freshDeployment();
    const local = await seed(database);
    const saved: LearningSettings = {
      enabled: false,
      defaultTarget: null,
      agents: {},
    };
    await createLearningSettingsStore(intelligence).write(saved);
    await createLearningSharingStore(intelligence).setMode(local.grace, "open");
    const other = `other-${randomUUID()}`;
    people.push(other);
    const [joinedFirst] = local.trajectories;
    if (!joinedFirst) throw new Error("No trajectory was seeded.");
    expect(
      await intelligence.claimTrajectory(joinedFirst.trajectoryId, other),
    ).toBe(true);

    const outcome = await copyLocalLearningToIntelligence(
      database,
      intelligence,
    );
    expect(outcome).toMatchObject({ kind: "copied", settings: false });
    expect(await createLearningSettingsStore(intelligence).read()).toEqual(
      saved,
    );
    expect(
      await createLearningSharingStore(intelligence).read(local.grace),
    ).toEqual({
      mode: "open",
      openSkills: [],
    });
    expect(await intelligence.trajectoryOwner(joinedFirst.trajectoryId)).toBe(
      other,
    );
  }, 60_000);

  test("a row Intelligence refuses stops the boot, names it, and leaves the copy to run again", async () => {
    const database = await freshDeployment();
    const local = await seed(database);
    const threadId = randomUUID();
    await database.insert(learningThreadBindings).values({
      userId: local.ada,
      threadId,
      agentId: "bot",
      // Never a container id Intelligence accepts.
      containerId: "Not_A_Container",
    });
    let refused: unknown;
    try {
      await copyLocalLearningToIntelligence(database, intelligence);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(LearningCopyMismatchError);
    expect(String(refused)).toContain(
      `learning_thread_bindings ${local.ada}/${threadId}`,
    );
    expect(
      await database
        .select()
        .from(intelligenceCopies)
        .where(eq(intelligenceCopies.name, LEARNING_COPY_NAME)),
    ).toEqual([]);
  }, 60_000);

  test("once done it never runs again, so a record later removed in Intelligence does not come back", async () => {
    const database = await freshDeployment();
    const local = await seed(database);
    await copyLocalLearningToIntelligence(database, intelligence);
    await intelligence.purgePersonalSpace(local.grace);
    await intelligence.deleteThreadAssignments(local.ada);
    expect(
      await copyLocalLearningToIntelligence(database, intelligence),
    ).toEqual({
      kind: "done-before",
    });
    expect((await intelligence.personalSpace(local.grace)).version).toBe(0);
    expect(await intelligence.threadAssignments(local.ada)).toEqual([]);
  }, 60_000);
});
