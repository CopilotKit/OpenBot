/**
 * The enterprise controls, as stored.
 *
 * The switches an administrator sets (capabilities, enterprise settings, network rules) live in
 * Intelligence's organization policy (`policy/`), held in memory on every server and kept current by
 * Intelligence's change announcements, so every server enforces the same rows the moment one of them
 * saves a change. A switch that applies on one replica out of N reads as working while it does not.
 *
 * What stays here is this deployment's own: who is an administrator and in which groups (identity),
 * and the records kept about what Bots did (Action Recording, model usage).
 */
import { desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { people } from "../people/directory/directory";
import { actionRecords, modelUsage, users } from "../db/schema";
import { policy } from "../policy/cache";
import type { PolicySettings, PolicySettingsPatch } from "../policy/types";
import type { CapabilityRow, Member } from "./capabilities";

export type EnterpriseSettings = {
  /** Only a registered enterprise identity provider may sign anybody in. */
  ssoRequired: boolean;
  /** Record scrubbed shell commands Bots run, kept 90 days. */
  actionRecording: boolean;
  /** Stop computers nobody has used for this many days. 0 turns it off. */
  inactiveComputerDays: number;
  modelAllowlist: { enabled: boolean; models: string[] };
  mcpAllowlist: { enabled: boolean; servers: string[] };
  /**
   * People may open the Skills learned from their own recordings to every Bot (Settings, Learning). Off by default:
   * an opened Skill puts one person's recorded and narrated text in front of everybody's Bots, so an administrator
   * decides whether this deployment's people trust each other's recordings that far. Off, nobody can open one and a
   * Skill opened while it was on reaches no other person's Bot (learning/runtime.ts).
   */
  skillSharing: boolean;
  /**
   * How many check-ins each Bot may run for one person in any 24 hours (Admin, Check-ins). Skipped
   * check-ins do not count; one past it is skipped as `capped` before any model call. 24 is hourly,
   * the most often a Bot checks on its own, so the default only stops Run now pressed all day.
   */
  proactiveDailyRuns: number;
};

export const DEFAULT_ENTERPRISE_SETTINGS: EnterpriseSettings = {
  ssoRequired: false,
  actionRecording: false,
  inactiveComputerDays: 30,
  modelAllowlist: { enabled: false, models: [] },
  mcpAllowlist: { enabled: false, servers: [] },
  skillSharing: false,
  proactiveDailyRuns: 24,
};

/** OpenBot's settings, read from Intelligence's. The one field with another name is the computers'. */
export function enterpriseSettingsFrom(
  stored: PolicySettings,
): EnterpriseSettings {
  return {
    ssoRequired: stored.ssoRequired,
    actionRecording: stored.actionRecording,
    inactiveComputerDays: stored.inactiveEnvironmentDays,
    modelAllowlist: {
      enabled: stored.modelAllowlist.enabled,
      models: [...stored.modelAllowlist.models],
    },
    mcpAllowlist: {
      enabled: stored.mcpAllowlist.enabled,
      servers: [...stored.mcpAllowlist.servers],
    },
    skillSharing: stored.skillSharing,
    proactiveDailyRuns: stored.proactiveDailyRuns,
  };
}

/** One OpenBot setting as the change Intelligence takes. */
export function settingPatch<K extends keyof EnterpriseSettings>(
  key: K,
  value: EnterpriseSettings[K],
): PolicySettingsPatch {
  if (key === "inactiveComputerDays")
    return { inactiveEnvironmentDays: value as number };
  return { [key]: value } as PolicySettingsPatch;
}

export type NetworkPolicyRow = {
  scopeKind: "organization" | "group";
  scopeId: string;
  mode: "allow_all" | "defaults_plus_allowlist" | "allowlist_only";
  rules: unknown[];
  locked: boolean;
  updatedBy: string | null;
  updatedAt: string;
};

export type ModelUsageSummary = {
  model: string;
  source: string;
  runs: number;
  refused: number;
  people: number;
  lastUsedAt: string;
};

/**
 * The policy, refusing while it has never been read: an unread policy is not an empty one, and every
 * caller here fails closed on an error, as it did when the database could not be read.
 */
function loadedPolicy() {
  const held = policy();
  if (!held.loaded())
    throw new Error(
      "This server has not read the organization policy from Intelligence yet.",
    );
  return held;
}

export function createEnterpriseStore(database: Database) {
  return {
    /** From memory: the policy every server holds and Intelligence keeps current. */
    async settings(): Promise<EnterpriseSettings> {
      return enterpriseSettingsFrom(loadedPolicy().settings());
    },

    async setSetting<K extends keyof EnterpriseSettings>(
      key: K,
      value: EnterpriseSettings[K],
      by: string,
    ): Promise<void> {
      await policy().patchSettings({
        ...settingPatch(key, value),
        updatedBy: by,
      });
    },

    async capabilityRows(): Promise<CapabilityRow[]> {
      return loadedPolicy()
        .capabilityRules()
        .map((rule) => ({
          scopeKind: rule.scopeKind,
          scopeId: rule.scopeId,
          capability: rule.capability,
          allowed: rule.allowed,
        }));
    },

    /** `allowed: null` removes the row, returning that scope to whatever sits beneath it. */
    async setCapability(
      row: Omit<CapabilityRow, "allowed"> & { allowed: boolean | null },
      by: string,
    ): Promise<void> {
      const key = {
        scopeKind: row.scopeKind,
        scopeId: row.scopeKind === "organization" ? "" : row.scopeId,
        capability: row.capability,
      };
      if (row.allowed === null) await policy().deleteCapabilityRule(key);
      else await policy().putCapabilityRule(key, row.allowed, by);
    },

    /** One person as the capability rules see them. Unknown means a plain user in no group. */
    async member(userId: string): Promise<Member> {
      // The role and groups on the person's row: this deployment's copy of the directory's person.
      const person = await database
        .select({ role: users.role, groups: users.groups })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return {
        role: person[0]?.role === "admin" ? "admin" : "user",
        groups: person[0]?.groups ?? [],
      };
    },

    async adminIds(): Promise<Set<string>> {
      const rows = await database
        .select({ userId: users.id })
        .from(users)
        .where(eq(users.role, "admin"));
      return new Set(rows.map((row) => row.userId));
    },

    /** Members of the named groups, for the in-memory snapshot. Only groups that carry a row. */
    async groupMembers(
      groups: readonly string[],
    ): Promise<Map<string, string[]>> {
      if (groups.length === 0) return new Map();
      const rows = await database
        .select({ id: users.id, groups: users.groups })
        .from(users)
        .where(
          sql`${users.groups} && ARRAY[${sql.join(
            groups.map((group) => sql`${group}`),
            sql`, `,
          )}]::text[]`,
        );
      return new Map(rows.map((row) => [row.id, row.groups]));
    },

    /** Every group this deployment knows: written onto people by SCIM, or provisioned as a group. */
    async groups(): Promise<string[]> {
      const fromPeople = await database.execute(
        sql`select distinct unnest(${users.groups}) as name from ${users} order by 1`,
      );
      // Groups the company's directory provisioned, members or not: Intelligence's directory holds them.
      const provisioned = await people().client.groupNames();
      const names = new Set<string>();
      for (const row of fromPeople as unknown as { name: string }[]) {
        if (row.name) names.add(row.name);
      }
      for (const name of provisioned) names.add(name);
      return [...names].sort((a, b) => a.localeCompare(b));
    },

    async networkPolicies(): Promise<NetworkPolicyRow[]> {
      return loadedPolicy()
        .networkRules()
        .map((row) => ({
          scopeKind: row.scopeKind,
          scopeId: row.scopeId,
          mode: row.mode,
          rules: [...row.rules],
          locked: row.locked,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        }));
    },

    async setNetworkPolicy(
      row: Omit<NetworkPolicyRow, "updatedBy" | "updatedAt">,
      by: string,
    ): Promise<void> {
      await policy().putNetworkRule(
        {
          scopeKind: row.scopeKind,
          scopeId: row.scopeKind === "organization" ? "" : row.scopeId,
        },
        {
          mode: row.mode,
          rules: row.rules,
          locked: row.scopeKind === "organization" ? row.locked : false,
        },
        by,
      );
    },

    async removeNetworkPolicy(
      scopeKind: NetworkPolicyRow["scopeKind"],
      scopeId: string,
    ): Promise<boolean> {
      return policy().deleteNetworkRule({
        scopeKind,
        scopeId: scopeKind === "organization" ? "" : scopeId,
      });
    },

    async recordAction(input: {
      surface: "cloud" | "local";
      botId?: string | null;
      actorUserId?: string | null;
      toolName: string;
      command: string;
      outcome: string;
    }): Promise<void> {
      await database.insert(actionRecords).values({
        surface: input.surface,
        botId: input.botId ?? null,
        actorUserId: input.actorUserId ?? null,
        toolName: input.toolName,
        command: input.command,
        outcome: input.outcome,
      });
    },

    async actions(limit = 100) {
      const rows = await database
        .select()
        .from(actionRecords)
        .orderBy(desc(actionRecords.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500));
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async purgeActions(olderThan: Date): Promise<number> {
      const removed = await database
        .delete(actionRecords)
        .where(lt(actionRecords.createdAt, olderThan))
        .returning({ id: actionRecords.id });
      return removed.length;
    },

    async recordModelUsage(input: {
      userId?: string | null;
      agentId: string;
      threadId?: string | null;
      runId?: string | null;
      model: string;
      source: "configured" | "observed" | "unknown";
      allowed: boolean;
    }): Promise<void> {
      await database.insert(modelUsage).values({
        userId: input.userId ?? null,
        agentId: input.agentId,
        threadId: input.threadId ?? null,
        runId: input.runId ?? null,
        model: input.model,
        source: input.source,
        allowed: input.allowed,
      });
    },

    async modelUsageSummary(sinceDays: number): Promise<ModelUsageSummary[]> {
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      const rows = await database
        .select({
          model: modelUsage.model,
          source: modelUsage.source,
          runs: sql<number>`count(*)::int`,
          refused: sql<number>`count(*) filter (where not ${modelUsage.allowed})::int`,
          people: sql<number>`count(distinct ${modelUsage.userId})::int`,
          lastUsedAt: sql<string>`max(${modelUsage.createdAt})`,
        })
        .from(modelUsage)
        .where(gt(modelUsage.createdAt, since))
        .groupBy(modelUsage.model, modelUsage.source)
        .orderBy(sql`count(*) desc`);
      return rows.map((row) => ({
        ...row,
        lastUsedAt: new Date(row.lastUsedAt).toISOString(),
      }));
    },

    async recentModelUsage(limit = 50) {
      const rows = await database
        .select()
        .from(modelUsage)
        .orderBy(desc(modelUsage.createdAt))
        .limit(Math.min(Math.max(limit, 1), 500));
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
      }));
    },

    async usersById(ids: string[]) {
      if (ids.length === 0) return new Map<string, string>();
      const rows = await database
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, ids));
      return new Map(rows.map((row) => [row.id, row.email]));
    },
  };
}

export type EnterpriseStore = ReturnType<typeof createEnterpriseStore>;
