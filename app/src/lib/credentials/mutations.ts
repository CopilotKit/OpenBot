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
