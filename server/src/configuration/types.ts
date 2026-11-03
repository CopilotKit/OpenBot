/**
 * What OpenBot keeps in Intelligence beside its Bots, in OpenBot's own words.
 *
 * Intelligence holds five things for this deployment's project (see its `docs/contracts/`):
 *
 * - A Bot's ACCESS: the tools, skills and Bots it holds (`plugin_grants` before), whether it is
 *   published to the team and to whom (`team_bot_publications`, `team_bot_audience`), and which groups
 *   an administrator assigned it to (`team_bot_assignments`). Intelligence calls this agent access.
 * - A person's PREFERENCES: standing instructions (`user_instructions`), hidden and pinned Bots
 *   (`agent_preferences`), paused Bots and how loudly they may reach them (`bot_lifecycle`), where each
 *   kind of update goes (`update_routing_preferences`), the defaults they turned down
 *   (`default_opt_outs`), and the consents they gave Team Bots (`team_bot_consents`,
 *   `team_bot_consent_defaults`). Intelligence calls these end-user preferences.
 * - The COMPONENT catalogue: each component's governance, the functions it may call, the Bots held
 *   back from it, and a playground component's source (`components`, `component_functions`,
 *   `component_exclusions`, `sandboxed_components`). Intelligence calls these UI components.
 * - The SKILLS people and packages write, with the tools each declares (`skills`, `skill_tools`).
 * - The record of the tenant package this deployment applied (`deployment_packages`), which
 *   Intelligence calls an agent package.
 *
 * The field names here are OpenBot's, so the code that reads them did not change when the storage did.
 * `client.ts` is the one place that translates them to Intelligence's.
 */

/** What a grant is of: a tool on an app (`mcp`), a skill, or another Bot to hand work to. */
export type GrantKind = "mcp" | "skill" | "bot";

/**
 * One thing one Bot holds. Absence is refusal.
 *
 * `grantedAs` is `owner` when the Bot's owner gave it one of their own apps, and `admin` for every
 * other grant (rows from before the column read as `admin`). See `team-bots.ts`: it decides whose
 * account a Team Bot's call goes out on.
 */
export type BotGrant = {
  kind: GrantKind;
  ref: string;
  grantedBy: string | null;
  grantedAs: "admin" | "owner";
  grantedAt: Date;
  updatedAt: Date;
};

export type PublicationMember = {
  kind: "user" | "group";
  value: string;
  addedAt: Date;
};

/** A Bot its owner published to the team (`team`) or to named people and groups (`people`). */
export type BotPublication = {
  audience: "team" | "people";
  publishedBy: string;
  publishedAt: Date;
  members: PublicationMember[];
};

/** An administrator's assignment of a published Team Bot to a group (`*` is the whole team). */
export type BotAssignment = {
  group: string;
  assignedBy: string;
  assignedAt: Date;
};

/** Everything about one Bot's reach, as one record with one revision. */
export type BotAccess = {
  botId: string;
  revision: number;
  grants: BotGrant[];
  publication: BotPublication | null;
  assignments: BotAssignment[];
};

export type BotAccessChange =
  | {
      op: "grant";
      botId: string;
      kind: GrantKind;
      ref: string;
      grantedBy: string | null;
      grantedAs: "admin" | "owner";
      /** `replace` makes an existing grant this one; `keep` leaves an existing grant exactly as it is. */
      ifGranted: "replace" | "keep";
      grantedAt?: Date;
    }
  | { op: "revoke"; botId: string; kind: GrantKind; ref: string }
  | {
      op: "revokeMatching";
      kind: GrantKind;
      botIds?: string[];
      ref?: string;
      /** Plain text, never a pattern: `github/` matches `github/x` and nothing else. */
      refPrefix?: string;
      grantedBy?: string;
      grantedAs?: "admin" | "owner";
    }
  | {
      op: "publish";
      botId: string;
      audience: "team" | "people";
      members: { kind: "user" | "group"; value: string }[];
      publishedBy: string;
      publishedAt?: Date;
    }
  | { op: "unpublish"; botId: string }
  | {
      op: "assign";
      botId: string;
      group: string;
      assignedBy: string;
      assignedAt?: Date;
    }
  | { op: "unassign"; botId: string; group: string };

export type BotAccessChangeResult = {
  outcome:
    | "granted"
    | "replaced"
    | "kept"
    | "revoked"
    | "absent"
    | "shared"
    | "reshared"
    | "unshared"
    | "assigned"
    | "unassigned";
  /** For `revokeMatching`: every grant it took back, with the Bot that held it. */
  revoked?: (Pick<BotGrant, "kind" | "ref" | "grantedAs"> & {
    botId: string;
  })[];
};

export type BotNotify = "all" | "needs_input" | "none";

/** One person's settings for one Bot. */
export type PersonBotPreference = {
  botId: string;
  hiddenAt: Date | null;
  pinnedAt: Date | null;
  pausedAt: Date | null;
  notify: BotNotify;
  updatedAt: Date;
};

export type PersonRoute = {
  kind: string;
  transports: string[];
  updatedAt: Date;
};

export type PersonOptOut = {
  botId: string;
  feature: string;
  scope: string;
  createdAt: Date;
};

export type PersonConsent = {
  botId: string;
  serverId: string;
  decision: "always" | "once";
  updatedAt: Date;
};

export type PersonConsentDefault = { serverId: string; updatedAt: Date };

/** Everything one person has set, as one record with one revision. */
export type PersonPreferences = {
  userId: string;
  revision: number;
  instructions: string | null;
  instructionsUpdatedAt: Date | null;
  bots: PersonBotPreference[];
  routes: PersonRoute[];
  optOuts: PersonOptOut[];
  consents: PersonConsent[];
  consentDefaults: PersonConsentDefault[];
};

export type PersonPreferencesChange =
  | { op: "setInstructions"; instructions: string | null }
  | {
      op: "setBot";
      botId: string;
      hiddenAt?: Date | null;
      pinnedAt?: Date | null;
      pausedAt?: Date | null;
      notify?: BotNotify;
    }
  | { op: "setRoute"; kind: string; transports: string[] | null }
  | {
      op: "optOut";
      botId: string;
      feature: string;
      scope: string;
      createdAt?: Date;
    }
  | {
      op: "setConsent";
      botId: string;
      serverId: string;
      decision: "always" | "once" | null;
    }
  | { op: "setConsentDefault"; serverId: string; allowed: boolean }
  | { op: "clearConsents" };

export type PersonPreferencesChangeResult = { outcome: string };

/** What a playground component draws with, at one point in its life (draft or published). */
export type ComponentSourceVersion = {
  description: string;
  html: string;
  css: string;
  jsFunctions: string;
  argumentSchema: Record<string, unknown>;
};

/** A playground component's source, which only components written in the browser have. */
export type ComponentSource = {
  draft: ComponentSourceVersion;
  published: ComponentSourceVersion | null;
  sampleArguments: Record<string, unknown>;
  revision: number;
  isPublished: boolean;
  publishedAt: Date | null;
  authoredBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** One component and everything that governs it. */
export type ComponentEntry = {
  name: string;
  version: number;
  title: string;
  kind: string;
  draftDescription: string;
  publishedDescription: string | null;
  published: boolean;
  publishedAt: Date | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  functions: { name: string; grantedBy: string | null; grantedAt: Date }[];
  withheldFrom: {
    botId: string;
    withheldBy: string | null;
    withheldAt: Date;
  }[];
  source: ComponentSource | null;
};

/** What a component write sends: the whole component, as it should be. */
export type ComponentState = Omit<
  ComponentEntry,
  "name" | "version" | "createdAt" | "updatedAt" | "functions" | "withheldFrom"
> & {
  functions: { name: string; grantedBy: string | null; grantedAt?: Date }[];
  withheldFrom: {
    botId: string;
    withheldBy: string | null;
    withheldAt?: Date;
  }[];
  /** Only when copying an existing component in. */
  createdAt?: Date;
};

export type SkillEntry = {
  slug: string;
  version: number;
  ownerUserId: string | null;
  title: string;
  summary: string;
  instructions: string;
  origin: string;
  installedBy: string | null;
  tools: { ref: string; declaredBy: string | null; declaredAt: Date }[];
  createdAt: Date;
  updatedAt: Date;
};

export type SkillState = Omit<
  SkillEntry,
  "slug" | "version" | "tools" | "createdAt" | "updatedAt"
> & {
  tools: { ref: string; declaredBy: string | null }[];
  createdAt?: Date;
};

/** The record of a tenant package this deployment applied, which Intelligence calls an agent package. */
export type PackageRecord = {
  id: string;
  name: string;
  version: number;
  source: string;
  checksum: string;
  appliedAt: Date;
};
