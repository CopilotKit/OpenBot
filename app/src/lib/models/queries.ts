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
  /**
   * The thinking efforts this model accepts, weakest first, from `none`, `minimal`, `low`, `medium`,
   * `high`, `xhigh` and `max`. Absent or empty for a model that takes no effort, which then shows
   * no thinking control.
   */
  efforts?: string[];
  /** The effort the model uses when none is sent, when its provider says. Absent when unknown. */
  defaultEffort?: string;
};

/**
 * Who actually serves the models: a provider's own API, an OpenAI-compatible endpoint in front of
 * one, or a ChatGPT or Claude plan. What the Providers page names.
 */
export type ModelSource =
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "gateway"
  | "chatgpt"
  | "claude";

/**
 * Who decides which models people may pick. `all`: one person on their own machine, offered every
 * model the credential lists. `allowed`: a team, where an admin allows models in Admin, Providers.
 */
export type ModelExposure = "all" | "allowed";

export type ModelCatalogue = {
  /** The allowlist's `provider/model` prefix. Not who serves the models; that is `source`. */
  provider: "openai" | "anthropic";
  source: ModelSource;
  exposure: ModelExposure;
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
  source: ModelSource;
  exposure: ModelExposure;
  default: string;
  /** Newest first. Always holds the default. */
  models: ModelOption[];
  listed: boolean;
};

/**
 * One person's pick for one conversation, as the server holds it. A null model is the default
 * model; a null effort is the model's own default, so none is sent.
 */
export type ConversationModel = {
  model: string | null;
  effort: string | null;
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
 * The model and effort the signed-in person picked for one conversation, each null for the
 * default. Null too while an admin has picking off, or when the saved pick is no longer offered:
 * the server answers with what a run there would use.
 */
export function conversationModelQueryOptions(channelId: string) {
  return queryOptions({
    queryKey: modelKeys.conversation(channelId),
    queryFn: async (): Promise<ConversationModel> =>
      (
        await client(`/api/channels/${encodeURIComponent(channelId)}/model`, {
          fallback: "Couldn't load this conversation's model",
        })
      ).json(),
  });
}
