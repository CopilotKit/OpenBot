export type AgentVisibility = "public" | "private";

export type AgentActor = {
  id: string;
  role: "admin" | "user";
};

export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  ownerUserId: string | null;
  systemOwned: boolean;
  hidden: boolean;
  pinned: boolean;
  /** An administrator assigned this Team Bot to this person; it stays in their sidebar. */
  assignedToMe?: boolean;
  deletedAt: Date | null;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key. */
  hasAuth: boolean;
  /**
   * Whether this agent holds a credential for calling tools back.
   *
   * A boolean, never the token: the token exists in a readable form once, in the response that issued
   * it. A surface only needs to know whether to offer "generate" or "rotate".
   */
  hasCallbackToken: boolean;
  /**
   * Whether its owner asked for it to have a computer of its own rather than share theirs.
   *
   * What was asked for, not what happens: an administrator can withdraw "Isolated Bots" from the
   * owner, and then the Bot runs on the shared computer while this stays true, so that giving the
   * switch back restores it. `agents/isolation.ts` decides whether it is in effect now.
   */
  isolated: boolean;
};

export type CreateAgentInput = Pick<
  AgentProfile,
  "name" | "title" | "roleDescription" | "visibility"
> & {
  /**
   * The AG-UI endpoint this Bot runs on, or undefined for the one in the box.
   *
   * This field is the AG-UI endpoint for a customer-provided agent. Without it the Bot runs on the
   * built-in endpoint.
   */
  endpoint?: string;
  /**
   * A key this agent sits behind, if any.
   *
   * Write-only. It goes to the vault and is never read back to a person: the edit form shows that a
   * key is set, not what it is. Absent on an update means "leave whatever is there alone", which is
   * why it is optional rather than defaulting to empty; a blank field must not drop a key.
   */
  auth?: { header: string; value: string };
  /**
   * Whether this Bot gets a computer of its own.
   *
   * Optional for the reason `auth` is: absent on an update leaves it as it is, so an edit to a
   * Bot's name never moves it between computers, and absent on a create means no. True needs the
   * "Isolated Bots" switch for whoever sends it; false is always allowed.
   */
  isolated?: boolean;
};
