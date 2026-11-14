import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createCredential,
  revokeCredential,
} from "@/lib/api/generated/credentials/credentials";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { credentialKeys } from "./queries";

const FALLBACK = "Credential operation failed";

export type CredentialInput = {
  kind: "model" | "connector";
  provider: string;
  /** Left out of a model key, which the server files under the name the Bots read. */
  keyId?: string;
  metadata: Record<string, string>;
  /** Write-only: the server never sends it back. */
  secret: string;
};

export function createCredentialMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: CredentialInput) =>
      createCredential(
        ORGANIZATION_ID,
        input,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: credentialKeys.all }),
  });
}

export function revokeCredentialMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (credentialId: string) =>
      revokeCredential(
        ORGANIZATION_ID,
        credentialId,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: credentialKeys.all }),
  });
}

/**
 * Store an MCP server's token and hand back the credential id.
 *
 * A plain function rather than a factory, because it is a step inside another write rather than a
 * write somebody asked for: a plugin server record keeps only the credential id, so the token has to
 * become a credential before the server can be created. Returns `undefined` for an empty token,
 * which is how a server with no auth is added.
 *
 * The token goes one way. What a later read returns is that a credential exists, never its value.
 */
export async function storeMcpToken(
  serverId: string,
  token?: string,
): Promise<string | undefined> {
  if (!token?.trim()) return undefined;
  const credential = await createCredential(
    ORGANIZATION_ID,
    {
      kind: "mcp",
      provider: serverId,
      keyId: `mcp-${serverId}`,
      secret: token.trim(),
      metadata: { server: serverId },
    },
    { "Idempotency-Key": idempotencyKey() },
    { fallback: "The token could not be stored." },
  );
  return credential.id;
}
