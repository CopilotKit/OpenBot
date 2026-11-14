import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { batchCreateApprovalRules } from "@/lib/api/generated/approval-rules/approval-rules";
import type { ApprovalRuleDraftAuthoring } from "@/lib/api/generated/model";
import { idempotencyKey, ORGANIZATION_ID } from "@/lib/api/request";
import { type ApprovalRuleInput, approvalsKey } from "@/lib/approvals";
import { approvalRuleKeys } from "./queries";

const FALLBACK = "The team rules could not be saved.";

/** Where saved rules came from: the sentence the model wrote them from. */
export type ApprovalRuleAuthoring = ApprovalRuleDraftAuthoring;

/**
 * Several team rules in one save, with the sentence they were written from. The server refuses them,
 * saying what is wrong, unless every rule checks, and records the save once with the rules before
 * and after.
 */
export const saveTeamRulesMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: (variables: {
      rules: ApprovalRuleInput[];
      authoring?: ApprovalRuleAuthoring;
    }) =>
      batchCreateApprovalRules(
        ORGANIZATION_ID,
        variables,
        { "Idempotency-Key": idempotencyKey() },
        { fallback: FALLBACK },
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: approvalsKey }),
        queryClient.invalidateQueries({ queryKey: approvalRuleKeys.all }),
      ]),
  });
