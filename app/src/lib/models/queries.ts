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

export const modelKeys = {
  all: ["models"] as const,
  catalogue: ["models", "catalogue"] as const,
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
