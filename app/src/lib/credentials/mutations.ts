import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { credentialKeys } from "./queries";

export type CredentialInput = {
  kind: "model" | "connector";
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  plaintext: string;
};

export function createCredentialMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: CredentialInput) =>
      client("/api/admin/credentials", {
        method: "POST",
        body: input,
        fallback: "Credential operation failed",
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: credentialKeys.all }),
  });
}

export function revokeCredentialMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (credentialId: string) =>
      client(`/api/admin/credentials/${credentialId}/revoke`, {
        method: "POST",
        fallback: "Credential operation failed",
      }),
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
  const credential = await client<{ id: string }>(
    "/api/admin/credentials",
    "credential",
    {
      method: "POST",
      body: {
        kind: "mcp",
        provider: serverId,
        keyId: `mcp-${serverId}`,
        plaintext: token.trim(),
        metadata: { server: serverId },
      },
      fallback: "The token could not be stored.",
    },
  );
  return credential?.id;
}
