import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createApiKey,
  deleteApiKey,
} from "@/lib/api/generated/api-keys/api-keys";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import { ClientError } from "@/lib/client";
import { type ApiKey, apiKeyKeys } from "./queries";

const CREATE_FALLBACK = "Couldn't create the API key. Try again.";
const REVOKE_FALLBACK = "Couldn't revoke the API key. Try again.";

/** What a person gives to make a key: what it is for. */
export type ApiKeyInput = { name: string };

/** A key just made. `key` is the key itself, which the API answers this once and never again. */
export type NewApiKey = { apiKey: ApiKey; key: string };

/** The API's code for "no such key". */
export const API_KEY_NOT_FOUND = "API_KEY_NOT_FOUND";

/**
 * Whether a refusal says the key is already gone: the API's own 404, `API_KEY_NOT_FOUND`. Revoked in
 * another tab, which is what the person asked for, so it is success. Any other 404 (a proxy, a
 * missing route) says nothing about the key and is a failure: the key may still work.
 */
export function alreadyRevoked(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    error.status === 404 &&
    error.code === API_KEY_NOT_FOUND
  );
}

function invalidateApiKeys(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
}

export function createApiKeyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: ApiKeyInput): Promise<NewApiKey> =>
      createApiKey(
        organizationId(),
        "me",
        input,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: CREATE_FALLBACK },
      ),
    // The key itself is handed to whoever asked and kept nowhere: it can't be read again, so a
    // copy left in the mutation cache would be the one place it outlived the dialog that showed it.
    gcTime: 0,
    onSuccess: () => invalidateApiKeys(queryClient),
  });
}

export function revokeApiKeyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (apiKeyId: string): Promise<void> => {
      try {
        await deleteApiKey(
          organizationId(),
          "me",
          apiKeyId,
          { "Idempotency-Key": idempotencyKey() },
          { fallback: REVOKE_FALLBACK },
        );
      } catch (error) {
        if (alreadyRevoked(error)) return;
        throw error;
      }
    },
    onSettled: () => invalidateApiKeys(queryClient),
  });
}
