import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  deploymentPackages,
  pluginGrants,
  skills as skillsTable,
  skillTools,
  users,
} from "../src/db/schema";
import {
  createApplicationConfiguration,
  expandEnvironment,
  type LoadedTenantPackage,
  loadTenantPackage,
  synchronizeTenantPackage,
  validateTenantPackage,
  validateThemeCss,
} from "../src/tenant-package";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdPackageIds: string[] = [];
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

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
  for (const tenantId of createdTenantIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, tenantId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function packageAgent(
  overrides: Partial<LoadedTenantPackage["agents"][number]> = {},
): LoadedTenantPackage["agents"][number] {
  return {
    id: randomUUID(),
    name: "Package Assistant",
    title: "Everyday Work",
    roleDescription: "Help with everyday work.",
    type: "built_in",
    configuration: { systemPrompt: "Be helpful." },
    skills: [],
    ...overrides,
  };
}

function loadedPackage(
  agent: LoadedTenantPackage["agents"][number] = packageAgent(),
): LoadedTenantPackage {
  const tenantId = randomUUID();
  createdTenantIds.push(tenantId);
  return {
    tenantId,
    productName: "Package Test",
    stylesheet: null,
    agents: [agent],
    omittedAgentIds: [],
    channels: [],
    model: {
      provider: "openai",
      credentialSecretRef: "openai-key",
      defaultModel: "gpt-5.6-terra",
    },
    knowledgeSources: [],
    skills: [],
    themeCss: "",
    sourcePath: `/test/${randomUUID()}`,
    checksum: randomUUID(),
  };
}

async function createUser() {
  const userId = randomUUID();
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
  });
  createdUserIds.push(userId);
  return userId;
}

async function createPackage(tenantId: string) {
  const [deploymentPackage] = await database
    .insert(deploymentPackages)
    .values({
      tenantId,
      sourcePath: `/old/${randomUUID()}`,
      checksum: randomUUID(),
    })
    .returning();
  if (!deploymentPackage) throw new Error("Expected deployment package.");
  createdPackageIds.push(deploymentPackage.id);
  return deploymentPackage;
}

describe("tenant theme validation", () => {
  test("accepts approved variables in root and dark blocks", () => {
    expect(() =>
      validateThemeCss(`
        :root { --primary: oklch(0.32 0.09 250); }
        .dark { --primary: oklch(0.87 0.03 250); }
      `),
    ).not.toThrow();
  });

  test("rejects imports, selectors, and unsupported variables", () => {
    expect(() =>
      validateThemeCss('@import "https://example.com/theme.css";'),
    ).toThrow("must not contain imports or URLs");
    expect(() => validateThemeCss("body { color: red; }")).toThrow(
      "only define :root and .dark blocks",
    );
    expect(() => validateThemeCss(":root { --made-up: red; }")).toThrow(
      "is not an approved theme variable",
    );
  });
});

describe("a seeded Mastra Bot", () => {
  const withAgent = (agent: string) =>
    validateTenantPackage({
      brand: "tenant: { id: fintech, product_name: Ledgerline }",
      agents: `agents: [${agent}]`,
      channels: "channels: []",
      model:
        "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
      knowledge: "sources: []",
      themeCss: "",
    });

  test("is seeded as its own kind, carrying the agent it names", () => {
    const [agent] = withAgent(
      "{ id: research, name: Research, title: Research, role_description: Look things up., type: remote-mastra, endpoint: http://mastra.internal, remote_agent_id: openbot }",
    ).agents;
    expect(agent?.type).toBe("remote_mastra");
    expect(agent?.configuration).toEqual({
      endpoint: "http://mastra.internal",
      remoteAgentId: "openbot",
    });
  });

  test("naming no agent is allowed, and means the only one there", () => {
    const [agent] = withAgent(
      "{ id: research, name: Research, title: Research, role_description: Look things up., type: remote-mastra, endpoint: http://mastra.internal }",
    ).agents;
    expect(agent?.configuration).toEqual({
      endpoint: "http://mastra.internal",
    });
  });

  test("an AG-UI Bot never picks up a remote agent id", () => {
    // The field is Mastra's alone. Carried onto an AG-UI Bot it would be stored, read back, and
    // mean nothing, which is the kind of dead configuration somebody later tries to honour.
    const [agent] = withAgent(
      "{ id: risk, name: Risk, title: Risk, role_description: Check things., type: remote-ag-ui, endpoint: http://risk.internal, remote_agent_id: ignored }",
    ).agents;
    expect(agent?.configuration).toEqual({ endpoint: "http://risk.internal" });
  });

  test("a kind nobody serves is refused by name", () => {
    expect(() =>
      withAgent(
        "{ id: x, name: X, title: X, role_description: Y., type: remote-whatever, endpoint: http://x.test }",
      ),
    ).toThrow("agent.type must be built-in, remote-ag-ui or remote-mastra");
  });
});

describe("tenant YAML validation", () => {
  test("rejects an agent without a title", () => {
    expect(() =>
      validateTenantPackage({
        brand: "tenant: { id: fintech, product_name: Ledgerline }",
        agents:
          "agents: [{ id: knowledge, name: Knowledge, role_description: Answer company questions., type: built-in, system_prompt: Answer from knowledge. }]",
        channels: "channels: []",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []",
        themeCss: "",
      }),
    ).toThrow("agent.title must be a non-empty string");
  });

  test("rejects an agent without a role description", () => {
    expect(() =>
      validateTenantPackage({
        brand: "tenant: { id: fintech, product_name: Ledgerline }",
        agents:
          "agents: [{ id: knowledge, name: Knowledge, title: Company Knowledge, type: built-in, system_prompt: Answer from knowledge. }]",
        channels: "channels: []",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []",
        themeCss: "",
      }),
    ).toThrow("agent.role_description must be a non-empty string");
  });

  /*
   * A Bot named after a deployment route is refused before it can exist.
   *
   * `/:botId/*` under the computer router carries the guard that asks whether this person may act as
   * the Bot in the path, and it steps aside for the paths that are about the deployment rather than
   * about a Bot. Hono matches `/*` against zero segments, so those arrive as Bot ids and there is
   * nothing else to tell them apart by. A package free to name a Bot `policy` therefore hands that
   * Bot's computer surface to everybody who can sign in, with the guard never consulted at all.
   *
   * Refused here rather than guarded there, because a package id is the only way a Bot can have a
   * chosen id: everything created through the API is `agent_<uuid>`. Refusing at load is also the
   * answer an operator can act on, and it is where this package's other cross-file checks already
   * live.
   */
  for (const reserved of ["policy", "fleet"]) {
    test(`rejects an agent whose id is the deployment route "${reserved}"`, () => {
      expect(() =>
        validateTenantPackage({
          brand: "tenant: { id: fintech, product_name: Ledgerline }",
          agents: `agents: [{ id: ${reserved}, name: Knowledge, title: Company Knowledge, role_description: Answer company questions., type: built-in, system_prompt: Answer from knowledge. }]`,
          channels: "channels: []",
          model:
            "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
          knowledge: "sources: []",
          themeCss: "",
        }),
      ).toThrow(/reserved/i);
    });
  }

  test("an id that merely contains a reserved name is fine", () => {
    // The collision is exact: `/policy-desk/status` is a Bot path and reaches the guard normally.
    const tenantPackage = validateTenantPackage({
      brand: "tenant: { id: fintech, product_name: Ledgerline }",
      agents:
        "agents: [{ id: policy-desk, name: Policy Desk, title: Policy, role_description: Answer policy questions., type: built-in, system_prompt: Answer from policy. }]",
      channels: "channels: []",
      model:
        "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
      knowledge: "sources: []",
      themeCss: "",
    });
    expect(tenantPackage.agents.map((agent) => agent.id)).toEqual([
      "policy-desk",
    ]);
  });

  test("parses an explicit avatar seed and leaves an omitted seed undefined", () => {
    const tenantPackage = validateTenantPackage({
      brand: "tenant: { id: fintech, product_name: Ledgerline }",
      agents: `agents:
  - id: knowledge
    name: Knowledge
    title: Company Knowledge
    role_description: Answer company questions.
    avatar_seed: knowledge
    type: built-in
    system_prompt: Answer from knowledge.
  - id: risk
    name: Risk
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: http://risk.internal/ag-ui`,
      channels: "channels: []",
      model:
        "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
      knowledge: "sources: []",
      themeCss: "",
    });

    expect(tenantPackage.agents[0]?.avatarSeed).toBe("knowledge");
    expect(tenantPackage.agents[1]?.avatarSeed).toBeUndefined();
  });

  test("rejects an empty optional avatar seed", () => {
    expect(() =>
      validateTenantPackage({
        brand: "tenant: { id: fintech, product_name: Ledgerline }",
        agents:
          "agents: [{ id: knowledge, name: Knowledge, title: Company Knowledge, role_description: Answer company questions., avatar_seed: '', type: built-in, system_prompt: Answer from knowledge. }]",
        channels: "channels: []",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []",
        themeCss: "",
      }),
    ).toThrow("agent.avatar_seed must be a non-empty string");
  });

  test("creates a browser-safe application configuration", () => {
    const configuration = createApplicationConfiguration(
      validateTenantPackage({
        brand:
          "tenant: { id: fintech, product_name: Ledgerline }\nskin: { stylesheet: theme.css }",
        agents: "agents: []",
        channels: "channels: []",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []",
        themeCss: ":root { --primary: oklch(0.32 0.09 250); }",
      }),
    );

    // Brand only. Which providers are configured is answered at runtime by /api/capabilities,
    // because this is compiled into a build that knows nothing about the deployment running it.
    expect(configuration).toEqual({
      brand: {
        tenantId: "fintech",
        productName: "Ledgerline",
      },
    });
  });

  test("loads the mounted fintech package without a theme file", async () => {
    const tenantPackage = await loadTenantPackage(
      fileURLToPath(new URL("../../examples/fintech", import.meta.url)),
    );

    expect(tenantPackage.tenantId).toBe("openbot");
    expect(tenantPackage.stylesheet).toBeNull();
    expect(tenantPackage.themeCss).toBe("");
    expect(tenantPackage.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(tenantPackage.agents).toContainEqual({
      id: "general-assistant",
      name: "General Assistant",
      title: "Everyday Work",
      roleDescription:
        "Help with everyday work using clear, concise, and accurate answers.",
      avatarSeed: "general-assistant",
      type: "built_in",
      configuration: {
        systemPrompt:
          "You are a helpful general assistant. Give clear, concise, and accurate answers.",
      },
      /*
       * One skill each, and both are gates rather than preferences. `bot-creator` is what makes the
       * app offer `list_bots`, `read_bot`, `list_bot_skills` and `save_bot`; `skill-creator` is what
       * makes it offer the four tools that turn an interview into a saved skill. Dropped from the
       * package, either feature stops working with nothing on any screen to say why, which is why the
       * pairing is asserted here rather than left to whoever edits the YAML next.
       */
      skills: ["bot-creator", "skill-creator"],
    });
    // The pairing the shipped package makes, which is the whole reason Knowledge narrows to document
    // tools rather than being offered everything its grants hold.
    expect(
      tenantPackage.agents.find((agent) => agent.id === "knowledge")?.skills,
    ).toEqual([
      "find-a-document",
      "check-a-claim",
      "whats-changed",
      "who-owns-this",
    ]);
    /*
     * The skill that writes skills, shipped with no declared tools on purpose. Its tools are the app's
     * own rather than a connector's, so they are not `serverId/toolName` refs; a declaration here would
     * name nothing, and selection only ever narrows MCP tools.
     */
    const creator = tenantPackage.skills.find(
      (skill) => skill.slug === "skill-creator",
    );
    expect(creator?.title).toBe("Write a skill");
    expect(creator?.tools).toEqual([]);
    // The instruction is the whole feature, so pin the two ends of the loop it prescribes.
    expect(creator?.instructions).toContain("Interview first");
    expect(creator?.instructions).toContain("save_skill");
    expect(tenantPackage.channels).toContainEqual({
      id: "general-assistant",
      name: "General Assistant",
      description: "Ask for help with everyday work.",
      permittedAgents: ["general-assistant"],
      allowedGroups: ["all"],
    });
  });

  test("accepts the complete fintech package and normalizes agent types", () => {
    const tenantPackage = validateTenantPackage({
      brand: `tenant:\n  id: fintech\n  product_name: Ledgerline\nskin:\n  stylesheet: theme.css`,
      agents: `agents:\n  - id: knowledge\n    name: Knowledge\n    title: Company Knowledge\n    role_description: Answer company questions.\n    type: built-in\n    system_prompt: Answer from knowledge.\n  - id: risk\n    name: Risk\n    title: Risk & Compliance\n    role_description: Investigate policies and controls.\n    type: remote-ag-ui\n    endpoint: http://risk.internal/ag-ui`,
      channels: `channels:\n  - id: company\n    name: Company\n    description: Knowledge channel\n    permitted_agents: [knowledge, risk]\n    allowed_groups: [all]`,
      model: `model:\n  provider: openai\n  credential_secret_ref: openai-key\n  default_model: gpt-5.6-terra`,
      knowledge: `sources:\n  - type: google-drive\n    roots: [Policies]`,
      themeCss: ":root { --primary: black; }",
    });

    expect(tenantPackage.agents[0]?.type).toBe("built_in");
    expect(tenantPackage.agents[1]?.type).toBe("remote_ag_ui");
  });

  test("rejects a channel that refers to an unknown agent", () => {
    expect(() =>
      validateTenantPackage({
        brand:
          "tenant: { id: fintech, product_name: Ledgerline }\nskin: { stylesheet: theme.css }",
        agents: "agents: []",
        channels:
          "channels: [{ id: company, name: Company, description: Test, permitted_agents: [missing], allowed_groups: [all] }]",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []",
        themeCss: ":root { --primary: black; }",
      }),
    ).toThrow('references unknown agent "missing"');
  });

  test("omits a remote coworker whose endpoint expanded to nothing", () => {
    const tenantPackage = validateTenantPackage({
      brand: "tenant: { id: fintech, product_name: Ledgerline }",
      agents: `agents:
  - id: knowledge
    name: Knowledge
    title: Company Knowledge
    role_description: Answer company questions.
    type: built-in
    system_prompt: Answer from knowledge.
  - id: risk-analyst
    name: Risk Analyst
    title: Risk
    role_description: Investigate policies.
    type: remote-ag-ui
    endpoint: ""`,
      channels: `channels:
  - id: risk-and-compliance
    name: Risk
    description: Investigate.
    permitted_agents: [knowledge, risk-analyst]
    allowed_groups: [all]`,
      model:
        "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
      knowledge: "sources: []",
      themeCss: "",
    });

    expect(tenantPackage.agents.map((agent) => agent.id)).toEqual([
      "knowledge",
    ]);
    expect(tenantPackage.channels[0]?.permittedAgents).toEqual(["knowledge"]);
  });
});

describe("tenant package agent profile synchronization", () => {
  test("creates a public ownerless profile for a canonical package agent", async () => {
    const agent = packageAgent();
    const tenantPackage = loadedPackage(agent);

    const deploymentPackage = await synchronizeTenantPackage(
      database,
      tenantPackage,
    );
    createdAgentIds.push(agent.id);
    createdPackageIds.push(deploymentPackage.id);

    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agent.id));

    expect(canonical).toMatchObject({
      id: agent.id,
      name: agent.name,
      packageId: deploymentPackage.id,
    });
    expect(profile).toMatchObject({
      agentId: agent.id,
      ownerUserId: null,
      title: agent.title,
      roleDescription: agent.roleDescription,
      avatarSeed: agent.id,
      visibility: "public",
      deletedAt: null,
    });
  });

  /*
   * The row a corrected package leaves behind.
   *
   * Refusing the id in the YAML closes the way a Bot gets that name, not a Bot that already has it:
   * nothing here deletes a canonical agent when a package stops declaring it, so a deployment that
   * once shipped `policy` keeps the row after the operator renames it, and the computer router goes
   * on stepping aside for that path. So the table is checked as well as the file, and a deployment
   * holding one refuses to start rather than serving it to everybody who can sign in.
   */
  test("refuses to synchronize while a Bot named after a deployment route exists", async () => {
    await database.insert(agents).values({
      id: "policy",
      name: "Left behind by an older package",
      type: "built_in",
      configuration: {},
    });
    createdAgentIds.push("policy");

    const agent = packageAgent();
    await expect(
      synchronizeTenantPackage(database, loadedPackage(agent)),
    ).rejects.toThrow(/reserved for a deployment route/i);

    // The refusal is the whole answer: nothing of the package is half-applied behind it.
    const [applied] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id));
    expect(applied).toBeUndefined();
  });

  test("synchronizes normally when no such Bot exists", async () => {
    // The permissive half, so the check above is proved to be about the reserved id and not about
    // any pre-existing row.
    await database.insert(agents).values({
      id: `policy-desk-${randomUUID()}`,
      name: "An ordinary Bot",
      type: "built_in",
      configuration: {},
    });
    const agent = packageAgent();
    const deploymentPackage = await synchronizeTenantPackage(
      database,
      loadedPackage(agent),
    );
    createdAgentIds.push(agent.id);
    createdPackageIds.push(deploymentPackage.id);
    const [applied] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id));
    expect(applied).toBeDefined();
  });

  test("resynchronizes and undeletes an existing package profile", async () => {
    const agent = packageAgent({ avatarSeed: "old-avatar" });
    const tenantPackage = loadedPackage(agent);
    const deploymentPackage = await synchronizeTenantPackage(
      database,
      tenantPackage,
    );
    createdAgentIds.push(agent.id);
    createdPackageIds.push(deploymentPackage.id);
    const oldUpdatedAt = new Date("2000-01-01T00:00:00.000Z");
    await database
      .update(agentProfiles)
      .set({
        visibility: "private",
        deletedAt: new Date("2001-01-01T00:00:00.000Z"),
        updatedAt: oldUpdatedAt,
      })
      .where(eq(agentProfiles.agentId, agent.id));

    const updatedAgent = {
      ...agent,
      name: "Updated Package Assistant",
      title: "Updated Work",
      roleDescription: "Handle updated package work.",
      avatarSeed: "updated-avatar",
    };
    await synchronizeTenantPackage(database, {
      ...tenantPackage,
      agents: [updatedAgent],
      checksum: randomUUID(),
    });

    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agent.id));
    expect(canonical?.name).toBe(updatedAgent.name);
    expect(profile).toMatchObject({
      ownerUserId: null,
      title: updatedAgent.title,
      roleDescription: updatedAgent.roleDescription,
      avatarSeed: updatedAgent.avatarSeed,
      visibility: "public",
      deletedAt: null,
    });
    expect(profile?.updatedAt.getTime()).toBeGreaterThan(
      oldUpdatedAt.getTime(),
    );
  });

  test("rejects a user-created canonical and profile collision without changing them", async () => {
    const ownerUserId = await createUser();
    const agent = packageAgent();
    const tenantPackage = loadedPackage(agent);
    await database.insert(agents).values({
      id: agent.id,
      name: "User Agent",
      type: "built_in",
      configuration: { systemPrompt: "User-owned prompt." },
    });
    createdAgentIds.push(agent.id);
    await database.insert(agentProfiles).values({
      agentId: agent.id,
      ownerUserId,
      title: "User Title",
      roleDescription: "User role.",
      avatarSeed: "user-avatar",
      visibility: "private",
    });

    await expect(
      synchronizeTenantPackage(database, tenantPackage),
    ).rejects.toThrow("user-created agent");

    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agent.id));
    expect(canonical).toMatchObject({
      name: "User Agent",
      packageId: null,
      configuration: { systemPrompt: "User-owned prompt." },
    });
    expect(profile).toMatchObject({
      ownerUserId,
      title: "User Title",
      roleDescription: "User role.",
      avatarSeed: "user-avatar",
      visibility: "private",
    });
    const synchronizedPackages = await database
      .select()
      .from(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, tenantPackage.tenantId));
    expect(synchronizedPackages).toHaveLength(0);
  });

  test("rejects a user-owned profile collision and rolls back canonical changes", async () => {
    const ownerUserId = await createUser();
    const agent = packageAgent();
    const tenantPackage = loadedPackage(agent);
    const deploymentPackage = await createPackage(tenantPackage.tenantId);
    await database.insert(agents).values({
      id: agent.id,
      name: "Original Package Agent",
      type: "built_in",
      configuration: { systemPrompt: "Original package prompt." },
      packageId: deploymentPackage.id,
    });
    createdAgentIds.push(agent.id);
    await database.insert(agentProfiles).values({
      agentId: agent.id,
      ownerUserId,
      title: "User Title",
      roleDescription: "User role.",
      avatarSeed: "user-avatar",
      visibility: "private",
    });

    await expect(
      synchronizeTenantPackage(database, tenantPackage),
    ).rejects.toThrow("user-owned profile");

    const [canonical] = await database
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id));
    const [profile] = await database
      .select()
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, agent.id));
    const [unchangedPackage] = await database
      .select()
      .from(deploymentPackages)
      .where(eq(deploymentPackages.id, deploymentPackage.id));
    expect(canonical).toMatchObject({
      name: "Original Package Agent",
      configuration: { systemPrompt: "Original package prompt." },
      packageId: deploymentPackage.id,
    });
    expect(profile).toMatchObject({
      ownerUserId,
      title: "User Title",
      roleDescription: "User role.",
      avatarSeed: "user-avatar",
      visibility: "private",
    });
    expect(unchangedPackage).toMatchObject({
      sourcePath: deploymentPackage.sourcePath,
      checksum: deploymentPackage.checksum,
    });
  });

  test("a package cannot take over a channel another package or user owns", async () => {
    const channelId = `tenant-channel-${randomUUID().slice(0, 8)}`;
    const packageAAgent = packageAgent({ name: "Package A Agent" });
    const packageBAgent = packageAgent({ name: "Package B Agent" });
    const packageA = {
      ...loadedPackage(packageAAgent),
      channels: [
        {
          id: channelId,
          name: "Package A Channel",
          description: "Owned by package A.",
          permittedAgents: [packageAAgent.id],
          allowedGroups: ["all"],
        },
      ],
    };
    const packageB = {
      ...loadedPackage(packageBAgent),
      channels: [
        {
          id: channelId,
          name: "Package B Channel",
          description: "Owned by package B.",
          permittedAgents: [packageBAgent.id],
          allowedGroups: ["all"],
        },
      ],
    };

    createdAgentIds.push(packageAAgent.id, packageBAgent.id);
    createdChannelIds.push(channelId);
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, packageA)).id,
    );

    const snapshot = async () => ({
      channel: (
        await database
          .select({
            id: channels.id,
            name: channels.name,
            description: channels.description,
            packageId: channels.packageId,
          })
          .from(channels)
          .where(eq(channels.id, channelId))
      )[0],
      agents: (
        await database
          .select({ agentId: channelAgents.agentId })
          .from(channelAgents)
          .where(eq(channelAgents.channelId, channelId))
      ).map((row) => row.agentId),
    });

    const beforePackageB = await snapshot();
    await expect(synchronizeTenantPackage(database, packageB)).rejects.toThrow(
      `Tenant package channel "${channelId}" collides with a channel this package does not own`,
    );
    expect(await snapshot()).toEqual(beforePackageB);

    await database
      .delete(channelAgents)
      .where(eq(channelAgents.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
    await database.insert(channels).values({
      id: channelId,
      name: "User Channel",
      description: "Owned by a user.",
      allowedGroups: [],
      packageId: null,
    });
    await database.insert(channelAgents).values({
      channelId,
      agentId: packageAAgent.id,
    });

    const beforeUserChannel = await snapshot();
    await expect(synchronizeTenantPackage(database, packageB)).rejects.toThrow(
      `Tenant package channel "${channelId}" collides with a channel this package does not own`,
    );
    expect(await snapshot()).toEqual(beforeUserChannel);
  });

  test("a redeploy updates and removes agents only for the package's own channel", async () => {
    const channelId = `tenant-channel-${randomUUID().slice(0, 8)}`;
    const firstAgent = packageAgent({ name: "First Agent" });
    const secondAgent = packageAgent({ name: "Second Agent" });
    const firstPackage = {
      ...loadedPackage(firstAgent),
      agents: [firstAgent, secondAgent],
      channels: [
        {
          id: channelId,
          name: "First Name",
          description: "Before redeploy.",
          permittedAgents: [firstAgent.id],
          allowedGroups: ["all"],
        },
      ],
    };
    const secondPackage = {
      ...firstPackage,
      checksum: randomUUID(),
      channels: [
        {
          id: channelId,
          name: "Second Name",
          description: "After redeploy.",
          permittedAgents: [secondAgent.id],
          allowedGroups: ["all", "support"],
        },
      ],
    };

    createdAgentIds.push(firstAgent.id, secondAgent.id);
    createdChannelIds.push(channelId);
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, firstPackage)).id,
    );
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, secondPackage)).id,
    );

    const [channel] = await database
      .select()
      .from(channels)
      .where(eq(channels.id, channelId));
    const permittedAgents = (
      await database
        .select({ agentId: channelAgents.agentId })
        .from(channelAgents)
        .where(eq(channelAgents.channelId, channelId))
    ).map((row) => row.agentId);

    expect(channel).toMatchObject({
      name: "Second Name",
      description: "After redeploy.",
      allowedGroups: ["all", "support"],
    });
    expect(permittedAgents).toEqual([secondAgent.id]);
  });

  test("rejects a cross-package agent collision and rolls back both packages", async () => {
    const packageAAgent = packageAgent({
      name: "Package A Agent",
      title: "Package A Title",
      roleDescription: "Package A role.",
      avatarSeed: "package-a-avatar",
    });
    const packageA = loadedPackage(packageAAgent);
    const packageARow = await synchronizeTenantPackage(database, packageA);
    createdAgentIds.push(packageAAgent.id);
    createdPackageIds.push(packageARow.id);

    const packageB = loadedPackage({
      ...packageAAgent,
      name: "Package B Agent",
      title: "Package B Title",
      roleDescription: "Package B role.",
      avatarSeed: "package-b-avatar",
      configuration: { systemPrompt: "Package B prompt." },
    });
    const packageBRow = await createPackage(packageB.tenantId);

    const snapshot = async () => {
      const [canonical] = await database
        .select()
        .from(agents)
        .where(eq(agents.id, packageAAgent.id));
      const [profile] = await database
        .select()
        .from(agentProfiles)
        .where(eq(agentProfiles.agentId, packageAAgent.id));
      const [persistedPackageA] = await database
        .select()
        .from(deploymentPackages)
        .where(eq(deploymentPackages.id, packageARow.id));
      const [persistedPackageB] = await database
        .select()
        .from(deploymentPackages)
        .where(eq(deploymentPackages.id, packageBRow.id));
      return {
        canonical,
        profile,
        packageA: persistedPackageA,
        packageB: persistedPackageB,
      };
    };
    const before = await snapshot();

    const outcome = await synchronizeTenantPackage(database, packageB).then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({
        status: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const after = await snapshot();

    expect(outcome).toEqual({
      status: "rejected",
      message: `Tenant package agent "${packageAAgent.id}" collides with a user-created agent`,
    });
    expect(after).toEqual(before);
  });
});

/**
 * `${NAME}` in a package file.
 *
 * The addresses of the services a package points at belong to the environment rather than to the
 * package, so the same package has to work against a local stack and a deployed one. A name with no
 * value and no default is an error: substituting nothing would point a Bot at an address nobody
 * meant.
 */
describe("expanding a package file against the environment", () => {
  const file = "agents.yaml";

  test("takes the value from the environment", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
      expandEnvironment("endpoint: ${AG_UI_URL}", file, {
        AG_UI_URL: "https://bots.example.test/ag-ui",
      }),
    ).toBe("endpoint: https://bots.example.test/ag-ui");
  });

  test("falls back to the default when the name is not set", () => {
    expect(
      expandEnvironment(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
        "endpoint: ${AG_UI_URL:-http://localhost:4200}",
        file,
        {},
      ),
    ).toBe("endpoint: http://localhost:4200");
  });

  test("prefers the environment over the default", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
      expandEnvironment("endpoint: ${AG_UI_URL:-http://localhost:4200}", file, {
        AG_UI_URL: "https://bots.example.test",
      }),
    ).toBe("endpoint: https://bots.example.test");
  });

  test("treats an empty value as unset", () => {
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
      expandEnvironment("endpoint: ${AG_UI_URL:-http://localhost:4200}", file, {
        AG_UI_URL: "",
      }),
    ).toBe("endpoint: http://localhost:4200");
  });

  test("an empty default is allowed and is not an error", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
    expect(expandEnvironment("suffix: ${NOTHING:-}", file, {})).toBe(
      "suffix: ",
    );
  });

  test("refuses a name with neither a value nor a default", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is the fixture — this asserts on unexpanded placeholder text, so a real template would break the test.
    expect(() => expandEnvironment("endpoint: ${AG_UI_URL}", file, {})).toThrow(
      /agents\.yaml refers to \$\{AG_UI_URL\}/,
    );
  });
});

/**
 * The skills a package ships, and why it ships them at all.
 *
 * Selection narrows a Bot's tools to the ones its matching skills declare, and a deployment starts
 * with no skills. Left to a screen, that means the narrowing is off on every clone until somebody
 * maps tools to skills by hand — so the declaration ships with the package that declares it, and the
 * cases below are the ones that decide whether that is safe to seed.
 */
describe("skills a package ships", () => {
  const base = {
    brand: "tenant: { id: fintech, product_name: Ledgerline }",
    agents:
      "agents: [{ id: knowledge, name: Knowledge, title: Company Knowledge, role_description: Answer company questions., type: built-in, system_prompt: Answer from knowledge. }]",
    channels: "channels: []",
    model:
      "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
    knowledge: "sources: []",
    themeCss: "",
  };

  test("a package with no skills file still loads, and ships none", () => {
    // Every package written before this existed has no `skills.yaml`, and all of them keep working.
    expect(validateTenantPackage(base).skills).toEqual([]);
  });

  test("an empty skills file ships none", () => {
    expect(validateTenantPackage({ ...base, skills: "   " }).skills).toEqual(
      [],
    );
    expect(
      validateTenantPackage({ ...base, skills: "skills: []" }).skills,
    ).toEqual([]);
  });

  test("a skill carries its declared tools through unaltered", () => {
    const { skills } = validateTenantPackage({
      ...base,
      skills: `skills:
  - slug: find-a-document
    title: Find a document
    summary: Search the sources and read what comes back.
    instructions: Search first, then read the file you found.
    tools:
      - google-drive/search_files
      - google-drive/read_file_content`,
    });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.slug).toBe("find-a-document");
    expect(skills[0]?.tools).toEqual([
      "google-drive/search_files",
      "google-drive/read_file_content",
    ]);
  });

  test("a skill may declare tools for a connector nobody has added", () => {
    /*
     * The whole point of shipping the declaration. A package is written before anybody connects
     * anything, so refusing an unknown ref would mean a template could only ship skills for
     * connectors it could guarantee, which is none of them. The ref sits inert until its connector
     * exists, because the run-time offer is intersected with the grants.
     */
    const { skills } = validateTenantPackage({
      ...base,
      skills: `skills:
  - slug: triage
    title: Triage
    summary: Triage incoming issues.
    instructions: Read the issue and classify it.
    tools: [jira/search_issues, some-server-nobody-added/do_a_thing]`,
    });
    expect(skills[0]?.tools).toEqual([
      "jira/search_issues",
      "some-server-nobody-added/do_a_thing",
    ]);
  });

  test("a skill needs no tools at all", () => {
    // A skill is an instruction first. One that declares nothing is still worth shipping; it simply
    // takes no part in narrowing.
    const { skills } = validateTenantPackage({
      ...base,
      skills: `skills:
  - slug: be-brief
    title: Be brief
    summary: Answer in as few words as the question allows.
    instructions: Answer in one sentence unless asked for more.`,
    });
    expect(skills[0]?.tools).toEqual([]);
  });

  test("a slug nobody could type after a slash is refused", () => {
    expect(() =>
      validateTenantPackage({
        ...base,
        skills: `skills:
  - slug: Find A Document
    title: Find a document
    summary: Search.
    instructions: Search.`,
      }),
    ).toThrow('skill.slug "Find A Document" must be lowercase');
  });

  test("a ref that is not serverId/toolName is refused", () => {
    // It could never match a grant, so it would sit in the table doing nothing. Better to refuse the
    // package than to ship a skill that quietly loads no tools.
    expect(() =>
      validateTenantPackage({
        ...base,
        skills: `skills:
  - slug: triage
    title: Triage
    summary: Triage.
    instructions: Triage.
    tools: [search_issues]`,
      }),
    ).toThrow(
      'skill.tools entry "search_issues" must be in the form serverId/toolName',
    );
  });

  test("a skill without instructions is refused", () => {
    expect(() =>
      validateTenantPackage({
        ...base,
        skills: `skills:
  - slug: triage
    title: Triage
    summary: Triage.`,
      }),
    ).toThrow("skill.instructions must be a non-empty string");
  });

  test("editing the skills file changes the package checksum", () => {
    // Otherwise a deployment reports itself unchanged after its skills were rewritten, and never
    // reseeds them.
    const one = validateTenantPackage({ ...base, skills: "skills: []" });
    const two = validateTenantPackage({
      ...base,
      skills: `skills:
  - slug: triage
    title: Triage
    summary: Triage.
    instructions: Triage.`,
    });
    expect(one.skills).not.toEqual(two.skills);
  });
});

/**
 * Seeding those skills into a deployment.
 *
 * The parser above decides what a package may say. These decide what happens when it is applied to a
 * database that may already have skills in it, which is where the two ways this could go wrong live:
 * a package quietly replacing something a person wrote, and a person being able to stop the
 * deployment booting by taking a name.
 */
describe("seeding the skills a package ships", () => {
  const createdSkillIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSkillIds.splice(0)) {
      await database.delete(skillTools).where(eq(skillTools.skillId, id));
      await database.delete(skillsTable).where(eq(skillsTable.id, id));
    }
  });

  function withSkills(skills: LoadedTenantPackage["skills"]) {
    const loaded = loadedPackage();
    for (const skill of skills) createdSkillIds.push(skill.slug);
    return { ...loaded, skills };
  }

  const skill = (
    overrides: Partial<LoadedTenantPackage["skills"][number]> = {},
  ) => ({
    slug: `pkg-${randomUUID().slice(0, 8)}`,
    title: "Find a document",
    summary: "Search the sources and read what comes back.",
    instructions: "Search first, then read the file you found.",
    tools: ["google-drive/search_files", "google-drive/read_file_content"],
    ...overrides,
  });

  test("lands as a deployment skill with its declarations", async () => {
    const shipped = skill();
    const loaded = withSkills([shipped]);
    createdAgentIds.push(loaded.agents[0]?.id as string);
    const created = await synchronizeTenantPackage(database, loaded);
    createdPackageIds.push(created.id);

    const [row] = await database
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.slug, shipped.slug));
    expect(row?.origin).toBe("catalogue");
    // Null owner is what makes it everybody's, the same as one an administrator wrote.
    expect(row?.ownerUserId).toBeNull();
    expect(row?.instructions).toBe(shipped.instructions);

    const declared = await database
      .select()
      .from(skillTools)
      .where(eq(skillTools.skillId, shipped.slug));
    expect(declared.map((entry) => entry.ref).sort()).toEqual([
      "google-drive/read_file_content",
      "google-drive/search_files",
    ]);
  });

  test("a ref for a connector nobody has added is stored anyway", async () => {
    /*
     * The property that makes shipping the declaration possible at all. The API path refuses a tool
     * this deployment has never seen; a package cannot be held to that, because it is written before
     * anybody connects anything. The ref does nothing until its connector exists.
     */
    const shipped = skill({ tools: ["not-added-yet/do_a_thing"] });
    const loaded = withSkills([shipped]);
    createdAgentIds.push(loaded.agents[0]?.id as string);
    const created = await synchronizeTenantPackage(database, loaded);
    createdPackageIds.push(created.id);

    const declared = await database
      .select()
      .from(skillTools)
      .where(eq(skillTools.skillId, shipped.slug));
    expect(declared.map((entry) => entry.ref)).toEqual([
      "not-added-yet/do_a_thing",
    ]);
  });

  test("re-seeding replaces the declared set rather than adding to it", async () => {
    const shipped = skill();
    const first = withSkills([shipped]);
    createdAgentIds.push(first.agents[0]?.id as string);
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, first)).id,
    );

    const narrowed = { ...shipped, tools: ["google-drive/search_files"] };
    const second = { ...first, skills: [narrowed] };
    await synchronizeTenantPackage(database, second);

    const declared = await database
      .select()
      .from(skillTools)
      .where(eq(skillTools.skillId, shipped.slug));
    // A tool the package stopped declaring stops being declared, rather than lingering.
    expect(declared.map((entry) => entry.ref)).toEqual([
      "google-drive/search_files",
    ]);
  });

  test("a skill somebody here wrote keeps its name, and the deployment still boots", async () => {
    /*
     * The `/` namespace is shared and first to take a name keeps it. Anybody signed in may write a
     * skill, so a collision cannot be fatal: throwing here would let one person stop the deployment
     * starting by choosing a name the package also uses.
     */
    const owner = `user_${randomUUID().slice(0, 8)}`;
    createdUserIds.push(owner);
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test`, name: owner });

    const shipped = skill();
    await database.insert(skillsTable).values({
      id: `mine-${shipped.slug}`,
      ownerUserId: owner,
      slug: shipped.slug,
      title: "Mine",
      summary: "Written here.",
      instructions: "Do it my way.",
      origin: "yours",
    });
    createdSkillIds.push(`mine-${shipped.slug}`);

    const loaded = withSkills([shipped]);
    createdAgentIds.push(loaded.agents[0]?.id as string);
    // Resolves rather than throwing: that is the assertion.
    const created = await synchronizeTenantPackage(database, loaded);
    createdPackageIds.push(created.id);

    const [row] = await database
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.slug, shipped.slug));
    expect(row?.instructions).toBe("Do it my way.");
    expect(row?.origin).toBe("yours");
    expect(row?.ownerUserId).toBe(owner);
  });
});

/**
 * Pairing a package's coworkers with the skills it ships.
 *
 * A deployment that seeds skills attached to nobody has switched off the narrowing they exist for,
 * so the package states the pairing. The cases below are the ones that decide whether seeding a
 * grant is safe: it never confers a capability, it never reaches somebody else's skill, and a
 * redeploy can take back its own without touching an administrator's.
 */
describe("pairing a package's coworkers with its skills", () => {
  const createdSkillIds: string[] = [];

  afterEach(async () => {
    for (const id of createdSkillIds.splice(0)) {
      await database.delete(pluginGrants).where(eq(pluginGrants.ref, id));
      await database.delete(skillTools).where(eq(skillTools.skillId, id));
      await database.delete(skillsTable).where(eq(skillsTable.id, id));
    }
  });

  function packageGiving(slugs: string[]) {
    const agent = packageAgent({ skills: slugs });
    const loaded = loadedPackage(agent);
    const skills = slugs.map((slug) => ({
      slug,
      title: "Find a document",
      summary: "Search the sources and read what comes back.",
      instructions: "Search first, then read the file you found.",
      tools: ["google-drive/search_files"],
    }));
    for (const slug of slugs) createdSkillIds.push(slug);
    createdAgentIds.push(agent.id);
    return { ...loaded, skills };
  }

  const grantsFor = (agentId: string) =>
    database
      .select()
      .from(pluginGrants)
      .where(
        and(eq(pluginGrants.kind, "skill"), eq(pluginGrants.agentId, agentId)),
      );

  test("a coworker is granted the skills its package named", async () => {
    const slug = `pkg-${randomUUID().slice(0, 8)}`;
    const loaded = packageGiving([slug]);
    const created = await synchronizeTenantPackage(database, loaded);
    createdPackageIds.push(created.id);

    const granted = await grantsFor(loaded.agents[0]?.id as string);
    expect(granted.map((row) => row.ref)).toEqual([slug]);
    // The mark is what lets a later deploy take back its own and nobody else's.
    expect(granted[0]?.grantedBy).toBe("tenant-package");
  });

  test("a skill the package stopped naming is taken back", async () => {
    const slug = `pkg-${randomUUID().slice(0, 8)}`;
    const loaded = packageGiving([slug]);
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, loaded)).id,
    );

    const agentId = loaded.agents[0]?.id as string;
    expect(await grantsFor(agentId)).toHaveLength(1);

    // Same package, same skill still shipped, but the coworker no longer asks for it.
    const withoutIt = {
      ...loaded,
      agents: [{ ...(loaded.agents[0] as never), skills: [] }],
    } as typeof loaded;
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, withoutIt)).id,
    );

    expect(await grantsFor(agentId)).toHaveLength(0);
  });

  test("a redeploy takes back only grants from the package being synchronized", async () => {
    const slugA = `pkg-a-${randomUUID().slice(0, 8)}`;
    const slugB = `pkg-b-${randomUUID().slice(0, 8)}`;
    const userGrant = `user-grant-${randomUUID().slice(0, 8)}`;
    const packageA = packageGiving([slugA]);
    const packageB = packageGiving([slugB]);
    createdSkillIds.push(userGrant);

    createdPackageIds.push(
      (await synchronizeTenantPackage(database, packageA)).id,
    );
    const [packageAAgent] = packageA.agents;
    if (!packageAAgent)
      throw new Error("Expected package A to declare an agent.");
    const agentA = packageAAgent.id;
    expect((await grantsFor(agentA)).map((row) => row.ref)).toEqual([slugA]);

    await database.insert(pluginGrants).values({
      kind: "skill",
      ref: userGrant,
      agentId: agentA,
      grantedBy: "an-administrator",
    });

    createdPackageIds.push(
      (await synchronizeTenantPackage(database, packageB)).id,
    );
    const [packageBAgent] = packageB.agents;
    if (!packageBAgent)
      throw new Error("Expected package B to declare an agent.");
    const agentB = packageBAgent.id;

    expect((await grantsFor(agentA)).map((row) => row.ref).sort()).toEqual(
      [slugA, userGrant].sort(),
    );
    expect((await grantsFor(agentB)).map((row) => row.ref)).toEqual([slugB]);

    const packageAWithoutSkill = {
      ...packageA,
      agents: [{ ...packageAAgent, skills: [] }],
    };
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, packageAWithoutSkill)).id,
    );

    expect((await grantsFor(agentA)).map((row) => row.ref)).toEqual([
      userGrant,
    ]);
    expect((await grantsFor(agentB)).map((row) => row.ref)).toEqual([slugB]);
  });

  test("a grant an administrator made by hand survives a redeploy", async () => {
    const slug = `pkg-${randomUUID().slice(0, 8)}`;
    const loaded = packageGiving([slug]);
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, loaded)).id,
    );

    const agentId = loaded.agents[0]?.id as string;
    // Somebody decides this Bot should keep it, through the Skills page.
    await database
      .update(pluginGrants)
      .set({ grantedBy: "an-administrator" })
      .where(
        and(eq(pluginGrants.kind, "skill"), eq(pluginGrants.agentId, agentId)),
      );

    const withoutIt = {
      ...loaded,
      agents: [{ ...(loaded.agents[0] as never), skills: [] }],
    } as typeof loaded;
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, withoutIt)).id,
    );

    /*
     * Kept. The package retracts what it gave, not what somebody decided: a redeploy quietly undoing
     * a deliberate grant is the kind of thing nobody connects to the deploy that caused it.
     */
    const granted = await grantsFor(agentId);
    expect(granted.map((row) => row.ref)).toEqual([slug]);
    expect(granted[0]?.grantedBy).toBe("an-administrator");
  });

  test("a slug a person already owns is never granted to the package's Bot", async () => {
    /*
     * The case that decides whether this is safe at all. The seed skips a slug somebody already
     * took, so granting anyway would hand this Bot an instruction a stranger wrote, under a name the
     * package believed was its own.
     */
    const slug = `pkg-${randomUUID().slice(0, 8)}`;
    const owner = await createUser();
    await database.insert(skillsTable).values({
      id: slug,
      ownerUserId: owner,
      slug,
      title: "Mine",
      summary: "Mine.",
      instructions: "Do it my way.",
      origin: "yours",
    });

    const loaded = packageGiving([slug]);
    createdPackageIds.push(
      (await synchronizeTenantPackage(database, loaded)).id,
    );

    expect(await grantsFor(loaded.agents[0]?.id as string)).toHaveLength(0);
  });

  test("a coworker naming a skill the package does not ship is refused at load", () => {
    // A typo here attaches nothing and looks exactly like working, so it is refused rather than
    // dropped, the same as a channel naming an agent that is not there.
    expect(() =>
      validateTenantPackage({
        brand: "tenant: { id: fintech, product_name: Ledgerline }",
        agents:
          "agents: [{ id: knowledge, name: Knowledge, title: Company Knowledge, role_description: Answer., type: built-in, system_prompt: Answer., skills: [no-such-skill] }]",
        channels: "channels: []",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []",
        skills: `skills:
  - slug: find-a-document
    title: Find a document
    summary: Search.
    instructions: Search.`,
        themeCss: "",
      }),
    ).toThrow(
      'agent "knowledge" names skill "no-such-skill", which this package does not ship',
    );
  });
});

test("blank package endpoint disables only its owned agent and restores it when configured again", async () => {
  const suffix = randomUUID();
  const actor = { id: `reader-${suffix}`, role: "user" as const };
  const original = process.env.MANAGED_AGENT_AG_UI_URL;
  const originalPicked = process.env.PICKED_HARNESS_URL;
  let packageId: string | undefined;
  let otherPackageId: string | undefined;
  const ownedIds: string[] = [];
  const historyId = `history-${suffix}`;
  try {
    process.env.MANAGED_AGENT_AG_UI_URL = "http://127.0.0.1:4201/ag-ui";
    process.env.PICKED_HARNESS_URL = "http://127.0.0.1:4206/ag-ui";
    const source = new URL("../../examples/fintech", import.meta.url).pathname;
    const configured = await loadTenantPackage(source);
    const rename = (id: string) => `${id}-${suffix}`;
    const isolate = (loaded: LoadedTenantPackage): LoadedTenantPackage => ({
      ...loaded,
      tenantId: suffix,
      skills: [],
      channels: [],
      agents: loaded.agents.map((agent) => ({
        ...agent,
        id: rename(agent.id),
        skills: [],
      })),
      omittedAgentIds: (loaded.omittedAgentIds ?? []).map(rename),
    });
    const enabled = isolate(configured);
    ownedIds.push(...enabled.agents.map((agent) => agent.id));
    packageId = (await synchronizeTenantPackage(database, enabled)).id;
    await database
      .insert(users)
      .values({ id: actor.id, email: `${suffix}@example.test` });
    const target = rename("risk-analyst");
    const picked = rename("picked-harness");
    await database.insert(channels).values({
      id: historyId,
      name: "Historical conversation",
      description: "Preserved",
      allowedGroups: [],
    });
    await database
      .insert(channelAgents)
      .values({ channelId: historyId, agentId: target });
    await database
      .insert(channelMemberships)
      .values({ channelId: historyId, userId: actor.id });
    const profiles = createAgentProfileStore(database, undefined);
    const runtime = createRuntimeAgentLoader(database);
    expect((await profiles.get(actor, target))?.deletedAt).toBeNull();
    expect(
      (await runtime(actor)).find((agent) => agent.id === target)?.type,
    ).toBe("remote_ag_ui");

    const [otherPackage] = await database
      .insert(deploymentPackages)
      .values({
        tenantId: `other-${suffix}`,
        sourcePath: "/synthetic/other",
        checksum: suffix,
      })
      .returning();
    if (!otherPackage) throw new Error("missing synthetic package");
    otherPackageId = otherPackage.id;
    const controls = [
      { id: `user-${suffix}`, packageId: null, ownerUserId: actor.id },
      { id: `other-${suffix}`, packageId: otherPackageId, ownerUserId: null },
      { id: `owned-profile-${suffix}`, packageId, ownerUserId: actor.id },
      { id: `removed-yaml-${suffix}`, packageId, ownerUserId: null },
    ];
    for (const control of controls) {
      ownedIds.push(control.id);
      await database.insert(agents).values({
        id: control.id,
        name: control.id,
        type: "remote_ag_ui",
        configuration: { endpoint: "https://example.test/agent" },
        packageId: control.packageId,
      });
      await database.insert(agentProfiles).values({
        agentId: control.id,
        title: "Control",
        roleDescription: "Preserve ownership",
        avatarSeed: control.id,
        visibility: "public",
        ownerUserId: control.ownerUserId,
      });
    }
    process.env.MANAGED_AGENT_AG_UI_URL = "";
    const omitted = isolate(await loadTenantPackage(source));
    expect(omitted.agents.some((agent) => agent.id === target)).toBe(false);
    // Explicitly omitted foreign/user-owned IDs must not acquire package ownership.
    omitted.omittedAgentIds.push(
      ...controls.slice(0, 3).map((control) => control.id),
    );
    await synchronizeTenantPackage(database, omitted);
    expect(await profiles.get(actor, target)).toBeNull();
    expect(
      (await profiles.list(actor)).some((agent) => agent.id === target),
    ).toBe(false);
    expect(
      (await runtime(actor)).find((agent) => agent.id === target)?.type,
    ).toBe("unavailable");
    expect(
      (
        await database
          .select()
          .from(channelAgents)
          .where(eq(channelAgents.channelId, historyId))
      ).length,
    ).toBe(1);
    expect(
      (await database.select().from(agents).where(eq(agents.id, target)))
        .length,
    ).toBe(1);
    expect((await profiles.get(actor, picked))?.deletedAt).toBeNull();
    for (const control of controls)
      expect((await profiles.get(actor, control.id))?.deletedAt).toBeNull();
    await synchronizeTenantPackage(database, enabled);
    expect((await profiles.get(actor, target))?.deletedAt).toBeNull();
    expect(
      (await runtime(actor)).find((agent) => agent.id === target)?.type,
    ).toBe("remote_ag_ui");
  } finally {
    if (original === undefined) delete process.env.MANAGED_AGENT_AG_UI_URL;
    else process.env.MANAGED_AGENT_AG_UI_URL = original;
    if (originalPicked === undefined) delete process.env.PICKED_HARNESS_URL;
    else process.env.PICKED_HARNESS_URL = originalPicked;
    await database.delete(channels).where(eq(channels.id, historyId));
    for (const id of ownedIds)
      await database.delete(agents).where(eq(agents.id, id));
    if (packageId)
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, packageId));
    if (otherPackageId)
      await database
        .delete(deploymentPackages)
        .where(eq(deploymentPackages.id, otherPackageId));
    await database.delete(users).where(eq(users.id, actor.id));
  }
});
