/**
 * A Bot as OpenBot holds it: its definition and its profile, which used to be one row each in
 * `agents` and `agent_profiles` and are now one agent in Intelligence's agent registry.
 *
 * The field names are OpenBot's, so the code that reads a Bot did not change when the storage did.
 * `client.ts` is the one place that translates them to the registry's names.
 */
export type BotType = "built_in" | "remote_ag_ui" | "remote_mastra";

export type Bot = {
  id: string;
  name: string;
  type: BotType;
  /**
   * What the Bot runs on: `{ systemPrompt }` for a Bot in the box, `{ endpoint, auth?, remoteAgentId? }`
   * for a remote one. `auth` is `{ header, credentialId }`, a reference into OpenBot's own vault; the
   * key itself never leaves this deployment.
   */
  configuration: Record<string, unknown>;
  /** The tenant package this Bot came from, or null for a person's own. A package's Bot is protected. */
  packageId: string | null;
  ownerUserId: string | null;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: "public" | "private";
  isolated: boolean;
  callbackTokenHash: string | null;
  callbackTokenIssuedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Intelligence's version of the record, for optimistic concurrency and for ordering what arrives. */
  version: number;
};

/** What a new Bot is made of. Identity is fixed here: the id and the type never change afterwards. */
export type BotDraft = {
  id: string;
  type: BotType;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: "public" | "private";
  ownerUserId: string | null;
  packageId: string | null;
  isolated: boolean;
  configuration: Record<string, unknown>;
  callbackTokenHash?: string | null;
  callbackTokenIssuedAt?: Date | null;
  /** Only for copying an existing Bot in: when it was made, and whether it was already deleted. */
  createdAt?: Date;
  deletedAt?: Date | null;
};

/** The fields an edit may change. Absent leaves a field as it is; `configuration` is replaced whole. */
export type BotChanges = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "roleDescription"
    | "avatarSeed"
    | "visibility"
    | "ownerUserId"
    | "packageId"
    | "isolated"
    | "callbackTokenHash"
    | "callbackTokenIssuedAt"
    | "configuration"
  >
>;
