import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { type ApprovalRuleInput, approvalsKey } from "@/lib/approvals";
import { client } from "@/lib/client";
import { approvalRuleKeys } from "./queries";

const FALLBACK = "The team rules could not be saved.";

/** Where saved rules came from: the sentence the model wrote them from. */
export type ApprovalRuleAuthoring = { source: "english"; text: string };

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
      client("/api/approvals/team/rules/batch", {
        method: "POST",
        body: variables,
        fallback: FALLBACK,
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: approvalsKey }),
        queryClient.invalidateQueries({ queryKey: approvalRuleKeys.all }),
      ]),
  });
