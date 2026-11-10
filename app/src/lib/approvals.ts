import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { botLifecycleKeys } from "@/lib/bot-lifecycle/queries";
import { client } from "@/lib/client";
export type ApprovalDecision =
  | "allow_once"
  | "allow_conversation"
  | "allow_always"
  | "deny"
  | "handled";
export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";
/** The kinds of action OpenBot asks about by name, as server/src/approvals/types.ts lists them. */
export type ActionKind =
  | "deleting"
  | "sending"
  | "sharing"
  | "publishing"
  | "payments"
  | "credentials"
  | "security_settings";
/** What the admin lets members do about a kind: open, ask every time, or leave it to them. */
export type ActionKindPolicy = "open" | "ask" | "hand_off";
/**
 * One "Allow for this conversation": what it allows, and in which conversation. Drawn in that
 * conversation, with a way to turn it off.
 */
export type ConversationGrant = {
  id: string;
  threadId: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  account?: string;
  kind?: ActionKind;
  createdAt: string;
};
export type HostCommandPolicy = "ask" | "allow" | "never";
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
export type ApprovalRuleRow = ApprovalRuleInput & {
  id: string;
  /** The one account at the app a saved rule is for, where the person holds several. */
  account?: string | null;
};
export const BEHAVIOUR_LABELS: Record<RuleBehaviour, string> = {
  allow: "Take action without asking",
  pre_approved: "Take action if pre-approved",
  ask: "Ask before taking action",
  hand_off: "Hand off to you",
};
export type ApprovalInboxData = {
  enabled: boolean;
  requests: {
    id: string;
    status: string;
    createdAt: string;
    /** When the person (or a rule) decided it; null while it waits. */
    decidedAt?: string | null;
    action: {
      botId: string;
      toolRef: string;
      effect: string;
      scope: string;
      threadId: string;
      toolCallId?: string;
      args: unknown;
      target: unknown;
      /** Which of the person's accounts at the app, where they hold several. */
      account?: string;
      policy?: {
        behaviour: "allow" | "ask" | "hand_off" | "deny";
        source: string;
        reason: string;
        kind?: ActionKind;
        /** The admin set this kind to ask every time: Allow once and Deny only. */
        closed?: boolean;
      };
    };
  }[];
  rules: ApprovalRuleRow[];
  teamRules: ApprovalRuleRow[];
  /** "Allow for this conversation" answers still in force, in every conversation. */
  conversationGrants?: ConversationGrant[];
  preferences?: {
    enabled: boolean;
    autoReview: boolean;
    hostCommands: HostCommandPolicy;
  };
  team?: {
    enforceAutoReview: boolean;
    customRulesEnabled: boolean;
    hostCommandsCap: HostCommandPolicy;
    /** The kinds the admin closed. A kind not named is open. */
    actionKinds?: Partial<Record<ActionKind, ActionKindPolicy>>;
  };
  /** The member's command policy after the team cap. */
  hostCommands?: HostCommandPolicy;
  questions: {
    id: string;
    botId: string;
    /** The Bot whose conversation this belongs to: for a hand-off, the Bot that handed it on. */
    conversationBotId?: string;
    threadId: string;
    /** The conversation it was asked in, which is where it is answered. */
    channelId?: string;
    question: string;
    why?: string;
    /** The separate decisions inside the question, each answered on its own. */
    parts?: { header: string; question: string; options?: string[] }[];
    createdAt: string;
  }[];
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
/**
 * A request the person has decided and the server has not finished carrying on from.
 *
 * Decided (`approved` or `denied`) or started (`consumed`), the server runs the action, or tells the
 * Bot it was declined, and then picks the conversation up where it stopped, in a turn no browser
 * streams. It marks the request `completed` only once that turn has ended. So between the two, the
 * conversation is the Bot's: the same fact a run on the wire is for a turn started here.
 */
const CARRYING_ON = new Set(["approved", "denied", "consumed"]);

/**
 * How long after the decision a request still counts as the server carrying on.
 *
 * The server stops a turn it carries on at five minutes (`TURN_LIMITS.turnTimeoutMs` in
 * toolkit/limits.ts), and this allows twice that, as the routine sweep does for a run. A request
 * still not `completed` after it is one the resume loop is retrying or giving up on, not a turn this
 * conversation is in, and counting it would leave "Thinking" and Stop up, and messages parked behind
 * them, for good.
 */
const CARRY_ON_MS = 2 * 5 * 60_000;

/** Whether the server is carrying this conversation on after one of its approvals was decided. */
export function carryingOnAfterApproval(
  inbox: ApprovalInboxData | undefined,
  threadId: string,
  now = Date.now(),
): boolean {
  return (inbox?.requests ?? []).some(
    (request) =>
      request.action.threadId === threadId &&
      CARRYING_ON.has(request.status) &&
      now - Date.parse(request.decidedAt ?? request.createdAt) < CARRY_ON_MS,
  );
}

/** Whether a conversation asks before every step, by its thread. Its own root: see below. */
export const approvalThreadKeys = {
  all: ["approval-thread"] as const,
  detail: (threadId: string) => ["approval-thread", threadId] as const,
};
/**
 * Whether this conversation asks before every step, which a task's started from a check-in does, as
 * the server's gate decides it. Never stale: a conversation is a task's from the moment it exists,
 * or never. Kept apart from `["approvals"]`, which every decision invalidates.
 */
export const threadAsksEveryStepQueryOptions = (threadId: string) =>
  queryOptions({
    queryKey: approvalThreadKeys.detail(threadId),
    queryFn: (): Promise<boolean> =>
      client(
        `/api/approvals/threads/${encodeURIComponent(threadId)}`,
        "asksEveryStep",
        { fallback: "This conversation's approvals could not be checked." },
      ),
    staleTime: Number.POSITIVE_INFINITY,
  });
export const decideApproval = (id: string, decision: ApprovalDecision) =>
  client(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: { decision },
    fallback: "Your decision could not be saved.",
  });
export const revokeConversationGrant = (id: string) =>
  client(`/api/approvals/conversation-grants/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Couldn't turn that off. Try again.",
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
  actionKinds?: Partial<Record<ActionKind, ActionKindPolicy>>;
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
/**
 * Answer a question a Bot asked. Given in the open conversation (`inConversation`), it may be that
 * conversation's to carry on: true means the question is closed and the conversation runs the answer
 * as its own next turn; false means the server resumes the run that asked.
 */
export const answerPersonQuestion = async (
  id: string,
  response: string,
  inConversation = false,
) =>
  (await client<boolean | undefined>(
    `/api/approvals/questions/${encodeURIComponent(id)}/respond`,
    "continueHere",
    {
      method: "POST",
      body: inConversation ? { response, inConversation } : { response },
      fallback: "Your answer could not be saved.",
    },
  )) === true;
export const dismissPersonQuestion = (id: string) =>
  client(`/api/approvals/questions/${encodeURIComponent(id)}/dismiss`, {
    method: "POST",
    fallback: "Couldn't dismiss that question.",
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

/** The inbox's key, which every approval write invalidates: requests, rules and settings alike. */
export const approvalsKey = ["approvals"] as const;
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
/** Turn off one "Allow for this conversation": the next such action there asks again. */
export const revokeConversationGrantMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: revokeConversationGrant,
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
/** Allow once, for this conversation or always, deny, or "I did it myself" on one waiting action. */
export const decideApprovalMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, choice }: { id: string; choice: ApprovalDecision }) =>
      decideApproval(id, choice),
    onSuccess: settle(queryClient),
  });
/** Answer a question a Bot asked mid-run; the run resumes with the answer. */
export const answerPersonQuestionMutationOptions = (queryClient: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      response,
      inConversation,
    }: {
      id: string;
      response: string;
      inConversation?: boolean;
    }) => answerPersonQuestion(id, response, inConversation),
    /*
     * Answered is answered, whatever the turn that carries the answer comes to: the question's card
     * goes at once, and the badge that counted it is read again rather than on its next poll.
     */
    onSuccess: (_continueHere, { id }) => {
      queryClient.setQueryData<ApprovalInboxData>(approvalsKey, (inbox) =>
        inbox
          ? {
              ...inbox,
              questions: inbox.questions.filter(
                (question) => question.id !== id,
              ),
            }
          : inbox,
      );
      void queryClient.invalidateQueries({
        queryKey: botLifecycleKeys.attention,
      });
      return settle(queryClient)();
    },
  });

/** Put a question down unanswered. Everything is read again: a task waiting on it moves on too. */
export const dismissPersonQuestionMutationOptions = (
  queryClient: QueryClient,
) =>
  mutationOptions({
    mutationFn: ({ id }: { id: string }) => dismissPersonQuestion(id),
    onSuccess: () => queryClient.invalidateQueries(),
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
