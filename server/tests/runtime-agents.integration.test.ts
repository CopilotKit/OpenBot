import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { standingRoleMessage } from "../src/copilot";
import { type CredentialSecretReader, encryptSecret } from "../src/credentials";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const managedEndpoint = new URL("https://managed.example.test/ag-ui");
const mastraManagedEndpoint = new URL("https://managed.example.test/mastra");
const profileStore = createAgentProfileStore(database, managedEndpoint);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);
const managedAgentToken = "managed-agent-token";
const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const loadAgents = createRuntimeAgentLoader(database, undefined, {
  endpoint: managedEndpoint,
  token: managedAgentToken,
  alsoRun: mastraManagedEndpoint,
});

const testPrefix = `runtime-agents-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(role: AgentActor["role"] = "user") {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Runtime Agents Test User",
  });
  createdUserIds.push(id);
  return { id, role } satisfies AgentActor;
}

async function createCoworker(
  owner: AgentActor,
  overrides: { name?: string; visibility?: "public" | "private" } = {},
) {
  const profile = await profileStore.create(owner, {
    name: overrides.name ?? "Expense Manager",
    title: "Finance Operations",
    roleDescription:
      "Review receipts, categorize expenses, and prepare reimbursement reports.",
    visibility: overrides.visibility ?? "private",
  });
  createdAgentIds.push(profile.id);
  return profile;
}

async function setAgentRun(
  id: string,
  run: {
    type: "remote_ag_ui" | "remote_mastra";
    configuration: Record<string, unknown>;
  },
) {
  await database.update(agents).set(run).where(eq(agents.id, id));
}

function idsOf(loaded: Awaited<ReturnType<typeof loadAgents>>) {
  return loaded.map((agent) => agent.id);
}

/**
 * Which coworkers exist is a per-person question, answered on every request. These assertions are
 * against the database rather than a fake, because the whole point of resolving here is that the
 * filtering happens in the query and not in JavaScript after every row has already been read.
 */
describe("runtime agent loading", () => {
  test("carries the owner's coworker with its standing role and managed endpoint", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    const loaded = await loadAgents(owner);

    expect(loaded).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "remote_ag_ui",
      endpoint: managedEndpoint.toString(),
      headers: { "x-openbot-agent-token": managedAgentToken },
      standingMessage: standingRoleMessage({
        id: profile.id,
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription:
          "Review receipts, categorize expenses, and prepare reimbursement reports.",
      }),
    });
  });

  test("carries the managed deployment token to a Mastra endpoint this deployment runs", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);
    await setAgentRun(profile.id, {
      type: "remote_mastra",
      configuration: {
        endpoint: mastraManagedEndpoint.toString(),
        remoteAgentId: "openbot",
      },
    });

    const loaded = await loadAgents(owner);

    expect(loaded).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "remote_mastra",
      endpoint: mastraManagedEndpoint.toString(),
      remoteAgentId: "openbot",
      headers: { "x-openbot-agent-token": managedAgentToken },
      standingMessage: standingRoleMessage({
        id: profile.id,
        name: "Expense Manager",
        title: "Finance Operations",
        roleDescription:
          "Review receipts, categorize expenses, and prepare reimbursement reports.",
      }),
    });
  });

  test("resolves vault auth headers for a Mastra endpoint that names a credential", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner, { name: "Research Mastra" });
    const vaultReads: string[] = [];
    const credentialId = `credential-${randomUUID()}`;
    const reader: CredentialSecretReader = {
      readSecret: async (id) => {
        vaultReads.push(id);
        return id === credentialId
          ? {
              encryptedValue: await encryptSecret(
                encryptionKey,
                "Bearer mastra-secret",
              ),
              revokedAt: null,
            }
          : null;
      },
    };
    await setAgentRun(profile.id, {
      type: "remote_mastra",
      configuration: {
        endpoint: "https://customer-mastra.example.test",
        remoteAgentId: "research",
        auth: {
          header: "Authorization",
          credentialId,
        },
      },
    });
    const loadWithVault = createRuntimeAgentLoader(database, {
      reader,
      encryptionKey,
    });

    const loaded = await loadWithVault(owner);

    expect(vaultReads).toEqual([credentialId]);
    expect(loaded).toContainEqual({
      id: profile.id,
      name: "Research Mastra",
      type: "remote_mastra",
      endpoint: "https://customer-mastra.example.test",
      remoteAgentId: "research",
      headers: { Authorization: "Bearer mastra-secret" },
      standingMessage: standingRoleMessage({
        id: profile.id,
        name: "Research Mastra",
        title: "Finance Operations",
        roleDescription:
          "Review receipts, categorize expenses, and prepare reimbursement reports.",
      }),
    });
  });

  test("hides a private coworker from everybody but its owner and administrators", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const administrator = await createUser("admin");
    const profile = await createCoworker(owner);

    expect(idsOf(await loadAgents(owner))).toContain(profile.id);
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
    expect(idsOf(await loadAgents(administrator))).toContain(profile.id);
  });

  test("shares a public coworker with everybody", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const profile = await createCoworker(owner, {
      name: "Company Helper",
      visibility: "public",
    });

    expect(idsOf(await loadAgents(otherUser))).toContain(profile.id);
  });

  test("drops a deleted coworker that has no history to restore", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    await profileStore.softDelete(owner, profile.id);

    expect(idsOf(await loadAgents(owner))).not.toContain(profile.id);
  });

  test("keeps a deleted coworker as a tombstone for a channel member", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const profile = await createCoworker(owner);
    const channel = await channelStore.create(owner, [profile.id]);
    createdChannelIds.push(channel.id);

    await profileStore.softDelete(owner, profile.id);

    expect(await loadAgents(owner)).toContainEqual({
      id: profile.id,
      name: "Expense Manager",
      type: "unavailable",
      reason:
        "Expense Manager has been deleted and can no longer run. Its conversations remain readable.",
    });
    // Somebody with no channel of their own gets no tombstone: history is what authorizes it.
    expect(idsOf(await loadAgents(otherUser))).not.toContain(profile.id);
  });

  test("authorizes deleted coworker tombstones only through live channels", async () => {
    const owner = await createUser();
    const otherUser = await createUser();
    const deletedOnlyProfile = await createCoworker(owner, {
      name: "Deleted Only Helper",
    });
    const preservedProfile = await createCoworker(owner, {
      name: "Preserved Helper",
    });
    const deletedOnlyChannel = await channelStore.create(owner, [
      deletedOnlyProfile.id,
    ]);
    const deletedPreservedChannel = await channelStore.create(owner, [
      preservedProfile.id,
    ]);
    const livePreservedChannel = await channelStore.create(owner, [
      preservedProfile.id,
    ]);
    createdChannelIds.push(
      deletedOnlyChannel.id,
      deletedPreservedChannel.id,
      livePreservedChannel.id,
    );

    await profileStore.softDelete(owner, deletedOnlyProfile.id);
    await profileStore.softDelete(owner, preservedProfile.id);
    await channelStore.softDelete(owner, deletedOnlyChannel.id);
    await channelStore.softDelete(owner, deletedPreservedChannel.id);

    const retainedDeletedOnlyRows = await database
      .select({
        channelDeletedAt: channels.deletedAt,
        memberUserId: channelMemberships.userId,
        agentId: channelAgents.agentId,
        profileDeletedAt: agentProfiles.deletedAt,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        eq(channelMemberships.channelId, channels.id),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, channelAgents.agentId),
      )
      .where(eq(channels.id, deletedOnlyChannel.id));
    expect(retainedDeletedOnlyRows).toHaveLength(1);
    expect(retainedDeletedOnlyRows[0]).toMatchObject({
      memberUserId: owner.id,
      agentId: deletedOnlyProfile.id,
    });
    expect(retainedDeletedOnlyRows[0]?.channelDeletedAt).toBeInstanceOf(Date);
    expect(retainedDeletedOnlyRows[0]?.profileDeletedAt).toBeInstanceOf(Date);

    const retainedLivePreservedRows = await database
      .select({
        channelDeletedAt: channels.deletedAt,
        memberUserId: channelMemberships.userId,
        agentId: channelAgents.agentId,
        profileDeletedAt: agentProfiles.deletedAt,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        eq(channelMemberships.channelId, channels.id),
      )
      .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
      .innerJoin(
        agentProfiles,
        eq(agentProfiles.agentId, channelAgents.agentId),
      )
      .where(eq(channels.id, livePreservedChannel.id));
    expect(retainedLivePreservedRows).toHaveLength(1);
    expect(retainedLivePreservedRows[0]).toMatchObject({
      channelDeletedAt: null,
      memberUserId: owner.id,
      agentId: preservedProfile.id,
    });
    expect(retainedLivePreservedRows[0]?.profileDeletedAt).toBeInstanceOf(Date);

    const ownerRoster = await loadAgents(owner);
    expect(ownerRoster).not.toContainEqual(
      expect.objectContaining({ id: deletedOnlyProfile.id }),
    );
    expect(ownerRoster).toContainEqual({
      id: preservedProfile.id,
      name: "Preserved Helper",
      type: "unavailable",
      reason:
        "Preserved Helper has been deleted and can no longer run. Its conversations remain readable.",
    });
    expect(idsOf(await loadAgents(otherUser))).not.toEqual(
      expect.arrayContaining([deletedOnlyProfile.id, preservedProfile.id]),
    );
  });

  test("applies an edited role to the next load without a restart", async () => {
    const owner = await createUser();
    const profile = await createCoworker(owner);

    await profileStore.update(owner, profile.id, {
      name: "Expense Manager",
      title: "Finance Operations",
      roleDescription: "Reconcile corporate card statements.",
      visibility: "private",
    });

    const reloaded = (await loadAgents(owner)).find(
      (agent) => agent.id === profile.id,
    );
    expect(
      reloaded?.type === "remote_ag_ui" && reloaded.standingMessage.content,
    ).toContain("Reconcile corporate card statements.");
  });
});
