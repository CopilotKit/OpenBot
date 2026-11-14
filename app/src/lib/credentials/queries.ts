import { queryOptions } from "@tanstack/react-query";
import {
  getModelKey,
  listCredentials,
} from "@/lib/api/generated/credentials/credentials";
import type { Credential } from "@/lib/api/generated/model";
import { ORGANIZATION_ID } from "@/lib/api/request";
import { ClientError } from "@/lib/client";

/**
 * A credential the vault keeps, as the API shows it: what it is for and whether it is live. Never
 * its secret, which only ever goes in.
 */
export type CredentialStatus = Credential;

/** The AI providers a model key can be for: the ones OpenBot's own Bots run on. */
export type ModelProvider = "openai" | "anthropic";

/**
 * The one model key OpenBot's own Bots read: the provider they run on, and the name the key is
 * filed under. A model key saved for that provider is filed under that name by the server.
 */
export type ModelKeyName = {
  provider: ModelProvider;
  keyId: string;
};

export const credentialKeys = {
  all: ["credentials"] as const,
  list: () => [...credentialKeys.all, "list"] as const,
  modelKey: () => [...credentialKeys.all, "model-key"] as const,
};

const FALLBACK = "Could not load credentials";

/** Every credential the vault keeps, live and revoked, oldest first: every page of the list. */
export function credentialListQueryOptions() {
  return queryOptions({
    queryKey: credentialKeys.list(),
    queryFn: async ({ signal }): Promise<CredentialStatus[]> => {
      const credentials: CredentialStatus[] = [];
      let cursor: string | undefined;
      do {
        const page = await listCredentials(
          ORGANIZATION_ID,
          { limit: 100, ...(cursor ? { cursor } : {}) },
          { signal, fallback: FALLBACK },
        );
        credentials.push(...page.credentials);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return credentials;
    },
  });
}

/**
 * Which model key the Bots read, or null where this OpenBot's Bots read none from the vault (the
 * API's not found).
 */
export function modelKeyQueryOptions() {
  return queryOptions({
    queryKey: credentialKeys.modelKey(),
    queryFn: async ({ signal }): Promise<ModelKeyName | null> => {
      try {
        const { provider, keyId } = await getModelKey(ORGANIZATION_ID, {
          signal,
          fallback: FALLBACK,
        });
        return { provider, keyId };
      } catch (error) {
        if (
          error instanceof ClientError &&
          error.code === "MODEL_KEY_NOT_FOUND"
        )
          return null;
        throw error;
      }
    },
  });
}
