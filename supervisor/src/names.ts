/**
 * What a Bot id is allowed to be, and what it becomes.
 *
 * This is a security boundary. Every id that arrives here is turned into a container name, two volume
 * names and a label filter. The supervisor only accepts plain Bot identifiers, so callers cannot
 * name an existing container, database volume, API server resource, or host tool through this API.
 *
 * So an id must be a plain identifier and nothing else: letters, digits, hyphen and underscore. No
 * slashes (which would let a name escape into another path segment on the socket API), no dots (which
 * Docker allows in names but which invite `..` reasoning), no colons (image tags), no whitespace.
 *
 * Names are derived rather than accepted. A caller says which Bot; it never says which container.
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
 * Everything the supervisor is permitted to create for one Bot, and nothing it is not.
 *
 * `label` is what makes stop and reset safe: the supervisor only ever acts on containers carrying it,
 * so even a correct-looking name for something it did not create will not match.
 */
export type ComputerNames = {
  botId: string;
  container: string;
  profileVolume: string;
  workspaceVolume: string;
};

export type NameResult =
  | { ok: true; names: ComputerNames }
  | { ok: false; reason: string };

/** The label every container and volume the supervisor owns carries. */
export const OWNER_LABEL = "openbot.supervisor";

/** The label holding the Bot a container belongs to, so a listing can report it without parsing names. */
export const BOT_LABEL = "openbot.bot-id";

/** The label holding the deployment a container belongs to. */
export const NAMESPACE_LABEL = "openbot.namespace";

export function namesFor(botId: unknown): NameResult {
  if (typeof botId !== "string" || botId.length === 0) {
    return { ok: false, reason: "A bot id is required." };
  }
  if (botId.length > MAX_BOT_ID) {
    return {
      ok: false,
      reason: `A bot id may be at most ${MAX_BOT_ID} characters.`,
    };
  }
  if (!ALLOWED.test(botId)) {
    return {
      ok: false,
      reason:
        "A bot id may contain only letters, digits, hyphen and underscore, and must start with a letter or digit.",
    };
  }

  return {
    ok: true,
    names: {
      botId,
      container: `${NAMESPACE}-computer-${botId}`,
      profileVolume: `${NAMESPACE}-profile-${botId}`,
      workspaceVolume: `${NAMESPACE}-workspace-${botId}`,
    },
  };
}
