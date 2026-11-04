/**
 * Organization policy as Intelligence stores it: the records an administrator sets for this
 * deployment (capability switches, enterprise settings, network rules, the computer-action
 * boundary, approval preferences and rules, and approvals for a Bot to use a Shared app).
 *
 * The shapes are Intelligence's, from its `docs/contracts/organization-policy.md`, so this file reads
 * like the contract. The stores that hold OpenBot's own vocabulary (`admin/settings-store.ts`,
 * `approvals/store.ts`, `plugins/shared-use-store.ts`, `computer/policy-store.ts`) translate.
 */

export type HostCommands = "ask" | "allow" | "never";

export type PolicySettings = {
  /** 0 until anybody saves a setting: everything below is then its default. */
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  ssoRequired: boolean;
  actionRecording: boolean;
  /** OpenBot's "inactive computer days". */
  inactiveEnvironmentDays: number;
  modelAllowlist: { enabled: boolean; models: string[] };
  mcpAllowlist: { enabled: boolean; servers: string[] };
  skillSharing: boolean;
  proactiveDailyRuns: number;
  approvals: {
    enforceAutoReview: boolean;
    customRulesEnabled: boolean;
    hostCommandsCap: HostCommands;
  };
};

/** A change to the settings: any field, and the approval group one level deep. */
export type PolicySettingsPatch = Partial<
  Omit<
    PolicySettings,
    | "version"
    | "updatedAt"
    | "updatedBy"
    | "approvals"
    | "modelAllowlist"
    | "mcpAllowlist"
  >
> & {
  modelAllowlist?: Partial<PolicySettings["modelAllowlist"]>;
  mcpAllowlist?: Partial<PolicySettings["mcpAllowlist"]>;
  approvals?: Partial<PolicySettings["approvals"]>;
  updatedBy?: string | null;
};

export const DEFAULT_POLICY_SETTINGS: PolicySettings = {
  version: 0,
  updatedAt: null,
  updatedBy: null,
  ssoRequired: false,
  actionRecording: false,
  inactiveEnvironmentDays: 30,
  modelAllowlist: { enabled: false, models: [] },
  mcpAllowlist: { enabled: false, servers: [] },
  skillSharing: false,
  proactiveDailyRuns: 24,
  approvals: {
    enforceAutoReview: false,
    customRulesEnabled: true,
    hostCommandsCap: "allow",
  },
};

export type ActionBoundary = {
  mode: "enforce" | "dry-run";
  deny: string[];
  allow: string[];
  labels: Record<string, { name: string; description: string }>;
};

export type ActionBoundaryRecord = {
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Null: the deployment has none of its own, and its configured default applies. */
  boundary: ActionBoundary | null;
};

export const DEFAULT_ACTION_BOUNDARY_RECORD: ActionBoundaryRecord = {
  version: 0,
  updatedAt: null,
  updatedBy: null,
  boundary: null,
};

export type CapabilityRuleKey = {
  scopeKind: "organization" | "role" | "group";
  scopeId: string;
  capability: string;
};

export type CapabilityRuleRecord = CapabilityRuleKey & {
  allowed: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
};

export type NetworkRuleKey = {
  scopeKind: "organization" | "group";
  scopeId: string;
};

export type NetworkRuleRecord = NetworkRuleKey & {
  mode: "allow_all" | "defaults_plus_allowlist" | "allowlist_only";
  rules: unknown[];
  locked: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
};

export type ApprovalPreferencesRecord = {
  userId: string;
  enabled: boolean;
  autoReview: boolean;
  hostCommands: HostCommands;
  /** 0 when this person never changed theirs: the values are the defaults. */
  version: number;
  updatedAt: string | null;
};

export type ApprovalPreferencesPatch = Partial<
  Pick<ApprovalPreferencesRecord, "enabled" | "autoReview" | "hostCommands">
>;

export type ApprovalRuleBehaviour =
  | "allow"
  | "pre_approved"
  | "ask"
  | "hand_off";

export type ApprovalRuleRecord = {
  id: string;
  /** Null: a team rule, for everybody. */
  ownerUserId: string | null;
  agentId: string;
  tool: string;
  effect: string;
  scope: string;
  behaviour: ApprovalRuleBehaviour;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  version: number;
};

export type ApprovalRuleDraft = {
  id: string;
  ownerUserId: string | null;
  agentId: string;
  tool: string;
  effect: string;
  scope: string;
  behaviour: ApprovalRuleBehaviour;
  createdBy?: string | null;
  /** For the upgrade copy, which keeps each rule's history. */
  createdAt?: string;
  revokedAt?: string | null;
};

export type ApprovalRulePatch = Partial<
  Pick<
    ApprovalRuleRecord,
    "agentId" | "tool" | "effect" | "scope" | "behaviour"
  >
>;

export type ConnectionApprovalKey = { agentId: string; connectionId: string };

export type ConnectionApprovalMember = {
  kind: "user" | "group";
  value: string;
};

export type ConnectionApprovalRecord = ConnectionApprovalKey & {
  audience: "owner" | "people" | "team";
  outsideInput: boolean;
  members: ConnectionApprovalMember[];
  approvedBy: string;
  approvedAs: "admin" | "owner";
  approvedAt: string;
  version: number;
  updatedAt: string;
};

export type ConnectionApprovalDraft = Pick<
  ConnectionApprovalRecord,
  "audience" | "outsideInput" | "members" | "approvedBy" | "approvedAs"
> & {
  /** For the upgrade copy, which keeps when each approval was given. */
  approvedAt?: string;
};

export const POLICY_RESOURCES = [
  "settings",
  "action_boundary",
  "capability_rule",
  "network_rule",
  "approval_preferences",
  "approval_rule",
  "connection_approval",
] as const;

export type PolicyResource = (typeof POLICY_RESOURCES)[number];

/** Intelligence's announcement that one policy record changed. It names the record; it never carries it. */
export type PolicyChange = {
  resource: PolicyResource;
  key: Record<string, string>;
  version: number;
  change: "created" | "updated" | "deleted";
};
