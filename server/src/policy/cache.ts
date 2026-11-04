/**
 * This deployment's organization policy, held in memory per server instance and kept fresh from
 * Intelligence.
 *
 * WHY A CACHE. Policy is read on the hottest paths OpenBot has: the computer boundary asks for the
 * action boundary, the capability switches and the network rules on every action a Bot takes, the
 * approval gate reads the person's preferences, the team settings and every matching rule on every
 * tool call that may need approval, and the shared-account gate reads an approval on every call that
 * spends a Shared app's account. A round trip to Intelligence under each of those would put the
 * network under every click. So each instance holds the whole set (an organization's policy is a few
 * hundred records, not millions) and answers from memory, synchronously.
 *
 * HOW IT STAYS FRESH, ACROSS REPLICAS. A write made here updates the cache from Intelligence's answer
 * at once, so this instance reads its own writes. Every other instance hears of it from Intelligence's
 * realtime gateway, which announces each change by record and version; the announcement is followed
 * by a read of that one record. Announcements can be lost (a socket drops, a replica restarts), so
 * everything is read again whenever the subscription joins, which includes every reconnect, and every
 * minute, which is how stale the old Postgres snapshot could be without its listener.
 *
 * WHICH READ WINS. A record deleted and stored again starts at version 1 again, so versions cannot
 * order what arrives. Every read and write takes a ticket from one counter instead: a read takes it as
 * it starts, a write as it finishes, and a result replaces what is held only when its ticket is newer.
 * A read that started before a write finished can never put back what that write replaced.
 *
 * NOT LOADED IS NOT EMPTY. Until the first full read completes, `loaded()` is false; the enterprise
 * controls refuse every capability-gated action until then, as they did before anything was read.
 */
import {
  type OrgPolicyClient,
  PolicyVersionConflictError,
  type Precondition,
  policyFailure,
  policyIdempotencyKey,
} from "./client";
import {
  type PolicyChangeSubscription,
  subscribeToPolicyChanges,
} from "./events";
import {
  type ActionBoundary,
  type ActionBoundaryRecord,
  type ApprovalPreferencesPatch,
  type ApprovalPreferencesRecord,
  type ApprovalRuleDraft,
  type ApprovalRulePatch,
  type ApprovalRuleRecord,
  type CapabilityRuleKey,
  type CapabilityRuleRecord,
  type ConnectionApprovalDraft,
  type ConnectionApprovalKey,
  type ConnectionApprovalRecord,
  DEFAULT_ACTION_BOUNDARY_RECORD,
  DEFAULT_POLICY_SETTINGS,
  type NetworkRuleKey,
  type NetworkRuleRecord,
  type PolicyChange,
  type PolicyResource,
  type PolicySettings,
  type PolicySettingsPatch,
} from "./types";

/** One record as held: what it is (null once deleted) and the ticket of the read or write that said so. */
type Held<V> = { ticket: number; value: V | null };

class Records<V> {
  readonly entries = new Map<string, Held<V>>();

  /** Hold `value` for `id` if `ticket` is newer than what is held. True when what is held changed. */
  apply(id: string, value: V | null, ticket: number): boolean {
    const held = this.entries.get(id);
    if (held && held.ticket > ticket) return false;
    const changed =
      JSON.stringify(held?.value ?? null) !== JSON.stringify(value);
    this.entries.set(id, { ticket, value });
    return changed;
  }

  get(id: string): V | undefined {
    return this.entries.get(id)?.value ?? undefined;
  }

  values(): V[] {
    const values: V[] = [];
    for (const held of this.entries.values())
      if (held.value !== null) values.push(held.value);
    return values;
  }

  /** After a complete read that started at `ticket`: drop what it did not list, unless written since. */
  sweep(listed: Set<string>, ticket: number): boolean {
    let changed = false;
    for (const [id, held] of this.entries) {
      if (listed.has(id) || held.value === null || held.ticket > ticket)
        continue;
      this.entries.set(id, { ticket, value: null });
      changed = true;
    }
    return changed;
  }
}

const capabilityId = (key: CapabilityRuleKey) =>
  `${key.scopeKind}\u0000${key.scopeId}\u0000${key.capability}`;
const networkId = (key: NetworkRuleKey) =>
  `${key.scopeKind}\u0000${key.scopeId}`;
const approvalId = (key: ConnectionApprovalKey) =>
  `${key.agentId}\u0000${key.connectionId}`;
const SINGLETON = "";

export type PolicyCache = ReturnType<typeof createPolicyCache>;

/** Every minute: the longest the old per-server snapshot could go stale without its listener. */
const RESYNC_INTERVAL_MS = 60_000;

export function createPolicyCache(options: {
  client: OrgPolicyClient;
  /** The gateway address the runtime is configured with. Absent: no announcements, timer only. */
  gatewayWsUrl?: string;
  resyncIntervalMs?: number;
  /** How announcements are subscribed to. The gateway's, unless a test drives them itself. */
  subscribe?: typeof subscribeToPolicyChanges;
}) {
  const { client } = options;
  let counter = 0;
  const ticket = () => ++counter;

  const settings = new Records<PolicySettings>();
  const boundary = new Records<ActionBoundaryRecord>();
  const capabilities = new Records<CapabilityRuleRecord>();
  const network = new Records<NetworkRuleRecord>();
  const preferences = new Records<ApprovalPreferencesRecord>();
  const rules = new Records<ApprovalRuleRecord>();
  const approvals = new Records<ConnectionApprovalRecord>();

  const listeners = new Set<(resource: PolicyResource) => void>();
  let subscription: PolicyChangeSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resyncing: Promise<void> | undefined;
  let resyncAgain = false;
  let loaded = false;

  const announce = (resource: PolicyResource) => {
    for (const listener of listeners) {
      try {
        listener(resource);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "policy-change-listener-failed",
            resource,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };

  const applied = (resource: PolicyResource, changed: boolean) => {
    if (changed) announce(resource);
  };

  /** Only rules still in force are held; a revoked rule reads as gone. */
  const liveRule = (rule: ApprovalRuleRecord | null) =>
    rule && rule.revokedAt === null ? rule : null;
  /** Preferences nobody saved are the defaults, which is what holding nothing means. */
  const storedPreferences = (record: ApprovalPreferencesRecord | null) =>
    record && record.version > 0 ? record : null;

  /** Read again the one record an announcement named. */
  const reread = async (change: PolicyChange) => {
    const started = ticket();
    const key = change.key;
    switch (change.resource) {
      case "settings":
        applied(
          "settings",
          settings.apply(SINGLETON, await client.settings(), started),
        );
        return;
      case "action_boundary":
        applied(
          "action_boundary",
          boundary.apply(SINGLETON, await client.actionBoundary(), started),
        );
        return;
      case "capability_rule": {
        const ruleKey = {
          scopeKind: key.scopeKind,
          scopeId: key.scopeId ?? "",
          capability: key.capability,
        } as CapabilityRuleKey;
        applied(
          "capability_rule",
          capabilities.apply(
            capabilityId(ruleKey),
            await client.capabilityRule(ruleKey),
            started,
          ),
        );
        return;
      }
      case "network_rule": {
        const ruleKey = {
          scopeKind: key.scopeKind,
          scopeId: key.scopeId ?? "",
        } as NetworkRuleKey;
        applied(
          "network_rule",
          network.apply(
            networkId(ruleKey),
            await client.networkRule(ruleKey),
            started,
          ),
        );
        return;
      }
      case "approval_preferences": {
        const userId = key.userId ?? "";
        applied(
          "approval_preferences",
          preferences.apply(
            userId,
            storedPreferences(await client.approvalPreferences(userId)),
            started,
          ),
        );
        return;
      }
      case "approval_rule": {
        const id = key.id ?? "";
        applied(
          "approval_rule",
          rules.apply(id, liveRule(await client.approvalRule(id)), started),
        );
        return;
      }
      case "connection_approval": {
        const approvalKey = {
          agentId: key.agentId ?? "",
          connectionId: key.connectionId ?? "",
        };
        applied(
          "connection_approval",
          approvals.apply(
            approvalId(approvalKey),
            await client.connectionApproval(approvalKey),
            started,
          ),
        );
        return;
      }
    }
  };

  const heard = async (change: PolicyChange) => {
    try {
      await reread(change);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "policy-change-read-failed",
          resource: change.resource,
          key: change.key,
          note: "The next full read picks the change up.",
          error: policyFailure(error),
        }),
      );
    }
  };

  const readAll = async () => {
    const started = ticket();
    // One after another: a full read is seven small requests, and their order does not matter.
    const currentSettings = await client.settings();
    const currentBoundary = await client.actionBoundary();
    const capabilityList = await client.capabilityRules();
    const networkList = await client.networkRules();
    const preferenceList = await client.approvalPreferencesList();
    const ruleList = await client.approvalRules();
    const approvalList = await client.connectionApprovals();

    applied("settings", settings.apply(SINGLETON, currentSettings, started));
    applied(
      "action_boundary",
      boundary.apply(SINGLETON, currentBoundary, started),
    );

    const load = <V>(
      resource: PolicyResource,
      records: Records<V>,
      items: V[],
      idOf: (item: V) => string,
    ) => {
      const listed = new Set<string>();
      let changed = false;
      for (const item of items) {
        const id = idOf(item);
        listed.add(id);
        changed = records.apply(id, item, started) || changed;
      }
      changed = records.sweep(listed, started) || changed;
      applied(resource, changed);
    };
    load("capability_rule", capabilities, capabilityList.items, capabilityId);
    load("network_rule", network, networkList.items, networkId);
    load(
      "approval_preferences",
      preferences,
      preferenceList.items,
      (item) => item.userId,
    );
    load("approval_rule", rules, ruleList.items, (item) => item.id);
    load("connection_approval", approvals, approvalList.items, approvalId);
    loaded = true;

    const joinCode =
      approvalList.joinCode ??
      ruleList.joinCode ??
      capabilityList.joinCode ??
      null;
    const subscribed = subscription?.joinCode();
    if (subscribed && subscribed !== joinCode) {
      // Intelligence rotated the code, or could not say what it is (null: its Redis did not answer).
      // Announcements for a new code never reach the old topic, so subscribe again.
      subscription?.renew();
    }
  };

  const resync = (): Promise<void> => {
    if (resyncing) {
      resyncAgain = true;
      return resyncing;
    }
    resyncing = (async () => {
      try {
        do {
          resyncAgain = false;
          await readAll();
        } while (resyncAgain);
      } finally {
        resyncing = undefined;
      }
    })();
    return resyncing;
  };

  const logResyncFailure = (error: unknown) =>
    console.warn(
      JSON.stringify({
        type: "policy-resync-failed",
        note: loaded
          ? "Still enforcing the policy this instance last read."
          : "No policy has been read yet, so every capability-gated action is refused.",
        error: policyFailure(error),
      }),
    );

  /** Apply what a write answered, as of now. */
  const wrote = <V>(
    resource: PolicyResource,
    records: Records<V>,
    id: string,
    value: V | null,
  ) => {
    applied(resource, records.apply(id, value, ticket()));
  };

  return {
    client,

    /** Read everything and subscribe to changes. Resolves once the first read is complete. */
    async start(): Promise<void> {
      if (options.gatewayWsUrl) {
        subscription = (options.subscribe ?? subscribeToPolicyChanges)({
          client,
          gatewayWsUrl: options.gatewayWsUrl,
          onChange: (change) => {
            void heard(change);
          },
          onJoined: () => {
            resync().catch(logResyncFailure);
          },
        });
      }
      await resync();
      timer = setInterval(() => {
        resync().catch(logResyncFailure);
      }, options.resyncIntervalMs ?? RESYNC_INTERVAL_MS);
      timer.unref?.();
    },

    stop(): void {
      clearInterval(timer);
      subscription?.stop();
    },

    /** Whether a complete read has ever finished on this instance. */
    loaded: () => loaded,
    /** Whether announcements are arriving: the realtime subscription is joined. */
    subscribed: () => subscription?.joinCode() != null,
    resync,

    /** Called with the resource whenever anything held for it changes, from any source. */
    onChange(listener: (resource: PolicyResource) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /* ------------------------------ reads: memory only ------------------------------ */

    settings: (): PolicySettings =>
      settings.get(SINGLETON) ?? DEFAULT_POLICY_SETTINGS,
    actionBoundary: (): ActionBoundaryRecord =>
      boundary.get(SINGLETON) ?? DEFAULT_ACTION_BOUNDARY_RECORD,
    capabilityRules: (): CapabilityRuleRecord[] => capabilities.values(),
    networkRules: (): NetworkRuleRecord[] => network.values(),
    /** This person's preferences, or the defaults (version 0) when they never saved any. */
    approvalPreferences: (userId: string): ApprovalPreferencesRecord =>
      preferences.get(userId) ?? {
        userId,
        enabled: false,
        autoReview: false,
        hostCommands: "ask",
        version: 0,
        updatedAt: null,
      },
    /** Rules in force. `ownerUserId: null` is the team's; a string is that person's; absent is every rule. */
    approvalRules: (
      filter: { ownerUserId?: string | null } = {},
    ): ApprovalRuleRecord[] =>
      rules
        .values()
        .filter(
          (rule) =>
            filter.ownerUserId === undefined ||
            rule.ownerUserId === filter.ownerUserId,
        ),
    approvalRule: (id: string): ApprovalRuleRecord | undefined => rules.get(id),
    connectionApproval: (
      key: ConnectionApprovalKey,
    ): ConnectionApprovalRecord | undefined => approvals.get(approvalId(key)),
    connectionApprovals: (): ConnectionApprovalRecord[] => approvals.values(),

    /* ----------------- reads through to Intelligence, for paths that must not miss ----------------- */

    /** This person's rules as Intelligence holds them now, held here too. For the resume path, never a gate. */
    async readApprovalRules(
      ownerUserId: string,
    ): Promise<ApprovalRuleRecord[]> {
      const started = ticket();
      const { items } = await client.approvalRules({ ownerUserId });
      let changed = false;
      for (const rule of items)
        changed = rules.apply(rule.id, liveRule(rule), started) || changed;
      applied("approval_rule", changed);
      return items.filter((rule) => rule.revokedAt === null);
    },

    /** Every approval at these connections as Intelligence holds them now, for an administrator's bulk change. */
    async readConnectionApprovals(filter: {
      connectionId: string;
      approvedAs?: "admin" | "owner";
    }): Promise<ConnectionApprovalRecord[]> {
      const started = ticket();
      const { items } = await client.connectionApprovals(filter);
      let changed = false;
      for (const approval of items)
        changed =
          approvals.apply(approvalId(approval), approval, started) || changed;
      applied("connection_approval", changed);
      return items;
    },

    /* ------------------------------ writes: Intelligence, then here ------------------------------ */

    async patchSettings(
      patch: PolicySettingsPatch,
      key = policyIdempotencyKey("settings"),
    ): Promise<PolicySettings> {
      const next = await client.patchSettings(patch, key);
      wrote("settings", settings, SINGLETON, next);
      return next;
    },

    async resetSettings(
      key = policyIdempotencyKey("settings-reset"),
    ): Promise<PolicySettings> {
      const next = await client.resetSettings(key);
      wrote("settings", settings, SINGLETON, next);
      return next;
    },

    async putActionBoundary(
      next: ActionBoundary | null,
      updatedBy: string | null,
      key = policyIdempotencyKey("action-boundary"),
    ): Promise<ActionBoundaryRecord> {
      const record = await client.putActionBoundary(next, updatedBy, key);
      wrote("action_boundary", boundary, SINGLETON, record);
      return record;
    },

    async resetActionBoundary(
      key = policyIdempotencyKey("action-boundary-reset"),
    ): Promise<ActionBoundaryRecord> {
      const record = await client.resetActionBoundary(key);
      wrote("action_boundary", boundary, SINGLETON, record);
      return record;
    },

    async putCapabilityRule(
      ruleKey: CapabilityRuleKey,
      allowed: boolean,
      updatedBy: string | null,
      key = policyIdempotencyKey("capability-rule"),
    ): Promise<CapabilityRuleRecord> {
      const record = await client.putCapabilityRule(
        ruleKey,
        allowed,
        updatedBy,
        key,
      );
      wrote("capability_rule", capabilities, capabilityId(ruleKey), record);
      return record;
    },

    async deleteCapabilityRule(
      ruleKey: CapabilityRuleKey,
      key = policyIdempotencyKey("capability-rule-delete"),
    ): Promise<boolean> {
      const removed = await client.deleteCapabilityRule(ruleKey, key);
      wrote("capability_rule", capabilities, capabilityId(ruleKey), null);
      return removed;
    },

    async putNetworkRule(
      ruleKey: NetworkRuleKey,
      rule: Pick<NetworkRuleRecord, "mode" | "rules" | "locked">,
      updatedBy: string | null,
      key = policyIdempotencyKey("network-rule"),
    ): Promise<NetworkRuleRecord> {
      const record = await client.putNetworkRule(ruleKey, rule, updatedBy, key);
      wrote("network_rule", network, networkId(ruleKey), record);
      return record;
    },

    async deleteNetworkRule(
      ruleKey: NetworkRuleKey,
      key = policyIdempotencyKey("network-rule-delete"),
    ): Promise<boolean> {
      const removed = await client.deleteNetworkRule(ruleKey, key);
      wrote("network_rule", network, networkId(ruleKey), null);
      return removed;
    },

    async patchApprovalPreferences(
      userId: string,
      patch: ApprovalPreferencesPatch,
      key = policyIdempotencyKey("approval-preferences"),
    ): Promise<ApprovalPreferencesRecord> {
      const record = await client.patchApprovalPreferences(userId, patch, key);
      wrote(
        "approval_preferences",
        preferences,
        userId,
        storedPreferences(record),
      );
      return record;
    },

    async createApprovalRule(
      draft: ApprovalRuleDraft,
      key = policyIdempotencyKey("approval-rule"),
    ): Promise<ApprovalRuleRecord> {
      const record = await client.createApprovalRule(draft, key);
      wrote("approval_rule", rules, record.id, liveRule(record));
      return record;
    },

    async patchApprovalRule(
      id: string,
      patch: ApprovalRulePatch,
      key = policyIdempotencyKey("approval-rule-update"),
    ): Promise<ApprovalRuleRecord> {
      const record = await client.patchApprovalRule(id, patch, key);
      wrote("approval_rule", rules, record.id, liveRule(record));
      return record;
    },

    async revokeApprovalRule(
      id: string,
      key = policyIdempotencyKey("approval-rule-revoke"),
    ): Promise<ApprovalRuleRecord> {
      const record = await client.revokeApprovalRule(id, key);
      wrote("approval_rule", rules, record.id, null);
      return record;
    },

    /**
     * Store an approval. With `ifNoneMatch`, only where none is stored; with `ifMatch`, only over that
     * version. A precondition that does not hold reads the approval again before it throws, so what is
     * held here is what beat this write.
     */
    async putConnectionApproval(
      approvalKey: ConnectionApprovalKey,
      draft: ConnectionApprovalDraft,
      precondition?: Precondition,
      key = policyIdempotencyKey("connection-approval"),
    ): Promise<ConnectionApprovalRecord> {
      try {
        const record = await client.putConnectionApproval(
          approvalKey,
          draft,
          key,
          precondition,
        );
        wrote(
          "connection_approval",
          approvals,
          approvalId(approvalKey),
          record,
        );
        return record;
      } catch (error) {
        if (error instanceof PolicyVersionConflictError)
          await this.refreshConnectionApproval(approvalKey);
        throw error;
      }
    },

    /** Remove an approval. True when this call removed it; false when none was stored. */
    async deleteConnectionApproval(
      approvalKey: ConnectionApprovalKey,
      precondition?: Precondition,
      key = policyIdempotencyKey("connection-approval-delete"),
    ): Promise<boolean> {
      try {
        const removed = await client.deleteConnectionApproval(
          approvalKey,
          key,
          precondition,
        );
        wrote("connection_approval", approvals, approvalId(approvalKey), null);
        return removed;
      } catch (error) {
        if (error instanceof PolicyVersionConflictError)
          await this.refreshConnectionApproval(approvalKey);
        throw error;
      }
    },

    /** Read one approval from Intelligence now, whatever is held. Null when none is stored. */
    async refreshConnectionApproval(
      approvalKey: ConnectionApprovalKey,
    ): Promise<ConnectionApprovalRecord | null> {
      const started = ticket();
      const record = await client.connectionApproval(approvalKey);
      applied(
        "connection_approval",
        approvals.apply(approvalId(approvalKey), record, started),
      );
      return record;
    },
  };
}

let installed: PolicyCache | undefined;

/** Make this the cache every policy read and write in this process goes through. */
export function installPolicyCache(cache: PolicyCache): PolicyCache {
  installed = cache;
  return cache;
}

/**
 * The organization policy, as this process holds it.
 *
 * Throws when nothing installed a cache, rather than answering with the defaults: a deployment whose
 * administrator restricted everything would otherwise run unrestricted and say nothing about why.
 */
export function policy(): PolicyCache {
  if (!installed) {
    throw new Error(
      "No policy cache is installed. The server installs one at boot (policy/cache.ts); a test installs the one in tests/support/policy.ts.",
    );
  }
  return installed;
}
