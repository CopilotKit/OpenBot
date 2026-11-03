import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { authFromConfiguration } from "../src/agents/auth-header";
import {
  AgentNotFoundError,
  AgentNotManageableError,
  type AgentProfileStore,
  createAgentProfileStore,
  ManagedAgentUnavailableError,
  ProtectedAgentError,
} from "../src/agents/profile-store";
import type {
  AgentActor,
  AgentProfile,
  CreateAgentInput,
} from "../src/agents/profile-types";
import { DEPLOYMENT_ROUTES } from "../src/computer/deployment-routes";
import { createDatabase } from "../src/db/client";
import { agentPreferences, deploymentPackages, users } from "../src/db/schema";
import { removeBots, seedBot, useTestBots } from "./support/bots";
import {
  conversationClient,
  purgeConversations,
  seedConversation,
} from "./support/conversations";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const databaseUrl = testDatabaseUrl();
const database = createDatabase(databaseUrl, TEST_POOL);
const managedAgentAgUiUrl = new URL("https://managed.example.test/ag-ui");
const store: AgentProfileStore = createAgentProfileStore(
  database,
  managedAgentAgUiUrl,
);
const testPrefix = `agent-profile-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];

afterEach(async () => {
  await purgeConversations(createdChannelIds.splice(0));
  // For good, with this deployment's rows that named them, as deleting the agents row used to.
  await removeBots(createdAgentIds.splice(0));
  for (const packageId of createdPackageIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

beforeAll(async () => {
  await useTestBots();
});

afterAll(async () => {
  await database.$client.close();
});

function id(kind: string) {
  return `${testPrefix}-${kind}-${randomUUID()}`;
}

async function createUser(role: AgentActor["role"] = "user") {
  const userId = id("user");
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Profile Store Test User",
  });
  createdUserIds.push(userId);
  return { id: userId, role } satisfies AgentActor;
}

async function createPackage() {
  const [deploymentPackage] = await database
    .insert(deploymentPackages)
    .values({
      tenantId: id("tenant"),
      sourcePath: "test/profile-store",
      checksum: randomUUID(),
    })
    .returning();
  if (!deploymentPackage) throw new Error("Expected deployment package.");
  createdPackageIds.push(deploymentPackage.id);
  return deploymentPackage;
}

async function createProfileFixture(options: {
  owner: AgentActor | null;
  visibility?: "public" | "private";
  packageId?: string;
  name?: string;
  title?: string;
  roleDescription?: string;
  avatarSeed?: string;
  type?: "built_in" | "remote_ag_ui" | "remote_mastra";
  configuration?: Record<string, unknown>;
}) {
  const agentId = id("seed-agent");
  const name = options.name ?? `Seed ${randomUUID()}`;
  const title = options.title ?? "Seed Assistant";
  const roleDescription = options.roleDescription ?? "Helps test profiles.";
  const avatarSeed = options.avatarSeed ?? `avatar-${randomUUID()}`;
  await seedBot({
    id: agentId,
    name,
    type: options.type ?? "remote_ag_ui",
    configuration: options.configuration ?? {
      endpoint: "https://seed.example.test/ag-ui",
    },
    packageId: options.packageId ?? null,
    ownerUserId: options.owner?.id ?? null,
    title,
    roleDescription,
    avatarSeed,
    visibility: options.visibility ?? "private",
  });
  createdAgentIds.push(agentId);
  return { agentId, name, title, roleDescription, avatarSeed };
}

async function profileById(actor: AgentActor, agentId: string) {
  const profile = await store.get(actor, agentId);
  if (!profile) throw new Error(`Expected visible profile ${agentId}.`);
  return profile;
}

function expectListed(
  profiles: AgentProfile[],
  agentId: string,
  expected: boolean,
) {
  expect(profiles.some((profile) => profile.id === agentId)).toBe(expected);
}

/** The Bot as Intelligence holds it now, read past this instance's memory. */
async function storedBot(agentId: string) {
  const bot = await (await useTestBots()).registry.get(agentId);
  if (!bot) throw new Error(`Intelligence has no Bot ${agentId}`);
  return bot;
}

/**
 * The stored row behind a coworker, proven to exist before anything reads it.
 *
 * Asserted here rather than at each call site because a missing row and a missing field are
 * different failures that an optional chain would collapse into the same one — "systemPrompt is
 * undefined" reads as a prompt that was not written when it may be a coworker that is not there.
 */
async function agentRow(agentId: string): Promise<{
  type: string;
  configuration: { systemPrompt?: string; endpoint?: string };
}> {
  const row = await storedBot(agentId);
  return {
    type: row.type,
    configuration: (row.configuration ?? {}) as {
      systemPrompt?: string;
      endpoint?: string;
    },
  };
}

describe("agent profile store integration", () => {
  test("refuses to create a coworker with no endpoint when this deployment has no managed Bot", async () => {
    const owner = await createUser();
    const withoutManaged = createAgentProfileStore(database, undefined);

    await expect(
      withoutManaged.create(owner, {
        name: "No Endpoint",
        title: "Needs an address",
        roleDescription: "Should not land on a missing Bot.",
        visibility: "private",
      }),
    ).rejects.toBeInstanceOf(ManagedAgentUnavailableError);
  });

  /**
   * The coworker with nowhere to send it, and the instruction it actually runs on.
   *
   * `registeredAgentFromRow` gives a `built_in` agent its `configuration.systemPrompt` and NO
   * standing role message, so that column is the whole of what such a coworker is ever told —
   * the Bot's role description never reaches it. These two tests exist because the pair can
   * drift silently: creating writes both, and an edit that wrote only the profile left every screen
   * showing new instructions while the Bot went on following the old ones, for good, with nothing
   * anywhere to say so.
   */
  test("creates a coworker that runs here when there is nowhere to send it", async () => {
    const owner = await createUser();
    const withoutManaged = createAgentProfileStore(database, undefined);

    const created = await withoutManaged.create(owner, {
      name: "Runs Here",
      title: "Everyday Work",
      roleDescription: "Answer from the ledger and quote the line you used.",
      visibility: "private",
      systemPrompt: "Answer from the ledger and quote the line you used.",
    });
    createdAgentIds.push(created.id);

    const row = await agentRow(created.id);
    expect(row.type).toBe("built_in");
    expect(row.configuration.systemPrompt).toBe(
      "Answer from the ledger and quote the line you used.",
    );
    // No address was given and none was invented; that is what makes it built_in rather than remote.
    expect(row.configuration.endpoint).toBeUndefined();
  });

  test("an edit moves the instruction such a coworker actually runs on", async () => {
    const owner = await createUser();
    const withoutManaged = createAgentProfileStore(database, undefined);
    const created = await withoutManaged.create(owner, {
      name: "Runs Here",
      title: "Everyday Work",
      roleDescription: "The first instruction.",
      visibility: "private",
      systemPrompt: "The first instruction.",
    });
    createdAgentIds.push(created.id);

    await withoutManaged.update(owner, created.id, {
      name: "Runs Here",
      title: "Everyday Work",
      roleDescription: "The second instruction, which must be the live one.",
      visibility: "private",
    });

    const row = await agentRow(created.id);
    expect(row.type).toBe("built_in");
    expect(row.configuration.systemPrompt).toBe(
      "The second instruction, which must be the live one.",
    );
    // And the profile every screen reads agrees with it, rather than only the profile moving.
    expect((await profileById(owner, created.id)).roleDescription).toBe(
      "The second instruction, which must be the live one.",
    );
  });

  /**
   * The other half of the same rule: a remote coworker must not acquire a prompt it never had.
   *
   * Its instruction travels as the standing role message built from the profile, so a `systemPrompt`
   * appearing in its configuration would be a second source for the same thing — and the one the
   * runtime prefers for a `built_in` row, which is what this coworker would look like if its type
   * ever changed.
   */
  test("an edit never gives a coworker at its own address a system prompt", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      visibility: "private",
      configuration: { endpoint: "https://remote.example.test/ag-ui" },
    });

    await store.update(owner, source.agentId, {
      name: "Still Remote",
      title: "Elsewhere",
      roleDescription: "Edited, and it still runs at its own address.",
      visibility: "private",
      endpoint: "https://remote.example.test/ag-ui",
    });

    const row = await agentRow(source.agentId);
    expect(row.type).toBe("remote_ag_ui");
    expect(row.configuration.systemPrompt).toBeUndefined();
  });

  test("lets an owner and admin get and list a private profile but hides it from another user", async () => {
    const owner = await createUser();
    const other = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({ owner, visibility: "private" });

    expect((await profileById(owner, source.agentId)).id).toBe(source.agentId);
    expect((await profileById(admin, source.agentId)).id).toBe(source.agentId);
    expect(await store.get(other, source.agentId)).toBeNull();
    expectListed(await store.list(owner), source.agentId, true);
    expectListed(await store.list(admin), source.agentId, true);
    expectListed(await store.list(other), source.agentId, false);
  });

  test("stores hiding per user and moves the caller between default and hidden lists", async () => {
    const owner = await createUser();
    const other = await createUser();
    const source = await createProfileFixture({ owner, visibility: "public" });

    expectListed(await store.list(owner), source.agentId, true);
    expectListed(await store.list(owner, true), source.agentId, false);
    expectListed(await store.list(other), source.agentId, true);

    await store.setHidden(owner, source.agentId, true);
    expectListed(await store.list(owner), source.agentId, false);
    expectListed(await store.list(owner, true), source.agentId, true);
    expectListed(await store.list(other), source.agentId, true);
    expectListed(await store.list(other, true), source.agentId, false);

    await store.setHidden(owner, source.agentId, false);
    expectListed(await store.list(owner), source.agentId, true);
    expectListed(await store.list(owner, true), source.agentId, false);
    const [preference] = await database
      .select()
      .from(agentPreferences)
      .where(
        and(
          eq(agentPreferences.userId, owner.id),
          eq(agentPreferences.agentId, source.agentId),
        ),
      );
    expect(preference?.hiddenAt).toBeNull();
  });

  test("stores pinning per user, independently of hiding", async () => {
    const owner = await createUser();
    const other = await createUser();
    const source = await createProfileFixture({ owner, visibility: "public" });
    const pinnedFor = async (actor: AgentActor) =>
      (await profileById(actor, source.agentId)).pinned;

    expect(await pinnedFor(owner)).toBe(false);

    await store.setPinned(owner, source.agentId, true);
    expect(await pinnedFor(owner)).toBe(true);
    expect(await pinnedFor(other)).toBe(false);

    // The same preference row as hiding: each write must leave the other column alone.
    await store.setHidden(owner, source.agentId, true);
    const [hiddenWhilePinned] = await store.list(owner, true);
    expect(hiddenWhilePinned?.pinned).toBe(true);
    await store.setPinned(owner, source.agentId, false);
    await store.setPinned(owner, source.agentId, true);
    expectListed(await store.list(owner, true), source.agentId, true);

    await store.setHidden(owner, source.agentId, false);
    expect(await pinnedFor(owner)).toBe(true);
    await store.setPinned(owner, source.agentId, false);
    expect(await pinnedFor(owner)).toBe(false);
    const [preference] = await database
      .select()
      .from(agentPreferences)
      .where(
        and(
          eq(agentPreferences.userId, owner.id),
          eq(agentPreferences.agentId, source.agentId),
        ),
      );
    expect(preference?.pinnedAt).toBeNull();
    expect(preference?.hiddenAt).toBeNull();
  });

  test("refuses to pin a coworker the caller cannot see", async () => {
    const owner = await createUser();
    const other = await createUser();
    const privateSource = await createProfileFixture({
      owner,
      visibility: "private",
    });

    await expect(
      store.setPinned(other, privateSource.agentId, true),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("takes the endpoint and ignores every field a caller must not set", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      visibility: "private",
      configuration: { endpoint: "https://preserved.example.test/ag-ui" },
    });
    const before = await storedBot(source.agentId);

    const result = await store.update(owner, source.agentId, {
      name: "Renamed Assistant",
      title: "Updated Title",
      roleDescription: "Updated role description.",
      visibility: "public",
      id: "forged-id",
      // The endpoint IS editable, and is the one field in this hostile payload that lands. A service
      // moves host, and the alternative is deleting the coworker and losing its conversations. It
      // reaches here already validated by the same check that guards creation.
      endpoint: "https://moved.example.test/ag-ui",
      ownerUserId: "forged-owner",
      avatarSeed: "forged-avatar",
      packageId: deploymentPackage.id,
      deletedAt: new Date(),
    } as unknown as CreateAgentInput);

    expect(result).toMatchObject({
      id: source.agentId,
      name: "Renamed Assistant",
      title: "Updated Title",
      roleDescription: "Updated role description.",
      visibility: "public",
      ownerUserId: owner.id,
      avatarSeed: source.avatarSeed,
      systemOwned: false,
      deletedAt: null,
    });
    const stored = await storedBot(source.agentId);
    expect(stored).toMatchObject({
      id: source.agentId,
      name: "Renamed Assistant",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://moved.example.test/ag-ui" },
      packageId: null,
      ownerUserId: owner.id,
      title: "Updated Title",
      roleDescription: "Updated role description.",
      avatarSeed: source.avatarSeed,
      visibility: "public",
      deletedAt: null,
      version: before.version + 1,
    });
    expect(stored.updatedAt.getTime()).toBeGreaterThan(
      before.updatedAt.getTime(),
    );
  });

  test("rejects public non-owner mutation as unmanageable and inaccessible private mutation as absent", async () => {
    const owner = await createUser();
    const other = await createUser();
    const publicSource = await createProfileFixture({
      owner,
      visibility: "public",
    });
    const privateSource = await createProfileFixture({
      owner,
      visibility: "private",
    });
    const input: CreateAgentInput = {
      name: "Other Name",
      title: "Other Title",
      roleDescription: "Other role.",
      visibility: "public",
    };

    await expect(
      store.update(other, publicSource.agentId, input),
    ).rejects.toBeInstanceOf(AgentNotManageableError);
    await store.setHidden(other, publicSource.agentId, true);
    expectListed(await store.list(other), publicSource.agentId, false);
    expectListed(await store.list(other, true), publicSource.agentId, true);
    await expect(
      store.update(other, privateSource.agentId, input),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(
      store.setHidden(other, privateSource.agentId, true),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("rejects update and soft delete for a package-backed profile", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      packageId: deploymentPackage.id,
    });
    const input: CreateAgentInput = {
      name: "Protected Rename",
      title: "Protected Title",
      roleDescription: "Protected role.",
      visibility: "public",
    };

    const profile = await profileById(owner, source.agentId);
    expect(profile.systemOwned).toBe(true);
    await expect(
      store.update(owner, source.agentId, input),
    ).rejects.toBeInstanceOf(ProtectedAgentError);
    await expect(
      store.softDelete(owner, source.agentId),
    ).rejects.toBeInstanceOf(ProtectedAgentError);
  });

  /*
   * Somebody else changes the Bot between this store reading it and writing it: a package takes it
   * over. There is no row lock to wait on any more, because the Bot is in Intelligence; the write is
   * made at the version the store checked, Intelligence refuses it as stale, and the store reads the
   * Bot again and refuses on what it now is. The change made behind its back goes straight to the
   * registry, so this instance's memory may or may not have heard of it yet; either way the answer is
   * the same.
   */
  async function attachBehindTheStore(agentId: string, packageId: string) {
    const registry = (await useTestBots()).registry;
    const current = await storedBot(agentId);
    await registry.update(
      agentId,
      current.version,
      { packageId },
      `test:${randomUUID()}`,
    );
  }

  test("refuses an update when a package took the Bot over since it was read", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      name: "Original Name",
      title: "Original Title",
      roleDescription: "Original role.",
    });
    await profileById(owner, source.agentId);
    await attachBehindTheStore(source.agentId, deploymentPackage.id);

    await expect(
      store.update(owner, source.agentId, {
        name: "Racing Rename",
        title: "Racing Title",
        roleDescription: "Racing role.",
        visibility: "public",
      }),
    ).rejects.toBeInstanceOf(ProtectedAgentError);
    expect(await storedBot(source.agentId)).toMatchObject({
      name: source.name,
      packageId: deploymentPackage.id,
      deletedAt: null,
      roleDescription: source.roleDescription,
      title: source.title,
      visibility: "private",
    });
  });

  test("refuses a delete when a package took the Bot over since it was read", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({ owner });
    await profileById(owner, source.agentId);
    await attachBehindTheStore(source.agentId, deploymentPackage.id);

    await expect(
      store.softDelete(owner, source.agentId),
    ).rejects.toBeInstanceOf(ProtectedAgentError);
    const stored = await storedBot(source.agentId);
    expect(stored.packageId).toBe(deploymentPackage.id);
    expect(stored.deletedAt).toBeNull();
  });

  test("allows an admin to update and soft delete a user-owned profile", async () => {
    const owner = await createUser();
    const admin = await createUser("admin");
    const source = await createProfileFixture({ owner });

    const updated = await store.update(admin, source.agentId, {
      name: "Admin Rename",
      title: "Admin Title",
      roleDescription: "Admin role update.",
      visibility: "private",
    });
    expect(updated).toMatchObject({
      name: "Admin Rename",
      ownerUserId: owner.id,
      title: "Admin Title",
    });

    await store.softDelete(admin, source.agentId);
    expect(await store.get(admin, source.agentId)).toBeNull();
  });

  test("duplicates a profile as a caller-owned private agent with copied presentation fields", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      visibility: "public",
      name: "Source Name",
      title: "Source Title",
      roleDescription: "Source role.",
      avatarSeed: "source-avatar",
    });
    await store.setHidden(owner, source.agentId, true);

    const duplicate = await store.duplicate(owner, source.agentId);

    expect(duplicate.id).toMatch(
      /^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(duplicate).toMatchObject({
      name: source.name,
      title: source.title,
      roleDescription: source.roleDescription,
      avatarSeed: source.avatarSeed,
      visibility: "private",
      ownerUserId: owner.id,
      systemOwned: false,
      hidden: false,
      deletedAt: null,
    });
    expect(duplicate.id).not.toBe(source.agentId);
    createdAgentIds.push(duplicate.id);
    const duplicatePreferences = await database
      .select()
      .from(agentPreferences)
      .where(eq(agentPreferences.agentId, duplicate.id));
    expect(duplicatePreferences).toHaveLength(0);
  });

  test("duplicates no channel membership or Intelligence mapping from the source", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({ owner, visibility: "public" });
    const channelId = id("channel");
    createdChannelIds.push(channelId);
    await seedConversation({
      id: channelId,
      name: "Source channel",
      description: "Links source agent to Intelligence.",
      agentIds: [source.agentId],
      members: [{ userId: owner.id, threadId: id("thread") }],
    });

    const duplicate = await store.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    // Every conversation, deleted ones included, that has this Bot in it, as Intelligence holds them.
    const conversationsWith = async (agentId: string) =>
      (await conversationClient()).all({ agentId, includeDeleted: true });
    // And each member's own thread in them: what `intelligence_channel_mappings` held.
    const ownThreadsIn = (
      found: Awaited<ReturnType<typeof conversationsWith>>,
    ) =>
      found.flatMap((conversation) =>
        conversation.threads.filter((thread) => thread.agentId === null),
      );
    const sourceMappings = ownThreadsIn(
      await conversationsWith(source.agentId),
    );
    const duplicateChannelAgents = await conversationsWith(duplicate.id);
    const duplicateMappings = ownThreadsIn(duplicateChannelAgents);
    expect(sourceMappings).not.toHaveLength(0);
    expect(duplicateChannelAgents).toHaveLength(0);
    expect(duplicateMappings).toHaveLength(0);
  });

  test("copies the source's own endpoint rather than repointing the copy at the managed Bot", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      configuration: { endpoint: "https://hosted.example.test/ag-ui" },
    });

    const duplicate = await store.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    expect(duplicate.endpoint).toBe("https://hosted.example.test/ag-ui");
    expect(duplicate.endpoint).not.toBe(managedAgentAgUiUrl.toString());
  });

  test("gives a copy of an endpoint-less source the managed Bot, as its source had", async () => {
    const owner = await createUser();
    const created = await store.create(owner, {
      name: `Created ${randomUUID()}`,
      title: "Created Title",
      roleDescription: "Created role description.",
      visibility: "private",
    } as CreateAgentInput);
    createdAgentIds.push(created.id);

    const duplicate = await store.duplicate(owner, created.id);
    createdAgentIds.push(duplicate.id);

    expect(duplicate.endpoint).toBe(managedAgentAgUiUrl.toString());
  });

  test("does not carry the source's stored key onto the copy", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      configuration: {
        endpoint: "https://hosted.example.test/ag-ui",
        auth: { header: "Authorization", credentialId: "credential-1" },
      },
    });
    expect((await profileById(owner, source.agentId)).hasAuth).toBe(true);

    const duplicate = await store.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    expect(duplicate.hasAuth).toBe(false);
    const row = await storedBot(duplicate.id);
    expect(authFromConfiguration(row.configuration)).toBeNull();
  });

  test("duplicates a coworker with its own endpoint on a deployment with no managed Bot", async () => {
    const unmanagedStore = createAgentProfileStore(database, undefined);
    const owner = await createUser();
    const source = await createProfileFixture({
      owner,
      configuration: { endpoint: "https://hosted.example.test/ag-ui" },
    });

    const duplicate = await unmanagedStore.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    expect(duplicate.endpoint).toBe("https://hosted.example.test/ag-ui");
  });

  test("refuses to duplicate an endpoint-less coworker with no managed Bot to fall back to", async () => {
    const unmanagedStore = createAgentProfileStore(database, undefined);
    const owner = await createUser();
    // Neither an address nor an instruction to run on: a Bot in the box whose prompt is empty.
    const source = await createProfileFixture({
      owner,
      type: "built_in",
      configuration: { systemPrompt: "" },
    });

    await expect(
      unmanagedStore.duplicate(owner, source.agentId),
    ).rejects.toBeInstanceOf(ManagedAgentUnavailableError);
  });

  test("soft deletes a profile from reads and lists while Intelligence keeps the Bot", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({ owner, visibility: "public" });

    await store.softDelete(owner, source.agentId);

    expect(await store.get(owner, source.agentId)).toBeNull();
    expectListed(await store.list(owner), source.agentId, false);
    expectListed(await store.list(owner, true), source.agentId, false);
    const stored = await storedBot(source.agentId);
    expect(stored.id).toBe(source.agentId);
    expect(stored.deletedAt).toBeInstanceOf(Date);
    await expect(
      store.setHidden(owner, source.agentId, true),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("leaves no Bot behind when Intelligence refuses the create", async () => {
    const owner = await createUser();
    const name = `Rollback ${randomUUID()}`;

    await expect(
      store.create(owner, {
        name,
        title: null,
        roleDescription: "This profile insert must fail.",
        visibility: "public",
      } as unknown as CreateAgentInput),
    ).rejects.toThrow();
    const { bots: everything } = await (await useTestBots()).registry.all({
      includeDeleted: true,
    });
    expect(everything.filter((bot) => bot.name === name)).toHaveLength(0);
  });

  /*
   * The id a caller gets is never one they chose.
   *
   * The reserved-id checks in `tenant-package.ts` rest on this: a package is the only place a Bot id
   * is written by a person, so refusing the reserved names there closes them everywhere. The day
   * this route lets a caller name their own Bot, that stops being true, and this is the test that
   * says so rather than the reader who happens to notice.
   */
  test("mints its own id rather than taking one, for a create and for a copy", async () => {
    const owner = await createUser();
    const created = await store.create(owner, {
      name: `Created ${randomUUID()}`,
      title: "Created Title",
      roleDescription: "Created role description.",
      visibility: "private",
    } as CreateAgentInput);
    createdAgentIds.push(created.id);
    const copy = await store.duplicate(owner, created.id);
    createdAgentIds.push(copy.id);

    for (const id of [created.id, copy.id]) {
      expect(id).toMatch(
        /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(DEPLOYMENT_ROUTES.has(id)).toBe(false);
    }
  });

  test("creates a caller-owned remote AG-UI profile with the requested visibility", async () => {
    const owner = await createUser();
    const input: CreateAgentInput = {
      name: `Created ${randomUUID()}`,
      title: "Created Title",
      roleDescription: "Created role description.",
      visibility: "public",
    };

    const created = await store.create(owner, input);
    createdAgentIds.push(created.id);

    expect(created).toMatchObject({
      name: input.name,
      title: input.title,
      roleDescription: input.roleDescription,
      avatarSeed: created.id,
      visibility: "public",
      ownerUserId: owner.id,
      systemOwned: false,
      hidden: false,
      deletedAt: null,
    });
    const canonical = await storedBot(created.id);
    expect(canonical).toMatchObject({
      id: created.id,
      name: input.name,
      type: "remote_ag_ui",
      configuration: { endpoint: managedAgentAgUiUrl.toString() },
      packageId: null,
    });
  });
});
