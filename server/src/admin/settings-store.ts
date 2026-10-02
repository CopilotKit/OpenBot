/**
 * The enterprise controls, as stored.
 *
 * Every write goes in a transaction with a `pg_notify` on {@link ENTERPRISE_TOPIC}, delivered on
 * commit, so every API server re-reads the same rows the moment one of them saves a change. Same
 * shape as the computer boundary in `computer/policy-store.ts`, and for the same reason: a switch
 * that applies on one replica out of N reads as working while it does not.
 */
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  actionRecords,
  capabilitySettings,
  enterpriseSettings,
  modelUsage,
  networkPolicies,
  scimGroups,
  userRoles,
  users,
} from "../db/schema";
import type { CapabilityRow, Member } from "./capabilities";

export const ENTERPRISE_TOPIC = "enterprise_settings_changed";

export type EnterpriseSettings = {
  /** Only a registered enterprise identity provider may sign anybody in. */
  ssoRequired: boolean;
  /** Record scrubbed shell commands Bots run, kept 90 days. */
  actionRecording: boolean;
  /** Stop computers nobody has used for this many days. 0 turns it off. */
  inactiveComputerDays: number;
  modelAllowlist: { enabled: boolean; models: string[] };
  mcpAllowlist: { enabled: boolean; servers: string[] };
};

export const DEFAULT_ENTERPRISE_SETTINGS: EnterpriseSettings = {
  ssoRequired: false,
  actionRecording: false,
  inactiveComputerDays: 30,
  modelAllowlist: { enabled: false, models: [] },
  mcpAllowlist: { enabled: false, servers: [] },
};

const SETTING_KEYS = {
  ssoRequired: "sso_required",
  actionRecording: "action_recording",
  inactiveComputerDays: "inactive_computer_days",
  modelAllowlist: "model_allowlist",
  mcpAllowlist: "mcp_allowlist",
} as const satisfies Record<keyof EnterpriseSettings, string>;

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

/** Stored as `{ value }` so every key is a JSON object, which the jsonb column type requires. */
function unwrap<K extends keyof EnterpriseSettings>(
  key: K,
  stored: Record<string, unknown> | undefined,
): EnterpriseSettings[K] {
  const fallback = DEFAULT_ENTERPRISE_SETTINGS[key];
  const value = stored?.value;
  if (value === undefined) return fallback;
  if (typeof fallback === "boolean")
    return (
      typeof value === "boolean" ? value : fallback
    ) as EnterpriseSettings[K];
  if (typeof fallback === "number") {
    return (
      typeof value === "number" && Number.isInteger(value) && value >= 0
        ? value
        : fallback
    ) as EnterpriseSettings[K];
  }
  const list = value as {
    enabled?: unknown;
    models?: unknown;
    servers?: unknown;
  };
  const items = (
    key === "modelAllowlist" ? list.models : list.servers
  ) as unknown;
  return {
    enabled: list.enabled === true,
    [key === "modelAllowlist" ? "models" : "servers"]: Array.isArray(items)
      ? items.filter((item): item is string => typeof item === "string")
      : [],
  } as EnterpriseSettings[K];
}

async function announce(database: Pick<Database, "execute">) {
  await database.execute(sql`select pg_notify(${ENTERPRISE_TOPIC}, '')`);
}

export function createEnterpriseStore(database: Database) {
  return {
    async settings(): Promise<EnterpriseSettings> {
      const rows = await database.select().from(enterpriseSettings);
      const byKey = new Map(rows.map((row) => [row.key, row.value]));
      return Object.fromEntries(
        (Object.keys(SETTING_KEYS) as (keyof EnterpriseSettings)[]).map(
          (key) => [key, unwrap(key, byKey.get(SETTING_KEYS[key]))],
        ),
      ) as EnterpriseSettings;
    },

    async setSetting<K extends keyof EnterpriseSettings>(
      key: K,
      value: EnterpriseSettings[K],
      by: string,
    ): Promise<void> {
      await database.transaction(async (tx) => {
        await tx
          .insert(enterpriseSettings)
          .values({
            key: SETTING_KEYS[key],
            value: { value },
            updatedBy: by,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: enterpriseSettings.key,
            set: { value: { value }, updatedBy: by, updatedAt: new Date() },
          });
        await announce(tx);
      });
    },

    async capabilityRows(): Promise<CapabilityRow[]> {
      return database
        .select({
          scopeKind: capabilitySettings.scopeKind,
          scopeId: capabilitySettings.scopeId,
          capability: capabilitySettings.capability,
          allowed: capabilitySettings.allowed,
        })
        .from(capabilitySettings);
    },

    /** `allowed: null` removes the row, returning that scope to whatever sits beneath it. */
    async setCapability(
      row: Omit<CapabilityRow, "allowed"> & { allowed: boolean | null },
      by: string,
    ): Promise<void> {
      await database.transaction(async (tx) => {
        const where = and(
          eq(capabilitySettings.scopeKind, row.scopeKind),
          eq(capabilitySettings.scopeId, row.scopeId),
          eq(capabilitySettings.capability, row.capability),
        );
        if (row.allowed === null) {
          await tx.delete(capabilitySettings).where(where);
        } else {
          await tx
            .insert(capabilitySettings)
            .values({
              scopeKind: row.scopeKind,
              scopeId: row.scopeId,
              capability: row.capability,
              allowed: row.allowed,
              updatedBy: by,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [
                capabilitySettings.scopeKind,
                capabilitySettings.scopeId,
                capabilitySettings.capability,
              ],
              set: {
                allowed: row.allowed,
                updatedBy: by,
                updatedAt: new Date(),
              },
            });
        }
        await announce(tx);
      });
    },

    /** One person as the capability rules see them. Unknown means a plain user in no group. */
    async member(userId: string): Promise<Member> {
      const roles = await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));
      const person = await database
        .select({ groups: users.groups })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return {
        role: roles.some((row) => row.role === "admin") ? "admin" : "user",
        groups: person[0]?.groups ?? [],
      };
    },

    async adminIds(): Promise<Set<string>> {
      const rows = await database
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .where(eq(userRoles.role, "admin"));
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
      const provisioned = await database
        .select({ name: scimGroups.displayName })
        .from(scimGroups);
      const names = new Set<string>();
      for (const row of fromPeople as unknown as { name: string }[]) {
        if (row.name) names.add(row.name);
      }
      for (const row of provisioned) names.add(row.name);
      return [...names].sort((a, b) => a.localeCompare(b));
    },

    async networkPolicies(): Promise<NetworkPolicyRow[]> {
      const rows = await database.select().from(networkPolicies);
      return rows.map((row) => ({
        scopeKind: row.scopeKind,
        scopeId: row.scopeId,
        mode: row.mode,
        rules: Array.isArray((row.rules as { entries?: unknown }).entries)
          ? (row.rules as { entries: unknown[] }).entries
          : [],
        locked: row.locked,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt.toISOString(),
      }));
    },

    async setNetworkPolicy(
      row: Omit<NetworkPolicyRow, "updatedBy" | "updatedAt">,
      by: string,
    ): Promise<void> {
      await database.transaction(async (tx) => {
        const values = {
          scopeKind: row.scopeKind,
          scopeId: row.scopeId,
          mode: row.mode,
          rules: { entries: row.rules },
          locked: row.scopeKind === "organization" ? row.locked : false,
          updatedBy: by,
          updatedAt: new Date(),
        };
        await tx
          .insert(networkPolicies)
          .values(values)
          .onConflictDoUpdate({
            target: [networkPolicies.scopeKind, networkPolicies.scopeId],
            set: values,
          });
        await announce(tx);
      });
    },

    async removeNetworkPolicy(
      scopeKind: NetworkPolicyRow["scopeKind"],
      scopeId: string,
    ): Promise<boolean> {
      return database.transaction(async (tx) => {
        const removed = await tx
          .delete(networkPolicies)
          .where(
            and(
              eq(networkPolicies.scopeKind, scopeKind),
              eq(networkPolicies.scopeId, scopeId),
            ),
          )
          .returning({ scopeId: networkPolicies.scopeId });
        await announce(tx);
        return removed.length > 0;
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
