import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { installEnterpriseControls } from "../src/admin/controls";
import { createEnterpriseGate } from "../src/admin/gate";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createAgentRoutes } from "../src/agents/routes";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  brokeredConnections,
  channelAgents,
  channelMemberships,
  channels,
  deploymentPackages,
  pluginGrants,
  skills as skillsTable,
  skillTools,
  users,
} from "../src/db/schema";
import { setEdition } from "../src/edition";
import {
  createApplicationConfiguration,
  deploymentNameOf,
  expandEnvironment,
  type LoadedTenantPackage,
  loadTenantPackage,
  synchronizeTenantPackage,
  validateTenantPackage,
  validateThemeCss,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
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
    formerTenantIds: [],
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

  /*
   * A comment is not something a theme defines.
   *
   * The rule this enforces, as `docs/configuration.md` states it, is about what a theme may define:
   * two blocks, approved variables, no imports and no URLs. A comment defines nothing, and a
   * stylesheet written by hand has one at the top saying whose brand it is.
   */
  test("accepts a comment above the blocks", () => {
    expect(() =>
      validateThemeCss(`
        /* Acme brand colours. Regenerate from the design tokens, do not hand-edit. */
        :root { --primary: oklch(0.32 0.09 250); }
      `),
    ).not.toThrow();
  });

  test("accepts a comment inside a block", () => {
    expect(() =>
      validateThemeCss(`
        :root {
          /* The one colour everything else is derived from. */
          --primary: oklch(0.32 0.09 250);
          --border: oklch(0.9 0 0); /* deliberately flat */
        }
      `),
    ).not.toThrow();
  });

  test("accepts a comment between the blocks", () => {
    expect(() =>
      validateThemeCss(`
        :root { --primary: oklch(0.32 0.09 250); }
        /* and the same again for dark mode */
        .dark { --primary: oklch(0.87 0.03 250); }
      `),
    ).not.toThrow();
  });

  /*
   * The guard against over-correcting. A comment must not become a way to smuggle in the two things
   * this refuses, and a comment that is never closed is not a comment.
   */
  test("still refuses what a comment is wrapped around", () => {
    expect(() =>
      validateThemeCss(
        ':root { --primary: url("https://example.com/x.png"); }',
      ),
    ).toThrow("must not contain imports or URLs");
    expect(() => validateThemeCss("/* theme */ body { color: red; }")).toThrow(
      "only define :root and .dark blocks",
    );
    expect(() => validateThemeCss(":root { /* --primary: red; }")).toThrow();
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
  test("accepts explicit blank agent titles and preserves trimmed text", () => {
    for (const title of ["", "   ", " Existing title "]) {
      const parsed = validateTenantPackage({
        brand: "tenant: { id: fintech, product_name: Ledgerline }",
        agents: `agents: [{ id: knowledge, name: Knowledge, title: ${JSON.stringify(title)}, role_description: Answer company questions., type: built-in, system_prompt: Answer from knowledge. }]`,
        channels: "channels: []",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []",
        themeCss: "",
      });
      expect(parsed.agents[0]?.title).toBe(title.trim());
    }
  });
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
    ).toThrow("agent.title must be text of 120 characters or fewer");
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

  // A person's own OpenBot browser is a computer named `person-` and 32 hex digits, reached the way a Bot's is: a Bot
  // with that id would share its computer with the person whose browser it is.
  test("rejects an agent whose id is the shape of a person's OpenBot browser, and keeps one that is not", () => {
    const withAgent = (id: string) =>
      validateTenantPackage({
        brand: "tenant: { id: fintech, product_name: Ledgerline }",
        agents: `agents: [{ id: ${id}, name: Knowledge, title: Company Knowledge, role_description: Answer company questions., type: built-in, system_prompt: Answer from knowledge. }]`,
        channels: "channels: []",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []",
        themeCss: "",
      });
    expect(() => withAgent(`person-${"0a".repeat(16)}`)).toThrow(
      /person's OpenBot browser/,
    );
    expect(withAgent("person-helper").agents.map((agent) => agent.id)).toEqual([
      "person-helper",
    ]);
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
        systemPrompt: expect.stringContaining(
          "You are a general assistant for everyday work",
        ),
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

  test("starts a deployment with two coworkers, not the whole catalog", async () => {
    /*
     * The roster a fresh deployment opens on. The ten in `catalog/` used to load from `agents/`, so
     * every new deployment met a dozen Bots at once. Risk Analyst and the picked harness only register
     * with an endpoint, so they are switched off here to read the package as a bare install does.
     */
    const saved = {
      managed: process.env.MANAGED_AGENT_AG_UI_URL,
      picked: process.env.PICKED_HARNESS_URL,
    };
    delete process.env.MANAGED_AGENT_AG_UI_URL;
    delete process.env.PICKED_HARNESS_URL;
    try {
      const tenantPackage = await loadTenantPackage(
        fileURLToPath(new URL("../../examples/fintech", import.meta.url)),
      );
      expect(tenantPackage.agents.map((agent) => agent.id)).toEqual([
        "general-assistant",
        "knowledge",
      ]);
    } finally {
      if (saved.managed === undefined)
        delete process.env.MANAGED_AGENT_AG_UI_URL;
      else process.env.MANAGED_AGENT_AG_UI_URL = saved.managed;
      if (saved.picked === undefined) delete process.env.PICKED_HARNESS_URL;
      else process.env.PICKED_HARNESS_URL = saved.picked;
    }
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
  test("editing only skills.yaml changes the loaded package checksum", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-skills-checksum-"));
    try {
      await cp(
        fileURLToPath(new URL("../../examples/fintech", import.meta.url)),
        directory,
        { recursive: true },
      );
      const skillsPath = join(directory, "skills.yaml");
      const original = await readFile(skillsPath, "utf8");
      const before = await loadTenantPackage(directory);
      expect((await loadTenantPackage(directory)).checksum).toBe(
        before.checksum,
      );

      await writeFile(
        skillsPath,
        `${original}\n  - slug: checksum-fixture\n    title: Checksum fixture\n    summary: Added instruction.\n    instructions: Read the revised policy.\n`,
        "utf8",
      );
      const after = await loadTenantPackage(directory);
      expect(after.skills).toHaveLength(before.skills.length + 1);
      expect(after.skills.at(-1)?.instructions).toBe(
        "Read the revised policy.",
      );
      expect(after.checksum).not.toBe(before.checksum);

      await writeFile(skillsPath, original, "utf8");
      expect((await loadTenantPackage(directory)).checksum).toBe(
        before.checksum,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

describe("bundled personal starter", () => {
  const personal = fileURLToPath(
    new URL("../../examples/personal", import.meta.url),
  );
  const claude = "http://agent-harness:4212";
  const langchain = "http://agent-harness:4206";
  const actor = { id: "personal-starter-reader", role: "admin" as const };
  const runtime = createRuntimeAgentLoader(database);
  const profiles = createAgentProfileStore(database, undefined);

  function starterTestTenant() {
    const tenantId = randomUUID();
    createdTenantIds.push(tenantId);
    createdAgentIds.push(
      "personal-assistant",
      "picked-harness",
      "general-assistant",
    );
    createdChannelIds.push("personal-assistant");
    return tenantId;
  }

  async function loadStarter(
    tenantId: string,
    endpoint: string,
    name?: string,
  ) {
    // The name OpenBot Desktop sends is the catalogue's, from shared/harnesses.json.
    const env = {
      PICKED_HARNESS_URL: endpoint,
      PICKED_HARNESS_NAME:
        name ?? (endpoint === claude ? "Claude Agent SDK" : "LangChain"),
      PICKED_HARNESS_KIND: "remote-ag-ui",
    };
    const previous = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, env);
    try {
      return { ...(await loadTenantPackage(personal)), tenantId };
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  async function ownedIds(packageId: string) {
    return (
      await database
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.packageId, packageId))
    )
      .map(({ id }) => id)
      .sort();
  }

  async function attachedSkills(agentId: string) {
    return (
      await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.agentId, agentId),
            eq(pluginGrants.kind, "skill"),
          ),
        )
    )
      .map(({ ref }) => ref)
      .sort();
  }

  async function channelBots() {
    return (
      await database
        .select({ id: channelAgents.agentId })
        .from(channelAgents)
        .where(eq(channelAgents.channelId, "personal-assistant"))
    )
      .map(({ id }) => id)
      .sort();
  }

  test.each([claude, langchain])(
    "seeds one runnable Personal Assistant at %s",
    async (endpoint) => {
      const loaded = await loadStarter(starterTestTenant(), endpoint);
      const pkg = await synchronizeTenantPackage(database, loaded);
      expect(await ownedIds(pkg.id)).toEqual(["picked-harness"]);
      const declared = loaded.agents.find(
        ({ id }) => id === "personal-assistant",
      );
      expect(await profiles.get(actor, "picked-harness")).toMatchObject({
        name: "Personal Assistant",
        title: `Everyday life. Powered by ${endpoint === claude ? "Claude Agent SDK" : "LangChain"}.`,
        roleDescription: declared?.roleDescription,
        instructions: declared?.configuration.systemPrompt,
      });
      expect(await attachedSkills("picked-harness")).toEqual([
        "bot-creator",
        "skill-creator",
      ]);
      expect(await channelBots()).toEqual(["picked-harness"]);
      const starter = (await runtime(actor)).find(
        (agent) => agent.id === "picked-harness",
      );
      expect(starter).toMatchObject({ type: "remote_ag_ui", endpoint });
      if (starter?.type !== "remote_ag_ui")
        throw new Error("Missing remote starter");
      const fallback = loaded.agents.find(
        (agent) => agent.id === "personal-assistant",
      );
      expect(starter.standingMessage.content).toContain(
        String(fallback?.configuration.systemPrompt),
      );
    },
  );

  test.each(["", claude])(
    "the personal edition permits starter edits through the HTTP capability gate: %s",
    async (endpoint) => {
      setEdition("personal");
      const userId = await createUser();
      const signedIn = {
        id: userId,
        email: `${userId}@example.test`,
        role: "admin" as const,
      };
      const controls = await installEnterpriseControls({
        database,
        databaseUrl: testDatabaseUrl(),
        auditStore: createAuditStore(database),
        env: {},
      });
      try {
        await synchronizeTenantPackage(
          database,
          await loadStarter(starterTestTenant(), endpoint),
        );
        const id = endpoint ? "picked-harness" : "personal-assistant";
        const starter = await profiles.get(signedIn, id);
        if (!starter) throw new Error("Missing starter");
        const requireUser: MiddlewareHandler<{
          Variables: AppVariables;
        }> = async (context, next) => {
          context.set("actor", signedIn);
          await next();
        };
        const app = new Hono<{ Variables: AppVariables }>();
        app.use("/api/*", createEnterpriseGate(requireUser));
        app.route("/api/agents", createAgentRoutes(profiles, requireUser));
        const input = {
          name: starter.name,
          title: "Everyday life.",
          roleDescription: starter.roleDescription,
          visibility: starter.visibility,
        };
        const response = await app.request(`/api/agents/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        expect(response.status).toBe(200);
        expect((await response.json()).agent.title).toBe("Everyday life.");
        const publish = await app.request(`/api/agents/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, visibility: "public" }),
        });
        expect(publish.status).toBe(403);
      } finally {
        await controls.stop();
        setEdition("team");
      }
    },
  );

  test("restart and provider switch keep one starter and refresh its connection", async () => {
    const tenantId = starterTestTenant();
    const loaded = await loadStarter(tenantId, claude);
    const pkg = await synchronizeTenantPackage(database, loaded);
    await synchronizeTenantPackage(database, loaded);
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await ownedIds(pkg.id)).toEqual(["picked-harness"]);
    expect(await profiles.get(actor, "picked-harness")).toMatchObject({
      name: "Personal Assistant",
      title: "Everyday life. Powered by LangChain.",
      endpoint: langchain,
    });
    await synchronizeTenantPackage(database, await loadStarter(tenantId, ""));
    expect(await ownedIds(pkg.id)).toEqual(["picked-harness"]);
    expect(
      (await runtime(actor)).find((agent) => agent.id === "picked-harness"),
    ).toMatchObject({ type: "remote_ag_ui", endpoint: langchain });
    expect(await attachedSkills("picked-harness")).toEqual([
      "bot-creator",
      "skill-creator",
    ]);
    expect(await channelBots()).toEqual(["picked-harness"]);
  });

  test("starter attribution can be removed and stays edited after restart and harness switch", async () => {
    const tenantId = starterTestTenant();
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    const starter = await profiles.get(actor, "picked-harness");
    expect(starter?.systemOwned).toBe(false);
    await profiles.update(actor, "picked-harness", {
      name: "Personal Assistant",
      title: "My everyday helper",
      roleDescription: "Only research public sources.",
      visibility: "public",
    });
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await profiles.get(actor, "picked-harness")).toMatchObject({
      title: "My everyday helper",
      endpoint: langchain,
    });
  });

  /*
   * What a conversation's header shows under the starter's name is its title and what it does, so
   * what it does has to be the sentence the package wrote for the person. Seeded with the
   * package's `system_prompt` instead, the header read "You are a personal assistant for one
   * person..." to the person.
   */
  test.each(["", claude])(
    "a fresh starter says what it does in the package's words for the person, not its instructions: %s",
    async (endpoint) => {
      const loaded = await loadStarter(starterTestTenant(), endpoint);
      await synchronizeTenantPackage(database, loaded);
      const declared = loaded.agents.find(
        ({ id }) => id === "personal-assistant",
      );
      const id = endpoint ? "picked-harness" : "personal-assistant";
      const starter = await profiles.get(actor, id);
      expect(starter?.roleDescription).toBe(
        "Help with email, your calendar, research, planning and everyday errands.",
      );
      expect(starter?.roleDescription).toBe(declared?.roleDescription);
      expect(starter?.roleDescription).not.toContain("You are");
      expect(starter?.instructions).toBe(
        String(declared?.configuration.systemPrompt),
      );
      // And the Bot still runs on the instructions.
      const running = (await runtime(actor)).find((agent) => agent.id === id);
      if (running?.type === "built_in")
        expect(running.systemPrompt).toBe(
          String(declared?.configuration.systemPrompt),
        );
      else if (running?.type === "remote_ag_ui")
        expect(running.standingMessage.content).toContain(
          String(declared?.configuration.systemPrompt),
        );
      else throw new Error("Expected a runnable starter");
    },
  );

  test.each(["", claude])(
    "starter instructions are edited apart from what it does: %s",
    async (endpoint) => {
      const tenantId = starterTestTenant();
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, endpoint),
      );
      const id = endpoint ? "picked-harness" : "personal-assistant";
      const key = endpoint ? "standingInstructions" : "systemPrompt";
      const starter = await profiles.get(actor, id);
      if (!starter?.instructions) throw new Error("Missing starter");
      expect(starter.instructions).toContain("Never type a password");
      const stored = async () => {
        const [row] = await database
          .select({ configuration: agents.configuration })
          .from(agents)
          .where(eq(agents.id, id));
        return row?.configuration as Record<string, unknown>;
      };

      // A new description leaves the instructions as they were.
      await profiles.update(actor, id, {
        name: starter.name,
        title: "Everyday life.",
        roleDescription: "Plans my week.",
        visibility: "public",
      });
      expect(await profiles.get(actor, id)).toMatchObject({
        roleDescription: "Plans my week.",
        instructions: starter.instructions,
      });
      expect((await stored())[key]).toBe(starter.instructions);

      // New instructions leave the description as it was, and the Bot runs on them.
      await profiles.update(actor, id, {
        name: starter.name,
        title: "Everyday life.",
        roleDescription: "Plans my week.",
        visibility: "public",
        instructions: `${starter.instructions} I live in Berlin.`,
      });
      expect(await profiles.get(actor, id)).toMatchObject({
        roleDescription: "Plans my week.",
        instructions: `${starter.instructions} I live in Berlin.`,
      });
      expect((await stored())[key]).toBe(
        `${starter.instructions} I live in Berlin.`,
      );
      const running = (await runtime(actor)).find((agent) => agent.id === id);
      if (running?.type === "built_in")
        expect(running.systemPrompt).toContain("I live in Berlin.");
      else if (running?.type === "remote_ag_ui") {
        expect(running.standingMessage.content).toContain("Plans my week.");
        expect(running.standingMessage.content).toContain("I live in Berlin.");
      } else throw new Error("Expected a runnable starter");
    },
  );

  /*
   * A desktop set up on 0.3.2 holds its starter in the shape that seed wrote: the package's
   * `system_prompt` as what it does, and for a harness nothing else, so the header showed the
   * instructions. The next start keeps what the Bot runs on and gives the header the package's
   * sentence, whether or not the person had added to the text.
   */
  test.each([
    ["Claude Agent SDK, as seeded", claude, ""],
    ["Claude Agent SDK, added to", claude, " I live in Berlin."],
    ["OpenBot, as seeded", "", ""],
    ["OpenBot, added to", "", " I live in Berlin."],
  ])(
    "a starter seeded with its instructions as what it does is repaired on the next start: %s",
    async (_case, endpoint, added) => {
      const tenantId = starterTestTenant();
      const loaded = await loadStarter(tenantId, endpoint);
      await synchronizeTenantPackage(database, loaded);
      const declared = loaded.agents.find(
        ({ id }) => id === "personal-assistant",
      );
      const prompt = String(declared?.configuration.systemPrompt);
      const id = endpoint ? "picked-harness" : "personal-assistant";
      const old = `${prompt}${added}`;
      // The rows as 0.3.2 left them.
      const [seeded] = await database
        .select({ configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, id));
      if (!seeded) throw new Error("Missing starter");
      const { standingInstructions: _dropped, ...configuration } =
        seeded.configuration as Record<string, unknown>;
      await database
        .update(agents)
        .set({
          configuration: endpoint
            ? configuration
            : { ...configuration, systemPrompt: old },
        })
        .where(eq(agents.id, id));
      await database
        .update(agentProfiles)
        .set({ roleDescription: old })
        .where(eq(agentProfiles.agentId, id));

      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, endpoint),
      );
      expect(await profiles.get(actor, id)).toMatchObject({
        roleDescription: declared?.roleDescription,
        instructions: old,
      });
      const running = (await runtime(actor)).find((agent) => agent.id === id);
      if (running?.type === "built_in") expect(running.systemPrompt).toBe(old);
      else if (running?.type === "remote_ag_ui")
        expect(running.standingMessage.content).toContain(old);
      else throw new Error("Expected a runnable starter");

      // Once apart, a description the person writes stays theirs across starts.
      const starter = await profiles.get(actor, id);
      if (!starter) throw new Error("Missing starter");
      await profiles.update(actor, id, {
        name: starter.name,
        title: starter.title,
        roleDescription: "Plans my week.",
        visibility: starter.visibility,
      });
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, endpoint),
      );
      expect(await profiles.get(actor, id)).toMatchObject({
        roleDescription: "Plans my week.",
        instructions: old,
      });
    },
  );

  /*
   * A desktop installed before the starter's instructions were rewritten holds the text that told
   * it to ask whenever something was ambiguous and to ask the person to sign in and wait. A
   * starter's instructions are seeded once, so the package's new text reaches that desktop only
   * through this repair. Text the person changed, by so much as a sentence, stays theirs.
   */
  const shippedUntilNow =
    "You are a personal assistant for one person. Help with their email, calendar, research, planning and everyday errands. Be clear and brief, and ask when something is ambiguous rather than guessing. When you send, buy, delete or post anything, say exactly what you are doing; OpenBot asks the person before it happens, so do not ask them yourself first. Never type a password yourself: ask the person to sign in, and wait for them.";
  test.each([
    ["OpenBot", ""],
    ["Claude Agent SDK", claude],
  ])(
    "a starter still on the instructions an earlier OpenBot shipped moves to the current ones: %s",
    async (_case, endpoint) => {
      const tenantId = starterTestTenant();
      const loaded = await loadStarter(tenantId, endpoint);
      await synchronizeTenantPackage(database, loaded);
      const current = String(
        loaded.agents.find(({ id }) => id === "personal-assistant")
          ?.configuration.systemPrompt,
      );
      expect(current).not.toBe(shippedUntilNow);
      const id = endpoint ? "picked-harness" : "personal-assistant";
      const key = endpoint ? "standingInstructions" : "systemPrompt";
      const holdInstructions = async (text: string) => {
        const [row] = await database
          .select({ configuration: agents.configuration })
          .from(agents)
          .where(eq(agents.id, id));
        if (!row) throw new Error("Missing starter");
        await database
          .update(agents)
          .set({
            configuration: {
              ...(row.configuration as Record<string, unknown>),
              [key]: text,
            },
          })
          .where(eq(agents.id, id));
      };

      await holdInstructions(shippedUntilNow);
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, endpoint),
      );
      expect((await profiles.get(actor, id))?.instructions).toBe(current);

      const edited = `${shippedUntilNow} I live in Berlin.`;
      await holdInstructions(edited);
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, endpoint),
      );
      expect((await profiles.get(actor, id))?.instructions).toBe(edited);
    },
  );

  test("the starter's Setup page saves its instructions over HTTP", async () => {
    const tenantId = starterTestTenant();
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    const userId = await createUser();
    const signedIn = {
      id: userId,
      email: `${userId}@example.test`,
      role: "admin" as const,
    };
    const starter = await profiles.get(signedIn, "picked-harness");
    if (!starter) throw new Error("Missing starter");
    const requireUser: MiddlewareHandler<{
      Variables: AppVariables;
    }> = async (context, next) => {
      context.set("actor", signedIn);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/api/agents", createAgentRoutes(profiles, requireUser, true));
    const body = {
      name: starter.name,
      title: starter.title,
      roleDescription: starter.roleDescription,
      visibility: starter.visibility,
      endpoint: starter.endpoint,
    };
    const read = await app.request("/api/agents/picked-harness");
    expect((await read.json()).agent).toMatchObject({
      roleDescription: starter.roleDescription,
      instructions: starter.instructions,
    });
    const saved = await app.request("/api/agents/picked-harness", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, instructions: "Answer in French." }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).agent).toMatchObject({
      roleDescription: starter.roleDescription,
      instructions: "Answer in French.",
    });
    const blank = await app.request("/api/agents/picked-harness", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, instructions: "  " }),
    });
    expect(blank.status).toBe(400);
  });

  test("fresh external starters have no guessed attribution", async () => {
    await synchronizeTenantPackage(
      database,
      await loadStarter(
        starterTestTenant(),
        "https://agents.example/run",
        "An agent you already run",
      ),
    );
    expect(await profiles.get(actor, "picked-harness")).toMatchObject({
      title: "Everyday life.",
    });
  });

  test("a personally edited connection survives restart and installer harness switches", async () => {
    const tenantId = starterTestTenant();
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    const starter = await profiles.get(actor, "picked-harness");
    if (!starter) throw new Error("Missing starter");
    await profiles.update(actor, starter.id, {
      name: starter.name,
      title: starter.title,
      roleDescription: starter.roleDescription,
      visibility: "public",
      endpoint: "https://agents.example/run",
    });
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await profiles.get(actor, starter.id)).toMatchObject({
      endpoint: "https://agents.example/run",
    });
  });

  test("renaming the starter on its Setup page keeps it on the installer's harness", async () => {
    const tenantId = starterTestTenant();
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    const userId = await createUser();
    const signedIn = {
      id: userId,
      email: `${userId}@example.test`,
      role: "admin" as const,
    };
    const starter = await profiles.get(signedIn, "picked-harness");
    if (!starter) throw new Error("Missing starter");
    const requireUser: MiddlewareHandler<{
      Variables: AppVariables;
    }> = async (context, next) => {
      context.set("actor", signedIn);
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    // A laptop's deployment, as OpenBot Desktop runs one.
    app.route("/api/agents", createAgentRoutes(profiles, requireUser, true));
    // What the Setup page sends for a new name and title: everything else as it showed it.
    const response = await app.request("/api/agents/picked-harness", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Personal Assistant F5",
        title: "Errands and research. Powered by Claude Agent SDK.",
        roleDescription: starter.roleDescription,
        visibility: starter.visibility,
        endpoint: starter.endpoint,
      }),
    });
    expect(response.status).toBe(200);
    const [edited] = await database
      .select({ configuration: agents.configuration })
      .from(agents)
      .where(eq(agents.id, "picked-harness"));
    expect(edited?.configuration).toMatchObject({ endpoint: claude });
    expect(edited?.configuration).not.toHaveProperty("personalConnection");

    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await profiles.get(signedIn, "picked-harness")).toMatchObject({
      name: "Personal Assistant F5",
      endpoint: langchain,
    });
  });

  test.each([
    ["follows the installer again", false, langchain],
    ["with a key of its own stays where it is", true, `${claude}/`],
  ])(
    "a starter renamed before this release %s",
    async (_case, keyed, endpoint) => {
      const tenantId = starterTestTenant();
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, claude),
      );
      const [seeded] = await database
        .select({ configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, "picked-harness"));
      // What a rename on the Setup page stored until this release.
      await database
        .update(agents)
        .set({
          configuration: {
            ...(seeded?.configuration as Record<string, unknown>),
            endpoint: `${claude}/`,
            personalConnection: true,
            ...(keyed
              ? { auth: { header: "Authorization", credentialId: "key-1" } }
              : {}),
          },
        })
        .where(eq(agents.id, "picked-harness"));

      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, langchain),
      );
      const [after] = await database
        .select({ configuration: agents.configuration })
        .from(agents)
        .where(eq(agents.id, "picked-harness"));
      expect(after?.configuration).toMatchObject({ endpoint });
      if (keyed)
        expect(after?.configuration).toMatchObject({
          personalConnection: true,
        });
      else
        expect(after?.configuration).not.toHaveProperty("personalConnection");
    },
  );

  test("the starter's subtitle names the harness it runs on after a switch, around the person's own words", async () => {
    const tenantId = starterTestTenant();
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    const starter = await profiles.get(actor, "picked-harness");
    if (!starter) throw new Error("Missing starter");
    await profiles.update(actor, starter.id, {
      name: "Personal Assistant F5",
      title: "Errands and research, edited on F5. Powered by Claude Agent SDK.",
      roleDescription: starter.roleDescription,
      visibility: starter.visibility,
    });

    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await profiles.get(actor, starter.id)).toMatchObject({
      name: "Personal Assistant F5",
      title: "Errands and research, edited on F5. Powered by LangChain.",
      endpoint: langchain,
    });

    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    expect(await profiles.get(actor, starter.id)).toMatchObject({
      title: "Errands and research, edited on F5. Powered by Claude Agent SDK.",
      endpoint: claude,
    });

    // An agent the person already runs is not a framework the installer can name.
    await synchronizeTenantPackage(
      database,
      await loadStarter(
        tenantId,
        "https://agents.example/run",
        "An agent you already run",
      ),
    );
    expect(await profiles.get(actor, starter.id)).toMatchObject({
      title: "Errands and research, edited on F5.",
      endpoint: "https://agents.example/run",
    });
  });

  test("a connection the person set keeps its subtitle through a harness switch", async () => {
    const tenantId = starterTestTenant();
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    const starter = await profiles.get(actor, "picked-harness");
    if (!starter) throw new Error("Missing starter");
    await profiles.update(actor, starter.id, {
      name: starter.name,
      title: starter.title,
      roleDescription: starter.roleDescription,
      visibility: starter.visibility,
      endpoint: "https://agents.example/run",
    });
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await profiles.get(actor, starter.id)).toMatchObject({
      title: "Everyday life. Powered by Claude Agent SDK.",
      endpoint: "https://agents.example/run",
    });
  });

  // Seeded by an earlier desktop, under a name the catalogue gave LangChain then.
  test.each(["LangGraph", "LangChain (LangGraph)"])(
    "legacy catalogue name %s follows harness changes without renaming custom Bots",
    async (earlier) => {
      const tenantId = starterTestTenant();
      const legacy = await loadStarter(tenantId, langchain, earlier);
      await synchronizeTenantPackage(database, {
        ...legacy,
        sourcePath: "/tmp/legacy-personal-package",
      });
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, langchain),
      );
      expect(await profiles.get(actor, "picked-harness")).toMatchObject({
        name: "LangChain",
        title: "Powered by LangChain",
      });
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, claude),
      );
      expect(await profiles.get(actor, "picked-harness")).toMatchObject({
        name: "Claude Agent SDK",
        title: "Powered by Claude Agent SDK",
        endpoint: claude,
        systemOwned: true,
      });
      await synchronizeTenantPackage(
        database,
        await loadStarter(
          tenantId,
          "https://agents.example/run",
          "An agent you already run",
        ),
      );
      expect(await profiles.get(actor, "picked-harness")).toMatchObject({
        endpoint: "https://agents.example/run",
      });
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, claude),
      );
      expect(await profiles.get(actor, "picked-harness")).toMatchObject({
        endpoint: claude,
        systemOwned: true,
      });
    },
  );

  test("source installs keep the built-in fallback if a harness later appears", async () => {
    const tenantId = starterTestTenant();
    const pkg = await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, ""),
    );
    // It runs here, so it says it runs on OpenBot itself.
    expect(await profiles.get(actor, "personal-assistant")).toMatchObject({
      title: "Everyday life. Powered by OpenBot.",
    });
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await ownedIds(pkg.id)).toEqual(["personal-assistant"]);
    expect(
      (await runtime(actor)).find((agent) => agent.id === "personal-assistant"),
    ).toMatchObject({ name: "Personal Assistant", type: "built_in" });
    expect(await channelBots()).toEqual(["personal-assistant"]);
  });

  test("concurrent initializers choose one starter", async () => {
    const tenantId = starterTestTenant();
    const installed = await loadStarter(tenantId, claude);
    const fallback = await loadStarter(tenantId, "");
    const [pkg] = await Promise.all([
      synchronizeTenantPackage(database, installed),
      synchronizeTenantPackage(database, fallback),
    ]);
    const ids = await ownedIds(pkg.id);
    expect(ids).toHaveLength(1);
    expect(await channelBots()).toEqual(ids);
  });

  test.each(["personal-assistant", "general-assistant"])(
    "an existing installation keeps its customized %s, picked Bot and conversations",
    async (otherId) => {
      const tenantId = starterTestTenant();
      const pkg = await createPackage(tenantId);
      await database.insert(agents).values([
        {
          id: otherId,
          name: "My own Assistant",
          type: "built_in",
          configuration: { systemPrompt: "My custom instructions." },
          packageId: pkg.id,
        },
        {
          id: "picked-harness",
          name: "My other Bot",
          type: "remote_ag_ui",
          configuration: { endpoint: claude, custom: "preserve" },
          packageId: pkg.id,
        },
      ]);
      await database.insert(agentProfiles).values(
        [otherId, "picked-harness"].map((agentId) => ({
          agentId,
          avatarSeed: "custom-orb",
          title: "My title",
          roleDescription: "My custom role.",
          visibility: "public" as const,
        })),
      );
      await database.insert(pluginGrants).values([
        {
          kind: "skill",
          ref: "bot-creator",
          agentId: otherId,
          grantedBy: "tenant-package",
        },
        {
          kind: "skill",
          ref: "skill-creator",
          agentId: "picked-harness",
          grantedBy: "admin",
        },
      ]);
      await database.insert(channels).values({
        id: "personal-assistant",
        name: "My conversation",
        description: "Existing",
        allowedGroups: [],
        packageId: pkg.id,
      });
      await database.insert(channelAgents).values(
        [otherId, "picked-harness"].map((agentId) => ({
          channelId: "personal-assistant",
          agentId,
        })),
      );
      await synchronizeTenantPackage(database, await loadStarter(tenantId, ""));
      expect(
        (await runtime(actor)).find((agent) => agent.id === "picked-harness"),
      ).toMatchObject({
        name: "My other Bot",
        type: "remote_ag_ui",
        endpoint: claude,
      });
      await synchronizeTenantPackage(
        database,
        await loadStarter(tenantId, langchain),
      );
      expect(await ownedIds(pkg.id)).toEqual([otherId, "picked-harness"]);
      expect(await profiles.get(actor, "picked-harness")).toMatchObject({
        name: "My other Bot",
        title: "My title",
        roleDescription: "My custom role.",
        avatarSeed: "custom-orb",
        endpoint: langchain,
      });
      expect(
        (await runtime(actor)).find((agent) => agent.id === otherId),
      ).toMatchObject({
        name: "My own Assistant",
        type: "built_in",
        systemPrompt: "My custom instructions.",
      });
      expect(await attachedSkills(otherId)).toEqual(["bot-creator"]);
      expect(await attachedSkills("picked-harness")).toEqual(["skill-creator"]);
      expect(await channelBots()).toEqual([otherId, "picked-harness"]);
      const [picked] = await database
        .select()
        .from(agents)
        .where(eq(agents.id, "picked-harness"));
      expect(picked?.configuration).toMatchObject({
        endpoint: langchain,
        custom: "preserve",
      });
    },
  );

  test("restarting does not restore a deleted picked Bot", async () => {
    const tenantId = starterTestTenant();
    const pkg = await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, claude),
    );
    await database
      .update(agentProfiles)
      .set({ deletedAt: new Date() })
      .where(eq(agentProfiles.agentId, "picked-harness"));
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await ownedIds(pkg.id)).toEqual(["picked-harness"]);
    expect(await profiles.get(actor, "picked-harness")).toBeNull();
    expect((await runtime(actor)).map(({ id }) => id)).not.toContain(
      "picked-harness",
    );
  });

  test("upgrading the former personal package carries its starter without reseeding", async () => {
    const formerTenantId = "personal";
    createdTenantIds.push(formerTenantId);
    const legacy = await synchronizeTenantPackage(database, {
      ...(await loadStarter(formerTenantId, "")),
      formerTenantIds: [],
    });
    await database
      .update(agents)
      .set({ name: "My original Assistant" })
      .where(eq(agents.id, "personal-assistant"));
    const upgraded = await loadStarter(starterTestTenant(), langchain);
    expect(await deploymentNameOf(database, upgraded)).toBe(formerTenantId);
    const current = await synchronizeTenantPackage(database, upgraded);
    await synchronizeTenantPackage(database, upgraded);
    expect(await ownedIds(legacy.id)).toEqual([]);
    expect(await ownedIds(current.id)).toEqual(["personal-assistant"]);
    expect(await profiles.get(actor, "personal-assistant")).toMatchObject({
      name: "My original Assistant",
    });
    expect(await attachedSkills("personal-assistant")).toEqual([
      "bot-creator",
      "skill-creator",
    ]);
    const [channel] = await database
      .select({ packageId: channels.packageId })
      .from(channels)
      .where(eq(channels.id, "personal-assistant"));
    expect(channel?.packageId).toBe(current.id);
    expect(await channelBots()).toEqual(["personal-assistant"]);
  });

  test("switching from a copied package preserves its remote Bot across restarts", async () => {
    const tenantId = starterTestTenant();
    const customEndpoint = "https://example.test/custom-bot";
    const custom = await loadStarter(tenantId, customEndpoint);
    const pkg = await synchronizeTenantPackage(database, {
      ...custom,
      sourcePath: "/customer/personal",
    });
    const bundled = await loadStarter(tenantId, langchain);
    await synchronizeTenantPackage(database, bundled);
    await synchronizeTenantPackage(database, bundled);
    expect(await ownedIds(pkg.id)).toEqual([
      "personal-assistant",
      "picked-harness",
    ]);
    expect(
      (await runtime(actor)).find((agent) => agent.id === "picked-harness"),
    ).toMatchObject({ type: "remote_ag_ui", endpoint: customEndpoint });
  });

  test("an existing user-owned picked-harness ID is left alone", async () => {
    const tenantId = starterTestTenant();
    const pkg = await createPackage(tenantId);
    const owner = await createUser();
    await database.insert(agents).values({
      id: "picked-harness",
      name: "Someone's Bot",
      type: "remote_ag_ui",
      configuration: { endpoint: "https://example.test/agent" },
    });
    await database.insert(agentProfiles).values({
      agentId: "picked-harness",
      ownerUserId: owner,
      title: "Custom",
      roleDescription: "My own role.",
      avatarSeed: "mine",
      visibility: "private",
    });
    await synchronizeTenantPackage(
      database,
      await loadStarter(tenantId, langchain),
    );
    expect(await ownedIds(pkg.id)).toEqual([]);
    expect(
      await profiles.get({ id: owner, role: "user" }, "picked-harness"),
    ).toMatchObject({
      name: "Someone's Bot",
      endpoint: "https://example.test/agent",
      ownerUserId: owner,
    });
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

/**
 * A personal edition set up under v0.3.1, whose package was then called `personal`, upgraded to the
 * package renamed `openbot`.
 *
 * Before `tenant.former_ids`, the upgraded server refused its own Personal Assistant as another
 * package's Bot ("collides with a user-created agent") and stopped at boot, and with DEPLOYMENT_ID
 * unset it started minting thread ids under a different deployment name.
 *
 * The real `examples/personal` package, with its ids suffixed so the suite never touches a row a
 * real deployment or another test could hold.
 */
describe("upgrading a deployment set up under a package's former id", () => {
  test("the shipped personal package names `personal` as its former id", async () => {
    const shipped = await loadTenantPackage(
      fileURLToPath(new URL("../../examples/personal", import.meta.url)),
    );
    expect(shipped.tenantId).toBe("openbot");
    expect(shipped.formerTenantIds).toEqual(["personal"]);
  });

  test("a package may not name its own id as a former one", () => {
    expect(() =>
      validateTenantPackage({
        brand:
          "tenant:\n  id: openbot\n  former_ids: [openbot]\n  product_name: OpenBot\n",
        agents: "agents: []\n",
        channels: "channels: []\n",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
        knowledge: "sources: []\n",
        themeCss: "",
      }),
    ).toThrow('tenant.former_ids names "openbot"');
  });

  test("boots with its Bots, conversations and connections intact, under the name it had", async () => {
    const suffix = randomUUID().slice(0, 8);
    const rename = (id: string) => `${id}-${suffix}`;
    const shipped = await loadTenantPackage(
      fileURLToPath(new URL("../../examples/personal", import.meta.url)),
    );
    const formerId = rename(shipped.formerTenantIds[0] ?? "personal");
    const currentId = rename(shipped.tenantId);
    createdTenantIds.push(formerId, currentId);
    const isolate = (
      tenantId: string,
      formerTenantIds: string[],
    ): LoadedTenantPackage => ({
      ...shipped,
      tenantId,
      formerTenantIds,
      skills: [],
      agents: shipped.agents.map((agent) => ({
        ...agent,
        id: rename(agent.id),
        skills: [],
      })),
      channels: shipped.channels.map((channel) => ({
        ...channel,
        id: rename(channel.id),
        permittedAgents: channel.permittedAgents.map(rename),
      })),
    });
    // v0.3.1: the same package, under the id it had then.
    const v031 = isolate(formerId, []);
    // This release: renamed, and saying what it used to be called.
    const upgraded = isolate(currentId, [formerId]);
    const assistant = rename("personal-assistant");
    const packageChannel = rename("personal-assistant");
    createdAgentIds.push(assistant);
    createdChannelIds.push(packageChannel);

    await synchronizeTenantPackage(database, v031);
    const userId = await createUser();
    const actor = { id: userId, role: "user" as const };

    // A Bot the person made, and a conversation with each Bot.
    const ownBot = `agent_${suffix}`;
    createdAgentIds.push(ownBot);
    await database.insert(agents).values({
      id: ownBot,
      name: "Trip Planner",
      type: "built_in",
      configuration: { systemPrompt: "Plan my trips." },
      packageId: null,
    });
    await database.insert(agentProfiles).values({
      agentId: ownBot,
      title: "Travel",
      roleDescription: "Plan my trips.",
      avatarSeed: ownBot,
      visibility: "private",
      ownerUserId: userId,
    });
    const conversations = [
      { id: `channel_${suffix}-assistant`, agentId: assistant },
      { id: `channel_${suffix}-own`, agentId: ownBot },
    ];
    for (const conversation of conversations) {
      createdChannelIds.push(conversation.id);
      await database.insert(channels).values({
        id: conversation.id,
        name: conversation.agentId,
        description: "A conversation.",
        allowedGroups: [],
      });
      await database
        .insert(channelAgents)
        .values({ channelId: conversation.id, agentId: conversation.agentId });
      await database
        .insert(channelMemberships)
        .values({ channelId: conversation.id, userId });
    }
    // An app the person connected.
    await database.insert(brokeredConnections).values({
      provider: "composio",
      app: `gmail-${suffix}`,
      holder: "person",
      userId,
      vendorUserId: `person-${suffix}`,
      connectedBy: userId,
      verified: true,
    });

    const snapshot = async () => ({
      bots: (await createAgentProfileStore(database, undefined).list(actor))
        .filter((bot) => bot.id === assistant || bot.id === ownBot)
        .map((bot) => ({ id: bot.id, deletedAt: bot.deletedAt }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      conversations: (
        await database
          .select({
            channelId: channelMemberships.channelId,
            agentId: channelAgents.agentId,
          })
          .from(channelMemberships)
          .innerJoin(
            channelAgents,
            eq(channelAgents.channelId, channelMemberships.channelId),
          )
          .where(eq(channelMemberships.userId, userId))
      ).sort((a, b) => a.channelId.localeCompare(b.channelId)),
      connections: (
        await database
          .select({
            app: brokeredConnections.app,
            vendorUserId: brokeredConnections.vendorUserId,
            verified: brokeredConnections.verified,
          })
          .from(brokeredConnections)
          .where(eq(brokeredConnections.userId, userId))
      ).sort((a, b) => a.app.localeCompare(b.app)),
    });
    const before = await snapshot();
    expect(before.bots.map((bot) => bot.id).sort()).toEqual(
      [assistant, ownBot].sort(),
    );
    expect(before.conversations).toHaveLength(2);
    expect(before.connections).toHaveLength(1);

    // The upgraded server names itself before it synchronises.
    expect(await deploymentNameOf(database, upgraded)).toBe(formerId);

    const row = await synchronizeTenantPackage(database, upgraded);
    expect(row.tenantId).toBe(currentId);
    expect(await snapshot()).toEqual(before);

    // The package's Bot and channel are now the renamed package's; the person's Bot is still theirs.
    const owners = await database
      .select({ id: agents.id, packageId: agents.packageId })
      .from(agents)
      .where(inArray(agents.id, [assistant, ownBot]));
    expect(Object.fromEntries(owners.map((a) => [a.id, a.packageId]))).toEqual({
      [assistant]: row.id,
      [ownBot]: null,
    });
    const [channel] = await database
      .select({ packageId: channels.packageId })
      .from(channels)
      .where(eq(channels.id, packageChannel));
    expect(channel?.packageId).toBe(row.id);

    // And on every boot after: the same name, the same rows.
    expect(await deploymentNameOf(database, upgraded)).toBe(formerId);
    await synchronizeTenantPackage(database, upgraded);
    expect(await snapshot()).toEqual(before);

    await database
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.userId, userId));
  });

  test("a deployment that never had a former id is named by the package's id", async () => {
    const tenantId = `fresh-${randomUUID().slice(0, 8)}`;
    expect(
      await deploymentNameOf(database, {
        tenantId,
        formerTenantIds: [`never-${randomUUID().slice(0, 8)}`],
      }),
    ).toBe(tenantId);
  });
});
