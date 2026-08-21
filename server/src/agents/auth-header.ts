import {
  type CredentialExecutor,
  type CredentialSecretReader,
  type CredentialStore,
  decryptSecret,
  encryptSecret,
} from "../credentials";

/**
 * The key a customer's agent sits behind.
 *
 * A bearer token for an external agent is a credential, and
 * this deployment already has one place that knows how to hold a credential: encrypted at rest,
 * revocable, listed for an operator, and never returned to a browser. Putting it in `configuration`
 * next to the endpoint would make it readable by anything that can read an agent, including the
 * admin API that lists them, and there would be no way to revoke it without editing the agent.
 *
 * The vault holds the value. The agent's configuration holds only the
 * credential's id and the header name, because the name is not a secret and the surface needs to
 * show "sends an Authorization header" without being able to show what it sends.
 *
 * It is never read back to a person. There is no endpoint that returns it and no field that
 * repopulates with it: the edit form shows that a key is set, and setting a new one replaces it. A
 * secret a UI can display is a secret in a screenshot.
 */

export type AgentAuth = {
  /** The header to send, e.g. `Authorization`. Not secret. */
  header: string;
  /** The vault row holding the value. */
  credentialId: string;
};

/** How an agent's auth is recorded in its `configuration`. Value never appears here. */
export function authFromConfiguration(
  configuration: unknown,
): AgentAuth | null {
  if (!configuration || typeof configuration !== "object") return null;
  const auth = (configuration as { auth?: unknown }).auth;
  if (!auth || typeof auth !== "object") return null;
  const { header, credentialId } = auth as {
    header?: unknown;
    credentialId?: unknown;
  };
  return typeof header === "string" && typeof credentialId === "string"
    ? { header, credentialId }
    : null;
}

/**
 * Put an agent's key in the vault and return the reference to store on the agent.
 *
 * `keyId` is the agent's own id, so an operator listing credentials can see which agent a row belongs
 * to without joining anything.
 */
export async function storeAgentAuth(input: {
  store: CredentialStore;
  encryptionKey: string;
  agentId: string;
  header: string;
  value: string;
  /**
   * The credential the agent's configuration currently names, if any. Present
   * on an edit that replaces the key, absent on first creation.
   *
   * Whether it is still live is checked here rather than assumed, because the
   * configuration keeps naming a credential an administrator has revoked from
   * the Credentials page. Rotating onto a revoked row is refused by the vault,
   * so trusting the reference would leave that agent's key impossible to
   * replace: every later edit would fail on the same stale id.
   */
  previousCredentialId?: string;
  /**
   * The transaction to write in, when the caller has one.
   *
   * Agent edits are a transaction over `agents` and `agent_profiles`, and the
   * credential is part of that same change. Written outside it, the key would
   * commit even where the edit that asked for it rolled back.
   */
  executor?: CredentialExecutor;
}): Promise<AgentAuth> {
  const value = {
    kind: "agent" as const,
    provider: "ag-ui",
    keyId: input.agentId,
    // The header name is metadata precisely because it is not a secret; keeping it here makes the
    // vault row self-describing for later audit.
    metadata: { header: input.header },
    encryptedValue: await encryptSecret(input.encryptionKey, input.value),
  };

  // A live previous credential is rotated, so the agent never holds two. Any
  // other case inserts: the partial unique index permits it, because there is
  // no live row for this agent to collide with.
  const rotates =
    input.previousCredentialId !== undefined &&
    (await input.store.isLive(input.previousCredentialId, input.executor));

  const credential = rotates
    ? await input.store.rotate(
        {
          ...value,
          previousCredentialId: input.previousCredentialId as string,
        },
        input.executor,
      )
    : await input.store.create(value, input.executor);
  return { header: input.header, credentialId: credential.id };
}

/**
 * Retire the key an edit has just replaced.
 *
 * Rotating a key is the standard answer to a suspected leak, and it only answers it if the old
 * credential stops working. Editing a Bot's key used to write a new vault row and repoint the agent
 * at it, leaving the previous one decryptable and still valid with nothing listing it and no way to
 * reach it: the honest answer to "is that leaked key still live" was yes. The vault also grew one
 * unrevoked secret per edit per Bot.
 *
 * Takes both configurations rather than a credential id, so the caller cannot get the direction
 * wrong and revoke the key it has just stored. Does nothing when the id has not changed, which is an
 * edit that left the key alone.
 *
 * Never throws. The new key is already stored and the Bot already works; a vault that would not
 * accept the revocation is worth saying loudly and is not worth failing an edit that has succeeded.
 */
export async function retireReplacedKey(
  store: Pick<CredentialStore, "revoke">,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Promise<void> {
  const before = credentialIdOf(previous);
  const after = credentialIdOf(next);
  if (!before || before === after) return;

  try {
    await store.revoke(before);
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "agent-key-revoke-failed",
        credentialId: before,
        note: "A Bot's key was replaced and the one it replaced is still live in the vault. Revoke it by hand.",
        error: String(error),
      }),
    );
  }
}

/** The vault row an agent configuration points at, if it points at one. */
function credentialIdOf(
  configuration: Record<string, unknown>,
): string | undefined {
  const auth = configuration.auth as { credentialId?: unknown } | undefined;
  return typeof auth?.credentialId === "string" ? auth.credentialId : undefined;
}

/**
 * The headers to send to this agent, or none.
 *
 * A revoked or missing credential sends nothing rather than guessing. The run then fails at the
 * agent with its own 401, which is the truthful outcome: the key is gone. Substituting an empty
 * header or falling back to no auth would turn a revoked key into a confusing agent error
 * with no mention of the key anywhere.
 */
export async function agentAuthHeaders(input: {
  reader: CredentialSecretReader;
  encryptionKey: string;
  auth: AgentAuth | null;
}): Promise<Record<string, string> | undefined> {
  if (!input.auth) return undefined;
  const stored = await input.reader.readSecret(input.auth.credentialId);
  if (!stored || stored.revokedAt) return undefined;
  return {
    [input.auth.header]: await decryptSecret(
      input.encryptionKey,
      stored.encryptedValue,
    ),
  };
}
