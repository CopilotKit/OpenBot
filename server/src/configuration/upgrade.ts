/**
 * Moving an existing deployment's Bot configuration into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds, in its own tables: each Bot's grants, publication,
 * audience and assignments; each person's standing instructions, hidden and pinned Bots, pauses,
 * notification levels, update routing, declined defaults and Team Bot consents; the component
 * catalogue with its functions, withholdings and playground source; the skills and what they declare;
 * and the record of its tenant package. This copies all of it into Intelligence (see `types.ts` for
 * where each lands), then checks Intelligence holds every piece, and only then records the copy as
 * done so it never runs again. The local tables stay, written by nothing, for one release.
 *
 * EVERY RECORD KEEPS ITS TIMES. Each goes across with when it was created and when it last changed, as
 * the local rows say, so "Last changed" reads the same after the upgrade as before it. Intelligence
 * takes those times only on the write that creates a record, which is the only write this copy makes.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. Each record is written by one
 * request under an idempotency key made from what the local rows say, and only where Intelligence has
 * nothing yet: a Bot's access and a person's preferences are written on condition their revision is
 * still 0, a component, a skill and the package only if absent. Two replicas copying the same record
 * send the same request, and Intelligence answers the second with the first's result; a record
 * somebody changed since (another replica finished its copy and served a write) is refused, not
 * overwritten.
 *
 * LOUD ON A MISMATCH. Anything Intelligence refuses, or does not hold afterwards, stops the boot with
 * what is missing named. Rows that name a Bot Intelligence does not have (it was purged) are not
 * copied, and said so: Intelligence removes everything about a Bot when it is purged, and so would
 * these rows have gone with it.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Bot } from "../agents/bot-registry/types";
import type { Database } from "../db/client";
import {
  agentPreferences,
  botLifecycle,
  componentExclusions,
  componentFunctions,
  components,
  defaultOptOuts,
  deploymentPackages,
  intelligenceCopies,
  pluginGrants,
  sandboxedComponents,
  skills,
  skillTools,
  teamBotAssignments,
  teamBotAudience,
  teamBotConsentDefaults,
  teamBotConsents,
  teamBotPublications,
  updateRoutingPreferences,
  userInstructions,
} from "../db/schema";
import { ConfigurationConflictError } from "./client";
import type { BotConfiguration } from "./directory";
import type {
  BotAccessChange,
  ComponentState,
  GrantKind,
  PersonPreferencesChange,
} from "./types";

export const CONFIGURATION_COPY_NAME = "bot-configuration";

export class ConfigurationCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationCopyMismatchError";
  }
}

export type ConfigurationCopyOutcome =
  | { kind: "done-before" }
  | {
      kind: "copied";
      access: number;
      preferences: number;
      components: number;
      skills: number;
      packages: number;
      skippedForPurgedBots: number;
    };

/** One key per record, the same from every replica: made from what is copied, hashed to fit. */
function copyKey(what: string, body: unknown): string {
  return `openbot-upgrade:${what}:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

/** The later of two times, either of which may be missing. */
function later(
  one: Date | null | undefined,
  other: Date | null | undefined,
): Date | undefined {
  if (!one) return other ?? undefined;
  if (!other) return one;
  return one > other ? one : other;
}

/** A grant's kind as it was stored: `mcp`, `skill` or `bot`. */
function grantKind(kind: string): GrantKind {
  if (kind === "mcp" || kind === "skill" || kind === "bot") return kind;
  throw new ConfigurationCopyMismatchError(
    `A grant of kind "${kind}" cannot be copied: Intelligence knows tools, skills and Bots.`,
  );
}

export async function copyLocalConfigurationToIntelligence(
  database: Database,
  configuration: BotConfiguration,
  /** Every Bot Intelligence has, deleted ones included. */
  knownBots: () => Bot[],
): Promise<ConfigurationCopyOutcome> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, CONFIGURATION_COPY_NAME))
    .limit(1);
  if (done) return { kind: "done-before" };

  const client = configuration.client;
  const known = new Set(knownBots().map((bot) => bot.id));
  const skipped: string[] = [];
  const keepBot = (table: string, botId: string) => {
    if (known.has(botId)) return true;
    skipped.push(`${table}:${botId}`);
    return false;
  };
  const refused: string[] = [];
  const refusedBy = (what: string) => (error: unknown) => {
    refused.push(
      `${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  /* --------------------------------------------------------------------------------------------
   * The package record first: its id is what the Bots it manages already name.
   * ------------------------------------------------------------------------------------------ */
  const packageRows = await database.select().from(deploymentPackages);
  for (const row of packageRows) {
    const input = {
      id: row.id,
      source: row.sourcePath,
      checksum: row.checksum,
      appliedAt: row.loadedAt,
      // The row kept one time, when the package was last applied: its last change, and the earliest
      // this deployment knows of it.
      copied: { createdAt: row.loadedAt, updatedAt: row.loadedAt },
    };
    await client.packages
      .create(
        row.tenantId,
        input,
        copyKey("package", { ...input, name: row.tenantId }),
      )
      .catch((error: unknown) => {
        // Already recorded, by another replica's copy or an application since. Its id is checked below.
        if (error instanceof ConfigurationConflictError) return;
        refusedBy(`package ${row.tenantId}`)(error);
      });
  }

  /* --------------------------------------------------------------------------------------------
   * Skills, before the grants that name them.
   * ------------------------------------------------------------------------------------------ */
  const skillRows = await database.select().from(skills);
  const declared = await database.select().from(skillTools);
  for (const row of skillRows) {
    const tools = declared.filter((tool) => tool.skillId === row.id);
    const state = {
      ownerUserId: row.ownerUserId,
      title: row.title,
      summary: row.summary,
      instructions: row.instructions,
      origin: row.origin,
      installedBy: row.installedBy,
      tools: tools.map((tool) => ({
        ref: tool.ref,
        declaredBy: tool.declaredBy,
      })),
      copied: {
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        declaredAt: Object.fromEntries(
          tools.map((tool) => [tool.ref, tool.createdAt]),
        ),
      },
    };
    await client.skills
      .create(row.slug, state, copyKey("skill", { slug: row.slug, ...state }))
      .catch((error: unknown) => {
        // Already there: copied by another replica, or somebody has written it since.
        if (error instanceof ConfigurationConflictError) return;
        refusedBy(`skill ${row.slug}`)(error);
      });
  }

  /* --------------------------------------------------------------------------------------------
   * Each Bot's access: grants, publication and audience, assignments.
   * ------------------------------------------------------------------------------------------ */
  const grants = await database.select().from(pluginGrants);
  const publications = await database.select().from(teamBotPublications);
  const audience = await database.select().from(teamBotAudience);
  const assignments = await database.select().from(teamBotAssignments);
  const accessByBot = new Map<string, BotAccessChange[]>();
  /** When each Bot's access last changed: the latest of its rows' times. */
  const accessChangedAt = new Map<string, Date>();
  const add = (botId: string, change: BotAccessChange, at: Date) => {
    accessByBot.set(botId, [...(accessByBot.get(botId) ?? []), change]);
    accessChangedAt.set(botId, later(accessChangedAt.get(botId), at) ?? at);
  };
  for (const row of grants) {
    if (!keepBot("plugin_grants", row.agentId)) continue;
    add(
      row.agentId,
      {
        op: "grant",
        botId: row.agentId,
        kind: grantKind(row.kind),
        ref: row.ref,
        grantedBy: row.grantedBy,
        grantedAs: row.grantedAs ?? "admin",
        ifGranted: "keep",
        grantedAt: row.grantedAt,
        updatedAt: row.updatedAt,
      },
      row.updatedAt,
    );
  }
  for (const row of publications) {
    if (!keepBot("team_bot_publications", row.agentId)) continue;
    const members =
      row.audience === "people"
        ? audience.filter((member) => member.agentId === row.agentId)
        : [];
    add(
      row.agentId,
      {
        op: "publish",
        botId: row.agentId,
        audience: row.audience,
        members: members.map((member) => ({
          kind: member.kind,
          value: member.value,
        })),
        publishedBy: row.publishedBy,
        publishedAt: row.publishedAt,
      },
      members.reduce<Date>(
        (latest, member) => later(latest, member.createdAt) ?? latest,
        row.publishedAt,
      ),
    );
  }
  for (const row of assignments) {
    if (!keepBot("team_bot_assignments", row.agentId)) continue;
    add(
      row.agentId,
      {
        op: "assign",
        botId: row.agentId,
        group: row.groupName,
        assignedBy: row.assignedBy,
        assignedAt: row.assignedAt,
      },
      row.assignedAt,
    );
  }
  /*
   * Checked against what Intelligence answered, which is what it committed (or, for a second replica
   * sending the same copy, what it committed for the first). A record somebody changed since is
   * refused by its revision and left as they made it.
   */
  const missing: string[] = [];
  const accessCopied = new Set<string>();
  for (const [botId, changes] of accessByBot) {
    const changedAt = accessChangedAt.get(botId);
    const answer = await client.access
      .change(
        changes,
        copyKey("access", { changes, changedAt }),
        { [botId]: 0 },
        changedAt ? { [botId]: changedAt } : undefined,
      )
      .catch((error: unknown) => {
        if (error instanceof ConfigurationConflictError) return null;
        refusedBy(`Bot ${botId}'s access`)(error);
        return null;
      });
    if (!answer) continue;
    accessCopied.add(botId);
    const record = answer.records.find((held) => held.botId === botId);
    for (const change of changes) {
      if (
        change.op === "grant" &&
        !record?.grants.some(
          (grant) => grant.kind === change.kind && grant.ref === change.ref,
        )
      )
        missing.push(`Bot ${botId}'s grant of ${change.kind} ${change.ref}`);
      if (change.op === "publish" && !record?.publication)
        missing.push(`Bot ${botId}'s publication`);
      if (
        change.op === "assign" &&
        !record?.assignments.some((held) => held.group === change.group)
      )
        missing.push(`Bot ${botId}'s assignment to ${change.group}`);
    }
  }

  /* --------------------------------------------------------------------------------------------
   * Each person's preferences.
   * ------------------------------------------------------------------------------------------ */
  const instructions = await database.select().from(userInstructions);
  const shown = await database.select().from(agentPreferences);
  const lifecycle = await database.select().from(botLifecycle);
  const routes = await database.select().from(updateRoutingPreferences);
  const optOuts = await database.select().from(defaultOptOuts);
  const consents = await database.select().from(teamBotConsents);
  const consentDefaults = await database.select().from(teamBotConsentDefaults);
  const preferencesByPerson = new Map<string, PersonPreferencesChange[]>();
  const say = (userId: string, change: PersonPreferencesChange) =>
    preferencesByPerson.set(userId, [
      ...(preferencesByPerson.get(userId) ?? []),
      change,
    ]);
  for (const row of instructions)
    say(row.userId, {
      op: "setInstructions",
      instructions: row.instructions,
      updatedAt: row.updatedAt,
    });
  const perBot = new Map<
    string,
    Extract<PersonPreferencesChange, { op: "setBot" }>
  >();
  const botEntry = (userId: string, botId: string) => {
    const key = JSON.stringify([userId, botId]);
    const entry = perBot.get(key) ?? {
      op: "setBot" as const,
      botId,
    };
    perBot.set(key, entry);
    return entry;
  };
  for (const row of shown) {
    if (!keepBot("agent_preferences", row.agentId)) continue;
    const entry = botEntry(row.userId, row.agentId);
    entry.hiddenAt = row.hiddenAt;
    entry.pinnedAt = row.pinnedAt;
    // The row kept no time of its own: hiding or pinning is the last thing that changed it.
    entry.updatedAt = later(later(entry.updatedAt, row.hiddenAt), row.pinnedAt);
  }
  for (const row of lifecycle) {
    if (!keepBot("bot_lifecycle", row.agentId)) continue;
    const entry = botEntry(row.ownerUserId, row.agentId);
    entry.pausedAt = row.pausedAt;
    entry.notify = row.notify;
    entry.updatedAt = later(entry.updatedAt, row.updatedAt);
  }
  for (const [key, entry] of perBot) {
    const [userId] = JSON.parse(key) as [string, string];
    say(userId, entry);
  }
  for (const row of routes)
    say(row.ownerUserId, {
      op: "setRoute",
      kind: row.kind,
      transports: row.transports,
      updatedAt: row.updatedAt,
    });
  for (const row of optOuts) {
    if (!keepBot("default_opt_outs", row.agentId)) continue;
    say(row.ownerUserId, {
      op: "optOut",
      botId: row.agentId,
      feature: row.feature,
      scope: row.scope,
      createdAt: row.createdAt,
    });
  }
  for (const row of consents) {
    if (!keepBot("team_bot_consents", row.agentId)) continue;
    say(row.userId, {
      op: "setConsent",
      botId: row.agentId,
      serverId: row.serverId,
      decision: row.decision,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of consentDefaults)
    say(row.userId, {
      op: "setConsentDefault",
      serverId: row.serverId,
      allowed: true,
      updatedAt: row.updatedAt,
    });
  const preferencesCopied = new Set<string>();
  for (const [userId, changes] of preferencesByPerson) {
    // When the person's record last changed: the latest of the times its settings kept.
    const changedAt = changes.reduce<Date | undefined>(
      (latest, change) =>
        later(
          latest,
          change.op === "optOut"
            ? change.createdAt
            : "updatedAt" in change
              ? change.updatedAt
              : undefined,
        ),
      undefined,
    );
    const answer = await client.preferences
      .change(
        userId,
        changes,
        copyKey("preferences", { userId, changes, changedAt }),
        0,
        changedAt,
      )
      .catch((error: unknown) => {
        if (error instanceof ConfigurationConflictError) return null;
        refusedBy(`${userId}'s preferences`)(error);
        return null;
      });
    if (!answer) continue;
    preferencesCopied.add(userId);
    const record = answer.preferences;
    const counts = {
      bots: changes.filter((change) => change.op === "setBot").length,
      routes: changes.filter((change) => change.op === "setRoute").length,
      optOuts: changes.filter((change) => change.op === "optOut").length,
      consents: changes.filter((change) => change.op === "setConsent").length,
      defaults: changes.filter((change) => change.op === "setConsentDefault")
        .length,
    };
    if (
      record.bots.length < counts.bots ||
      record.routes.length < counts.routes ||
      record.optOuts.length < counts.optOuts ||
      record.consents.length < counts.consents ||
      record.consentDefaults.length < counts.defaults ||
      (changes.some((change) => change.op === "setInstructions") &&
        record.instructions === null)
    )
      missing.push(`part of ${userId}'s preferences`);
  }

  /* --------------------------------------------------------------------------------------------
   * The component catalogue.
   * ------------------------------------------------------------------------------------------ */
  const componentRows = await database.select().from(components);
  const functionRows = await database.select().from(componentFunctions);
  const exclusionRows = await database.select().from(componentExclusions);
  const sourceRows = await database.select().from(sandboxedComponents);
  for (const row of componentRows) {
    const source = sourceRows.find((candidate) => candidate.name === row.name);
    const state: ComponentState = {
      title: row.title,
      kind: row.kind,
      draftDescription: row.draftDescription,
      publishedDescription: row.publishedDescription,
      published: row.published,
      publishedAt: row.publishedAt,
      updatedBy: row.updatedBy,
      functions: functionRows
        .filter((fn) => fn.componentName === row.name)
        .map((fn) => ({
          name: fn.functionName,
          grantedBy: fn.grantedBy,
          grantedAt: fn.grantedAt,
        })),
      withheldFrom: exclusionRows
        .filter(
          (exclusion) =>
            exclusion.componentName === row.name &&
            keepBot("component_exclusions", exclusion.agentId),
        )
        .map((exclusion) => ({
          botId: exclusion.agentId,
          withheldBy: exclusion.withheldBy,
          withheldAt: exclusion.withheldAt,
        })),
      source: source
        ? {
            draft: {
              description: source.draftDescription,
              html: source.draftHtml,
              css: source.draftCss,
              jsFunctions: source.draftJsFunctions,
              argumentSchema: source.draftArgumentSchema as Record<
                string,
                unknown
              >,
            },
            published:
              source.publishedHtml === null
                ? null
                : {
                    description: source.publishedDescription ?? "",
                    html: source.publishedHtml,
                    css: source.publishedCss ?? "",
                    jsFunctions: source.publishedJsFunctions ?? "",
                    argumentSchema: (source.publishedArgumentSchema ??
                      {}) as Record<string, unknown>,
                  },
            sampleArguments: source.sampleArguments as Record<string, unknown>,
            revision: source.revision,
            isPublished: source.published,
            publishedAt: source.publishedAt,
            authoredBy: source.authoredBy,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
          }
        : null,
      copied: {
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        source: source
          ? { createdAt: source.createdAt, updatedAt: source.updatedAt }
          : null,
      },
    };
    await client.components
      .create(row.name, state, copyKey("component", { name: row.name, state }))
      .catch((error: unknown) => {
        if (error instanceof ConfigurationConflictError) return;
        refusedBy(`component ${row.name}`)(error);
      });
  }

  const total =
    packageRows.length +
    skillRows.length +
    accessByBot.size +
    preferencesByPerson.size +
    componentRows.length;
  if (refused.length > 0) {
    throw new ConfigurationCopyMismatchError(
      `Intelligence refused ${refused.length} of this deployment's ${total} configuration records, so they were not moved and this server will not start without them:\n${refused.join("\n")}`,
    );
  }

  /* --------------------------------------------------------------------------------------------
   * Verify: every record copied is in Intelligence now.
   * ------------------------------------------------------------------------------------------ */
  const recordedPackages = new Map(
    (await client.packages.all()).map((record) => [record.name, record]),
  );
  for (const row of packageRows) {
    const record = recordedPackages.get(row.tenantId);
    if (!record) missing.push(`package ${row.tenantId}`);
    else if (record.id !== row.id)
      missing.push(
        `package ${row.tenantId} has id ${record.id} in Intelligence, not ${row.id}`,
      );
  }
  const presentSkills = new Set(
    (await client.skills.all()).map((skill) => skill.slug),
  );
  for (const row of skillRows)
    if (!presentSkills.has(row.slug)) missing.push(`skill ${row.slug}`);
  const presentAccess = new Set(
    (await client.access.all()).map((record) => record.botId),
  );
  for (const botId of accessCopied)
    if (!presentAccess.has(botId)) missing.push(`Bot ${botId}'s access`);
  const presentPreferences = new Set(
    (await client.preferences.all()).map((record) => record.userId),
  );
  for (const userId of preferencesCopied)
    if (!presentPreferences.has(userId))
      missing.push(`${userId}'s preferences`);
  const presentComponents = new Set(
    (await client.components.all()).map((component) => component.name),
  );
  for (const row of componentRows)
    if (!presentComponents.has(row.name)) missing.push(`component ${row.name}`);
  if (missing.length > 0) {
    throw new ConfigurationCopyMismatchError(
      `${total} configuration records were to be copied into Intelligence and ${missing.length} pieces are not there: ${missing.join(", ")}`,
    );
  }

  if (skipped.length > 0) {
    console.warn(
      JSON.stringify({
        type: "bot-configuration-copy-skipped-purged-bots",
        note: "These rows name Bots Intelligence no longer has; Intelligence would have removed them with the Bot, so they are not copied.",
        rows: skipped,
      }),
    );
  }
  await database
    .insert(intelligenceCopies)
    .values({ name: CONFIGURATION_COPY_NAME, copied: total })
    .onConflictDoNothing();
  console.info(
    JSON.stringify({
      type: "bot-configuration-copied-to-intelligence",
      packages: packageRows.length,
      skills: skillRows.length,
      access: accessByBot.size,
      preferences: preferencesByPerson.size,
      components: componentRows.length,
      skippedForPurgedBots: skipped.length,
    }),
  );
  await configuration.resync();
  return {
    kind: "copied",
    access: accessByBot.size,
    preferences: preferencesByPerson.size,
    components: componentRows.length,
    skills: skillRows.length,
    packages: packageRows.length,
    skippedForPurgedBots: skipped.length,
  };
}
