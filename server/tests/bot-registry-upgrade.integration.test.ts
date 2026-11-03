/**
 * An upgrading deployment's Bots move into Intelligence once, at boot, and nothing is lost.
 *
 * Each case is a deployment of its own: a database created here and migrated with this repository's
 * migrations, holding Bots the way a deployment before this release held them (`agents` and
 * `agent_profiles` rows). The copy runs against the real test Intelligence. What it must hold: every
 * field crosses, deleted Bots included; running it again, or from two replicas at once, copies nothing
 * twice; a Bot Intelligence refuses stops the boot and names it; once done it never runs again, so a
 * Bot later purged in Intelligence does not come back from the local row this release keeps.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";
import { createAgentRegistryClient } from "../src/agents/bot-registry/client";
import { createBotDirectory } from "../src/agents/bot-registry/directory";
import {
  BotCopyMismatchError,
  copyLocalBotsToIntelligence,
} from "../src/agents/bot-registry/upgrade";
import { applyMigrations } from "../src/db/apply-migrations";
import { createDatabase, type Database } from "../src/db/client";
import {
  agentProfiles,
  agents,
  deploymentPackages,
  intelligenceCopies,
  users,
} from "../src/db/schema";
import { removeBots, testIntelligence } from "./support/bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";
const suite = randomUUID().slice(0, 8);
const migrations = join(import.meta.dir, "..", "drizzle");
const created: string[] = [];
const opened: Database[] = [];
const copiedIds: string[] = [];

async function freshDeployment(): Promise<Database> {
  const name = `openbot_bot_copy_${suite}_${created.length}`;
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

/** A replica's directory against the test Intelligence, without announcements: the copy needs none. */
function replica() {
  const intelligence = testIntelligence();
  return createBotDirectory({
    registry: createAgentRegistryClient(intelligence),
  });
}

afterEach(async () => {
  for (const database of opened.splice(0)) await database.$client.close();
  await removeBots(copiedIds.splice(0));
});

afterAll(async () => {
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created)
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}, 60_000);

/** Three Bots as a deployment before this release held them: a person's, a deleted one, a package's. */
async function legacyBots(database: Database) {
  const tag = randomUUID().slice(0, 8);
  const owner = `copy-owner-${tag}`;
  await database
    .insert(users)
    .values({ id: owner, email: `${owner}@example.test`, name: "Owner" });
  const [pack] = await database
    .insert(deploymentPackages)
    .values({ tenantId: `tenant-${tag}`, sourcePath: "x", checksum: tag })
    .returning();
  if (!pack) throw new Error("Expected a package row.");
  const ids = {
    mine: `agent_copy_mine_${tag}`,
    deleted: `agent_copy_deleted_${tag}`,
    packaged: `copy-package-${tag}`,
  };
  const createdAt = new Date("2026-01-02T03:04:05.000Z");
  const deletedAt = new Date("2026-03-04T05:06:07.000Z");
  const issuedAt = new Date("2026-02-03T04:05:06.000Z");
  await database.insert(agents).values([
    {
      id: ids.mine,
      name: "Research",
      type: "remote_ag_ui",
      configuration: {
        endpoint: "https://research.example.test/ag-ui",
        auth: { header: "Authorization", credentialId: `cred-${tag}` },
      },
      createdAt,
    },
    {
      id: ids.deleted,
      name: "Old Mastra",
      type: "remote_mastra",
      configuration: {
        endpoint: "https://mastra.example.test",
        remoteAgentId: "weather",
      },
    },
    {
      id: ids.packaged,
      name: "Knowledge",
      type: "built_in",
      configuration: { systemPrompt: "Answer only from sources." },
      packageId: pack.id,
    },
  ]);
  await database.insert(agentProfiles).values([
    {
      agentId: ids.mine,
      ownerUserId: owner,
      title: "Research assistant",
      roleDescription: "Finds sources.",
      avatarSeed: "seed-research",
      visibility: "private",
      isolated: true,
      callbackTokenHash: `hash-${tag}`,
      callbackTokenIssuedAt: issuedAt,
    },
    {
      agentId: ids.deleted,
      ownerUserId: owner,
      title: "Weather",
      roleDescription: "Says the weather.",
      avatarSeed: ids.deleted,
      visibility: "public",
      deletedAt,
    },
    {
      agentId: ids.packaged,
      ownerUserId: null,
      title: "Knowledge",
      roleDescription: "Answers from the knowledge base.",
      avatarSeed: ids.packaged,
      visibility: "public",
    },
  ]);
  copiedIds.push(...Object.values(ids));
  return { ids, owner, packageId: pack.id, createdAt, deletedAt, issuedAt };
}

describe("copying an existing deployment's Bots into Intelligence", () => {
  test("every Bot crosses with every field, deleted ones included, and the copy is recorded", async () => {
    const database = await freshDeployment();
    const legacy = await legacyBots(database);
    const directory = replica();

    const outcome = await copyLocalBotsToIntelligence(database, directory);
    expect(outcome).toMatchObject({ kind: "copied", local: 3, created: 3 });

    const mine = await directory.registry.get(legacy.ids.mine);
    expect(mine).toMatchObject({
      id: legacy.ids.mine,
      type: "remote_ag_ui",
      name: "Research",
      title: "Research assistant",
      roleDescription: "Finds sources.",
      avatarSeed: "seed-research",
      visibility: "private",
      ownerUserId: legacy.owner,
      packageId: null,
      isolated: true,
      callbackTokenHash: expect.stringContaining("hash-"),
      deletedAt: null,
      configuration: {
        endpoint: "https://research.example.test/ag-ui",
        auth: {
          header: "Authorization",
          credentialId: expect.stringContaining("cred-"),
        },
      },
    });
    expect(mine?.createdAt.toISOString()).toBe(legacy.createdAt.toISOString());
    expect(mine?.callbackTokenIssuedAt?.toISOString()).toBe(
      legacy.issuedAt.toISOString(),
    );

    const deleted = await directory.registry.get(legacy.ids.deleted);
    expect(deleted?.deletedAt?.toISOString()).toBe(
      legacy.deletedAt.toISOString(),
    );
    expect(deleted?.configuration).toEqual({
      endpoint: "https://mastra.example.test",
      remoteAgentId: "weather",
    });

    const packaged = await directory.registry.get(legacy.ids.packaged);
    expect(packaged).toMatchObject({
      type: "built_in",
      packageId: legacy.packageId,
      ownerUserId: null,
      configuration: { systemPrompt: "Answer only from sources." },
    });

    const [record] = await database.select().from(intelligenceCopies);
    expect(record).toMatchObject({ name: "bots", copied: 3 });
  });

  test("a second boot copies nothing, and a Bot purged since is not brought back", async () => {
    const database = await freshDeployment();
    const legacy = await legacyBots(database);
    const directory = replica();
    await copyLocalBotsToIntelligence(database, directory);
    await directory.registry.purge(legacy.ids.mine, `test:${randomUUID()}`);

    expect(await copyLocalBotsToIntelligence(database, directory)).toEqual({
      kind: "done-before",
    });
    expect(await directory.registry.get(legacy.ids.mine)).toBeNull();
  });

  test("two replicas copying at once both finish, and each Bot exists once", async () => {
    const database = await freshDeployment();
    const legacy = await legacyBots(database);
    const outcomes = await Promise.all([
      copyLocalBotsToIntelligence(database, replica()),
      copyLocalBotsToIntelligence(database, replica()),
    ]);
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({ kind: "copied", local: 3 });
    const { bots: listed } = await replica().registry.all({
      includeDeleted: true,
    });
    for (const id of Object.values(legacy.ids))
      expect(listed.filter((bot) => bot.id === id)).toHaveLength(1);
  });

  test("a Bot with an id as long as the registry allows crosses too", async () => {
    // Intelligence keeps idempotency keys to 128 characters; a key built from a 200-character id
    // would be refused and stop the boot.
    const database = await freshDeployment();
    const longId = `copy-long-${randomUUID()}-${"x".repeat(200)}`.slice(0, 200);
    await database.insert(agents).values({
      id: longId,
      name: "Long",
      type: "built_in",
      configuration: { systemPrompt: "Has a long id." },
    });
    await database.insert(agentProfiles).values({
      agentId: longId,
      title: "",
      roleDescription: "",
      avatarSeed: longId,
      visibility: "public",
    });
    copiedIds.push(longId);

    expect(
      await copyLocalBotsToIntelligence(database, replica()),
    ).toMatchObject({ kind: "copied", local: 1, created: 1 });
    expect((await replica().registry.get(longId))?.id).toBe(longId);
  });

  test("a Bot Intelligence refuses stops the boot, names the Bot, and records nothing", async () => {
    const database = await freshDeployment();
    const legacy = await legacyBots(database);
    const broken = `agent_copy_broken_${randomUUID().slice(0, 8)}`;
    await database.insert(agents).values({
      id: broken,
      name: "Broken",
      type: "remote_ag_ui",
      // A key in plain text where a reference belongs: the registry holds no secrets.
      configuration: {
        endpoint: "https://user:secret@broken.example.test/ag-ui",
      },
    });
    await database.insert(agentProfiles).values({
      agentId: broken,
      title: "",
      roleDescription: "",
      avatarSeed: broken,
      visibility: "private",
    });
    copiedIds.push(broken);

    const copy = copyLocalBotsToIntelligence(database, replica());
    await expect(copy).rejects.toBeInstanceOf(BotCopyMismatchError);
    await expect(copy).rejects.toThrow(broken);
    expect(await database.select().from(intelligenceCopies)).toEqual([]);
    // The others crossed; the next boot only has the refused one left to resolve.
    expect(await replica().registry.get(legacy.ids.mine)).not.toBeNull();
  });
});
