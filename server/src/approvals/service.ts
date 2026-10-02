import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PERSON_INITIATOR } from "../audit";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import {
  decideAction,
  effectiveHostCommandPolicy,
  type ReviewModel,
  ruleMatches,
} from "./policy";
import type { ApprovalQuestions } from "./questions";
import {
  type ApprovalAction,
  type ApprovalCandidate,
  type ApprovalContinuation,
  type ApprovalDecision,
  type ApprovalPermit,
  type ApprovalPolicyOutcome,
  type ApprovalPreferences,
  type ApprovalRecord,
  ApprovalRefusedError,
  type ApprovalRule,
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

/**
 * What the Bot is told when the person says no. Plain, and distinct from a policy or boundary
 * refusal, so the model reports it truthfully and does not go looking for another way round it.
 */
export const DECLINED_BY_PERSON =
  "The person declined this action when you asked for their approval, so it was not done. This was their decision, not a policy or a boundary. Do not try this action, or anything equivalent, again in this conversation unless the person asks you to in words; tell them you did not do it because they declined.";
/** What a Bot retrying an action that is still waiting is told, instead of opening a second request. */
export const ALREADY_WAITING =
  "An identical request is already waiting for the person's decision in Approvals, so this was not done and no second request was made. Do not repeat it; wait for their answer.";
export const WITHDRAWN_APPROVALS_OFF =
  "Not done: this request was withdrawn because the person switched off asking before changes. Try the action again if it is still needed.";
export const WITHDRAWN_RULE_ALLOWS =
  "Not done: this request was withdrawn because a rule the person saved now allows it without asking. Try the action again if it is still needed.";

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
      ]),
    )
    .digest("hex");
}
const userTurnsOf = (continuation: ApprovalContinuation | undefined) =>
  (continuation?.messages ?? []).filter((message) => message.role === "user")
    .length;

/** What a hand-off answers the Bot with once the person has done it themselves. */
export const HANDLED_BY_PERSON =
  "The person did this themselves. Do not repeat it; continue from what they have done.";

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
    const [preferences, team, teamRules, personal] = await Promise.all([
      policy.preferences(candidate.actorId),
      policy.teamSettings(),
      policy.teamRules(),
      store.rules(candidate.actorId),
    ]);
    const continuation = candidate.continuation ?? currentApprovalContext();
    const outcome = await decideAction({
      candidate,
      messages: continuation?.messages,
      team: teamRules,
      personal,
      customRulesEnabled: team.customRulesEnabled,
      autoReview: preferences.autoReview || team.enforceAutoReview,
      askBeforeChanges: preferences.enabled,
      ...(options.review ? { model: options.review } : {}),
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
        ...(continuation?.initiator
          ? { initiator: continuation.initiator }
          : {}),
      });
    return outcome;
  }
  return {
    store,
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
      const equivalence =
        policy && candidate.effect !== "read" && continuation?.threadId
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
            ...(continuation.initiator
              ? { initiator: continuation.initiator }
              : {}),
          });
          throw new ApprovalRefusedError(DECLINED_BY_PERSON);
        }
      }
      const outcome = await evaluate(candidate);
      if (outcome) {
        if (outcome.behaviour === "allow") return;
      } else if (
        candidate.effect === "read" ||
        !(await store.enabled(candidate.actorId))
      )
        return;
      const action: ApprovalAction = {
        ...approvalAction(candidate),
        ...(outcome ? { policy: outcome } : {}),
        ...(equivalence ? { equivalence, userTurns } : {}),
      };
      const request = await store.open(action);
      if (request.decision === "handled")
        return { replay: HANDLED_BY_PERSON, complete: async () => undefined };
      if (request.result) {
        if (request.result.error)
          throw new ApprovalRefusedError(request.result.error);
        let replay: unknown;
        try {
          replay = JSON.parse(request.result.content);
        } catch {
          replay = request.result.content;
        }
        return { replay, complete: async () => undefined };
      }
      if (request.status === "denied")
        throw new ApprovalRefusedError(DECLINED_BY_PERSON);
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
        throw new ApprovalRefusedError(
          "This approval has already been used or revoked. The action was not repeated.",
        );
      const handOff = request.action.policy?.behaviour === "hand_off";
      throw new HeadlessToolSuspension(
        handOff
          ? `This needs you: ${request.action.policy?.reason} Do it yourself, then mark it done in Approvals.`
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
      if (!["allow_once", "allow_always", "deny", "handled"].includes(decision))
        throw new ApprovalRefusedError(
          "Choose allow once, allow always, deny, or done.",
        );
      return store.decide(ownerUserId, id, decision);
    },
    revoke: (ownerUserId: string, id: string) => store.revoke(ownerUserId, id),
    async answerQuestion(ownerUserId: string, id: string, response: string) {
      if (!questions)
        throw new ApprovalRefusedError(
          "Questions are unavailable in this deployment.",
        );
      return questions.respond(ownerUserId, id, response);
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
        const reason =
          "This action was started but its outcome is unknown. It was not repeated. Check whether it happened before asking the person again.";
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
            refusal = `Not done: ${
              error instanceof ApprovalRefusedError
                ? error.message
                : permanentReason(error)
            } Ask the person again if it is still needed.`;
          }
          if (refusal !== undefined || !current) {
            const reason = refusal ?? "Not done.";
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
        const text = `Not done: this action could not be carried out (${reason.slice(0, 300)}). Check whether it happened before asking the person again.`;
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
      ...(action.policy
        ? {
            policy: {
              behaviour: action.policy.behaviour,
              source: action.policy.source,
              reason: action.policy.reason,
            },
          }
        : {}),
    },
  };
}
