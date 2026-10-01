import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  AgentAssignedError,
  createAgentProfileStore,
} from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { PluginRefusedError } from "../src/plugins/store";
import {
  createTeamBots,
  TEAM_BOT_CONSENT_MARKER,
  TeamBotRefusedError,
} from "../src/team-bots/team-bots";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profiles,
  createThreadIdentity("test-deployment"),
);
const prefix = `team-bots-${randomUUID()}`;
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdChannels: string[] = [];
/** Which servers each person has their own account on, for the consent rule. */
const connected = new Map<string, Set<string>>();
const teamBots = createTeamBots({
  database,
  connectedServers: async (userId) => connected.get(userId) ?? new Set(),
});

afterEach(async () => {
  for (const id of createdChannels.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, id));
    await database.delete(channels).where(eq(channels.id, id));
  }
  const ids = createdAgents.splice(0);
  if (ids.length) {
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, ids));
    await database.delete(agents).where(inArray(agents.id, ids));
  }
  for (const id of createdUsers.splice(0))
    await database.delete(users).where(eq(users.id, id));
  connected.clear();
});
afterAll(async () => {
  await database.$client.close();
});

async function person(
  role: AgentActor["role"] = "user",
  groups: string[] = [],
): Promise<AgentActor & { email: string }> {
  const id = `${prefix}-user-${randomUUID()}`;
  const email = `${id}@example.test`;
  await database
    .insert(users)
    .values({ id, email, name: "Team Bot Test", groups });
  createdUsers.push(id);
  return { id, role, email };
}
async function privateBot(owner: AgentActor, roleDescription = "Answers.") {
  const profile = await profileStore().create(owner, {
    name: "Release Helper",
    title: "Releases",
    roleDescription,
    visibility: "private",
  });
  createdAgents.push(profile.id);
  return profile.id;
}
const profileStore = () => profiles;

describe("Team Bots in PostgreSQL", () => {
  test("publishing reaches the team, named people or groups, and unpublishing takes it away", async () => {
    const owner = await person();
    const teammate = await person();
    const engineer = await person("user", ["eng"]);
    const bot = await privateBot(owner);
    expect(await profiles.get(teammate, bot)).toBeNull();

    await teamBots.publish(owner, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    expect(await profiles.get(teammate, bot)).not.toBeNull();
    expect(await profiles.get(engineer, bot)).not.toBeNull();

    await teamBots.publish(owner, bot, {
      audience: "people",
      emails: [teammate.email.toUpperCase()],
      groups: [],
    });
    expect(await profiles.get(teammate, bot)).not.toBeNull();
    expect(await profiles.get(engineer, bot)).toBeNull();

    await teamBots.publish(owner, bot, {
      audience: "people",
      emails: [],
      groups: ["eng"],
    });
    expect(await profiles.get(teammate, bot)).toBeNull();
    expect(await profiles.get(engineer, bot)).not.toBeNull();

    await teamBots.unpublish(owner, bot);
    expect(await profiles.get(engineer, bot)).toBeNull();
    // Only the owner publishes, and an undescribed Bot is not published at all.
    await expect(
      teamBots.publish(teammate, bot, {
        audience: "team",
        emails: [],
        groups: [],
      }),
    ).rejects.toThrow();
    const bare = await privateBot(owner, "  ");
    await expect(
      teamBots.publish(owner, bare, {
        audience: "team",
        emails: [],
        groups: [],
      }),
    ).rejects.toThrow(TeamBotRefusedError);
  });

  test("a teammate's chat is private from the owner, and the Bot can join the teammate's group", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await privateBot(owner);
    await teamBots.publish(owner, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    const chat = await channelStore.create(teammate, [bot]);
    createdChannels.push(chat.id);
    expect(await channelStore.get(teammate, chat.id)).not.toBeNull();
    expect(await channelStore.get(owner, chat.id)).toBeNull();

    const own = await privateBot(teammate);
    const group = await channelStore.create(teammate, [bot, own]);
    createdChannels.push(group.id);
    expect(group.agentIds.sort()).toEqual([bot, own].sort());
  });

  test("an administrator's assignment reaches a group's sidebars and cannot be hidden", async () => {
    const owner = await person();
    const admin = await person("admin");
    const member = await person("user", ["support"]);
    const outsider = await person();
    const bot = await privateBot(owner);
    await expect(teamBots.assign(admin, bot, "support")).rejects.toThrow(
      TeamBotRefusedError,
    );
    await teamBots.publish(owner, bot, {
      audience: "people",
      emails: [],
      groups: ["nobody"],
    });
    await expect(teamBots.assign(member, bot, "support")).rejects.toThrow(
      TeamBotRefusedError,
    );
    await teamBots.assign(admin, bot, "support");
    expect(await teamBots.isAssignedTo(member.id, bot)).toBe(true);
    expect(await teamBots.isAssignedTo(outsider.id, bot)).toBe(false);
    expect(await profiles.get(member, bot)).not.toBeNull();
    expect(await profiles.get(outsider, bot)).toBeNull();
    await expect(profiles.setHidden(member, bot, true)).rejects.toThrow(
      AgentAssignedError,
    );
    const listed = await teamBots.list(member);
    expect(listed.find((row) => row.id === bot)).toMatchObject({
      assigned: true,
    });
    expect(listed.find((row) => row.id === bot)).not.toHaveProperty("people");
  });

  test("the Bot reaches the owner's accounts, and a teammate's own only with consent", async () => {
    const owner = await person();
    const teammate = await person();
    const bot = await privateBot(owner);
    await teamBots.publish(owner, bot, {
      audience: "team",
      emails: [],
      groups: [],
    });
    connected.set(owner.id, new Set(["github"]));
    connected.set(teammate.id, new Set(["github", "gmail"]));
    const as = teamBots.credentialActorFor(teammate.id, bot);
    expect(await as("github/search")).toBe(owner.id);
    expect(await as("shared-docs/search")).toBe(teammate.id);
    expect(await teamBots.credentialActorFor(owner.id, bot)("gmail/send")).toBe(
      owner.id,
    );

    const refusal = await as("gmail/send").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PluginRefusedError);
    expect((refusal as Error).message).toStartWith(TEAM_BOT_CONSENT_MARKER);

    await teamBots.consent(teammate, bot, "gmail", "allow_once");
    expect(await as("gmail/send")).toBe(teammate.id);
    await expect(as("gmail/send")).rejects.toThrow(PluginRefusedError);

    await teamBots.consent(teammate, bot, "gmail", "allow_always");
    expect(await as("gmail/send")).toBe(teammate.id);
    expect(await as("gmail/read")).toBe(teammate.id);
    await teamBots.consent(teammate, bot, "gmail", "skip");
    await expect(as("gmail/send")).rejects.toThrow(PluginRefusedError);
    await teamBots.consent(teammate, bot, "gmail", "allow_always");
    await teamBots.clearConsents(teammate);
    await expect(as("gmail/send")).rejects.toThrow(PluginRefusedError);
  });
  test("always allow for all Team Bots, and a Bot nobody described stays hidden", async () => {
    const owner = await person();
    const teammate = await person();
    const first = await privateBot(owner);
    const second = await privateBot(owner);
    for (const bot of [first, second])
      await teamBots.publish(owner, bot, {
        audience: "team",
        emails: [],
        groups: [],
      });
    connected.set(teammate.id, new Set(["gmail"]));
    await expect(
      teamBots.credentialActorFor(teammate.id, second)("gmail/send"),
    ).rejects.toThrow(PluginRefusedError);
    await teamBots.consent(teammate, first, "gmail", "allow_all_team_bots");
    expect(
      await teamBots.credentialActorFor(teammate.id, second)("gmail/send"),
    ).toBe(teammate.id);
    await teamBots.clearConsents(teammate);
    await expect(
      teamBots.credentialActorFor(teammate.id, second)("gmail/send"),
    ).rejects.toThrow(PluginRefusedError);

    // A published Bot whose description was later emptied, or that still has a placeholder name,
    // is invisible to teammates and says so to its owner.
    expect(await profiles.get(teammate, first)).not.toBeNull();
    await database
      .update(agentProfiles)
      .set({ roleDescription: "" })
      .where(eq(agentProfiles.agentId, first));
    expect(await profiles.get(teammate, first)).toBeNull();
    await database
      .update(agents)
      .set({ name: "New Bot" })
      .where(eq(agents.id, second));
    expect(await profiles.get(teammate, second)).toBeNull();
    const own = await teamBots.list(owner);
    expect(own.find((row) => row.id === first)?.visibleToTeam).toBe(false);
    const placeholder = await privateBot(owner);
    await database
      .update(agents)
      .set({ name: "Untitled" })
      .where(eq(agents.id, placeholder));
    await expect(
      teamBots.publish(owner, placeholder, {
        audience: "team",
        emails: [],
        groups: [],
      }),
    ).rejects.toThrow(TeamBotRefusedError);
  });
});
