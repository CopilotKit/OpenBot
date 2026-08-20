import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { desc, eq, isNull } from "drizzle-orm";
import { parse } from "yaml";
import type { Database } from "./db/client";
import {
  agentProfiles,
  agents as agentTable,
  channelAgents,
  channels as channelTable,
  deploymentPackages,
} from "./db/schema";

const approvedThemeVariables = new Set([
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--radius",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
]);

export function validateThemeCss(css: string) {
  if (/@import|url\s*\(/i.test(css)) {
    throw new Error("Tenant theme must not contain imports or URLs");
  }

  const blocks = [...css.matchAll(/(:root|\.dark)\s*\{([^{}]*)\}/g)];
  const remaining = css.replace(/(:root|\.dark)\s*\{[^{}]*\}/g, "").trim();
  if (!blocks.length || remaining) {
    throw new Error("Tenant theme may only define :root and .dark blocks");
  }

  for (const [, , body] of blocks) {
    for (const declaration of body.split(";")) {
      const trimmed = declaration.trim();
      if (!trimmed) {
        continue;
      }
      const separator = trimmed.indexOf(":");
      const variable = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();

      if (separator < 1 || !value || !approvedThemeVariables.has(variable)) {
        throw new Error(
          `Tenant theme variable ${variable || "(invalid)"} is not an approved theme variable`,
        );
      }
    }
  }
}

type PackageFiles = {
  brand: string;
  agents: string;
  channels: string;
  model: string;
  knowledge: string;
  themeCss: string;
};

type TenantAgent = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed?: string;
  type: "built_in" | "remote_ag_ui";
  configuration: Record<string, unknown>;
};

type TenantChannel = {
  id: string;
  name: string;
  description: string;
  permittedAgents: string[];
  allowedGroups: string[];
};

export type TenantPackage = {
  tenantId: string;
  productName: string;
  stylesheet: string | null;
  agents: TenantAgent[];
  channels: TenantChannel[];
  model: {
    provider: "openai";
    credentialSecretRef: string;
    defaultModel: string;
  };
  /**
   * What `knowledge.yaml` says this deployment may connect to.
   *
   * Parsed and validated, and currently read by nothing. The connector that consumed it synced a
   * customer's Drive into a local index using a service account, so every person's answer came back
   * as the deployment rather than as themselves; it was removed rather than fixed. The file stays
   * part of the package contract because shipped packages carry it and validation should keep
   * refusing a malformed one, but a reader should not take the presence of this field as evidence
   * that anything acts on it.
   */
  knowledgeSources: {
    type: "google-drive" | "microsoft-onedrive";
    roots: string[];
  }[];
  themeCss: string;
};

export type LoadedTenantPackage = TenantPackage & {
  sourcePath: string;
  checksum: string;
};

export type PackageStatusReader = {
  active: () => Promise<{
    tenantId: string;
    sourcePath: string;
    checksum: string;
    loadedAt: string;
  } | null>;
};

export type ApplicationConfiguration = {
  brand: {
    tenantId: string;
    productName: string;
  };
  auth: { providers: string[] };
};

export function createApplicationConfiguration(
  tenantPackage: TenantPackage,
  providers: string[],
): ApplicationConfiguration {
  return {
    brand: {
      tenantId: tenantPackage.tenantId,
      productName: tenantPackage.productName,
    },
    auth: { providers },
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * A list a package must supply, named in the error when it does not.
 *
 * Cast without checking, a missing `agents:` reaches `.map` on `undefined` and the reader gets a
 * TypeError naming neither the file nor the key. Editing YAML by hand is the first thing somebody
 * does here, so getting it wrong has to produce a sentence they can act on.
 */
function asList(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be a list`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function yaml(value: string, filename: string): Record<string, unknown> {
  try {
    return asRecord(parse(value), filename);
  } catch (error) {
    throw new Error(
      `${filename} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * `${NAME}` in a package file, resolved from the environment.
 *
 * A package describes a deployment's Bots, and the addresses of the services behind them belong to
 * the environment rather than to the package: the same package has to be usable against a local
 * stack, a staging one and production. An unset name is an error rather than an empty string.
 */
export function expandEnvironment(
  value: string,
  filename: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, fallback: string | undefined) => {
      const resolved = environment[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error(
        `${filename} refers to \${${name}}, which is not set in this environment.`,
      );
    },
  );
}

export function validateTenantPackage(files: PackageFiles): TenantPackage {
  if (files.themeCss.trim()) {
    validateThemeCss(files.themeCss);
  }
  const brand = yaml(files.brand, "brand.yaml");
  const agentsYaml = yaml(files.agents, "agents.yaml");
  const channelsYaml = yaml(files.channels, "channels.yaml");
  const modelYaml = yaml(files.model, "model.yaml");
  const knowledgeYaml = yaml(files.knowledge, "knowledge.yaml");
  const tenant = asRecord(brand.tenant, "brand.tenant");
  const skin =
    brand.skin === undefined ? undefined : asRecord(brand.skin, "brand.skin");
  const agents = asList(agentsYaml.agents, "agents.yaml agents").map(
    (value) => {
      const agent = asRecord(value, "agent");
      const type: TenantAgent["type"] | undefined =
        agent.type === "built-in"
          ? "built_in"
          : agent.type === "remote-ag-ui"
            ? "remote_ag_ui"
            : undefined;
      if (!type) {
        throw new Error("agent.type must be built-in or remote-ag-ui");
      }
      return {
        id: requiredString(agent.id, "agent.id"),
        name: requiredString(agent.name, "agent.name"),
        title: requiredString(agent.title, "agent.title"),
        roleDescription: requiredString(
          agent.role_description,
          "agent.role_description",
        ),
        avatarSeed:
          agent.avatar_seed === undefined
            ? undefined
            : requiredString(agent.avatar_seed, "agent.avatar_seed"),
        type,
        configuration:
          type === "built_in"
            ? {
                systemPrompt: requiredString(
                  agent.system_prompt,
                  "agent.system_prompt",
                ),
              }
            : { endpoint: requiredString(agent.endpoint, "agent.endpoint") },
      };
    },
  );
  const agentIds = new Set(agents.map((agent) => agent.id));
  const channels = asList(channelsYaml.channels, "channels.yaml channels").map(
    (value) => {
      const channel = asRecord(value, "channel");
      const permittedAgents = stringArray(
        channel.permitted_agents,
        "channel.permitted_agents",
      );
      for (const agentId of permittedAgents) {
        if (!agentIds.has(agentId)) {
          throw new Error(`channel references unknown agent "${agentId}"`);
        }
      }
      return {
        id: requiredString(channel.id, "channel.id"),
        name: requiredString(channel.name, "channel.name"),
        description: requiredString(channel.description, "channel.description"),
        permittedAgents,
        allowedGroups: stringArray(
          channel.allowed_groups,
          "channel.allowed_groups",
        ),
      };
    },
  );
  const model = asRecord(modelYaml.model, "model");
  if (model.provider !== "openai") {
    throw new Error("model.provider must be openai");
  }
  const sources = asList(knowledgeYaml.sources, "knowledge.yaml sources").map(
    (value) => {
      const source = asRecord(value, "knowledge source");
      if (
        source.type !== "google-drive" &&
        source.type !== "microsoft-onedrive"
      ) {
        throw new Error("knowledge source type is not supported");
      }
      return {
        type: source.type,
        roots: stringArray(source.roots, "source.roots"),
      } as { type: "google-drive" | "microsoft-onedrive"; roots: string[] };
    },
  );

  return {
    tenantId: requiredString(tenant.id, "tenant.id"),
    productName: requiredString(tenant.product_name, "tenant.product_name"),
    stylesheet: skin
      ? requiredString(skin.stylesheet, "skin.stylesheet")
      : null,
    agents,
    channels,
    model: {
      provider: "openai",
      credentialSecretRef: requiredString(
        model.credential_secret_ref,
        "model.credential_secret_ref",
      ),
      defaultModel: requiredString(model.default_model, "model.default_model"),
    },
    knowledgeSources: sources,
    themeCss: files.themeCss,
  };
}

export async function loadTenantPackage(
  sourcePath: string,
): Promise<LoadedTenantPackage> {
  const filenames = [
    "brand.yaml",
    "agents.yaml",
    "channels.yaml",
    "model.yaml",
    "knowledge.yaml",
  ] as const;
  const contents = await Promise.all(
    filenames.map(async (filename) =>
      expandEnvironment(
        await readFile(join(sourcePath, filename), "utf8"),
        filename,
      ),
    ),
  );
  const [brand, agents, channels, model, knowledge] = contents;
  const themeCss = await readFile(join(sourcePath, "theme.css"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const tenantPackage = validateTenantPackage({
    brand,
    agents,
    channels,
    model,
    knowledge,
    themeCss,
  });

  return {
    ...tenantPackage,
    sourcePath,
    checksum: createHash("sha256").update(contents.join("\n")).digest("hex"),
  };
}

export async function synchronizeTenantPackage(
  database: Database,
  tenantPackage: LoadedTenantPackage,
) {
  return database.transaction(async (transaction) => {
    const [deploymentPackage] = await transaction
      .insert(deploymentPackages)
      .values({
        tenantId: tenantPackage.tenantId,
        sourcePath: tenantPackage.sourcePath,
        checksum: tenantPackage.checksum,
      })
      .onConflictDoUpdate({
        target: deploymentPackages.tenantId,
        set: {
          sourcePath: tenantPackage.sourcePath,
          checksum: tenantPackage.checksum,
          loadedAt: new Date(),
        },
      })
      .returning();

    if (!deploymentPackage) {
      throw new Error("Tenant package could not be synchronized");
    }

    for (const agent of tenantPackage.agents) {
      const updatedAt = new Date();
      const [canonicalAgent] = await transaction
        .insert(agentTable)
        .values({
          id: agent.id,
          name: agent.name,
          type: agent.type,
          configuration: agent.configuration,
          packageId: deploymentPackage.id,
        })
        .onConflictDoUpdate({
          target: agentTable.id,
          setWhere: eq(agentTable.packageId, deploymentPackage.id),
          set: {
            name: agent.name,
            type: agent.type,
            configuration: agent.configuration,
            packageId: deploymentPackage.id,
            updatedAt,
          },
        })
        .returning({ id: agentTable.id });

      if (!canonicalAgent) {
        throw new Error(
          `Tenant package agent "${agent.id}" collides with a user-created agent`,
        );
      }

      const [profile] = await transaction
        .insert(agentProfiles)
        .values({
          agentId: canonicalAgent.id,
          ownerUserId: null,
          title: agent.title,
          roleDescription: agent.roleDescription,
          avatarSeed: agent.avatarSeed ?? canonicalAgent.id,
          visibility: "public",
          deletedAt: null,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: agentProfiles.agentId,
          setWhere: isNull(agentProfiles.ownerUserId),
          set: {
            ownerUserId: null,
            title: agent.title,
            roleDescription: agent.roleDescription,
            avatarSeed: agent.avatarSeed ?? canonicalAgent.id,
            visibility: "public",
            deletedAt: null,
            updatedAt,
          },
        })
        .returning({ agentId: agentProfiles.agentId });

      if (!profile) {
        throw new Error(
          `Tenant package agent "${agent.id}" collides with a user-owned profile`,
        );
      }
    }

    for (const channel of tenantPackage.channels) {
      await transaction
        .insert(channelTable)
        .values({
          id: channel.id,
          name: channel.name,
          description: channel.description,
          allowedGroups: channel.allowedGroups,
          packageId: deploymentPackage.id,
        })
        .onConflictDoUpdate({
          target: channelTable.id,
          set: {
            name: channel.name,
            description: channel.description,
            allowedGroups: channel.allowedGroups,
            packageId: deploymentPackage.id,
            updatedAt: new Date(),
          },
        });
      await transaction
        .delete(channelAgents)
        .where(eq(channelAgents.channelId, channel.id));
      if (channel.permittedAgents.length) {
        await transaction.insert(channelAgents).values(
          channel.permittedAgents.map((agentId) => ({
            channelId: channel.id,
            agentId,
          })),
        );
      }
    }

    return deploymentPackage;
  });
}

export function createPackageStatusReader(
  database: Database,
): PackageStatusReader {
  return {
    active: async () => {
      const [tenantPackage] = await database
        .select()
        .from(deploymentPackages)
        .orderBy(desc(deploymentPackages.loadedAt))
        .limit(1);
      return tenantPackage
        ? {
            tenantId: tenantPackage.tenantId,
            sourcePath: tenantPackage.sourcePath,
            checksum: tenantPackage.checksum,
            loadedAt: tenantPackage.loadedAt.toISOString(),
          }
        : null;
    },
  };
}
