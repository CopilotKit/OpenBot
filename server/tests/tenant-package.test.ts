import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import {
  agentProfiles,
  agents,
  deploymentPackages,
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

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const createdAgentIds: string[] = [];
const createdPackageIds: string[] = [];
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
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
    channels: [],
    model: {
      provider: "openai",
      credentialSecretRef: "openai-key",
      defaultModel: "gpt-4.1",
    },
    knowledgeSources: [],
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

describe("tenant YAML validation", () => {
  test("rejects an agent without a title", () => {
    expect(() =>
      validateTenantPackage({
        brand: "tenant: { id: fintech, product_name: Ledgerline }",
        agents:
          "agents: [{ id: knowledge, name: Knowledge, role_description: Answer company questions., type: built-in, system_prompt: Answer from knowledge. }]",
        channels: "channels: []",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1 }",
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
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1 }",
        knowledge: "sources: []",
        themeCss: "",
      }),
    ).toThrow("agent.role_description must be a non-empty string");
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
        "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1 }",
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
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1 }",
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
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1 }",
        knowledge: "sources: []",
        themeCss: ":root { --primary: oklch(0.32 0.09 250); }",
      }),
      ["google"],
    );

    expect(configuration).toEqual({
      brand: {
        tenantId: "fintech",
        productName: "Ledgerline",
      },
      auth: { providers: ["google"] },
    });
  });

  test("loads the mounted fintech package without a theme file", async () => {
    const tenantPackage = await loadTenantPackage(
      new URL("../../examples/fintech", import.meta.url).pathname,
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
    });
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
      model: `model:\n  provider: openai\n  credential_secret_ref: openai-key\n  default_model: gpt-4.1`,
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
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1 }",
        knowledge: "sources: []",
        themeCss: ":root { --primary: black; }",
      }),
    ).toThrow('references unknown agent "missing"');
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
      expandEnvironment("endpoint: ${AG_UI_URL}", file, {
        AG_UI_URL: "https://bots.example.test/ag-ui",
      }),
    ).toBe("endpoint: https://bots.example.test/ag-ui");
  });

  test("falls back to the default when the name is not set", () => {
    expect(
      expandEnvironment(
        "endpoint: ${AG_UI_URL:-http://localhost:4200}",
        file,
        {},
      ),
    ).toBe("endpoint: http://localhost:4200");
  });

  test("prefers the environment over the default", () => {
    expect(
      expandEnvironment("endpoint: ${AG_UI_URL:-http://localhost:4200}", file, {
        AG_UI_URL: "https://bots.example.test",
      }),
    ).toBe("endpoint: https://bots.example.test");
  });

  test("treats an empty value as unset", () => {
    expect(
      expandEnvironment("endpoint: ${AG_UI_URL:-http://localhost:4200}", file, {
        AG_UI_URL: "",
      }),
    ).toBe("endpoint: http://localhost:4200");
  });

  test("an empty default is allowed and is not an error", () => {
    expect(expandEnvironment("suffix: ${NOTHING:-}", file, {})).toBe(
      "suffix: ",
    );
  });

  test("refuses a name with neither a value nor a default", () => {
    expect(() => expandEnvironment("endpoint: ${AG_UI_URL}", file, {})).toThrow(
      /agents\.yaml refers to \$\{AG_UI_URL\}/,
    );
  });
});
