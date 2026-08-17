import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { credentialKeys } from "./queries";

export type CredentialInput = {
  kind: "model" | "connector";
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  plaintext: string;
};

async function credentialRequest(path: string, body?: CredentialInput) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error("Credential operation failed");
}

export function createCredentialMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: CredentialInput) =>
      credentialRequest("/api/admin/credentials", input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: credentialKeys.all }),
  });
}

export function revokeCredentialMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (credentialId: string) =>
      credentialRequest(`/api/admin/credentials/${credentialId}/revoke`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: credentialKeys.all }),
  });
}
