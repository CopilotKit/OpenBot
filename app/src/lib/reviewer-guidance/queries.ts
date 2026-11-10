import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** One request a person decided, with what the reviewer would do about it given the guidance. */
export type GuidanceBacktestRow = {
  id: string;
  createdAt: string;
  ownerUserId: string;
  /** What started the run: a person, a routine, a handoff. */
  initiator: { kind: string; id: string | null };
  bot: string;
  toolRef: string;
  effect: string;
  scope: string;
  /** The file, page, command or folder it was aimed at. */
  subject: { file?: string; page?: string; command?: string; folder?: string };
  /** What the person pressed when they were asked. */
  person: "allow_once" | "allow_always" | "deny";
  /** What the reviewer, with the guidance, would have done. `unreviewed` is no usable answer. */
  would: "proceed" | "ask" | "hand_off" | "unreviewed";
  outcome: "agree" | "let_through_denied" | "asked_allowed" | "unreviewed";
  /** The reviewer's own reason. */
  reason: string;
  /** Whether the conversation had words from a person for the reviewer to read. */
  hadRequest: boolean;
};

/**
 * The reviewer with the guidance, replayed over the requests people decided. Agreement is counted over
 * `reviewed`; the two kinds of disagreement are kept apart because they cost different things.
 */
export type GuidanceBacktest = {
  sample: number;
  reviewed: number;
  agreed: number;
  letThroughDenied: number;
  askedAllowed: number;
  unreviewed: number;
  withoutRequest: number;
  /** Decided requests passed over because a built-in safety requirement decides them first. */
  skippedSafety: number;
  rows: GuidanceBacktestRow[];
};

/** How many model calls a replay would make, worked out without making any. */
export type GuidanceBacktestPreview = { calls: number; skippedSafety: number };

export const reviewerGuidanceKeys = {
  all: ["reviewer-guidance"] as const,
  saved: ["reviewer-guidance", "saved"] as const,
  preview: ["reviewer-guidance", "backtest-preview"] as const,
};

/** The admin's guidance for auto-review in force now, or null for none. */
export const reviewerGuidanceQueryOptions = () =>
  queryOptions({
    queryKey: reviewerGuidanceKeys.saved,
    queryFn: (): Promise<string | null> =>
      client("/api/approvals/team/guidance", "guidance", {
        fallback: "Couldn't load the guidance for auto-review.",
      }),
  });

/** How many requests a replay would cover, and so how many model calls it would make. */
export const guidanceBacktestPreviewQueryOptions = () =>
  queryOptions({
    queryKey: reviewerGuidanceKeys.preview,
    queryFn: async (): Promise<GuidanceBacktestPreview> =>
      (
        await client("/api/approvals/team/guidance/backtest", {
          fallback: "Couldn't count the requests to test against.",
        })
      ).json(),
  });
