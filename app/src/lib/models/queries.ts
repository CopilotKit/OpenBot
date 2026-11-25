import { queryOptions } from "@tanstack/react-query";
import type {
  ModelCatalogueConnection,
  ModelChoice,
  ModelChoiceInput,
} from "@/lib/api/generated/model";

/**
 * One AI connection's models, where several are connected: its id (what a pick names), whose it is,
 * whether it can run now and why not, and its own models and default. Never a key or an address.
 */
export type CatalogueConnection = ModelCatalogueConnection;

import {
  getModelCatalogue,
  getModelChoice,
} from "@/lib/api/generated/models/models";
import { organizationId } from "@/lib/api/request";

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
  /**
   * Every AI connection the person's runs can use, each with its own models, the default first.
   * The fields above describe the default one. Absent from an OpenBot older than several
   * connections.
   */
  connections?: CatalogueConnection[];
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
export type ConversationModel = ModelChoice;

export type ConversationModelInput = ModelChoiceInput;

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
    queryFn: async ({ signal }): Promise<ModelCatalogue> =>
      getModelCatalogue(
        organizationId(),
        { view: "offered" },
        { signal, fallback: "Couldn't load models" },
      ),
    // The server keeps the provider's listing for ten minutes; asking more often learns nothing.
    staleTime: 5 * 60_000,
  });
}

/** Admin only: the whole listing, for choosing the model allowlist. */
export function availableModelsQueryOptions() {
  return queryOptions({
    queryKey: modelKeys.available,
    queryFn: async ({ signal }): Promise<AvailableModels> =>
      getModelCatalogue(
        organizationId(),
        { view: "all" },
        { signal, fallback: "Couldn't load the models" },
      ),
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
    queryFn: async ({ signal }): Promise<ConversationModel> =>
      getModelChoice(organizationId(), "me", channelId, {
        signal,
        fallback: "Couldn't load this conversation's model",
      }),
  });
}
