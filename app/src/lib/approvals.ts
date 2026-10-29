import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
export type ApprovalDecision =
  | "allow_once"
  | "allow_always"
  | "deny"
  | "handled";
export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";
export type HostCommandPolicy = "ask" | "allow" | "never";
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalRuleRow = ApprovalRuleInput & { id: string };
export const BEHAVIOUR_LABELS: Record<RuleBehaviour, string> = {
  allow: "Take action without asking",
  pre_approved: "Take action if pre-approved",
  ask: "Ask before taking action",
  hand_off: "Hand off to you",
};
/** One action a Bot asked to take, as the inbox returns it: waiting, decided, or done. */
export type ApprovalRequest = {
  id: string;
  /** "pending", "approved", "denied", "consumed" (running), or "completed". */
  status: string;
  createdAt: string;
  action: {
    botId: string;
    toolRef: string;
    effect: string;
    scope: string;
    threadId: string;
    toolCallId?: string;
    args: unknown;
    target: unknown;
    policy?: {
      behaviour: "allow" | "ask" | "hand_off" | "deny";
      source: string;
      reason: string;
    };
  };
  /**
   * What was chosen: by the person, or `allow_always` by a saved rule as the request opened. Null
   * while it waits, and for a request withdrawn before anyone answered.
   */
  decision?: ApprovalDecision | null;
  /** ISO-8601, when it was decided. */
  decidedAt?: string | null;
  /** ISO-8601, when the action finished running. */
  completedAt?: string | null;
  /** How running it went. The content stays on the server. */
  result?: { error?: string } | null;
};
/** A question a Bot asked mid-run and is waiting on the person to answer. */
export type PersonQuestion = {
  id: string;
  botId: string;
  /** The Bot whose conversation this belongs to: for a hand-off, the Bot that handed it on. */
  conversationBotId?: string;
  threadId: string;
  question: string;
  why?: string;
  createdAt: string;
};
export type ApprovalInboxData = {
  enabled: boolean;
  requests: ApprovalRequest[];
  rules: ApprovalRuleRow[];
  teamRules: ApprovalRuleRow[];
  preferences?: {
    enabled: boolean;
    autoReview: boolean;
    hostCommands: HostCommandPolicy;
  };
  team?: {
    enforceAutoReview: boolean;
    customRulesEnabled: boolean;
    hostCommandsCap: HostCommandPolicy;
  };
  /** The member's command policy after the team cap. */
  hostCommands?: HostCommandPolicy;
  questions: PersonQuestion[];
};
export const approvalInboxOptions = () =>
  queryOptions({
    queryKey: ["approvals"],
    queryFn: async (): Promise<ApprovalInboxData> => {
      const response = await client("/api/approvals", {
        fallback: "Your approvals could not be loaded.",
      });
      return response.json();
    },
    refetchInterval: 10_000,
  });
export const decideApproval = (id: string, decision: ApprovalDecision) =>
  client(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: { decision },
    fallback: "Your decision could not be saved.",
  });
export const revokeApprovalRule = (id: string) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "The permission could not be revoked.",
  });
export const setApprovalEnabled = (enabled: boolean) =>
  setApprovalPreferences({ enabled });
export const setApprovalPreferences = (input: {
  enabled?: boolean;
  autoReview?: boolean;
  hostCommands?: HostCommandPolicy;
}) =>
  client("/api/approvals/preferences", {
    method: "PATCH",
    body: input,
    fallback: "Your approval preference could not be saved.",
  });
export const createApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/rules", {
    method: "POST",
    body: input,
    fallback: "The rule could not be saved.",
  });
export const setTeamApprovalSettings = (input: {
  enforceAutoReview?: boolean;
  customRulesEnabled?: boolean;
  hostCommandsCap?: HostCommandPolicy;
}) =>
  client("/api/approvals/team", {
    method: "PATCH",
    body: input,
    fallback: "The team setting could not be saved.",
  });
export const createTeamApprovalRule = (input: ApprovalRuleInput) =>
  client("/api/approvals/team/rules", {
    method: "POST",
    body: input,
    fallback: "The team rule could not be saved.",
  });
export const revokeTeamApprovalRule = (id: string) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "The team rule could not be removed.",
  });
export const answerPersonQuestion = (id: string, response: string) =>
  client(`/api/approvals/questions/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: { response },
    fallback: "Your answer could not be saved.",
  });
export const updateApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "The rule could not be changed.",
  });
export const updateTeamApprovalRule = (
  id: string,
  input: Partial<ApprovalRuleInput>,
) =>
  client(`/api/approvals/team/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
    fallback: "The team rule could not be changed.",
  });

const approvalsKey = ["approvals"] as const;
const settle = (queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: approvalsKey });

export const approvalPreferencesMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: setApprovalPreferences,
    onSettled: settle(queryClient),
  });
export const createApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: createApprovalRule,
    onSettled: settle(queryClient),
  });
export const updateApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateApprovalRule(id, { behaviour }),
    onSettled: settle(queryClient),
  });
export const revokeApprovalRuleMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: revokeApprovalRule,
    onSettled: settle(queryClient),
  });
export const teamApprovalSettingsMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: setTeamApprovalSettings,
    onSettled: settle(queryClient),
  });
export const createTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: createTeamApprovalRule,
    onSettled: settle(queryClient),
  });
export const updateTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: ({ id, behaviour }: { id: string; behaviour: RuleBehaviour }) =>
      updateTeamApprovalRule(id, { behaviour }),
    onSettled: settle(queryClient),
  });
export const revokeTeamApprovalRuleMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: revokeTeamApprovalRule,
    onSettled: settle(queryClient),
  });
/**
 * Allow once, always allow, decline, or "I did it myself" on one waiting action.
 *
 * THE ONE WRITE HERE THAT ALSO PATCHES THE INBOX, before reading it again. The card folds as soon
 * as the decision is saved, and stays folded if that read fails: left pending, it showed its buttons
 * again and a second press was refused as "already decided". Only what the server just answered is
 * written: the decision it accepted, the status it returned (or the one `decide` sets for it), and
 * the time. Everything else waits for the read.
 */
export const decideApprovalMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: async ({
      id,
      choice,
    }: {
      id: string;
      choice: ApprovalDecision;
    }): Promise<{ status?: string }> =>
      // Saved once this resolves. A body that does not parse loses only the status, not the answer.
      (await decideApproval(id, choice)).json().catch(() => ({})),
    onSuccess: async (saved, { id, choice }) => {
      queryClient.setQueryData<ApprovalInboxData>(
        approvalInboxOptions().queryKey,
        (inbox) =>
          inbox && {
            ...inbox,
            requests: inbox.requests.map((request) =>
              request.id === id
                ? {
                    ...request,
                    decision: choice,
                    decidedAt: new Date().toISOString(),
                    status:
                      saved.status ??
                      (choice === "deny" ? "denied" : "approved"),
                  }
                : request,
            ),
          },
      );
      await settle(queryClient)();
    },
  });
/** Answer a question a Bot asked mid-run; the run resumes with the answer. */
export const answerPersonQuestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, response }: { id: string; response: string }) =>
      answerPersonQuestion(id, response),
    onSuccess: settle(queryClient),
  });

/**
 * Whether a rule's Bot field covers this Bot, matched the way the server matches it (`policy.ts`):
 * `*` is anything, and a `*` inside a value is any run of characters.
 */
export function ruleCoversBot(pattern: string, agentId: string): boolean {
  if (pattern === "*") return true;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(agentId);
}
