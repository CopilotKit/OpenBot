/**
 * Moving an existing deployment's organization policy into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds its policy in ten tables: `capability_settings`,
 * `enterprise_settings`, `network_policies`, `action_policy`, `approval_preferences`,
 * `approval_team_settings`, `approval_rules`, `approval_team_rules`, `shared_use_approvals` and
 * `shared_use_approval_members`. This copies every row into Intelligence's organization policy, with
 * the values, authors and timestamps they had (revoked rules included: they are history), then checks
 * that Intelligence holds every record it copied, and only then records the copy as done, so it never
 * runs again: a rule later removed in Intelligence must not come back from the local row this release
 * keeps.
 *
 * NEVER OVER WHAT INTELLIGENCE ALREADY HOLDS. Every write is conditional: a setting is copied only
 * while Intelligence's has never been written (`If-Match: "0"`), a keyed record only where none is
 * stored (`If-None-Match: *`), a rule only under an id Intelligence does not have. A server of this
 * release that already saved a change there keeps it.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. The preconditions are what
 * make a record copied once: two replicas copying the same row both send it, the first is stored and
 * the second is refused by its precondition and left alone. Each write also carries an idempotency
 * key, made from the record and this run, so a retry after a lost response is the same write. Not
 * from the record alone: a key outlives its write by a day, and a later run (after a failed one, or
 * over a record removed since) must write again, not be answered with a write that no longer stands.
 *
 * LOUD ON A MISMATCH. A record Intelligence refuses, or one missing after the copy, stops the boot with
 * the records named. Running on with half an organization's policy copied would enforce rules nobody
 * set, or drop rules somebody did, and say nothing.
 */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  actionPolicy,
  approvalPreferences,
  approvalRules,
  approvalTeamRules,
  approvalTeamSettings,
  capabilitySettings,
  enterpriseSettings,
  intelligenceCopies,
  networkPolicies,
  sharedUseApprovalMembers,
  sharedUseApprovals,
} from "../db/schema";
import type { PolicyCache } from "./cache";
import {
  PolicyAlreadyExistsError,
  PolicyVersionConflictError,
  policyFailure,
} from "./client";
import type {
  ApprovalRuleDraft,
  ConnectionApprovalMember,
  PolicySettingsPatch,
} from "./types";

export const POLICY_COPY_NAME = "policy";

export class PolicyCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyCopyMismatchError";
  }
}

export type PolicyCopyOutcome =
  | { kind: "done-before" }
  | { kind: "copied"; local: number; written: number; present: number };

/** The key for one record's write in one run: the same for a retry of that write, new for a new run. */
function upgradeKey(run: string, kind: string, record: unknown): string {
  return `openbot-upgrade:policy:${kind}:${createHash("sha256").update(JSON.stringify({ run, record })).digest("hex")}`;
}

/** The old `enterprise_settings` rows, as Intelligence's one settings record. Unknown keys are not settings. */
function settingsFromRows(
  rows: { key: string; value: unknown }[],
): PolicySettingsPatch {
  const patch: PolicySettingsPatch = {};
  for (const row of rows) {
    const value = (row.value as { value?: unknown } | null)?.value;
    if (value === undefined) continue;
    switch (row.key) {
      case "sso_required":
        if (typeof value === "boolean") patch.ssoRequired = value;
        break;
      case "action_recording":
        if (typeof value === "boolean") patch.actionRecording = value;
        break;
      case "skill_sharing":
        if (typeof value === "boolean") patch.skillSharing = value;
        break;
      case "inactive_computer_days":
        if (typeof value === "number" && Number.isInteger(value) && value >= 0)
          patch.inactiveEnvironmentDays = value;
        break;
      case "proactive_daily_runs":
        if (typeof value === "number" && Number.isInteger(value) && value >= 0)
          patch.proactiveDailyRuns = value;
        break;
      case "model_allowlist":
      case "mcp_allowlist": {
        const list = value as {
          enabled?: unknown;
          models?: unknown;
          servers?: unknown;
        };
        const field = row.key === "model_allowlist" ? "models" : "servers";
        const items = Array.isArray(list[field])
          ? (list[field] as unknown[]).filter(
              (item): item is string => typeof item === "string",
            )
          : [];
        if (row.key === "model_allowlist")
          patch.modelAllowlist = {
            enabled: list.enabled === true,
            models: items,
          };
        else
          patch.mcpAllowlist = {
            enabled: list.enabled === true,
            servers: items,
          };
        break;
      }
    }
  }
  return patch;
}

export async function copyLocalPolicyToIntelligence(
  database: Database,
  cache: PolicyCache,
): Promise<PolicyCopyOutcome> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, POLICY_COPY_NAME))
    .limit(1);
  if (done) return { kind: "done-before" };

  const client = cache.client;
  const run = randomUUID();
  const settingsRows = await database.select().from(enterpriseSettings);
  const [teamRow] = await database.select().from(approvalTeamSettings);
  const [boundaryRow] = await database.select().from(actionPolicy);
  const capabilityRows = await database.select().from(capabilitySettings);
  const networkRows = await database.select().from(networkPolicies);
  const preferenceRows = await database.select().from(approvalPreferences);
  const personalRows = await database.select().from(approvalRules);
  const teamRuleRows = await database.select().from(approvalTeamRules);
  const approvalRows = await database.select().from(sharedUseApprovals);
  const memberRows = await database.select().from(sharedUseApprovalMembers);

  const refused: string[] = [];
  let written = 0;
  /** One conditional write. A precondition that does not hold means Intelligence already has its own. */
  const copy = async (what: string, write: () => Promise<unknown>) => {
    try {
      await write();
      written += 1;
    } catch (error) {
      if (
        error instanceof PolicyVersionConflictError ||
        error instanceof PolicyAlreadyExistsError
      )
        return;
      refused.push(`${what}: ${policyFailure(error)}`);
    }
  };

  // The settings and the team's approval settings are one record in Intelligence.
  const settingsPatch: PolicySettingsPatch = {
    ...settingsFromRows(settingsRows),
    ...(teamRow
      ? {
          approvals: {
            enforceAutoReview: teamRow.enforceAutoReview,
            customRulesEnabled: teamRow.customRulesEnabled,
            hostCommandsCap: teamRow.hostCommandsCap,
          },
        }
      : {}),
  };
  const lastSettingsAuthor =
    [...settingsRows]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .find((row) => row.updatedBy)?.updatedBy ??
    teamRow?.updatedBy ??
    null;
  const hasSettings = settingsRows.length > 0 || teamRow !== undefined;
  if (hasSettings) {
    const patch = { ...settingsPatch, updatedBy: lastSettingsAuthor };
    await copy("settings", () =>
      client.patchSettings(patch, upgradeKey(run, "settings", patch), {
        ifMatch: 0,
      }),
    );
  }

  if (boundaryRow) {
    const boundary = {
      mode: boundaryRow.mode as "enforce" | "dry-run",
      deny: [...boundaryRow.deny],
      allow: [...boundaryRow.allow],
      labels: { ...boundaryRow.labels },
    };
    await copy("action boundary", () =>
      client.putActionBoundary(
        boundary,
        boundaryRow.updatedBy,
        upgradeKey(run, "action-boundary", boundary),
        { ifMatch: 0 },
      ),
    );
  }

  for (const row of capabilityRows) {
    const key = {
      scopeKind: row.scopeKind,
      scopeId: row.scopeKind === "organization" ? "" : row.scopeId,
      capability: row.capability,
    };
    await copy(
      `capability ${row.capability} for ${row.scopeKind} ${row.scopeId}`,
      () =>
        client.putCapabilityRule(
          key,
          row.allowed,
          row.updatedBy,
          upgradeKey(run, "capability", { key, allowed: row.allowed }),
          { ifNoneMatch: true },
        ),
    );
  }

  for (const row of networkRows) {
    const key = {
      scopeKind: row.scopeKind,
      scopeId: row.scopeKind === "organization" ? "" : row.scopeId,
    };
    const entries = (row.rules as { entries?: unknown }).entries;
    const rule = {
      mode: row.mode,
      rules: Array.isArray(entries) ? entries : [],
      locked: row.scopeKind === "organization" ? row.locked : false,
    };
    await copy(`network rule for ${row.scopeKind} ${row.scopeId}`, () =>
      client.putNetworkRule(
        key,
        rule,
        row.updatedBy,
        upgradeKey(run, "network", { key, rule }),
        { ifNoneMatch: true },
      ),
    );
  }

  for (const row of preferenceRows) {
    const patch = {
      enabled: row.enabled,
      autoReview: row.autoReview,
      hostCommands: row.hostCommands,
    };
    await copy(`approval preferences for ${row.ownerUserId}`, () =>
      client.patchApprovalPreferences(
        row.ownerUserId,
        patch,
        upgradeKey(run, "preferences", { user: row.ownerUserId, patch }),
        { ifMatch: 0 },
      ),
    );
  }

  const ruleDrafts: ApprovalRuleDraft[] = [
    ...personalRows.map((row) => ({
      id: row.id,
      ownerUserId: row.ownerUserId,
      agentId: row.botId,
      tool: row.toolRef,
      effect: row.effect,
      scope: row.scope,
      behaviour: row.behaviour,
      createdBy: row.ownerUserId,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    })),
    ...teamRuleRows.map((row) => ({
      id: row.id,
      ownerUserId: null,
      agentId: row.botId,
      tool: row.toolRef,
      effect: row.effect,
      scope: row.scope,
      behaviour: row.behaviour,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    })),
  ];
  for (const draft of ruleDrafts) {
    await copy(`approval rule ${draft.id}`, () =>
      client.createApprovalRule(draft, upgradeKey(run, "rule", draft)),
    );
  }

  const membersOf = new Map<string, ConnectionApprovalMember[]>();
  for (const member of memberRows) {
    const id = `${member.agentId}\u0000${member.serverId}`;
    const list = membersOf.get(id) ?? [];
    list.push({ kind: member.kind, value: member.value });
    membersOf.set(id, list);
  }
  for (const row of approvalRows) {
    const key = { agentId: row.agentId, connectionId: row.serverId };
    const draft = {
      audience: row.audience,
      outsideInput: row.outsideInput,
      members:
        row.audience === "people"
          ? (membersOf.get(`${row.agentId}\u0000${row.serverId}`) ?? [])
          : [],
      approvedBy: row.approvedBy,
      // A null is a row from a replica older than the column, and every one of those was an administrator's.
      approvedAs: row.approvedAs ?? ("admin" as const),
      approvedAt: row.approvedAt.toISOString(),
    };
    await copy(
      `Shared app approval for ${row.agentId} at ${row.serverId}`,
      () =>
        client.putConnectionApproval(
          key,
          draft,
          upgradeKey(run, "connection-approval", { key, draft }),
          { ifNoneMatch: true },
        ),
    );
  }

  const local =
    (hasSettings ? 1 : 0) +
    (boundaryRow ? 1 : 0) +
    capabilityRows.length +
    networkRows.length +
    preferenceRows.length +
    ruleDrafts.length +
    approvalRows.length;
  if (refused.length > 0) {
    throw new PolicyCopyMismatchError(
      `Intelligence refused ${refused.length} of this deployment's ${local} policy records, so they were not moved and this server will not start without them:\n${refused.join("\n")}`,
    );
  }

  /*
   * Verified against Intelligence itself, not against what the writes answered: every record copied
   * must be there now, whoever wrote it.
   */
  const missing: string[] = [];
  if (hasSettings && (await client.settings()).version === 0)
    missing.push("settings");
  if (boundaryRow && (await client.actionBoundary()).version === 0)
    missing.push("action boundary");
  const capabilityHeld = new Set(
    (await client.capabilityRules()).items.map(
      (rule) =>
        `${rule.scopeKind}\u0000${rule.scopeId}\u0000${rule.capability}`,
    ),
  );
  for (const row of capabilityRows) {
    const scopeId = row.scopeKind === "organization" ? "" : row.scopeId;
    if (
      !capabilityHeld.has(
        `${row.scopeKind}\u0000${scopeId}\u0000${row.capability}`,
      )
    )
      missing.push(
        `capability ${row.capability} for ${row.scopeKind} ${row.scopeId}`,
      );
  }
  const networkHeld = new Set(
    (await client.networkRules()).items.map(
      (rule) => `${rule.scopeKind}\u0000${rule.scopeId}`,
    ),
  );
  for (const row of networkRows) {
    const scopeId = row.scopeKind === "organization" ? "" : row.scopeId;
    if (!networkHeld.has(`${row.scopeKind}\u0000${scopeId}`))
      missing.push(`network rule for ${row.scopeKind} ${row.scopeId}`);
  }
  const preferencesHeld = new Set(
    (await client.approvalPreferencesList()).items.map((item) => item.userId),
  );
  for (const row of preferenceRows)
    if (!preferencesHeld.has(row.ownerUserId))
      missing.push(`approval preferences for ${row.ownerUserId}`);
  const rulesHeld = new Set(
    (await client.approvalRules({ includeRevoked: true })).items.map(
      (rule) => rule.id,
    ),
  );
  for (const draft of ruleDrafts)
    if (!rulesHeld.has(draft.id)) missing.push(`approval rule ${draft.id}`);
  const approvalsHeld = new Set(
    (await client.connectionApprovals()).items.map(
      (approval) => `${approval.agentId}\u0000${approval.connectionId}`,
    ),
  );
  for (const row of approvalRows)
    if (!approvalsHeld.has(`${row.agentId}\u0000${row.serverId}`))
      missing.push(`Shared app approval for ${row.agentId} at ${row.serverId}`);
  if (missing.length > 0) {
    throw new PolicyCopyMismatchError(
      `${local} policy records were to be copied into Intelligence and ${local - missing.length} are there. Missing: ${missing.join(", ")}`,
    );
  }

  await database
    .insert(intelligenceCopies)
    .values({ name: POLICY_COPY_NAME, copied: local })
    .onConflictDoNothing();
  // What this server holds is what it read before the copy; read it all again now.
  await cache.resync();
  console.info(
    JSON.stringify({
      type: "policy-copied-to-intelligence",
      local,
      written,
    }),
  );
  return { kind: "copied", local, written, present: local };
}
