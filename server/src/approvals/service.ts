import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ALREADY_WAITING,
  DECLINED_BY_PERSON,
  HANDLED_BY_PERSON,
  NOT_DONE,
  notCarriedOut,
  notDoneOnRecheck,
  OUTCOME_UNKNOWN,
  WITHDRAWN_APPROVALS_OFF,
  WITHDRAWN_RULE_ALLOWS,
} from "@openbot/shared/approval-outcomes";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { PERSON_INITIATOR } from "../audit";
import {
  decideAction,
  effectiveHostCommandPolicy,
  type ReviewModel,
  ruleMatches,
} from "./policy";
import type { ApprovalQuestions } from "./questions";
import {
  type ApprovalAction,
  ApprovalAlreadyAnsweredError,
  APPROVAL_DECISIONS,
  type ApprovalCandidate,
  type ApprovalContinuation,
  type ApprovalConversationGrant,
  type ApprovalDecision,
  type ApprovalPermit,
  type ApprovalPolicyOutcome,
  type ApprovalPreferences,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalRule,
  type ApprovalRuleAuthoring,
  type ApprovalRuleInput,
  type ApprovalStore,
  type ApprovalTeamSettings,
  approvalAction,
  approvalPreview,
  currentApprovalContext,
  type HostCommandPolicy,
  parseApprovalContinuation,
  withApprovalContext,
} from "./types";

// The sentences a Bot is told about a step it did not carry out live with their person-facing
// versions (shared/approval-outcomes.ts), so the app translates exactly what is sent here.
export {
  ALREADY_WAITING,
  DECLINED_BY_PERSON,
  HANDLED_BY_PERSON,
  OUTCOME_UNKNOWN,
  WITHDRAWN_APPROVALS_OFF,
  WITHDRAWN_RULE_ALLOWS,
};
/** Why a change in a check-in task waits for the person, on its card where they decide it. */
export const TASK_ASKS =
  "Tasks started from a check-in ask before every change.";

/** Snapshot ids and element refs change on every page read; the action they point at does not. */
const VOLATILE = new Set(["snapshotId", "ref", "toolCallId", "signal"]);
function stable(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((entry) => stable(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stable(entry, depth + 1)]),
  );
}
export function equivalenceOf(candidate: ApprovalCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        candidate.actorId,
        candidate.botId,
        candidate.toolRef,
        candidate.effect,
        candidate.scope,
        // Both: a connector, host or hand-off target names the tool, not the call, so the target
        // alone made every later call to that tool "the same" as one the person declined.
        stable(candidate.target),
        stable(candidate.args),
        // Which mailbox: a denial of a send from one account says nothing about another.
        ...(candidate.account ? [candidate.account] : []),
      ]),
    )
    .digest("hex");
}
/** The call a verdict is about, for the trail, so its request pairs with it (see `recordDecision`). */
const callOf = (continuation: ApprovalContinuation | undefined) =>
  continuation?.runId && continuation.toolCallId
    ? {
        call: {
          runId: continuation.runId,
          toolCallId: continuation.toolCallId,
        },
      }
    : {};
const userTurnsOf = (continuation: ApprovalContinuation | undefined) =>
  (continuation?.messages ?? []).filter((message) => message.role === "user")
    .length;

const executionAuthority = new AsyncLocalStorage<{
  approvalId: string;
  digest: string;
  owner: string;
}>();
const validationProbe = new AsyncLocalStorage<{ action?: ApprovalAction }>();
/**
 * Whether this call is an approved action's re-check, which only asks the gate what it would decide.
 * Anything with a side effect of its own (spending a one-time consent) must wait for the real run.
 */
export const isApprovalRecheck = () => validationProbe.getStore() !== undefined;
class ApprovalValidated extends HeadlessToolSuspension {
  constructor() {
    super("The action was checked before execution.", {
      kind: "approval_validation",
    });
  }
}
export type ApprovalResumeDependencies = {
  /**
   * Whether the deployment still lets this Bot run for this person (Use Bots, the model allowlist).
   * Asked before anything else, so a refused action is never carried out, and final: the Bot cannot
   * answer the result either, so the request ends with the refusal saved and no continuation.
   */
  refusal?(action: ApprovalAction): Promise<string | null>;
  /** Resolve the target again and recheck current policy/grants; never trust approval as authority. */
  validate(action: ApprovalAction): Promise<ApprovalAction>;
  execute(action: ApprovalAction): Promise<unknown>;
  /** Persist this deterministic tool result and resume its canonical conversation. */
  continue(input: {
    approvalId: string;
    messageId: string;
    continuation: ApprovalContinuation;
    result: { content: string; error?: string };
  }): Promise<void>;
};
export type ApprovalService = ReturnType<typeof createApprovalService>;

export function createApprovalService(
  store: ApprovalStore,
  questions?: ApprovalQuestions,
  frontend?: (
    ownerUserId: string,
    botId: string,
    snapshot: ApprovalContinuation,
  ) => Promise<unknown>,
  options: {
    /** The deployment's configured model, for auto-review and pre-approval checks. */
    review?: ReviewModel;
  } = {},
) {
  /**
   * A personal "allow" rule closes the requests it now covers that were only waiting on the person's
   * default or their own rules. Safety hand-offs, team rules and auto-review stops are left alone.
   */
  async function withdrawAllowed(ownerUserId: string, rule: ApprovalRule) {
    if (rule.behaviour !== "allow" || !store.policy) return;
    await store.policy.withdrawPending(
      ownerUserId,
      WITHDRAWN_RULE_ALLOWS,
      (action) =>
        (!action.policy ||
          action.policy.source === "default" ||
          action.policy.source === "personal_rule") &&
        ruleMatches(rule, action),
    );
  }
  /** Safety, rules, auto-review and the person's default, settled once per action and audited. */
  async function evaluate(
    candidate: ApprovalCandidate,
  ): Promise<ApprovalPolicyOutcome | undefined> {
    const policy = store.policy;
    if (!policy) return undefined;
    const [preferences, team, teamRules, personal, guidance] =
      await Promise.all([
        policy.preferences(candidate.actorId),
        policy.teamSettings(),
        policy.teamRules(),
        store.rules(candidate.actorId),
        // The admin's guidance for auto-review, which the reviewer reads below the built-in rules.
        policy.reviewerGuidance?.() ?? null,
      ]);
    const continuation = candidate.continuation ?? currentApprovalContext();
    // Only this conversation's answers: one given in another conversation never reaches this one.
    const conversation =
      continuation?.threadId && policy.conversationGrants
        ? await policy.conversationGrants(
            candidate.actorId,
            continuation.threadId,
          )
        : [];
    const outcome = await decideAction({
      candidate,
      messages: continuation?.messages,
      team: teamRules,
      personal,
      conversation,
      actionKinds: team.actionKinds,
      customRulesEnabled: team.customRulesEnabled,
      autoReview: preferences.autoReview || team.enforceAutoReview,
      askBeforeChanges: preferences.enabled,
      ...(options.review ? { model: options.review } : {}),
      ...(guidance ? { guidance } : {}),
    });
    // An unremarkable read is not a verdict anybody asked for; everything else is on the trail.
    if (
      outcome.review ||
      outcome.behaviour !== "allow" ||
      outcome.source !== "default"
    )
      await policy.recordDecision({
        ownerUserId: candidate.actorId,
        botId: candidate.botId,
        toolRef: candidate.toolRef,
        effect: candidate.effect,
        scope: candidate.scope,
        outcome,
        target: candidate.target,
        ...(continuation?.initiator
          ? { initiator: continuation.initiator }
          : {}),
        ...callOf(continuation),
      });
    return outcome;
  }
  return {
    store,
    /**
     * The reviewer model the gate asks, so a replay of auto-review over past requests asks the very
     * same one (./reviewer-guidance.ts). Absent where none is configured, and then the gate fails closed.
     */
    reviewer: options.review,
    async frontendAction(ownerUserId: string, botId: string, input: unknown) {
      if (!frontend)
        throw new ApprovalRefusedError(
          "Computer approvals are unavailable in this deployment.",
        );
      const snapshot = parseApprovalContinuation(input);
      snapshot.initiator = PERSON_INITIATOR;
      if (!snapshot.toolName.startsWith("computer_"))
        throw new ApprovalRefusedError(
          "That tool cannot be called through this computer request.",
        );
      const call = snapshot.messages
        .flatMap((message) =>
          message.role === "assistant" ? (message.toolCalls ?? []) : [],
        )
        .find((call) => call.id === snapshot.toolCallId);
      if (
        !call ||
        call.function.name !== snapshot.toolName ||
        !isDeepStrictEqual(
          JSON.parse(call.function.arguments),
          snapshot.args,
        ) ||
        snapshot.messages.some(
          (message) =>
            message.role === "tool" && message.toolCallId === call.id,
        )
      )
        throw new ApprovalRefusedError(
          "The action does not match an unanswered tool call in this conversation.",
        );
      return withApprovalContext(snapshot, () =>
        frontend(ownerUserId, botId, snapshot),
      );
    },
    async validateReentry(
      action: ApprovalAction,
      execute: () => Promise<unknown>,
    ): Promise<ApprovalAction> {
      const continuation = parseApprovalContinuation(action.continuation);
      const probe: { action?: ApprovalAction } = {};
      try {
        await withApprovalContext(continuation, () =>
          validationProbe.run(probe, execute),
        );
      } catch (error) {
        if (!(error instanceof ApprovalValidated)) throw error;
      }
      if (!probe.action)
        throw new ApprovalRefusedError(
          "That action is no longer available for approval.",
        );
      return probe.action;
    },
    async gate(
      candidate: ApprovalCandidate,
    ): Promise<ApprovalPermit | undefined> {
      const probe = validationProbe.getStore();
      if (probe) {
        probe.action = approvalAction(candidate);
        throw new ApprovalValidated();
      }
      // The approved action itself, being executed by `resume`. Decided already; never re-asked.
      const authority = executionAuthority.getStore();
      if (authority) {
        const approved = approvalAction(candidate);
        if (
          authority.owner === approved.actorId &&
          authority.digest === approved.actionDigest
        )
          return;
      }
      /*
       * The person's own earlier answer in this conversation comes first, before any policy that
       * might now allow the action: a declined action and its equivalents are not tried again until
       * the person has spoken since, and an action already waiting is not asked about twice.
       */
      const policy = store.policy;
      const continuation = candidate.continuation ?? currentApprovalContext();
      /*
       * A TASK STARTED FROM A CHECK-IN ASKS BEFORE EVERYTHING BUT A TRUSTED READ, whatever the
       * person's own switch or rules would allow: the work came from something a Bot noticed, not
       * something the person wrote out, so they see each step before it happens. The one thing it
       * does unasked is read an app the person connected with their own account, with a tool a
       * reviewed read list names (`ownConnectionRead`). A tool only labelled a read, by its server or
       * a broker, asks; so does a read chat would run freely (a page, a search on the deployment's
       * key). A stricter answer (a hand-off, a refusal) still stands.
       */
      const inTask =
        continuation?.threadId !== undefined &&
        (await store.asksEveryChange?.(
          candidate.actorId,
          continuation.threadId,
        )) === true;
      const trustedRead = inTask && candidate.ownConnectionRead === true;
      const taskAsks = inTask && !trustedRead;
      const equivalence =
        policy &&
        (candidate.effect !== "read" || taskAsks) &&
        continuation?.threadId
          ? equivalenceOf(candidate)
          : undefined;
      const userTurns = userTurnsOf(continuation);
      if (policy && equivalence && continuation) {
        const prior = await policy.findEquivalent({
          ownerUserId: candidate.actorId,
          threadId: continuation.threadId,
          equivalence,
          excludeToolCallId: continuation.toolCallId,
        });
        if (prior?.status === "pending")
          throw new ApprovalRefusedError(ALREADY_WAITING);
        if (
          prior?.decision === "deny" &&
          (prior.action.userTurns ?? 0) >= userTurns
        ) {
          await policy.recordDecision({
            ownerUserId: candidate.actorId,
            botId: candidate.botId,
            toolRef: candidate.toolRef,
            effect: candidate.effect,
            scope: candidate.scope,
            outcome: {
              behaviour: "deny",
              source: "person_declined",
              reason: DECLINED_BY_PERSON,
            },
            target: candidate.target,
            ...(continuation.initiator
              ? { initiator: continuation.initiator }
              : {}),
            ...callOf(continuation),
          });
          throw new ApprovalRefusedError(DECLINED_BY_PERSON);
        }
      }
      /*
       * A trusted read in a task is judged as the read it is, the way a check-in judges it: the
       * person's and the team's rules about reads still apply, and the switch that asks before
       * changes does not, though chat classifies the tool as a change.
       */
      const evaluated = await evaluate(
        trustedRead ? { ...candidate, effect: "read" } : candidate,
      );
      /*
       * EVERY ASK IN A TASK IS THE TASK'S, whichever layer would have asked anyway. An ask the
       * person's own switch or rule raised would otherwise keep `default` or `personal_rule`, and
       * those are exactly what "Always allow here", turning the switch off and saving an allow rule
       * answer: the card would offer a rule the next task ignores, and the switch or the rule would
       * withdraw what the task is waiting on. Only a stricter answer, a hand-off or a refusal,
       * keeps its own source.
       */
      const outcome: ApprovalPolicyOutcome | undefined =
        taskAsks &&
        evaluated?.behaviour !== "hand_off" &&
        evaluated?.behaviour !== "deny"
          ? {
              behaviour: "ask",
              source: "task",
              reason: TASK_ASKS,
              ...(evaluated?.review ? { review: evaluated.review } : {}),
            }
          : evaluated;
      if (outcome) {
        if (outcome.behaviour === "allow") return;
      } else if (
        candidate.effect === "read" ||
        trustedRead ||
        !(await store.enabled(candidate.actorId))
      )
        return;
      const { ownConnectionRead: _trust, ...asked } = candidate;
      const action: ApprovalAction = {
        ...approvalAction(asked),
        ...(outcome ? { policy: outcome } : {}),
        ...(equivalence ? { equivalence, userTurns } : {}),
      };
      const request = await store.open(action);
      if (request.decision === "handled")
        return { replay: HANDLED_BY_PERSON, complete: async () => undefined };
      if (request.result) {
        if (request.result.error)
          throw new ApprovalAlreadyAnsweredError(request.result.error);
        let replay: unknown;
        try {
          replay = JSON.parse(request.result.content);
        } catch {
          replay = request.result.content;
        }
        return { replay, complete: async () => undefined };
      }
      if (request.status === "denied")
        throw new ApprovalAlreadyAnsweredError(DECLINED_BY_PERSON);
      if (
        request.status === "approved" &&
        (await store.consume(action.actorId, request.id, action.actionDigest))
      )
        return {
          complete: async (output) => {
            const content =
              typeof output === "string" ? output : JSON.stringify(output);
            if (content === undefined)
              throw new ApprovalRefusedError(
                "The approved action returned no result.",
              );
            await store.saveResult(action.actorId, request.id, { content });
            await store.finish(action.actorId, request.id);
          },
        };
      if (request.status !== "pending")
        throw new ApprovalAlreadyAnsweredError(
          "This approval has already been used or revoked. The action was not repeated.",
        );
      const handOff = request.action.policy?.behaviour === "hand_off";
      throw new HeadlessToolSuspension(
        handOff
          ? `This needs you: ${request.action.policy?.reason} Do it yourself, then mark it done on the Bot's page in OpenBot.`
          : "This action is waiting for your approval.",
        {
          kind: "approval",
          approvalId: request.id,
          requestId: request.id,
          ...(handOff ? { handoff: true } : {}),
          continuation: action.continuation,
        },
      );
    },
    async decide(ownerUserId: string, id: string, decision: ApprovalDecision) {
      if (!(APPROVAL_DECISIONS as readonly string[]).includes(decision))
        throw new ApprovalRefusedError(
          "Choose allow once, allow for this conversation, always allow, deny, or done.",
        );
      return store.decide(ownerUserId, id, decision);
    },
    revoke: (ownerUserId: string, id: string) => store.revoke(ownerUserId, id),
    /** Turn off one "Allow for this conversation": the next such call in it asks again. */
    async revokeConversationGrant(ownerUserId: string, id: string) {
      if (!store.policy?.revokeConversationGrant)
        throw new ApprovalRefusedError(
          "Conversation approvals are unavailable here.",
        );
      return store.policy.revokeConversationGrant(ownerUserId, id);
    },
    async answerQuestion(
      ownerUserId: string,
      id: string,
      response: string,
      options?: { inConversation?: boolean },
    ) {
      if (!questions)
        throw new ApprovalRefusedError(
          "Questions are unavailable in this deployment.",
        );
      return questions.respond(ownerUserId, id, response, options);
    },
    async dismissQuestion(ownerUserId: string, id: string) {
      if (!questions)
        throw new ApprovalRefusedError(
          "Questions are unavailable in this deployment.",
        );
      return questions.dismiss(ownerUserId, id);
    },
    async inbox(ownerUserId: string) {
      const requests = await store.list(ownerUserId);
      const policy = store.policy;
      const [preferences, team, teamRules] = policy
        ? await Promise.all([
            policy.preferences(ownerUserId),
            policy.teamSettings(),
            policy.teamRules(),
          ])
        : [undefined, undefined, []];
      return {
        enabled: await store.enabled(ownerUserId),
        requests: requests.map(publicApproval),
        rules: await store.rules(ownerUserId),
        teamRules,
        conversationGrants: (
          (await policy?.allConversationGrants?.(ownerUserId)) ?? []
        ).map(publicGrant),
        ...(preferences && team
          ? {
              preferences,
              team,
              hostCommands: effectiveHostCommandPolicy(
                preferences.hostCommands,
                team.hostCommandsCap,
              ),
            }
          : {}),
        questions: (await questions?.list(ownerUserId)) ?? [],
      };
    },
    /** Commands on this person's own computer, after the team cap: the stricter setting applies. */
    async hostCommandPolicy(ownerUserId: string): Promise<HostCommandPolicy> {
      const policy = store.policy;
      if (!policy) return "ask";
      const [preferences, team] = await Promise.all([
        policy.preferences(ownerUserId),
        policy.teamSettings(),
      ]);
      return effectiveHostCommandPolicy(
        preferences.hostCommands,
        team.hostCommandsCap,
      );
    },
    async setPreferences(
      ownerUserId: string,
      input: Partial<ApprovalPreferences>,
    ) {
      if (!store.policy)
        throw new ApprovalRefusedError("Custom rules are unavailable here.");
      if (input.enabled !== undefined)
        await store.setEnabled(ownerUserId, input.enabled);
      const saved = await store.policy.setPreferences(ownerUserId, input);
      // Requests that were only asked because of this switch would otherwise wait for ever.
      if (input.enabled === false)
        await store.policy.withdrawPending(
          ownerUserId,
          WITHDRAWN_APPROVALS_OFF,
          (action) => !action.policy || action.policy.source === "default",
        );
      return saved;
    },
    async createRule(ownerUserId: string, input: ApprovalRuleInput) {
      const policy = store.policy;
      if (!policy)
        throw new ApprovalRefusedError("Custom rules are unavailable here.");
      if (!(await policy.teamSettings()).customRulesEnabled)
        throw new ApprovalRefusedError(
          "Your workspace has switched custom rules off, so personal rules cannot be edited.",
        );
      const rule = await policy.createRule(ownerUserId, input);
      await withdrawAllowed(ownerUserId, rule);
      return rule;
    },
    async updateRule(
      ownerUserId: string,
      id: string,
      input: Partial<ApprovalRuleInput>,
    ) {
      const policy = store.policy;
      if (!policy)
        throw new ApprovalRefusedError("Custom rules are unavailable here.");
      if (!(await policy.teamSettings()).customRulesEnabled)
        throw new ApprovalRefusedError(
          "Your workspace has switched custom rules off, so personal rules cannot be edited.",
        );
      const rule = await policy.updateRule(ownerUserId, id, input);
      await withdrawAllowed(ownerUserId, rule);
      return rule;
    },
    async updateTeamRule(
      by: string,
      id: string,
      input: Partial<ApprovalRuleInput>,
    ) {
      if (!store.policy)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.updateTeamRule(by, id, input);
    },
    async setTeamSettings(by: string, input: Partial<ApprovalTeamSettings>) {
      if (!store.policy)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.setTeamSettings(by, input);
    },
    async createTeamRule(by: string, input: ApprovalRuleInput) {
      if (!store.policy)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.createTeamRule(by, input);
    },
    async revokeTeamRule(by: string, id: string) {
      if (!store.policy)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.revokeTeamRule(by, id);
    },
    /** Several team rules in one save, with the sentence they were written from. */
    async createTeamRules(
      by: string,
      input: readonly ApprovalRuleInput[],
      authoring?: ApprovalRuleAuthoring,
    ) {
      if (!store.policy?.createTeamRules)
        throw new ApprovalRefusedError("Team rules are unavailable here.");
      return store.policy.createTeamRules(by, input, authoring);
    },
    async resume(
      ownerUserId: string,
      id: string,
      dependencies: ApprovalResumeDependencies,
    ): Promise<void> {
      const request = await store.get(ownerUserId, id);
      if (request.status === "completed") return;
      if (request.status === "pending")
        throw new ApprovalRefusedError(
          "This action is still waiting for your decision.",
        );
      const continuation = request.action.continuation;
      if (!continuation)
        throw new ApprovalRefusedError(
          "The interrupted conversation is unavailable.",
        );
      let result = request.result;
      const refused =
        !result && dependencies.refusal
          ? await dependencies.refusal(request.action)
          : null;
      if (refused) {
        // Only the process that saves the refusal ends the request.
        if (
          !(await store.saveResult(ownerUserId, id, {
            content: refused,
            error: refused,
          }))
        )
          return;
        await store.finish(ownerUserId, id);
        return;
      }
      if (!result && request.status === "consumed") {
        /*
         * Started, and the process running it stopped before saving what happened. Repeating it
         * could do it twice, and refusing to answer left the conversation waiting forever, so the
         * Bot is told. Only the process that saves this answer continues the conversation.
         */
        const reason = OUTCOME_UNKNOWN;
        if (
          !(await store.saveResult(ownerUserId, id, {
            content: reason,
            error: reason,
          }))
        )
          return;
        result = { content: reason, error: reason };
      } else if (!result) {
        if (request.status === "denied")
          result = { content: DECLINED_BY_PERSON, error: DECLINED_BY_PERSON };
        else if (request.decision === "handled")
          result = { content: HANDLED_BY_PERSON };
        else {
          /*
           * A re-check that refuses is an answer, not a failure to retry. Thrown, the sweep retried
           * it until its attempts ran out, nothing was saved, and the conversation hung with the
           * request stuck in `approved`. Told to the Bot, the run continues. Anything else (a
           * database or network failure) still throws, so the sweep retries it.
           */
          let current: ApprovalAction | undefined;
          let refusal: string | undefined;
          try {
            current = await dependencies.validate(request.action);
            if (
              current.actorId !== ownerUserId ||
              current.actionDigest !== request.action.actionDigest
            )
              throw new ApprovalRefusedError(
                "The approved action or resolved target has changed.",
              );
            if (!(await store.consume(ownerUserId, id, current.actionDigest))) {
              // Still `approved`: an "Always allow" whose rule was revoked before it ran. Anything
              // else means another replica took the request, and it continues the conversation.
              if ((await store.get(ownerUserId, id)).status !== "approved")
                return;
              throw new ApprovalRefusedError(
                "The rule that allowed this was removed before it ran.",
              );
            }
          } catch (error) {
            if (!(error instanceof ApprovalRefusedError) && !isPermanent(error))
              throw error;
            refusal = notDoneOnRecheck(
              error instanceof ApprovalRefusedError
                ? error.message
                : permanentReason(error),
            );
          }
          if (refusal !== undefined || !current) {
            const reason = refusal ?? NOT_DONE;
            result = { content: reason, error: reason };
          } else {
            const approved = current;
            try {
              const output = await withApprovalContext(continuation, () =>
                executionAuthority.run(
                  {
                    approvalId: id,
                    digest: approved.actionDigest,
                    owner: ownerUserId,
                  },
                  () => dependencies.execute(approved),
                ),
              );
              const content =
                typeof output === "string" ? output : JSON.stringify(output);
              if (content === undefined)
                throw new Error("The approved action returned no result.");
              result = { content };
            } catch (error) {
              const reason =
                error instanceof Error ? error.message : String(error);
              result = { content: reason, error: reason };
            }
          }
        }
        // Saved by one process only: whichever saves the answer is the one that continues.
        if (!(await store.saveResult(ownerUserId, id, result))) return;
      }
      await dependencies.continue({
        approvalId: id,
        messageId: `approval:${id}`,
        continuation,
        result,
      });
      await store.finish(ownerUserId, id);
    },
    /**
     * The work item carrying this resume ran out of tries. Left alone, the request stayed approved
     * and the conversation waited forever, so the Bot is told the action could not be carried out
     * and the conversation continues. Only the process that saves that answer continues it.
     */
    async abandon(
      ownerUserId: string,
      id: string,
      reason: string,
      dependencies: Pick<ApprovalResumeDependencies, "continue">,
    ): Promise<void> {
      const request = await store.get(ownerUserId, id);
      if (request.status === "completed" || request.status === "pending")
        return;
      const continuation = request.action.continuation;
      let result = request.result;
      if (!result) {
        const text = notCarriedOut(reason);
        if (
          !(await store.saveResult(ownerUserId, id, {
            content: text,
            error: text,
          }))
        )
          return;
        result = { content: text, error: text };
      }
      if (continuation)
        await dependencies.continue({
          approvalId: id,
          messageId: `approval:${id}`,
          continuation,
          result,
        });
      await store.finish(ownerUserId, id);
    },
  };
}

/**
 * Failures the re-check will meet again on every try: the connector was removed, a saved argument no
 * longer parses, or a private-share check is waiting again. Retried, they only delayed the moment the
 * work item died and the conversation hung.
 */
function isPermanent(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ZodError" || error.name === "CatalogueEntryUnknownError")
    return true;
  return (
    error instanceof HeadlessToolSuspension &&
    !(error instanceof ApprovalValidated)
  );
}
function permanentReason(error: unknown): string {
  if (error instanceof HeadlessToolSuspension)
    return "it is waiting for another decision first.";
  if (error instanceof Error && error.name === "ZodError")
    return "the saved request no longer has a valid shape.";
  return "the app it needs is no longer available.";
}
/** A conversation answer as the browser reads it: what it allows, where, and how to turn it off. */
function publicGrant(grant: ApprovalConversationGrant) {
  return {
    id: grant.id,
    threadId: grant.threadId,
    botId: grant.botId,
    toolRef: grant.toolRef,
    effect: grant.effect,
    scope: grant.scope,
    ...(grant.account ? { account: grant.account } : {}),
    ...(grant.kind ? { kind: grant.kind } : {}),
    createdAt: grant.createdAt,
  };
}
function publicApproval(request: ApprovalRecord) {
  const { action, ...record } = request;
  return {
    ...record,
    result: request.result ? { error: request.result.error } : null,
    action: {
      botId: action.botId,
      toolRef: action.toolRef,
      effect: action.effect,
      scope: action.scope,
      threadId: action.threadId,
      // The owner's own call id, so the conversation can draw this request where the action was.
      toolCallId: action.toolCallId,
      args: approvalPreview(action.args),
      target: approvalPreview(action.target),
      // The account the card names: "send email from dana@work.example on Gmail".
      ...(action.account ? { account: action.account } : {}),
      ...(action.policy
        ? {
            policy: {
              behaviour: action.policy.behaviour,
              source: action.policy.source,
              reason: action.policy.reason,
              ...(action.policy.kind ? { kind: action.policy.kind } : {}),
              ...(action.policy.closed ? { closed: true } : {}),
            },
          }
        : {}),
    },
  };
}
