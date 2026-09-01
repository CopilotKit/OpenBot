import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
import {
  agentPreferences,
  agentProfiles,
  agents,
  channelAgents,
  channels,
  deploymentPackages,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
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
  for (const channelId of createdChannelIds.splice(0)) {
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const packageId of createdPackageIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.id, packageId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
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
  avatarImage?: string;
  configuration?: Record<string, unknown>;
}) {
  const agentId = id("seed-agent");
  const name = options.name ?? `Seed ${randomUUID()}`;
  const title = options.title ?? "Seed Assistant";
  const roleDescription = options.roleDescription ?? "Helps test profiles.";
  const avatarSeed = options.avatarSeed ?? `avatar-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name,
    type: "remote_ag_ui",
    configuration: options.configuration ?? {
      endpoint: "https://seed.example.test/ag-ui",
    },
    packageId: options.packageId,
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: options.owner?.id ?? null,
    title,
    roleDescription,
    avatarSeed,
    avatarImage: options.avatarImage,
    visibility: options.visibility ?? "private",
  });
  return {
    agentId,
    name,
    title,
    roleDescription,
    avatarSeed,
    avatarImage: options.avatarImage ?? null,
  };
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

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitForMutationBlock(
  applicationName: string,
  mutationSettled: () => boolean,
) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const blockedSessions = await database.execute(sql`
      SELECT pid
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND cardinality(pg_blocking_pids(pid)) > 0
      LIMIT 1
    `);
    if (blockedSessions.length > 0) return true;
    if (mutationSettled()) return false;
  }
  throw new Error(`Timed out observing blocked session ${applicationName}.`);
}

async function racePackageAttachment(
  agentId: string,
  packageId: string,
  mutate: (namedStore: AgentProfileStore) => Promise<unknown>,
) {
  const applicationName = `profile_store_lock_${randomUUID()}`;
  const namedDatabaseUrl = new URL(databaseUrl);
  namedDatabaseUrl.searchParams.set("application_name", applicationName);
  const namedDatabase = createDatabase(namedDatabaseUrl.toString(), TEST_POOL);
  const namedStore = createAgentProfileStore(
    namedDatabase,
    managedAgentAgUiUrl,
  );
  const writeAcquired = deferred();
  const releaseAttachment = deferred();
  const attachment = database.transaction(async (transaction) => {
    await transaction
      .update(agents)
      .set({ packageId })
      .where(eq(agents.id, agentId));
    writeAcquired.resolve();
    await releaseAttachment.promise;
  });
  void attachment.catch(writeAcquired.reject);

  try {
    await writeAcquired.promise;
    let settled = false;
    const outcomePromise = mutate(namedStore).then(
      (value) => {
        settled = true;
        return { status: "fulfilled", value } as const;
      },
      (reason: unknown) => {
        settled = true;
        return { reason, status: "rejected" } as const;
      },
    );
    const blocked = await waitForMutationBlock(applicationName, () => settled);
    releaseAttachment.resolve();
    await attachment;
    return { blocked, outcome: await outcomePromise };
  } finally {
    releaseAttachment.resolve();
    await attachment.catch(() => undefined);
    await namedDatabase.$client.close();
  }
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

  test("takes the endpoint and ignores every field a caller must not set", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      visibility: "private",
      configuration: { endpoint: "https://preserved.example.test/ag-ui" },
    });
    const oldTimestamp = new Date("2000-01-01T00:00:00.000Z");
    await database
      .update(agents)
      .set({ updatedAt: oldTimestamp })
      .where(eq(agents.id, source.agentId));
    await database
      .update(agentProfiles)
      .set({ updatedAt: oldTimestamp })
      .where(eq(agentProfiles.agentId, source.agentId));

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
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical).toMatchObject({
      id: source.agentId,
      name: "Renamed Assistant",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://moved.example.test/ag-ui" },
      packageId: null,
    });
    expect(profile).toMatchObject({
      ownerUserId: owner.id,
      title: "Updated Title",
      roleDescription: "Updated role description.",
      avatarSeed: source.avatarSeed,
      visibility: "public",
      deletedAt: null,
    });
    expect(canonical?.updatedAt.getTime()).toBeGreaterThan(
      oldTimestamp.getTime(),
    );
    expect(profile?.updatedAt.getTime()).toBeGreaterThan(
      oldTimestamp.getTime(),
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

  test("serializes update authorization against concurrent package attachment", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({
      owner,
      name: "Original Name",
      title: "Original Title",
      roleDescription: "Original role.",
    });

    const { blocked, outcome } = await racePackageAttachment(
      source.agentId,
      deploymentPackage.id,
      (namedStore) =>
        namedStore.update(owner, source.agentId, {
          name: "Racing Rename",
          title: "Racing Title",
          roleDescription: "Racing role.",
          visibility: "public",
        }),
    );

    expect(outcome.status).toBe("rejected");
    expect(blocked).toBe(true);
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(ProtectedAgentError);
    }
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.name).toBe(source.name);
    expect(canonical?.packageId).toBe(deploymentPackage.id);
    expect(profile).toMatchObject({
      deletedAt: null,
      roleDescription: source.roleDescription,
      title: source.title,
      visibility: "private",
    });
  });

  test("serializes soft-delete authorization against concurrent package attachment", async () => {
    const owner = await createUser();
    const deploymentPackage = await createPackage();
    const source = await createProfileFixture({ owner });

    const { blocked, outcome } = await racePackageAttachment(
      source.agentId,
      deploymentPackage.id,
      (namedStore) => namedStore.softDelete(owner, source.agentId),
    );

    expect(outcome.status).toBe("rejected");
    expect(blocked).toBe(true);
    if (outcome.status === "rejected") {
      expect(outcome.reason).toBeInstanceOf(ProtectedAgentError);
    }
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.packageId).toBe(deploymentPackage.id);
    expect(profile?.deletedAt).toBeNull();
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

  test("stores avatar overrides for owners and lets an admin brand a package Bot", async () => {
    const owner = await createUser();
    const other = await createUser();
    const admin = await createUser("admin");
    const userAgent = await createProfileFixture({ owner });
    const deploymentPackage = await createPackage();
    const packageAgent = await createProfileFixture({
      owner: null,
      packageId: deploymentPackage.id,
      visibility: "public",
    });

    const updated = await store.setAvatar(
      owner,
      userAgent.agentId,
      "data:image/png;base64,owner",
    );
    expect(updated.hasCustomAvatar).toBe(true);
    expect(await store.avatar(owner, userAgent.agentId)).toBe(
      "data:image/png;base64,owner",
    );
    await expect(
      store.setAvatar(other, userAgent.agentId, "data:image/png;base64,other"),
    ).rejects.toThrow("was not found");

    const branded = await store.setAvatar(
      admin,
      packageAgent.agentId,
      "data:image/png;base64,admin",
    );
    expect(branded.hasCustomAvatar).toBe(true);
    expect(await store.avatar(admin, packageAgent.agentId)).toBe(
      "data:image/png;base64,admin",
    );
    await expect(
      store.setAvatar(owner, packageAgent.agentId, null),
    ).rejects.toThrow("cannot be managed");
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
      avatarImage: "data:image/png;base64,source",
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
      hasCustomAvatar: true,
      visibility: "private",
      ownerUserId: owner.id,
      systemOwned: false,
      hidden: false,
      deletedAt: null,
    });
    expect(await store.avatar(owner, duplicate.id)).toBe(source.avatarImage);
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
    await database.insert(channels).values({
      id: channelId,
      name: "Source channel",
      description: "Links source agent to Intelligence.",
    });
    await database.insert(channelAgents).values({
      channelId,
      agentId: source.agentId,
    });
    await database.insert(intelligenceChannelMappings).values({
      userId: owner.id,
      channelId,
      threadId: id("thread"),
    });
    createdChannelIds.push(channelId);

    const duplicate = await store.duplicate(owner, source.agentId);
    createdAgentIds.push(duplicate.id);

    const sourceMappings = await database
      .select()
      .from(channelAgents)
      .innerJoin(
        intelligenceChannelMappings,
        eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
      )
      .where(eq(channelAgents.agentId, source.agentId));
    const duplicateMappings = await database
      .select()
      .from(channelAgents)
      .innerJoin(
        intelligenceChannelMappings,
        eq(channelAgents.channelId, intelligenceChannelMappings.channelId),
      )
      .where(eq(channelAgents.agentId, duplicate.id));
    const duplicateChannelAgents = await database
      .select()
      .from(channelAgents)
      .where(eq(channelAgents.agentId, duplicate.id));
    expect(sourceMappings).not.toHaveLength(0);
    expect(duplicateChannelAgents).toHaveLength(0);
    expect(duplicateMappings).toHaveLength(0);
  });

  test("soft deletes a profile from reads and lists while retaining its raw rows", async () => {
    const owner = await createUser();
    const source = await createProfileFixture({ owner, visibility: "public" });

    await store.softDelete(owner, source.agentId);

    expect(await store.get(owner, source.agentId)).toBeNull();
    expectListed(await store.list(owner), source.agentId, false);
    expectListed(await store.list(owner, true), source.agentId, false);
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, source.agentId));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, source.agentId));
    expect(canonical?.id).toBe(source.agentId);
    expect(profile?.agentId).toBe(source.agentId);
    expect(profile?.deletedAt).toBeInstanceOf(Date);
    await expect(
      store.setHidden(owner, source.agentId, true),
    ).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  test("rolls back canonical creation when the profile insert fails", async () => {
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
    const rows = await database
      .select()
      .from(agents)
      .where(eq(agents.name, name));
    expect(rows).toHaveLength(0);
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
    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, created.id));
    expect(canonical).toMatchObject({
      id: created.id,
      name: input.name,
      type: "remote_ag_ui",
      configuration: { endpoint: managedAgentAgUiUrl.toString() },
      packageId: null,
    });
  });
});
