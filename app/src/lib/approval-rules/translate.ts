import type { ApprovalRuleInput } from "@/lib/approvals";
import { client } from "@/lib/client";

/** What is wrong with one field of one rule, counted from 1 as the screen counts them. */
export type RuleRowProblem = {
  row: number;
  field: keyof ApprovalRuleInput;
  message: string;
};

/**
 * Whether rules match real tools, kinds of action and Bots with the gate's own matcher, and what is
 * wrong with each field when they don't.
 */
export type RuleRowsCheck =
  | { ok: true }
  | { ok: false; error: string; problems: RuleRowProblem[] };

/**
 * Team approval rules the deployment's model wrote from an admin's description.
 *
 * `explanation` is a second reading of `rules` by a call that never saw the description, so it says
 * what they do rather than what was asked for. Null when they don't check. `summary` is the same
 * reading in one sentence. `warning` is set when a rule covers every action every Bot takes.
 */
export type ApprovalRuleTranslation = {
  rules: ApprovalRuleInput[];
  summary: string | null;
  explanation: string | null;
  check: RuleRowsCheck;
  warning: string | null;
};

/**
 * Description in, rules out. A plain function rather than a mutation: nothing is saved and nothing is
 * cached. The server records the request on the trail; saving the rules is still the admin's own act.
 */
export async function translateApprovalRules(
  text: string,
): Promise<ApprovalRuleTranslation> {
  const response = await client("/api/approvals/team/rules/translate", {
    method: "POST",
    body: { text },
    fallback: "Couldn't write the rules. Try again, or add the rule by hand.",
  });
  return (await response.json()) as ApprovalRuleTranslation;
}
