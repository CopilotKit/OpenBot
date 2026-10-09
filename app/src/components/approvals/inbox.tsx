import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  approvalInboxOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { queryClient as appQueryClient } from "@/query-client";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { RuleForm, RuleRow } from "./rules";
import { WaitingForYou } from "./waiting";

/**
 * What is waiting for the person, and rules that name a single Bot.
 *
 * Whether to ask at all, and rules for every Bot, are in Settings → Approvals; team settings are in
 * Admin → Approvals.
 */
export function ApprovalInbox() {
  const inbox = useQuery(approvalInboxOptions());
  const addRule = useMutation(
    createApprovalRuleMutationOptions(appQueryClient),
  );
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(appQueryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(appQueryClient));
  const error =
    inbox.error ?? addRule.error ?? changeRule.error ?? revoke.error;
  const me = useQuery(currentUserQueryOptions()).data;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  const oneBot = (inbox.data?.rules ?? []).filter((rule) => rule.botId !== "*");
  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Whether your Bots ask before acting, and rules for every Bot, are in{" "}
        <Link className="underline underline-offset-4" to="/settings/approvals">
          Settings → Approvals
        </Link>
        .
        {me?.role === "admin" ? (
          <>
            {" "}
            Team settings and shared account requests are in{" "}
            <Link
              className="underline underline-offset-4"
              to="/admin/approvals"
            >
              Admin → Approvals
            </Link>
            .
          </>
        ) : null}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      <WaitingForYou />
      <div className="space-y-3">
        <h2 className="font-medium">Rules for one Bot</h2>
        {rulesOff ? (
          <p className="text-sm text-muted-foreground">
            Your team has switched personal rules off, so they are kept but do
            not apply.
          </p>
        ) : null}
        {oneBot.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            locked={rulesOff}
            disabled={revoke.isPending || changeRule.isPending}
            onRevoke={() => revoke.mutate(rule.id)}
            onChange={(behaviour) =>
              changeRule.mutate({ id: rule.id, behaviour })
            }
          />
        ))}
        {oneBot.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rules for a single Bot.
          </p>
        ) : null}
        {inbox.data?.preferences && !rulesOff ? (
          <RuleForm
            label="Add a rule for one Bot"
            oneBot
            pending={addRule.isPending}
            onSave={(input) => addRule.mutate(input)}
          />
        ) : null}
      </div>
    </div>
  );
}
