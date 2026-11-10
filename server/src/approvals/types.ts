import { createHash } from "node:crypto";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import {
  type ApprovalContinuation,
  currentApprovalContext,
  withApprovalContext,
} from "@openbot/toolkit/continuation";
import type { AuditEventInput, AuditInitiator } from "../audit";
import { cutAtCodeUnits } from "../channels/text";

/**
 * `handled` answers a hand-off: the person did it themselves, so it is never executed for them.
 * `allow_conversation` allows this action now and for the rest of this conversation: the same tool,
 * the same Bot, the same target and account, in this conversation only (see `conversationGrant`).
 */
export type ApprovalDecision =
  | "allow_once"
  | "allow_conversation"
  | "allow_always"
  | "deny"
  | "handled";
export const APPROVAL_DECISIONS = [
  "allow_once",
  "allow_conversation",
  "allow_always",
  "deny",
  "handled",
] as const satisfies readonly ApprovalDecision[];
/**
 * The kinds of action OpenBot recognises by name and asks about whatever the person's own switch
 * says (`safetyRequirement` in ./policy). Open by default: the person can allow one once, for the
 * conversation, or always. An admin can close each kind (`ApprovalTeamSettings.actionKinds`).
 */
export type ActionKind =
  | "deleting"
  | "sending"
  | "sharing"
  | "publishing"
  | "payments"
  | "credentials"
  | "security_settings";
export const ACTION_KINDS = [
  "deleting",
  "sending",
  "sharing",
  "publishing",
  "payments",
  "credentials",
  "security_settings",
] as const satisfies readonly ActionKind[];
/**
 * What the admin lets members do about one kind of action. `open` (the default) asks, and the person
 * can allow it once, for the conversation, or always. `ask` asks every time, with Allow once and Deny
 * only. `hand_off` leaves it to the person to do themselves.
 */
export type ActionKindPolicy = "open" | "ask" | "hand_off";
export const ACTION_KIND_POLICIES = [
  "open",
  "ask",
  "hand_off",
] as const satisfies readonly ActionKindPolicy[];
/**
 * What a matching custom rule does, in Dot's four behaviours: take action without asking; take
 * action only when the person explicitly asked for that exact action in this run's request; ask
 * before taking action; hand it off to the person.
 */
export type RuleBehaviour = "allow" | "pre_approved" | "ask" | "hand_off";
export const RULE_BEHAVIOURS = [
  "allow",
  "pre_approved",
  "ask",
  "hand_off",
] as const satisfies readonly RuleBehaviour[];
/** Commands on the person's own computer. */
export type HostCommandPolicy = "ask" | "allow" | "never";
/** Why the gate settled an action the way it did; stored on the request and in the audit row. */
export type ApprovalPolicyOutcome = {
  behaviour: "allow" | "ask" | "hand_off" | "deny";
  /** Which layer decided: a built-in safety requirement, a rule, auto-review, or the default. */
  source:
    | "safety"
    | "team_rule"
    | "personal_rule"
    | "auto_review"
    | "default"
    /** The person already declined this action, or an equivalent, earlier in this conversation. */
    | "person_declined"
    /** The person allowed this action for the rest of this conversation (`conversationGrant`). */
    | "conversation"
    /**
     * A task started from a check-in item: every change it makes asks first, whatever the person's
     * "Ask before making changes" says (tasks/turn.ts). Kept apart from `default` so turning that
     * switch off, or saving an allow rule, never withdraws what a task is waiting on.
     */
    | "task";
  reason: string;
  ruleId?: string;
  /** The kind of action OpenBot recognised this as, where it is one (see `ActionKind`). */
  kind?: ActionKind;
  /**
   * The admin closed this kind to standing answers: it asks every time, so the card offers Allow
   * once and Deny only (`offersStandingRule`).
   */
  closed?: true;
  review?: {
    verdict: "proceed" | "needs_approval" | "hand_off";
    preApproved: boolean;
    reason: string;
    /** The reviewer's safety classification; any value but `none` hands the action off. */
    safety?: "none" | "credentials" | "security_settings" | "payments";
    failedClosed?: boolean;
  };
};
export {
  type ApprovalContinuation,
  currentApprovalContext,
  withApprovalContext,
};

export type ApprovalCandidate = {
  actorId: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  args: unknown;
  target?: unknown;
  continuation?: ApprovalContinuation;
  /**
   * A reviewed read of the person's own app: a tool on an app they connected with their own account,
   * named on a reviewed read list (`reviewedRead` in plugins/catalogue.ts). Chat goes on judging a
   * call by `effect`; in a task's conversation this is the one kind of call that runs without asking.
   * Not part of what the person approves, so not in the action's digest.
   */
  ownConnectionRead?: true;
  /**
   * The app marks this tool as destroying something: MCP's `destructiveHint`, or a broker's
   * destructive flag, as recorded when the app was listed (`mcpTools.destructive`). It asks as
   * deleting does, whatever the tool is called (see `safetyRequirement` in ./policy). A fact about
   * the tool, not about this call, so not in the action's digest.
   */
  destructive?: true;
  /**
   * The row the trail records for this action if the person denies it, built by the code that would
   * have carried it out, so a denial reads like that surface's other refusals and lands in the
   * Blocked view. Written once, with the decision, in the transaction that saves it. Not part of what
   * the person approves, so not in the action's digest.
   */
  declined?: AuditEventInput;
  /**
   * Which of the person's accounts at an app the call runs in, by the address the person knows it
   * by, where they hold more than one. Part of what makes two actions the same action: a call to one
   * mailbox is never answered by an approval, a denial or a saved rule about another.
   */
  account?: string;
};
export type ApprovalAction = ApprovalCandidate & {
  runId: string;
  threadId: string;
  toolCallId: string;
  actionDigest: string;
  /** Set by the gate. Absent on a request opened by older code, which may still auto-approve. */
  policy?: ApprovalPolicyOutcome;
  /**
   * The same action with its volatile parts removed (snapshot ids, element refs), so a retry of a
   * declined or still-pending action is recognised as the same thing.
   */
  equivalence?: string;
  /** How many times the person had spoken in the conversation when this was asked. */
  userTurns?: number;
};
export type ApprovalRecord = {
  id: string;
  ownerUserId: string;
  action: ApprovalAction;
  status: "pending" | "approved" | "denied" | "consumed" | "completed";
  decision: ApprovalDecision | null;
  result: { content: string; error?: string } | null;
  createdAt: Date;
  decidedAt: Date | null;
  consumedAt: Date | null;
  completedAt: Date | null;
};
/**
 * An action class and what happens to it. `botId`, `toolRef`, `effect` and `scope` (the target) are
 * exact values or globs where `*` matches anything, so `mcp/gmail/*` names every Gmail tool.
 */
export type ApprovalRule = {
  id: string;
  ownerUserId: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
  /** The one account the rule is for, or null for the app whichever account; see `ruleMatches`. */
  account?: string | null;
  /**
   * The kind of action the rule was saved from, by "Always allow here" on that kind's card, or null.
   * An allow reaches an action of a kind only when it was saved from that kind (see `reachesKind`).
   */
  kind?: ActionKind | null;
  revokedAt: Date | null;
  createdAt: Date;
};
/**
 * "Allow for this conversation": one action (Bot, tool, target, account), in one conversation, for
 * one person. It ends when the person turns it off or deletes the conversation, and reaches no other
 * conversation, Bot or tool.
 */
export type ApprovalConversationGrant = {
  id: string;
  ownerUserId: string;
  threadId: string;
  /** The request it was given on. */
  approvalId: string;
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  account: string | null;
  kind: ActionKind | null;
  createdAt: Date;
};
export type ApprovalTeamRule = Omit<ApprovalRule, "ownerUserId" | "kind"> & {
  createdBy: string | null;
};
export type ApprovalRuleInput = {
  botId: string;
  toolRef: string;
  effect: string;
  scope: string;
  behaviour: RuleBehaviour;
};
/**
 * Where saved rules came from, when they were not typed into the form: a sentence in plain English
 * that the deployment's model wrote them from, and the admin then saved. The boundary's own shape
 * (`PolicyAuthoring` in computer/policy-store.ts).
 */
export type ApprovalRuleAuthoring = { source: "english"; text: string };
export type ApprovalPreferences = {
  enabled: boolean;
  autoReview: boolean;
  hostCommands: HostCommandPolicy;
};
export type ApprovalTeamSettings = {
  enforceAutoReview: boolean;
  customRulesEnabled: boolean;
  hostCommandsCap: HostCommandPolicy;
  /** The kinds the admin closed. A kind not named is `open`. */
  actionKinds: Partial<Record<ActionKind, ActionKindPolicy>>;
};
/**
 * A save of the admin's guidance for auto-review: the words, or null to remove them, and the
 * independent reading of the words the admin saw before saving (./reviewer-guidance.ts).
 */
export type ReviewerGuidanceChange = {
  text: string | null;
  /** The admin's email, as the trail's other admin rows name them. */
  actor?: string;
  reading?: { summary: string | null; explanation: string };
};
/** Rules, preferences and team settings. Optional on the store so older fakes keep working. */
export type ApprovalPolicyStore = {
  preferences(ownerUserId: string): Promise<ApprovalPreferences>;
  setPreferences(
    ownerUserId: string,
    input: Partial<ApprovalPreferences>,
  ): Promise<ApprovalPreferences>;
  teamSettings(): Promise<ApprovalTeamSettings>;
  setTeamSettings(
    by: string,
    input: Partial<ApprovalTeamSettings>,
  ): Promise<ApprovalTeamSettings>;
  teamRules(): Promise<ApprovalTeamRule[]>;
  createRule(
    ownerUserId: string,
    input: ApprovalRuleInput,
  ): Promise<ApprovalRule>;
  createTeamRule(
    by: string,
    input: ApprovalRuleInput,
  ): Promise<ApprovalTeamRule>;
  /** Owner-scoped: another person's rule id is not found. */
  updateRule(
    ownerUserId: string,
    id: string,
    input: Partial<ApprovalRuleInput>,
  ): Promise<ApprovalRule>;
  updateTeamRule(
    by: string,
    id: string,
    input: Partial<ApprovalRuleInput>,
  ): Promise<ApprovalTeamRule>;
  revokeTeamRule(by: string, id: string): Promise<void>;
  /**
   * Several team rules saved as one change, as a description in English writes them: all or none,
   * with one row on the trail naming who saved them, the team rules before and after, and the
   * sentence they were written from. Optional so older fakes keep working.
   */
  createTeamRules?(
    by: string,
    input: readonly ApprovalRuleInput[],
    authoring?: ApprovalRuleAuthoring,
  ): Promise<ApprovalTeamRule[]>;
  /**
   * The newest requests across every person, for replaying candidate rules over what people were
   * asked and what they answered. Admin reads only. Optional so older fakes keep working.
   */
  recentRequests?(limit: number): Promise<ApprovalRecord[]>;
  /**
   * The admin's guidance for auto-review, or null for none. Read by the gate for every review and by
   * the admin's screen; never part of what members read. Optional so older fakes keep working.
   */
  reviewerGuidance?(): Promise<string | null>;
  /**
   * Save the admin's guidance, or remove it with `text: null`, with one `approval.guidance_changed`
   * row naming who, the guidance before and after, and how it was read when it was saved.
   */
  setReviewerGuidance?(
    by: string,
    change: ReviewerGuidanceChange,
  ): Promise<string | null>;
  /** The newest request in this conversation for an equivalent action, other than this call. */
  findEquivalent(input: {
    ownerUserId: string;
    threadId: string;
    equivalence: string;
    excludeToolCallId: string;
  }): Promise<ApprovalRecord | undefined>;
  /**
   * Close this person's pending requests that `match` selects without executing them: the waiting
   * conversation is resumed with `reason` as the result, and each is audited.
   *
   * `resume: false` closes them and carries nothing on, for a run that has already ended and been
   * answered another way: a subagent's, which handed its action back to the Bot that started it.
   */
  withdrawPending(
    ownerUserId: string,
    reason: string,
    match: (action: ApprovalAction) => boolean,
    options?: { resume?: boolean },
  ): Promise<string[]>;
  /**
   * The person's "Allow for this conversation" answers still in force in this conversation: not
   * turned off, and the conversation not deleted. Optional so older fakes keep working.
   */
  conversationGrants?(
    ownerUserId: string,
    threadId: string,
  ): Promise<ApprovalConversationGrant[]>;
  /** Every one of this person's conversation answers still in force, for the inbox. */
  allConversationGrants?(
    ownerUserId: string,
  ): Promise<ApprovalConversationGrant[]>;
  /** Turn one off. Owner-scoped: another person's id is not found. Audited. */
  revokeConversationGrant?(ownerUserId: string, id: string): Promise<void>;
  /** One audit row per settled action, so every verdict can be read back. */
  recordDecision(input: {
    ownerUserId: string;
    botId: string;
    toolRef: string;
    effect: string;
    scope: string;
    outcome: ApprovalPolicyOutcome;
    initiator?: AuditInitiator;
    /** What the action was aimed at, so the row can name the file or page it was about. */
    target?: unknown;
    /**
     * The call this verdict is about, where it came from a conversation. A request the gate opens
     * for the same call carries the same two ids, so a replay counts the verdict and its request as
     * the one action they are (approvals/rule-backtest.ts).
     */
    call?: { runId: string; toolCallId: string };
  }): Promise<void>;
};
export type ApprovalPermit = {
  replay?: unknown;
  complete(result: unknown): Promise<void>;
};
export type ApprovalGate = (
  candidate: ApprovalCandidate,
) => Promise<ApprovalPermit | undefined>;
export type ApprovalStore = {
  enabled(ownerUserId: string): Promise<boolean>;
  setEnabled(ownerUserId: string, enabled: boolean): Promise<void>;
  open(action: ApprovalAction): Promise<ApprovalRecord>;
  get(ownerUserId: string, id: string): Promise<ApprovalRecord>;
  list(ownerUserId: string): Promise<ApprovalRecord[]>;
  decide(
    ownerUserId: string,
    id: string,
    decision: ApprovalDecision,
  ): Promise<ApprovalRecord>;
  consume(ownerUserId: string, id: string, digest: string): Promise<boolean>;
  saveResult(
    ownerUserId: string,
    id: string,
    result: { content: string; error?: string },
  ): Promise<boolean>;
  finish(ownerUserId: string, id: string): Promise<void>;
  rules(ownerUserId: string): Promise<ApprovalRule[]>;
  revoke(ownerUserId: string, id: string): Promise<void>;
  /**
   * Whether this thread is the conversation of a task the person started from a check-in item,
   * where every change asks first. Absent where there are no tasks.
   */
  asksEveryChange?(ownerUserId: string, threadId: string): Promise<boolean>;
  policy?: ApprovalPolicyStore;
};
/** Whether an approval may be answered with "Always allow here". Shared with the browser. */
export { offersStandingRule } from "@openbot/shared/standing-rule";
export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefusedError";
  }
}
/**
 * The policy wants to ask, and the call arrived with no conversation to ask in.
 *
 * A browser sends a Bot's look at a page (a navigation, a snapshot) straight to the computer; only its
 * changes travel through the approval route that carries the conversation. A rule can still ask about
 * a look. Marked apart from other refusals so the computer routes can say so, and the browser can send
 * the same call again through that route, where the person is asked, instead of handing the Bot a
 * refusal it can only apologise for.
 */
export class ApprovalNeedsConversationError extends ApprovalRefusedError {
  constructor() {
    super(
      "This action needs your approval, but it was not started from a conversation that can ask you. Nothing was done. Ask for it in a chat with this Bot, or change your rules in Settings → Approvals.",
    );
    this.name = "ApprovalNeedsConversationError";
  }
}
/**
 * This same call was answered already: it was denied, it failed, or its approval was used. What it
 * got then is what it gets now. Nothing new was turned away, so the action's code records nothing new.
 */
export class ApprovalAlreadyAnsweredError extends ApprovalRefusedError {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalAlreadyAnsweredError";
  }
}
export class ApprovalNotFoundError extends Error {
  constructor() {
    super("This approval could not be found.");
    this.name = "ApprovalNotFoundError";
  }
}
/**
 * The file or page an action was aimed at, for its approval rows on the trail: without it a decision
 * names a tool and a folder, and nobody can tell which of the actions beside it it was about.
 */
export function targetSubject(target: unknown): {
  file?: string;
  page?: string;
  command?: string;
  folder?: string;
} {
  if (!target || typeof target !== "object") return {};
  const { filePath, pageUrl, grantId, displayName, relativePath, command } =
    target as {
      filePath?: unknown;
      pageUrl?: unknown;
      grantId?: unknown;
      displayName?: unknown;
      relativePath?: unknown;
      command?: unknown;
    };
  /*
   * A folder on the person's computer (`host-access/broker.ts`): the file in it, the command, and
   * the folder by its name. Without them the row named only its scope, the grant's id, and Activity
   * read "Save a file  host-grant-15407-1794112361547002000".
   */
  const folder = typeof grantId === "string";
  return {
    ...(typeof filePath === "string" && filePath ? { file: filePath } : {}),
    ...(folder &&
    typeof relativePath === "string" &&
    relativePath &&
    relativePath !== "."
      ? { file: relativePath }
      : {}),
    ...(typeof pageUrl === "string" && pageUrl ? { page: pageUrl } : {}),
    ...(folder && typeof command === "string" && command ? { command } : {}),
    ...(folder && typeof displayName === "string" && displayName
      ? { folder: displayName }
      : {}),
  };
}
export function parseApprovalResult(value: unknown): {
  content: string;
  error?: string;
} {
  if (typeof value === "string") return { content: value };
  if (
    value &&
    typeof value === "object" &&
    "content" in value &&
    typeof value.content === "string"
  ) {
    if (
      "error" in value &&
      value.error !== undefined &&
      typeof value.error !== "string"
    )
      throw new ApprovalRefusedError("The saved tool error is invalid.");
    return {
      content: value.content,
      ...("error" in value && typeof value.error === "string"
        ? { error: value.error }
        : {}),
    };
  }
  throw new ApprovalRefusedError("The saved tool result is invalid.");
}
export function parseApprovalContinuation(
  value: unknown,
): ApprovalContinuation {
  if (!value || typeof value !== "object")
    throw new ApprovalRefusedError(
      "The interrupted conversation is unavailable.",
    );
  const input = value as Partial<ApprovalContinuation>;
  if (
    typeof input.toolCallId !== "string" ||
    !input.toolCallId ||
    typeof input.toolName !== "string" ||
    !input.toolName
  )
    throw new ApprovalRefusedError(
      "The interrupted tool identity is unavailable.",
    );
  const parsed = RunAgentInputSchema.safeParse({ ...input, tools: [] });
  if (!parsed.success)
    throw new ApprovalRefusedError("The interrupted conversation is invalid.");
  return {
    runId: parsed.data.runId,
    threadId: parsed.data.threadId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: input.args,
    messages: parsed.data.messages,
    state: parsed.data.state,
    context: parsed.data.context,
    forwardedProps: parsed.data.forwardedProps,
    ...(input.initiator ? { initiator: input.initiator } : {}),
  };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}
export function approvalAction(candidate: ApprovalCandidate): ApprovalAction {
  const continuation = candidate.continuation ?? currentApprovalContext();
  if (
    !continuation?.runId ||
    !continuation.threadId ||
    !continuation.toolCallId
  )
    throw new ApprovalNeedsConversationError();
  if (
    ![
      candidate.actorId,
      candidate.botId,
      candidate.toolRef,
      candidate.effect,
      candidate.scope,
    ].every((value) => typeof value === "string" && value.trim())
  )
    throw new ApprovalRefusedError("The action identity is incomplete.");
  const actionDigest = createHash("sha256")
    .update(
      canonical({
        actorId: candidate.actorId,
        botId: candidate.botId,
        toolRef: candidate.toolRef,
        effect: candidate.effect,
        scope: candidate.scope,
        args: candidate.args,
        target: candidate.target,
        // Only where there is one, so a request opened before accounts were named keeps its digest.
        ...(candidate.account ? { account: candidate.account } : {}),
      }),
    )
    .digest("hex");
  return {
    ...candidate,
    continuation,
    runId: continuation.runId,
    threadId: continuation.threadId,
    toolCallId: continuation.toolCallId,
    actionDigest,
  };
}

export function approvalPreview(args: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (Array.isArray(args))
    return args.slice(0, 20).map((value) => approvalPreview(value, depth + 1));
  if (args && typeof args === "object")
    return Object.fromEntries(
      Object.entries(args)
        .slice(0, 20)
        .map(([key, value]) => [
          key,
          // Secrets by name. Not `text` or `content`: what is typed, written or sent is exactly
          // what the person is approving, and hiding it let a Bot get "Allow once" on a payload
          // nobody could see. Secret-looking values inside it are still masked below.
          /pass|secret|token|authorization|cookie|credential/i.test(key)
            ? "[private value]"
            : approvalPreview(value, depth + 1),
        ]),
    );
  if (typeof args === "string")
    return (args.length > 2000 ? `${cutAtCodeUnits(args, 1999)}…` : args)
      .replace(
        /((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s;]+/gi,
        "$1[private value]",
      )
      .replace(/Bearer\s+\S+/gi, "Bearer [private value]");
  return args;
}
