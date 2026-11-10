/**
 * What would these approval rules have changed, about actions the gate already decided?
 *
 * The approval gate writes down every verdict it reaches that is not a plain "nothing to ask"
 * (`approval.evaluated`), and every action it asks a person about is a request with the whole action
 * and the person's answer (`approval_requests`). So a candidate set of team rules can be replayed over
 * both, with the same pure matcher the gate uses ({@link strictestRule}), and answer before it is
 * saved: these asks would have gone, and a person had denied these; these actions would have asked.
 *
 * Replay, not simulation. Only what a rule decides is replayed, and only against the decision that
 * was recorded:
 *
 * - A built-in safety requirement comes before every rule (`decideAction`), so an action one decided
 *   is fixed. So is one auto-review decided, which a rule cannot be replayed through without asking
 *   the reviewer again; one the person had already declined in that conversation; and one in a task
 *   started from a check-in, which asks before every change whatever the rules say. Each is listed as
 *   unchanged, and none is counted as a change.
 * - Everything else was decided by the strictest matching rule, or by nothing and the person's own
 *   default. Adding team rules changes it only where one of them is stricter than the rule that won,
 *   or where no rule had matched: the strictest wins across both layers, so a rule that is not
 *   stricter than the winner never decides anything. The recorded behaviour stands in for the winner.
 *
 * ONE ACTION IS COUNTED ONCE. An action the gate asked about has both an `approval.evaluated` row and
 * a request. They are paired by the call they were about (`payload.call`, written since this file
 * existed), or for older rows by the person, the Bot, the tool, the target and the verdict, the
 * request opened within a moment of the verdict, each row used once. A request with no row beside it
 * (its row is older than the slice read) is replayed on its own, and so is a verdict with no request,
 * which is every action that was allowed.
 *
 * What is never on the trail cannot be replayed: an action no rule and no setting had anything to say
 * about is not recorded, so a new ask can reach further than this shows. The screen says so.
 */
import type { AuditEvent } from "../audit";
import { strictestRule } from "./policy";
import {
  type ApprovalPolicyOutcome,
  type ApprovalRecord,
  type ApprovalRuleInput,
  type ApprovalTeamRule,
  targetSubject,
} from "./types";

type Behaviour = ApprovalPolicyOutcome["behaviour"];

/** The sources whose verdict a rule cannot change, and why, in a person's words. */
const FIXED_SOURCES: Record<string, string> = {
  safety: "A safety requirement decided this. Rules don't change that.",
  auto_review: "Auto-review decided this. Rules don't change that.",
  person_declined: "The person had already declined this in that conversation.",
  task: "A task started from a check-in asks before every change.",
};

const RANK: Record<string, number> = {
  allow: 0,
  pre_approved: 1,
  ask: 2,
  hand_off: 3,
};

/** What the person answered, where they were asked. */
export type PersonAnswer =
  | "allow_once"
  | "allow_conversation"
  | "allow_always"
  | "deny"
  | "handled"
  | "waiting"
  | "withdrawn";

export type BacktestChange = {
  /** The audit row's id, or the request's where there is no row beside it. */
  id: string;
  createdAt: string;
  /** Whose action: the person the Bot acted for. */
  ownerUserId: string | null;
  initiator: { kind: string; id: string | null };
  bot: string;
  toolRef: string;
  effect: string;
  scope: string;
  /** The file, page, command or folder it was aimed at, as its audit row names it. */
  subject: ReturnType<typeof targetSubject>;
  was: Behaviour;
  /** Which layer decided what happened: `safety`, `team_rule`, `personal_rule`, `default`… */
  wasSource: string;
  would: Behaviour;
  /**
   * `removes_ask` and `adds_ask` are the two that matter; `stricter` and `looser` move between asking
   * and handing off; `fixed` is an action one of these rules is about whose verdict no rule changes.
   */
  change: "removes_ask" | "adds_ask" | "stricter" | "looser" | "fixed";
  person: PersonAnswer | null;
  /** Which candidate rule decided it, counted from 1 as the screen counts them. */
  rule: number;
  reason: string;
};

export type ApprovalBacktest = {
  /** Actions replayed, each once. */
  scanned: number;
  /** Actions any of the rules is about. */
  matched: number;
  /** Decisions that would change: removed asks, added asks, and moves between asking and handing off. */
  changed: number;
  removedAsks: number;
  /** Of the removed asks, the ones a person had denied. */
  removedDenied: number;
  addedAsks: number;
  /** Actions the rules are about whose verdict is fixed. Never counted as changed. */
  fixed: number;
  /** Changed first (denied asks first of all), then fixed. Capped; the counts are over everything. */
  changes: BacktestChange[];
};

/** Rows returned in full. The counts still cover every action replayed. */
const CHANGES_CAP = 50;
const FIXED_CAP = 20;

/** One action, as the trail and the request record it, ready to be judged again. */
type Recorded = {
  id: string;
  createdAt: string;
  ownerUserId: string | null;
  initiator: { kind: string; id: string | null };
  bot: string;
  toolRef: string;
  effect: string;
  scope: string;
  account?: string;
  subject: ReturnType<typeof targetSubject>;
  outcome: Pick<ApprovalPolicyOutcome, "behaviour" | "source" | "review">;
  person: PersonAnswer | null;
};

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

function outcomeOf(value: unknown): Recorded["outcome"] | null {
  if (!value || typeof value !== "object") return null;
  const { behaviour, source, review } = value as Record<string, unknown>;
  if (
    behaviour !== "allow" &&
    behaviour !== "ask" &&
    behaviour !== "hand_off" &&
    behaviour !== "deny"
  )
    return null;
  if (typeof source !== "string") return null;
  return {
    behaviour,
    source: source as ApprovalPolicyOutcome["source"],
    ...(review && typeof review === "object"
      ? { review: review as ApprovalPolicyOutcome["review"] }
      : {}),
  };
}

function personOf(request: ApprovalRecord): PersonAnswer | null {
  if (request.decision) return request.decision;
  if (request.status === "pending") return "waiting";
  if (request.status === "denied") return "withdrawn";
  return null;
}

/** The subject an audit row names, as `targetSubject` wrote it into the payload. */
function subjectOfPayload(
  payload: Record<string, unknown>,
): ReturnType<typeof targetSubject> {
  return {
    ...(text(payload.file) ? { file: text(payload.file) } : {}),
    ...(text(payload.page) ? { page: text(payload.page) } : {}),
    ...(text(payload.command) ? { command: text(payload.command) } : {}),
    ...(text(payload.folder) ? { folder: text(payload.folder) } : {}),
  };
}

function fromEvaluated(event: AuditEvent): Recorded | null {
  const payload = event.payload ?? {};
  const outcome = outcomeOf(payload.outcome);
  const [bot, toolRef, effect, scope] = [
    payload.bot,
    payload.tool,
    payload.effect,
    payload.scope,
  ].map(text);
  if (!outcome || !bot || !toolRef || !effect || !scope) return null;
  return {
    id: event.id,
    createdAt: event.createdAt,
    ownerUserId: event.actorUserId,
    initiator: { kind: event.initiatorKind, id: event.initiatorId },
    bot,
    toolRef,
    effect,
    scope,
    subject: subjectOfPayload(payload),
    outcome,
    person: null,
  };
}

function fromRequest(request: ApprovalRecord): Recorded {
  const { action } = request;
  const initiator = action.continuation?.initiator as
    | { kind?: unknown; id?: unknown }
    | undefined;
  return {
    id: request.id,
    createdAt: new Date(request.createdAt).toISOString(),
    ownerUserId: request.ownerUserId,
    initiator: {
      kind: text(initiator?.kind) || "person",
      id: text(initiator?.id) || null,
    },
    bot: action.botId,
    toolRef: action.toolRef,
    effect: action.effect,
    scope: action.scope,
    ...(action.account ? { account: action.account } : {}),
    subject: targetSubject(action.target),
    // A request opened by older code carries no verdict: it asked because the person's switch did.
    outcome: action.policy
      ? {
          behaviour: action.policy.behaviour,
          source: action.policy.source,
          ...(action.policy.review ? { review: action.policy.review } : {}),
        }
      : { behaviour: "ask", source: "default" },
    person: personOf(request),
  };
}

/** How far after its verdict a request may be opened and still be that verdict's request. */
const PAIR_BEFORE_MS = 2_000;
const PAIR_AFTER_MS = 60_000;

/**
 * Every action once: each verdict, with its request's answer where it asked, and each request no
 * verdict in this slice accounts for.
 */
export function recordedActions(
  evaluated: readonly AuditEvent[],
  requests: readonly ApprovalRecord[],
): Recorded[] {
  const verdicts = evaluated
    .filter((event) => event.eventType === "approval.evaluated")
    .map((event) => ({ event, recorded: fromEvaluated(event) }))
    .filter(
      (entry): entry is { event: AuditEvent; recorded: Recorded } =>
        entry.recorded !== null,
    );
  const paired = new Set<string>();
  const byCall = new Map<string, Recorded>();
  for (const { event, recorded } of verdicts) {
    const call = event.payload.call as
      | { runId?: unknown; toolCallId?: unknown }
      | undefined;
    if (text(call?.runId) && text(call?.toolCallId))
      byCall.set(
        `${event.actorUserId}\u0000${text(call?.runId)}\u0000${text(call?.toolCallId)}`,
        recorded,
      );
  }
  const unpaired: Recorded[] = [];
  // Oldest first, so two identical actions a moment apart pair in the order they happened.
  const ordered = [...requests].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  for (const request of ordered) {
    const exact = byCall.get(
      `${request.ownerUserId}\u0000${request.action.runId}\u0000${request.action.toolCallId}`,
    );
    const opened = new Date(request.createdAt).getTime();
    const policy = request.action.policy;
    const match =
      exact && !paired.has(exact.id)
        ? exact
        : verdicts
            .map((entry) => entry.recorded)
            .filter(
              (verdict) =>
                !paired.has(verdict.id) &&
                verdict.ownerUserId === request.ownerUserId &&
                verdict.bot === request.action.botId &&
                verdict.toolRef === request.action.toolRef &&
                verdict.scope === request.action.scope &&
                // A task's ask is the gate's own, laid over whatever the verdict row said.
                (!policy ||
                  policy.source === "task" ||
                  (verdict.outcome.behaviour === policy.behaviour &&
                    verdict.outcome.source === policy.source)) &&
                opened - new Date(verdict.createdAt).getTime() >=
                  -PAIR_BEFORE_MS &&
                opened - new Date(verdict.createdAt).getTime() <= PAIR_AFTER_MS,
            )
            .sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
            )[0];
    if (match) {
      paired.add(match.id);
      match.person = personOf(request);
      // What the gate did, which a task's ask overrides the verdict row on (approvals/service.ts).
      if (policy)
        match.outcome = {
          behaviour: policy.behaviour,
          source: policy.source,
          ...(policy.review ? { review: policy.review } : {}),
        };
      if (request.action.account) match.account = request.action.account;
      // The request names the action's target in full; the row only what the trail keeps.
      match.subject = {
        ...targetSubject(request.action.target),
        ...match.subject,
      };
    } else unpaired.push(fromRequest(request));
  }
  return [...verdicts.map((entry) => entry.recorded), ...unpaired].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

const asks = (behaviour: Behaviour) =>
  behaviour === "ask" || behaviour === "hand_off" || behaviour === "deny";

const BEHAVIOUR_WORDS: Record<string, string> = {
  allow: "takes action without asking",
  pre_approved: "takes action only if the person asked for it",
  ask: "asks first",
  hand_off: "hands it to the person",
};

/**
 * Replay candidate team rules over recorded actions. Pure: the rows, the trail's verdicts and the
 * requests in; the counts and the actions that would change out.
 */
export function backtestApprovalRules(
  rules: readonly ApprovalRuleInput[],
  evaluated: readonly AuditEvent[],
  requests: readonly ApprovalRecord[],
): ApprovalBacktest {
  const team: ApprovalTeamRule[] = rules.map((rule, index) => ({
    ...rule,
    id: String(index + 1),
    createdBy: null,
    revokedAt: null,
    createdAt: new Date(0),
  }));
  const report: ApprovalBacktest = {
    scanned: 0,
    matched: 0,
    changed: 0,
    removedAsks: 0,
    removedDenied: 0,
    addedAsks: 0,
    fixed: 0,
    changes: [],
  };
  const changed: BacktestChange[] = [];
  const fixed: BacktestChange[] = [];

  for (const action of recordedActions(evaluated, requests)) {
    report.scanned += 1;
    const match = strictestRule(
      {
        actorId: action.ownerUserId ?? "",
        botId: action.bot,
        toolRef: action.toolRef,
        effect: action.effect,
        scope: action.scope,
        args: null,
        ...(action.account ? { account: action.account } : {}),
      },
      team,
      [],
    );
    if (!match) continue;
    report.matched += 1;
    const rule = Number(match.rule.id);
    const was = action.outcome.behaviour;
    const row = (
      change: BacktestChange["change"],
      would: Behaviour,
      reason: string,
    ): BacktestChange => ({
      id: action.id,
      createdAt: action.createdAt,
      ownerUserId: action.ownerUserId,
      initiator: action.initiator,
      bot: action.bot,
      toolRef: action.toolRef,
      effect: action.effect,
      scope: action.scope,
      subject: action.subject,
      was,
      wasSource: action.outcome.source,
      would,
      change,
      person: action.person,
      rule,
      reason,
    });

    const fixedBecause = FIXED_SOURCES[action.outcome.source];
    if (fixedBecause) {
      report.fixed += 1;
      fixed.push(row("fixed", was, fixedBecause));
      continue;
    }

    // The rule that won, read off the verdict: a rule's own behaviour, or none at all.
    const ruled =
      action.outcome.source === "team_rule" ||
      action.outcome.source === "personal_rule";
    const before = ruled ? (RANK[was] ?? 0) : -1;
    if (RANK[match.rule.behaviour] === undefined) continue;
    if ((RANK[match.rule.behaviour] as number) <= before) continue;
    const would: Behaviour =
      match.rule.behaviour === "pre_approved"
        ? action.outcome.review?.preApproved &&
          !action.outcome.review.failedClosed
          ? "allow"
          : "ask"
        : match.rule.behaviour;
    if (would === was) continue;

    const change: BacktestChange["change"] =
      asks(was) && !asks(would)
        ? "removes_ask"
        : !asks(was) && asks(would)
          ? "adds_ask"
          : (RANK[would] ?? 0) > (RANK[was] ?? 0)
            ? "stricter"
            : "looser";
    report.changed += 1;
    if (change === "removes_ask") {
      report.removedAsks += 1;
      if (action.person === "deny") report.removedDenied += 1;
    }
    if (change === "adds_ask") report.addedAsks += 1;
    changed.push(
      row(
        change,
        would,
        `Rule ${rule} ${BEHAVIOUR_WORDS[match.rule.behaviour] ?? match.rule.behaviour}.`,
      ),
    );
  }

  // The asks a person said no to that these rules would stop asking about, first: they are the
  // reason to read this list before saving.
  const denied = changed.filter(
    (change) => change.change === "removes_ask" && change.person === "deny",
  );
  report.changes = [
    ...denied,
    ...changed.filter((change) => !denied.includes(change)),
  ]
    .slice(0, CHANGES_CAP)
    .concat(fixed.slice(0, FIXED_CAP));
  return report;
}
