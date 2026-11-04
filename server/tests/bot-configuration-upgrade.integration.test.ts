/**
 * An existing deployment's Bot configuration moves into Intelligence once, at boot.
 *
 * The local rows are seeded here in the shape the previous release wrote them, then the copy the
 * server runs at boot is run against a real Intelligence: everything arrives, verified; nothing is
 * copied twice, however many replicas run it at once; a record somebody changed since is not
 * overwritten; rows about a Bot purged since are left behind and said so; and a refusal stops the
 * boot loudly rather than starting with half the configuration.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { bots } from "../src/agents/bot-registry/directory";
import {
  CONFIGURATION_COPY_NAME,
  ConfigurationCopyMismatchError,
  copyLocalConfigurationToIntelligence,
} from "../src/configuration/upgrade";
import { createDatabase } from "../src/db/client";
import {
  agentPreferences,
  botLifecycle,
  componentExclusions,
  componentFunctions,
  components,
  defaultOptOuts,
  deploymentPackages,
  intelligenceCopies,
  pluginGrants,
  sandboxedComponents,
  skills,
  skillTools,
  teamBotAssignments,
  teamBotAudience,
  teamBotConsentDefaults,
  teamBotConsents,
  teamBotPublications,
  updateRoutingPreferences,
  userInstructions,
  users,
} from "../src/db/schema";
import {
  removeBots,
  removeTestPackages,
  seedBot,
  storedAccess,
  storedPreferences,
  useTestConfiguration,
} from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const made: string[] = [];
const people: string[] = [];

/** Every table the copy reads, emptied between cases so each seeds only its own rows. */
const LOCAL = [
  userInstructions,
  agentPreferences,
  botLifecycle,
  updateRoutingPreferences,
  defaultOptOuts,
  teamBotConsents,
  teamBotConsentDefaults,
  teamBotAudience,
  teamBotAssignments,
  teamBotPublications,
  pluginGrants,
  componentExclusions,
  componentFunctions,
  sandboxedComponents,
  components,
  skillTools,
  skills,
  deploymentPackages,
] as const;

async function emptyLocal() {
  // The package records a copy made from these rows, or a case recorded under their names.
  await removeTestPackages(
    (
      await database
        .select({ name: deploymentPackages.tenantId })
        .from(deploymentPackages)
    ).map((row) => row.name),
  );
  for (const table of LOCAL) await database.delete(table);
  await database
    .delete(intelligenceCopies)
    .where(eq(intelligenceCopies.name, CONFIGURATION_COPY_NAME));
}

beforeEach(async () => {
  await useTestConfiguration();
  await emptyLocal();
});

afterAll(async () => {
  await emptyLocal();
  await removeBots(made);
  if (people.length)
    await database.delete(users).where(inArray(users.id, people));
  await database.$client.close();
});

async function person(label: string) {
  const id = `upgrade-${label}-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id, email: `${id}@example.test`, groups: ["Sales"] });
  people.push(id);
  return id;
}

async function bot(ownerUserId: string | null) {
  const made_ = await seedBot({
    ownerUserId,
    name: "Upgraded",
    roleDescription: "Came from the old tables.",
  });
  made.push(made_.id);
  return made_.id;
}

/**
 * When each seeded row was made and last changed: all in the past, all different, so a copy that
 * stamped anything with the time it ran, or with the wrong row's time, shows.
 */
const at = (day: string) => new Date(`2026-${day}T09:00:00.000Z`);
const TIMES = {
  skillCreated: at("08-01"),
  skillChanged: at("09-01"),
  toolDeclared: at("08-02"),
  grantMade: at("08-03"),
  grantChanged: at("09-03"),
  memberAdded: at("10-04"),
  // The latest of the Bot's access rows: when its access record last changed.
  assigned: at("10-05"),
  instructionsMade: at("08-06"),
  instructionsChanged: at("09-06"),
  // Pinned on 10-02 and paused on 10-03: the later is when the teammate's entry last changed.
  lifecycleChanged: at("10-03"),
  routeChanged: at("09-07"),
  optedOut: at("09-13"),
  consentChanged: at("09-08"),
  // The latest of the teammate's settings: when their record last changed.
  consentDefaultChanged: at("10-09"),
  componentCreated: at("07-01"),
  componentChanged: at("09-10"),
  sourceCreated: at("07-02"),
  sourceChanged: at("09-11"),
  packageApplied: at("09-12"),
};

/** What the previous release left behind for one Bot, its owner and a teammate. */
async function seedPreviousRelease() {
  const suite = randomUUID().slice(0, 8);
  const owner = await person("owner");
  const teammate = await person("teammate");
  const botId = await bot(owner);
  const skillSlug = `upgrade-${suite}`;
  const componentName = `UpgradeCard${suite}`;
  const authoredName = `custom_upgrade_${suite}`;
  const tenantId = `upgrade-tenant-${suite}`;
  const publishedAt = new Date("2026-10-01T09:00:00.000Z");

  await database.insert(deploymentPackages).values({
    tenantId,
    sourcePath: "/app/examples/fintech",
    checksum: suite,
    loadedAt: TIMES.packageApplied,
  });
  await database.insert(skills).values({
    id: skillSlug,
    slug: skillSlug,
    ownerUserId: owner,
    title: "Upgrade",
    summary: "Carried across.",
    instructions: "Say it came across.",
    origin: "yours",
    installedBy: owner,
    createdAt: TIMES.skillCreated,
    updatedAt: TIMES.skillChanged,
  });
  await database.insert(skillTools).values({
    skillId: skillSlug,
    ref: "github/list_issues",
    declaredBy: owner,
    createdAt: TIMES.toolDeclared,
  });
  const grantTimes = {
    grantedAt: TIMES.grantMade,
    updatedAt: TIMES.grantChanged,
  };
  await database.insert(pluginGrants).values([
    {
      kind: "skill",
      ref: skillSlug,
      agentId: botId,
      grantedBy: owner,
      ...grantTimes,
    },
    {
      kind: "mcp",
      ref: "gmail/send",
      agentId: botId,
      grantedBy: owner,
      grantedAs: "owner",
      ...grantTimes,
    },
  ]);
  await database.insert(teamBotPublications).values({
    agentId: botId,
    publishedBy: owner,
    audience: "people",
    publishedAt,
  });
  await database.insert(teamBotAudience).values([
    {
      agentId: botId,
      kind: "user",
      value: teammate,
      createdAt: TIMES.memberAdded,
    },
    {
      agentId: botId,
      kind: "group",
      value: "Sales",
      createdAt: TIMES.memberAdded,
    },
  ]);
  await database.insert(teamBotAssignments).values({
    agentId: botId,
    groupName: "Sales",
    assignedBy: owner,
    assignedAt: TIMES.assigned,
  });
  await database.insert(userInstructions).values({
    userId: owner,
    instructions: "Write in British English.",
    createdAt: TIMES.instructionsMade,
    updatedAt: TIMES.instructionsChanged,
  });
  await database.insert(agentPreferences).values({
    userId: teammate,
    agentId: botId,
    pinnedAt: new Date("2026-10-02T09:00:00.000Z"),
  });
  await database.insert(botLifecycle).values({
    ownerUserId: teammate,
    agentId: botId,
    pausedAt: new Date("2026-10-03T09:00:00.000Z"),
    notify: "none",
    updatedAt: TIMES.lifecycleChanged,
  });
  await database.insert(updateRoutingPreferences).values({
    ownerUserId: teammate,
    kind: "question",
    transports: ["sms"],
    updatedAt: TIMES.routeChanged,
  });
  await database.insert(defaultOptOuts).values({
    ownerUserId: teammate,
    agentId: botId,
    feature: "memory_source",
    scope: "gmail",
    createdAt: TIMES.optedOut,
  });
  await database.insert(teamBotConsents).values({
    userId: teammate,
    agentId: botId,
    serverId: "gmail",
    decision: "once",
    updatedAt: TIMES.consentChanged,
  });
  await database.insert(teamBotConsentDefaults).values({
    userId: teammate,
    serverId: "calendar",
    updatedAt: TIMES.consentDefaultChanged,
  });
  await database.insert(components).values([
    {
      name: componentName,
      title: "Upgrade card",
      kind: "card",
      draftDescription: "Draws an upgrade card.",
      publishedDescription: "Draws an upgrade card.",
      published: true,
      publishedAt,
      updatedBy: "the build",
      createdAt: TIMES.componentCreated,
      updatedAt: TIMES.componentChanged,
    },
    {
      name: authoredName,
      title: "Authored upgrade",
      kind: "sandboxed",
      draftDescription: "An authored card.",
      publishedDescription: "An authored card.",
      published: true,
      publishedAt,
      updatedBy: owner,
    },
  ]);
  await database
    .insert(componentFunctions)
    .values({ componentName, functionName: "listAccounts", grantedBy: owner });
  await database
    .insert(componentExclusions)
    .values({ componentName, agentId: botId, withheldBy: owner });
  await database.insert(sandboxedComponents).values({
    name: authoredName,
    title: "Authored upgrade",
    draftDescription: "An authored card.",
    draftHtml: "<div>draft</div>",
    publishedDescription: "An authored card.",
    publishedHtml: "<div>published</div>",
    publishedCss: "",
    publishedJsFunctions: "",
    publishedArgumentSchema: {},
    revision: 3,
    published: true,
    publishedAt,
    authoredBy: owner,
    createdAt: TIMES.sourceCreated,
    updatedAt: TIMES.sourceChanged,
  });
  return {
    owner,
    teammate,
    botId,
    skillSlug,
    componentName,
    authoredName,
    tenantId,
    publishedAt,
  };
}

/** A record as Intelligence serves it, for the times OpenBot's own types leave out. */
async function served(path: string): Promise<{ updatedAt: string | null }> {
  const response = await fetch(
    `${process.env.TEST_INTELLIGENCE_API_URL}${path}`,
    {
      headers: {
        authorization: `Bearer ${process.env.TEST_INTELLIGENCE_API_KEY}`,
      },
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { updatedAt: string | null };
}

describe("copying the Bot configuration into Intelligence", () => {
  test("copies every piece once, verifies it, records itself, and leaves the local rows alone", async () => {
    const configuration = await useTestConfiguration();
    const seeded = await seedPreviousRelease();

    const outcome = await copyLocalConfigurationToIntelligence(
      database,
      configuration,
      () => bots().cached(),
    );
    expect(outcome).toMatchObject({ kind: "copied", skippedForPurgedBots: 0 });

    const access = await storedAccess(seeded.botId);
    expect(
      access.grants
        .map((grant) => [grant.kind, grant.ref, grant.grantedAs])
        .sort(),
    ).toEqual([
      ["mcp", "gmail/send", "owner"],
      ["skill", seeded.skillSlug, "admin"],
    ]);
    expect(access.publication).toMatchObject({
      audience: "people",
      publishedBy: seeded.owner,
    });
    expect(access.publication?.publishedAt).toEqual(seeded.publishedAt);
    expect(
      access.publication?.members.map((member) => [member.kind, member.value]),
    ).toEqual([
      ["group", "Sales"],
      ["user", seeded.teammate],
    ]);
    expect(access.assignments.map((assignment) => assignment.group)).toEqual([
      "Sales",
    ]);

    expect((await storedPreferences(seeded.owner)).instructions).toBe(
      "Write in British English.",
    );
    expect(await storedPreferences(seeded.teammate)).toMatchObject({
      bots: [
        expect.objectContaining({
          botId: seeded.botId,
          pinnedAt: new Date("2026-10-02T09:00:00.000Z"),
          pausedAt: new Date("2026-10-03T09:00:00.000Z"),
          notify: "none",
        }),
      ],
      routes: [
        expect.objectContaining({ kind: "question", transports: ["sms"] }),
      ],
      optOuts: [
        expect.objectContaining({
          botId: seeded.botId,
          feature: "memory_source",
          scope: "gmail",
        }),
      ],
      consents: [
        expect.objectContaining({
          botId: seeded.botId,
          serverId: "gmail",
          decision: "once",
        }),
      ],
      consentDefaults: [expect.objectContaining({ serverId: "calendar" })],
    });

    const skill = await configuration.client.skills.get(seeded.skillSlug);
    expect(skill).toMatchObject({
      ownerUserId: seeded.owner,
      origin: "yours",
      tools: [expect.objectContaining({ ref: "github/list_issues" })],
    });
    const card = await configuration.client.components.get(
      seeded.componentName,
    );
    expect(card).toMatchObject({
      published: true,
      functions: [expect.objectContaining({ name: "listAccounts" })],
      withheldFrom: [expect.objectContaining({ botId: seeded.botId })],
    });
    const authored = await configuration.client.components.get(
      seeded.authoredName,
    );
    expect(authored?.source).toMatchObject({
      revision: 3,
      isPublished: true,
      published: expect.objectContaining({ html: "<div>published</div>" }),
      draft: expect.objectContaining({ html: "<div>draft</div>" }),
    });

    // Recorded, so it never runs again, and the old rows are still there for one release.
    expect(
      await copyLocalConfigurationToIntelligence(database, configuration, () =>
        bots().cached(),
      ),
    ).toEqual({ kind: "done-before" });
    expect(await database.select().from(pluginGrants)).toHaveLength(2);

    await configuration.client.skills.remove(
      seeded.skillSlug,
      `t:${randomUUID()}`,
    );
    await configuration.client.components.remove(
      seeded.componentName,
      `t:${randomUUID()}`,
    );
    await configuration.client.components.remove(
      seeded.authoredName,
      `t:${randomUUID()}`,
    );
  });

  test("every record keeps when it was created and when it last changed", async () => {
    const configuration = await useTestConfiguration();
    const seeded = await seedPreviousRelease();

    await copyLocalConfigurationToIntelligence(database, configuration, () =>
      bots().cached(),
    );

    // `toEqual`, not `toMatchObject`: Bun's `toMatchObject` passes any Date for any other.
    const access = await storedAccess(seeded.botId);
    expect(
      access.grants.map((grant) => [grant.grantedAt, grant.updatedAt]),
    ).toEqual([
      [TIMES.grantMade, TIMES.grantChanged],
      [TIMES.grantMade, TIMES.grantChanged],
    ]);
    expect((await served(`/api/agents/${seeded.botId}/access`)).updatedAt).toBe(
      TIMES.assigned.toISOString(),
    );

    const owner = await storedPreferences(seeded.owner);
    expect(owner.instructionsUpdatedAt).toEqual(TIMES.instructionsChanged);
    expect(
      (await served(`/api/end-users/${seeded.owner}/preferences`)).updatedAt,
    ).toBe(TIMES.instructionsChanged.toISOString());
    const teammate = await storedPreferences(seeded.teammate);
    expect(teammate.bots[0]?.updatedAt).toEqual(TIMES.lifecycleChanged);
    expect(teammate.routes[0]?.updatedAt).toEqual(TIMES.routeChanged);
    expect(teammate.optOuts[0]?.createdAt).toEqual(TIMES.optedOut);
    expect(teammate.consents[0]?.updatedAt).toEqual(TIMES.consentChanged);
    expect(teammate.consentDefaults[0]?.updatedAt).toEqual(
      TIMES.consentDefaultChanged,
    );
    expect(
      (await served(`/api/end-users/${seeded.teammate}/preferences`)).updatedAt,
    ).toBe(TIMES.consentDefaultChanged.toISOString());

    const skill = await configuration.client.skills.get(seeded.skillSlug);
    expect([
      skill?.createdAt,
      skill?.updatedAt,
      skill?.tools[0]?.declaredAt,
    ]).toEqual([TIMES.skillCreated, TIMES.skillChanged, TIMES.toolDeclared]);
    const card = await configuration.client.components.get(
      seeded.componentName,
    );
    expect([card?.createdAt, card?.updatedAt]).toEqual([
      TIMES.componentCreated,
      TIMES.componentChanged,
    ]);
    const authored = await configuration.client.components.get(
      seeded.authoredName,
    );
    expect([authored?.source?.createdAt, authored?.source?.updatedAt]).toEqual([
      TIMES.sourceCreated,
      TIMES.sourceChanged,
    ]);
    const recorded = await configuration.client.packages.get(seeded.tenantId);
    expect([
      recorded?.appliedAt,
      recorded?.createdAt,
      recorded?.updatedAt,
    ]).toEqual([
      TIMES.packageApplied,
      TIMES.packageApplied,
      TIMES.packageApplied,
    ]);

    await configuration.client.skills.remove(
      seeded.skillSlug,
      `t:${randomUUID()}`,
    );
    await configuration.client.components.remove(
      seeded.componentName,
      `t:${randomUUID()}`,
    );
    await configuration.client.components.remove(
      seeded.authoredName,
      `t:${randomUUID()}`,
    );
  });

  test("two replicas copying at once copy each piece once", async () => {
    const configuration = await useTestConfiguration();
    const seeded = await seedPreviousRelease();

    const outcomes = await Promise.all([
      copyLocalConfigurationToIntelligence(database, configuration, () =>
        bots().cached(),
      ),
      copyLocalConfigurationToIntelligence(database, configuration, () =>
        bots().cached(),
      ),
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "copied",
      "copied",
    ]);
    const access = await storedAccess(seeded.botId);
    expect(access.grants).toHaveLength(2);
    // One batch wrote the record: the second replica's identical batch was answered with the first's.
    expect(access.revision).toBe(1);
    expect((await storedPreferences(seeded.teammate)).revision).toBe(1);

    await configuration.client.skills.remove(
      seeded.skillSlug,
      `t:${randomUUID()}`,
    );
    await configuration.client.components.remove(
      seeded.componentName,
      `t:${randomUUID()}`,
    );
    await configuration.client.components.remove(
      seeded.authoredName,
      `t:${randomUUID()}`,
    );
  });

  test("a record somebody changed in Intelligence since is not overwritten by a late copy", async () => {
    const configuration = await useTestConfiguration();
    const seeded = await seedPreviousRelease();
    // Another replica finished its copy, and served a change to this Bot since.
    await configuration.client.access.change(
      [
        {
          op: "grant",
          botId: seeded.botId,
          kind: "mcp",
          ref: "slack/post",
          grantedBy: seeded.owner,
          grantedAs: "admin",
          ifGranted: "replace",
        },
      ],
      `t:${randomUUID()}`,
    );

    await copyLocalConfigurationToIntelligence(database, configuration, () =>
      bots().cached(),
    );
    const access = await storedAccess(seeded.botId);
    expect(access.grants.map((grant) => grant.ref)).toEqual(["slack/post"]);
    expect(access.publication).toBeNull();

    await configuration.client.skills.remove(
      seeded.skillSlug,
      `t:${randomUUID()}`,
    );
    await configuration.client.components.remove(
      seeded.componentName,
      `t:${randomUUID()}`,
    );
    await configuration.client.components.remove(
      seeded.authoredName,
      `t:${randomUUID()}`,
    );
  });

  test("rows about a Bot Intelligence no longer has are left behind, and said so", async () => {
    const configuration = await useTestConfiguration();
    const owner = await person("orphan");
    await database.insert(pluginGrants).values({
      kind: "mcp",
      ref: "gmail/send",
      agentId: `purged-${randomUUID()}`,
      grantedBy: owner,
    });
    const outcome = await copyLocalConfigurationToIntelligence(
      database,
      configuration,
      () => bots().cached(),
    );
    expect(outcome).toMatchObject({ kind: "copied", skippedForPurgedBots: 1 });
  });

  test("a package Intelligence holds under another id stops the boot, named, and nothing is recorded", async () => {
    const configuration = await useTestConfiguration();
    const tenantId = `upgrade-tenant-${randomUUID()}`;
    await configuration.client.packages.record(
      tenantId,
      { source: "elsewhere", checksum: "1" },
      `t:${randomUUID()}`,
    );
    await database.insert(deploymentPackages).values({
      tenantId,
      sourcePath: "/app/examples/fintech",
      checksum: "2",
    });
    try {
      await expect(
        copyLocalConfigurationToIntelligence(database, configuration, () =>
          bots().cached(),
        ),
      ).rejects.toBeInstanceOf(ConfigurationCopyMismatchError);
      expect(
        await database
          .select()
          .from(intelligenceCopies)
          .where(eq(intelligenceCopies.name, CONFIGURATION_COPY_NAME)),
      ).toEqual([]);
    } finally {
      await removeTestPackages([tenantId]);
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.tenantId, tenantId));
    }
  });
});
