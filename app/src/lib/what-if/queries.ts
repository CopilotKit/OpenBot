import type { WhatIfVocabulary } from "@openbot/shared/what-if";
import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export const whatIfKeys = {
  all: ["what-if"] as const,
  vocabulary: ["what-if", "vocabulary"] as const,
};

/**
 * What an action may name on this OpenBot: its Bots and their owners, its people and groups, and its
 * apps with their tools. The only values an action's chips hold, and the only ones the model may pick.
 */
export function whatIfVocabularyQueryOptions() {
  return queryOptions({
    queryKey: whatIfKeys.vocabulary,
    queryFn: async (): Promise<WhatIfVocabulary> =>
      (
        await client("/api/admin/what-if/vocabulary", {
          fallback: "Couldn't load this OpenBot's Bots and apps",
        })
      ).json(),
  });
}
