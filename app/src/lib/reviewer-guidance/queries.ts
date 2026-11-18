import { queryOptions } from "@tanstack/react-query";
import type {
  ReviewerGuidanceReplay,
  ReviewerGuidanceReplayRow,
  ReviewerGuidanceReplaySample,
} from "@/lib/api/generated/model";
import {
  getReviewerGuidance,
  getReviewerGuidanceReplaySample,
} from "@/lib/api/generated/reviewer-guidance/reviewer-guidance";
import { organizationId } from "@/lib/api/request";

/**
 * One request a person decided, with what the reviewer would do about it given the guidance: what
 * the person pressed (`person`), what the reviewer would have done (`would`, where `unreviewed` is no
 * usable answer), its own `reason`, and whether the conversation had words from a person to read.
 */
export type GuidanceBacktestRow = ReviewerGuidanceReplayRow;

/**
 * The reviewer with the guidance, replayed over the requests people decided. Agreement is counted over
 * `reviewed`; the two kinds of disagreement are kept apart because they cost different things.
 */
export type GuidanceBacktest = ReviewerGuidanceReplay;

/** How many model calls a replay would make, worked out without making any. */
export type GuidanceBacktestPreview = ReviewerGuidanceReplaySample;

export const reviewerGuidanceKeys = {
  all: ["reviewer-guidance"] as const,
  saved: ["reviewer-guidance", "saved"] as const,
  preview: ["reviewer-guidance", "backtest-preview"] as const,
};

/** The admin's guidance for auto-review in force now, or null for none. */
export const reviewerGuidanceQueryOptions = () =>
  queryOptions({
    queryKey: reviewerGuidanceKeys.saved,
    queryFn: async ({ signal }): Promise<string | null> =>
      (
        await getReviewerGuidance(organizationId(), {
          signal,
          fallback: "Couldn't load the guidance for auto-review.",
        })
      ).guidance,
  });

/** How many requests a replay would cover, and so how many model calls it would make. */
export const guidanceBacktestPreviewQueryOptions = () =>
  queryOptions({
    queryKey: reviewerGuidanceKeys.preview,
    queryFn: ({ signal }): Promise<GuidanceBacktestPreview> =>
      getReviewerGuidanceReplaySample(organizationId(), undefined, {
        signal,
        fallback: "Couldn't count the requests to test against.",
      }),
  });
