import {
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
}): Promise<AgentAuth> {
  const credential = await input.store.create({
    kind: "agent",
    provider: "ag-ui",
    keyId: input.agentId,
    // The header name is metadata precisely because it is not a secret; keeping it here makes the
    // vault row self-describing for later audit.
    metadata: { header: input.header },
    encryptedValue: await encryptSecret(input.encryptionKey, input.value),
  });
  return { header: input.header, credentialId: credential.id };
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
