import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { parse } from "yaml";
import { DEPLOYMENT_ROUTES } from "./computer/deployment-routes";
import type { Database } from "./db/client";
import {
  agentProfiles,
  agents as agentTable,
  channelAgents,
  channels as channelTable,
  deploymentPackages,
  pluginGrants,
  skills as skillTable,
  skillTools,
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
  /**
   * Optional, unlike the five above, because packages written before skills shipped do not have it
   * and must keep loading. Absent means a deployment with no skills of its own, which is what every
   * package had until now.
   */
  skills?: string;
  themeCss: string;
};

/**
 * A skill the package ships, and the tools it says it needs.
 *
 * WHY THE PACKAGE AND NOT A SCREEN. Selection narrows a Bot's tools to the ones the matching skills
 * declare, so with no skills there is nothing to match and the narrowing never switches on. Every
 * deployment starts with no skills, so left to a screen the feature is off on every clone until
 * somebody sits down and maps tools to skills by hand — in each deployment, again after each new
 * connector. That is curation work a product with a services team can absorb and a template cannot.
 *
 * So the declaration ships with the thing that declares it. A package skill names the tools it needs
 * the way it names its own instructions, and connecting the connector is the only step left.
 */
export type TenantSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  /**
   * `<serverId>/<toolName>` refs, and deliberately NOT checked against the tools this deployment has
   * seen.
   *
   * A package is written before anybody connects anything, so it names tools for connectors that may
   * not be added yet and may never be. An unknown ref has to sit there inert — the run-time
   * intersection drops it, which is why `skill_tools` carries no foreign key. Refusing to load the
   * package over one would mean a template could only ship skills for connectors it could guarantee,
   * which is none of them.
   */
  tools: string[];
};

/**
 * The mark a grant this package made carries, in `plugin_grants.granted_by`.
 *
 * Every other value there is the id of the person who pressed the button, so this cannot collide
 * with one, and it is what lets a redeploy take back only what the package gave.
 */
const PACKAGE_GRANT = "tenant-package";

type TenantAgent = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed?: string;
  type: "built_in" | "remote_ag_ui";
  configuration: Record<string, unknown>;
  /**
   * The package skills this coworker is given, by slug.
   *
   * SAFE TO SEED, unlike an MCP grant, and for a reason worth stating rather than assuming. A skill
   * is an instruction and confers nothing: what a Bot may call is its grants, and the run-time offer
   * is always the intersection of the two, so a skill naming a tool its Bot does not hold loads
   * nothing. Seeding an MCP grant would be the opposite, since those reach a person's own account.
   *
   * Without this a fork boots with the skills its package ships attached to no Bot at all, and the
   * per-run narrowing that skills exist for is switched off until somebody opens the Skills page and
   * pairs them by hand. The pairing is the package's to state: it wrote both files.
   */
  skills: string[];
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
  /** What `skills.yaml` ships, or empty for a package that has none. */
  skills: TenantSkill[];
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
};

/**
 * What the browser is told about this deployment at build time.
 *
 * Brand only. Which identity providers are configured used to live here too, and could not: the
 * image is built once, without any deployment's environment, so a deployment that configured Entra
 * got a sign-in screen built on a machine that had never heard of it. That answer now comes from
 * `/api/capabilities` at runtime, where the process that knows can answer.
 */
export function createApplicationConfiguration(
  tenantPackage: TenantPackage,
): ApplicationConfiguration {
  return {
    brand: {
      tenantId: tenantPackage.tenantId,
      productName: tenantPackage.productName,
    },
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
  // Absent is a package with no skills, not a malformed one. A file that is present and wrong is
  // still refused, the way every other file here is.
  const skillsYaml = files.skills?.trim()
    ? yaml(files.skills, "skills.yaml")
    : {};
  const tenant = asRecord(brand.tenant, "brand.tenant");
  const skin =
    brand.skin === undefined ? undefined : asRecord(brand.skin, "brand.skin");
  const omittedAgentIds = new Set<string>();
  const agents = asList(agentsYaml.agents, "agents.yaml agents").flatMap(
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
      const id = requiredString(agent.id, "agent.id");
      /*
       * A Bot may not be named after a deployment route.
       *
       * The computer router's bot-access guard steps aside for those names, and a request cannot
       * tell a Bot called `policy` from `/policy` itself, so such a Bot would be served to anybody
       * who can sign in without the guard ever being asked. A package id is the only way a Bot gets
       * a chosen id, everything created through the API being `agent_<uuid>`, so refusing it here
       * closes it rather than moving it.
       */
      if (DEPLOYMENT_ROUTES.has(id)) {
        throw new Error(
          `agent.id "${id}" is reserved for a deployment route and cannot name a Bot`,
        );
      }
      if (type === "remote_ag_ui") {
        const endpoint =
          typeof agent.endpoint === "string" ? agent.endpoint.trim() : "";
        if (!endpoint) {
          omittedAgentIds.add(id);
          return [];
        }
      }
      return [
        {
          id,
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
              : {
                  endpoint: requiredString(agent.endpoint, "agent.endpoint"),
                },
          skills:
            agent.skills === undefined || agent.skills === null
              ? []
              : stringArray(agent.skills, "agent.skills"),
        },
      ];
    },
  );
  const agentIds = new Set(agents.map((agent) => agent.id));
  const packageSkills = parseTenantSkills(skillsYaml.skills);
  const skillSlugs = new Set(packageSkills.map((skill) => skill.slug));
  for (const agent of agents) {
    for (const slug of agent.skills) {
      /*
       * Checked against this package's own skills and nothing else, and refused rather than dropped.
       *
       * The two files ship together, so a slug matching none of them is a typo, and a typo that
       * silently attaches no skill is the kind nobody finds: the Bot simply never narrows and the
       * deployment looks like it is working. Deliberately not checked against skills already in the
       * deployment, because those include any a person wrote, and a package must not be able to
       * hand its Bots somebody else's instructions by naming their slug.
       */
      if (!skillSlugs.has(slug)) {
        throw new Error(
          `agent "${agent.id}" names skill "${slug}", which this package does not ship`,
        );
      }
    }
  }
  const channels = asList(channelsYaml.channels, "channels.yaml channels").map(
    (value) => {
      const channel = asRecord(value, "channel");
      const permittedAgents = stringArray(
        channel.permitted_agents,
        "channel.permitted_agents",
      ).filter((agentId) => !omittedAgentIds.has(agentId));
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
    skills: packageSkills,
    themeCss: files.themeCss,
  };
}

/**
 * The skills a package ships, as rows a deployment can be seeded with.
 *
 * A slug is what a person types after `/`, so the shape the API enforces is enforced here too: a
 * package shipping `Find A Document` would create a command nobody can type.
 */
function parseTenantSkills(value: unknown): TenantSkill[] {
  if (value === undefined || value === null) return [];
  return asList(value, "skills.yaml skills").map((entry) => {
    const skill = asRecord(entry, "skill");
    const slug = requiredString(skill.slug, "skill.slug");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      throw new Error(
        `skill.slug "${slug}" must be lowercase letters, digits and hyphens, and start with a letter or digit`,
      );
    }
    const tools =
      skill.tools === undefined || skill.tools === null
        ? []
        : stringArray(skill.tools, "skill.tools").map((ref) => {
            /*
             * `<serverId>/<toolName>` is the one shape a grant and a declaration share, so a ref in
             * any other shape can never match a grant and would sit in the table doing nothing.
             * Refused here rather than left to be discovered as a skill that quietly loads no tools.
             */
            if (!/^[^/\s]+\/[^/\s]+$/.test(ref)) {
              throw new Error(
                `skill.tools entry "${ref}" must be in the form serverId/toolName`,
              );
            }
            return ref;
          });
    return {
      slug,
      title: requiredString(skill.title, "skill.title"),
      summary: requiredString(skill.summary, "skill.summary"),
      instructions: requiredString(skill.instructions, "skill.instructions"),
      tools,
    };
  });
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
  /*
   * Optional, like `theme.css` and unlike the five required files.
   *
   * Every package written before skills shipped has no `skills.yaml`, and those packages have to go
   * on loading. Missing is a deployment with no skills of its own; present and malformed is still
   * refused.
   */
  const skills = await readFile(join(sourcePath, "skills.yaml"), "utf8")
    .then((file) => expandEnvironment(file, "skills.yaml"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  const tenantPackage = validateTenantPackage({
    brand,
    agents,
    channels,
    model,
    knowledge,
    skills,
    themeCss,
  });

  return {
    ...tenantPackage,
    sourcePath,
    // `skills` is in the checksum, so editing it is a package change like any other and the
    // deployment notices on the next boot rather than reporting itself unchanged.
    checksum: createHash("sha256")
      .update([...contents, skills].join("\n"))
      .digest("hex"),
  };
}

export async function synchronizeTenantPackage(
  database: Database,
  tenantPackage: LoadedTenantPackage,
) {
  return database.transaction(async (transaction) => {
    /*
     * A Bot already holding one of those names, from a package that declared it before this was
     * refused. Validation covers the file, and nothing here removes a canonical agent when a package
     * stops declaring one, so correcting the YAML leaves the row and the router goes on stepping
     * aside for its path. Checked inside the transaction so a deployment in that state does not come
     * up half-synchronised, and refused rather than renamed because whose Bot that is, and what
     * points at it, is not this function's to decide.
     */
    const reserved = await transaction
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(inArray(agentTable.id, [...DEPLOYMENT_ROUTES]));
    if (reserved.length > 0) {
      const names = reserved.map((agent) => `"${agent.id}"`).join(", ");
      throw new Error(
        `Bot ${names} is reserved for a deployment route and cannot exist; rename or remove it before this deployment can start`,
      );
    }

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

    /*
     * The skills the package ships, and what each one declares it needs.
     *
     * A DEPLOYMENT SKILL, not a person's: `owner_user_id` is null, so everybody sees it in their `/`
     * menu, the same as one an administrator wrote. `origin` says where it came from, which is the
     * only thing distinguishing it from an administrator's own on the Skills page.
     *
     * The declared refs are NOT checked against `mcp_tools` here, unlike the API path, which refuses
     * a tool this deployment has never seen. A package is written before anybody connects anything,
     * so it necessarily names tools for connectors that may not be added yet — and that is the point
     * of shipping it. An unknown ref sits inert until its connector exists, because the run-time
     * intersection only ever offers what the Bot was granted.
     */
    /*
     * Which coworkers asked for each skill, so the loop below can pair them as it seeds.
     *
     * Written wholesale under one marker: every grant this package made last time is removed first,
     * so a package that stops giving a Bot a skill takes it back. Only its own, though. A grant an
     * administrator made through the Skills page carries their id and survives, because retracting
     * somebody's deliberate decision is not something a redeploy should do quietly.
     */
    const wantedBy = new Map<string, string[]>();
    for (const agent of tenantPackage.agents) {
      for (const slug of agent.skills) {
        wantedBy.set(slug, [...(wantedBy.get(slug) ?? []), agent.id]);
      }
    }
    await transaction
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "skill"),
          eq(pluginGrants.grantedBy, PACKAGE_GRANT),
        ),
      );

    for (const skill of tenantPackage.skills) {
      const [seeded] = await transaction
        .insert(skillTable)
        .values({
          id: skill.slug,
          ownerUserId: null,
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary,
          instructions: skill.instructions,
          origin: "catalogue",
          installedBy: null,
        })
        .onConflictDoUpdate({
          target: skillTable.slug,
          /*
           * Only ever a package skill. The `/` namespace is shared and first to take a name keeps
           * it, so a person who wrote their own skill under this slug keeps theirs and the package
           * loses one — rather than the package silently replacing something somebody wrote.
           *
           * A collision is skipped rather than thrown, unlike the agent case above. Anybody signed
           * in may write a skill, so throwing would let one person stop the deployment booting by
           * choosing a name.
           */
          setWhere: eq(skillTable.origin, "catalogue"),
          set: {
            title: skill.title,
            summary: skill.summary,
            instructions: skill.instructions,
            updatedAt: new Date(),
          },
        })
        .returning({ id: skillTable.id });

      if (!seeded) {
        console.warn(
          JSON.stringify({
            type: "package-skill-skipped",
            slug: skill.slug,
            reason:
              "a skill written in this deployment already answers to that name, and it keeps it",
          }),
        );
        continue;
      }

      // Replaced wholesale, so a tool the package stopped declaring stops being declared. The same
      // rule the API path applies, and the reason the table is keyed on (skill, ref).
      await transaction
        .delete(skillTools)
        .where(eq(skillTools.skillId, seeded.id));
      if (skill.tools.length > 0) {
        await transaction.insert(skillTools).values(
          skill.tools.map((ref) => ({
            skillId: seeded.id,
            ref,
            declaredBy: null,
          })),
        );
      }

      /*
       * Paired only with the skill this package actually owns.
       *
       * Inside this branch on purpose: the seed above skips a slug a person had already taken, and
       * granting there would hand the package's Bots an instruction somebody else wrote under a name
       * the package expected to be its own. Skipped, it keeps the existing warning and grants
       * nothing, which is the safe half of the same decision.
       */
      const agentIds = wantedBy.get(skill.slug) ?? [];
      if (agentIds.length > 0) {
        await transaction
          .insert(pluginGrants)
          .values(
            agentIds.map((agentId) => ({
              kind: "skill",
              ref: seeded.id,
              agentId,
              grantedBy: PACKAGE_GRANT,
            })),
          )
          .onConflictDoUpdate({
            target: [pluginGrants.kind, pluginGrants.ref, pluginGrants.agentId],
            // An administrator who granted this by hand keeps the credit; the package only ever
            // adds what was missing, and the delete above already took back what it owned.
            set: { updatedAt: new Date() },
          });
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
