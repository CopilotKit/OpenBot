/**
 * What a person or Bot id is allowed to be, and what it becomes.
 *
 * This is a security boundary. Every id that arrives here is turned into a container name, two volume
 * names and a label filter. The supervisor only accepts plain identifiers, so callers cannot name an
 * existing container, database volume, API server resource, or host tool through this API.
 *
 * So an id must be a plain identifier and nothing else: letters, digits, hyphen and underscore. No
 * slashes (which would let a name escape into another path segment on the socket API), no dots (which
 * Docker allows in names but which invite `..` reasoning), no colons (image tags), no whitespace.
 *
 * Names are derived rather than accepted. A caller says whose computer (a person's, or an isolated
 * Bot's); it never says which container.
 */

/** Long enough for a uuid-shaped agent id, short enough to stay inside Docker's own name limits. */
const MAX_BOT_ID = 64;

const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * The deployment a computer belongs to.
 *
 * Container and volume names are global to a Docker host, so two OpenBot deployments sharing a host
 * would otherwise derive the same names for the same Bot id and each would treat the other's
 * containers as its own. The namespace is part of every derived name, and is held to the same
 * character rules for the same reason.
 */
export const DEFAULT_NAMESPACE = "openbot";

export const NAMESPACE = (() => {
  const configured = process.env.COMPUTER_NAMESPACE?.trim();
  if (!configured) return DEFAULT_NAMESPACE;
  if (!ALLOWED.test(configured) || configured.length > MAX_BOT_ID) {
    throw new Error(
      "COMPUTER_NAMESPACE may contain only letters, digits, hyphen and underscore, and must start with a letter or digit.",
    );
  }
  return configured;
})();

/**
 * Whose computer it is.
 *
 * One computer per person is the default: every Bot a person uses runs on it, each with its own
 * browser profile and folder inside. A Bot whose owner asked for it to be isolated gets a computer of
 * its own instead, which everyone who uses that Bot shares. The kind is part of every name, so a
 * person and a Bot can never derive the same container whatever their ids are.
 */
export type ComputerKind = "person" | "bot";

export function isComputerKind(value: unknown): value is ComputerKind {
  return value === "person" || value === "bot";
}

/**
 * Everything the supervisor is permitted to create for one computer, and nothing it is not.
 *
 * `label` is what makes stop and reset safe: the supervisor only ever acts on containers carrying it,
 * so even a correct-looking name for something it did not create will not match.
 */
export type ComputerNames = {
  kind: ComputerKind;
  /** The person, or the Bot, this computer belongs to. */
  id: string;
  container: string;
  profileVolume: string;
  workspaceVolume: string;
};

export type NameResult =
  | { ok: true; names: ComputerNames }
  | { ok: false; reason: string };

/** The label every container and volume the supervisor owns carries. */
export const OWNER_LABEL = "openbot.supervisor";

/**
 * The label holding the Bot a computer belongs to, on a Bot's own computer.
 *
 * Kept on an isolated Bot's computer because that is what a SPIRE docker workload attestor selects
 * on. Computers from before one per person carry it too, without {@link KIND_LABEL}, which is how
 * they are told apart.
 */
export const BOT_LABEL = "openbot.bot-id";

/** The label holding the person a computer belongs to, on a person's computer. */
export const PERSON_LABEL = "openbot.person-id";

/** Whether a computer is a person's or a Bot's. Absent on a computer from before that existed. */
export const KIND_LABEL = "openbot.computer-kind";

/** The label holding the deployment a container belongs to. */
export const NAMESPACE_LABEL = "openbot.namespace";

/** A person or Bot id, checked before it becomes any part of a name. */
function checkId(id: unknown, what: string): string | undefined {
  if (typeof id !== "string" || id.length === 0)
    return `A ${what} id is required.`;
  if (id.length > MAX_BOT_ID)
    return `A ${what} id may be at most ${MAX_BOT_ID} characters.`;
  if (!ALLOWED.test(id))
    return `A ${what} id may contain only letters, digits, hyphen and underscore, and must start with a letter or digit.`;
  return undefined;
}

/**
 * The names of a person's computer or an isolated Bot's.
 *
 * `${namespace}-computer-person-<id>` and `${namespace}-computer-bot-<id>`, with the profile and
 * workspace volumes named the same way.
 */
export function namesFor(kind: unknown, id: unknown): NameResult {
  if (!isComputerKind(kind)) {
    return {
      ok: false,
      reason: "A computer belongs to a person or a bot.",
    };
  }
  const refused = checkId(id, kind);
  if (refused) return { ok: false, reason: refused };
  const plain = id as string;

  return {
    ok: true,
    names: {
      kind,
      id: plain,
      container: `${NAMESPACE}-computer-${kind}-${plain}`,
      profileVolume: `${NAMESPACE}-profile-${kind}-${plain}`,
      workspaceVolume: `${NAMESPACE}-workspace-${kind}-${plain}`,
    },
  };
}

/** What a Bot's computer was called before computers were one per person. */
export type LegacyNames = {
  botId: string;
  container: string;
  profileVolume: string;
  workspaceVolume: string;
};

/**
 * The names a Bot's computer had when every Bot had its own.
 *
 * Read only, to find a private Bot's old profile and files and give them to its owner. Nothing is created under
 * these names any more, and they share a prefix with the new ones, which is why a new computer also
 * checks {@link KIND_LABEL} before it treats a container or volume as its own.
 */
export function legacyNamesFor(
  botId: unknown,
): { ok: true; names: LegacyNames } | { ok: false; reason: string } {
  const refused = checkId(botId, "bot");
  if (refused) return { ok: false, reason: refused };
  const plain = botId as string;
  return {
    ok: true,
    names: {
      botId: plain,
      container: `${NAMESPACE}-computer-${plain}`,
      profileVolume: `${NAMESPACE}-profile-${plain}`,
      workspaceVolume: `${NAMESPACE}-workspace-${plain}`,
    },
  };
}
