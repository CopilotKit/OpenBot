import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  approvalInboxOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";
import { RuleForm, RuleRow } from "./rules";

/**
 * The person's approval rules for one Bot, and the team rules that reach it, locked. Rules for every
 * Bot are in Settings → Approvals. A rule's `botId` is the Bot's id, or a pattern covering it.
 */
export function BotApprovalRules({ agentId }: { agentId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const error =
    inbox.error ?? addRule.error ?? changeRule.error ?? revoke.error;
  if (inbox.isPending && !error) return null;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  // Rules naming this Bot, including a pattern that covers it; rules for every Bot are in Settings.
  const mine = (inbox.data?.rules ?? []).filter(
    (rule) => rule.botId !== "*" && ruleCoversBot(rule.botId, agentId),
  );
  const team = (inbox.data?.teamRules ?? []).filter(
    (rule) => rule.botId === "*" || rule.botId === agentId,
  );

  return (
    <div className="mt-6 space-y-3">
      <p className="text-muted-foreground text-sm">
        The strictest matching rule wins, so an "ask" rule beats an "allow" one.
        Rules for every Bot are in{" "}
        <Link className="underline underline-offset-4" to="/settings/approvals">
          Settings → Approvals
        </Link>
        .
        {rulesOff
          ? " Your team has switched personal rules off, so they are kept but do not apply."
          : ""}
      </p>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {team.map((rule) => (
        <RuleRow
          disabled
          key={rule.id}
          locked
          onChange={() => {}}
          onRevoke={() => {}}
          rule={rule}
          team
        />
      ))}
      {mine.map((rule) => (
        <RuleRow
          disabled={revoke.isPending || changeRule.isPending}
          key={rule.id}
          locked={rulesOff}
          onChange={(behaviour) =>
            changeRule.mutate({ id: rule.id, behaviour })
          }
          onRevoke={() => revoke.mutate(rule.id)}
          rule={rule}
        />
      ))}
      {mine.length === 0 && team.length === 0 ? (
        <p className="text-muted-foreground text-sm">No rules for this Bot.</p>
      ) : null}
      {inbox.data?.preferences && !rulesOff ? (
        <RuleForm
          botField={false}
          forBot={agentId}
          label="Add a rule"
          onSave={(input) => addRule.mutate(input)}
          pending={addRule.isPending}
        />
      ) : null}
    </div>
  );
}
