import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type CredentialStatus = {
  id: string;
  kind: "model" | "connector";
  provider: string;
  keyId: string;
  metadata: Record<string, unknown>;
  revokedAt: string | null;
};

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

export function credentialListQueryOptions() {
  return queryOptions({
    queryKey: credentialKeys.list(),
    queryFn: async (): Promise<CredentialStatus[]> => {
      return client("/api/admin/credentials", "credentials", {
        fallback: "Could not load credentials",
      });
    },
  });
}

/** Which model key the Bots read, or null where the server doesn't say. */
export function modelKeyQueryOptions() {
  return queryOptions({
    queryKey: credentialKeys.modelKey(),
    queryFn: async (): Promise<ModelKeyName | null> =>
      (await client<ModelKeyName | undefined>(
        "/api/admin/credentials",
        "modelKey",
        { fallback: "Could not load credentials" },
      )) ?? null,
  });
}
