import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The models a person may pick for a built-in Bot's run. See server/src/model-catalogue.ts.
 *
 * Read from whatever serves OpenBot's model: the provider, or a gateway or router in front of it.
 * The ids are what a run sends; the labels are what the picker shows. The server has already
 * narrowed the list to the admin's allowlist, so the browser offers exactly what it is given.
 */
export type ModelOption = {
  id: string;
  label: string;
  /** Who makes it, as a brand id for its mark. Absent for a gateway alias that names no vendor. */
  vendor?: string;
};

export type ModelCatalogue = {
  provider: "openai" | "anthropic";
  /** What a run uses when nobody picked anything. Always one of `models`. */
  default: string;
  /** Newest first. */
  models: ModelOption[];
  /** Whether there is anything to pick. False hides the picker. */
  choosable: boolean;
};

/**
 * Every model the provider or gateway lists, before the admin's allowlist narrows it. What an admin
 * picks the allowlist from. `listed` is false when the listing could not be read.
 */
export type AvailableModels = {
  provider: "openai" | "anthropic";
  default: string;
  /** Newest first. Always holds the default. */
  models: ModelOption[];
  listed: boolean;
};

export const modelKeys = {
  all: ["models"] as const,
  catalogue: ["models", "catalogue"] as const,
  available: ["models", "available"] as const,
  conversation: (channelId: string) =>
    ["models", "conversation", channelId] as const,
};

export function modelCatalogueQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.catalogue,
    queryFn: async (): Promise<ModelCatalogue> =>
      (
        await client("/api/models", { fallback: "Couldn't load models" })
      ).json(),
    // The server keeps the provider's listing for ten minutes; asking more often learns nothing.
    staleTime: 5 * 60_000,
  });
}

/** Admin only: the whole listing, for choosing the model allowlist. */
export function availableModelsQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.available,
    queryFn: async (): Promise<AvailableModels> =>
      (
        await client("/api/models/available", {
          fallback: "Couldn't load the models",
        })
      ).json(),
    staleTime: 5 * 60_000,
  });
}

/**
 * The model the signed-in person picked for one conversation, or null for OpenBot's own. Null too
 * while an admin has picking off, or when the saved pick is no longer offered: the server answers
 * with what a run there would use.
 */
export function conversationModelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: modelKeys.conversation(channelId),
    queryFn: (): Promise<string | null> =>
      client(`/api/channels/${encodeURIComponent(channelId)}/model`, "model", {
        fallback: "Couldn't load this conversation's model",
      }),
  });
}
