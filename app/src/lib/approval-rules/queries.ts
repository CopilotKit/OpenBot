import { queryOptions } from "@tanstack/react-query";
import { replayApprovalRules } from "@/lib/api/generated/approval-rules/approval-rules";
import type {
  ApprovalRuleDraftReplayChange,
  ApprovalRuleDraftReplayReport,
} from "@/lib/api/generated/model";
import { idempotencyKey, organizationId } from "@/lib/api/request";
import type { ApprovalRuleInput } from "@/lib/approvals";
import type { RuleRowsCheck } from "./translate";

/**
 * One action the gate already decided that candidate rules are about: who the Bot acted for, what
 * started the run, what it was aimed at, what happened (`was`, and `wasSource` for what decided it),
 * what would happen with the rules (`would`), and what the person answered when they were asked.
 * `change` is `fixed` for an action whose verdict no rule changes, listed as unchanged.
 */
export type BacktestChange = ApprovalRuleDraftReplayChange;

/** Changed first, denied asks first of all, then unchanged ones. `changes` is capped; the counts are not. */
export type ApprovalBacktest = ApprovalRuleDraftReplayReport;

export type ApprovalRulesPreview = {
  /** The rules as they stand now, checked against this OpenBot's tools and Bots. */
  check: RuleRowsCheck;
  warning: string | null;
  report: ApprovalBacktest;
};

export const approvalRuleKeys = {
  all: ["approval-rules"] as const,
  backtest: (rules: readonly ApprovalRuleInput[]) =>
    ["approval-rules", "backtest", { rules }] as const,
};

/**
 * What these rules would have changed, about actions the approval gate already decided, and whether
 * they check. Writes nothing.
 *
 * Keyed by the rules themselves: the answer is about those rules and nothing else, and editing back
 * to rules already tried answers from the cache. Not retried, as a boundary's dry-run is not.
 */
export function approvalRulesBacktestQueryOptions(
  rules: readonly ApprovalRuleInput[],
) {
  return queryOptions({
    queryKey: approvalRuleKeys.backtest(rules),
    queryFn: async ({ signal }): Promise<ApprovalRulesPreview> =>
      (await replayApprovalRules(
        organizationId(),
        { rules: [...rules] },
        { "Idempotency-Key": idempotencyKey() },
        {
          signal,
          fallback: "The rules could not be tested against history.",
        },
      )) as ApprovalRulesPreview,
    retry: false,
  });
}
