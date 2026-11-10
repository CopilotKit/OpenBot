import { queryOptions } from "@tanstack/react-query";
import type { ApprovalRuleInput } from "@/lib/approvals";
import { client } from "@/lib/client";
import type { RuleRowsCheck } from "./translate";

type Behaviour = "allow" | "ask" | "hand_off" | "deny";

/** One action the gate already decided that candidate rules are about. */
export type BacktestChange = {
  id: string;
  createdAt: string;
  /** The person the Bot acted for. */
  ownerUserId: string | null;
  /** What started the run: a person, a routine, a handoff. */
  initiator: { kind: string; id: string | null };
  bot: string;
  toolRef: string;
  effect: string;
  scope: string;
  /** The file, page, command or folder it was aimed at, as its audit row names it. */
  subject: { file?: string; page?: string; command?: string; folder?: string };
  was: Behaviour;
  /** Which layer decided what happened: `safety`, `team_rule`, `personal_rule`, `default`… */
  wasSource: string;
  would: Behaviour;
  /** `fixed` is an action whose verdict no rule changes, listed as unchanged. */
  change: "removes_ask" | "adds_ask" | "stricter" | "looser" | "fixed";
  /** What the person answered when they were asked. */
  person:
    | "allow_once"
    | "allow_conversation"
    | "allow_always"
    | "deny"
    | "handled"
    | "waiting"
    | "withdrawn"
    | null;
  /** Which rule decided it, counted from 1. */
  rule: number;
  reason: string;
};

export type ApprovalBacktest = {
  scanned: number;
  matched: number;
  changed: number;
  removedAsks: number;
  removedDenied: number;
  addedAsks: number;
  fixed: number;
  /** Changed first, denied asks first of all, then unchanged ones. Capped; the counts are not. */
  changes: BacktestChange[];
};

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
    queryFn: async (): Promise<ApprovalRulesPreview> =>
      (
        await client("/api/approvals/team/rules/backtest", {
          method: "POST",
          body: { rules },
          fallback: "The rules could not be tested against history.",
        })
      ).json(),
    retry: false,
  });
}
