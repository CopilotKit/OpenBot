import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type {
  LearningEvidence,
  LearningProposal,
  LearningProposalDetail,
  LearningRunSummary,
} from "@openbot/shared/learning";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { LearningModelCalls } from "./model-endpoint";

/** The runtime key's own Learning routes: a project's containers, runs and proposed Skills. */
export type LearningManagement = Pick<
  CopilotKitIntelligence["experimental"]["learning"],
  | "getLearningContainer"
  | "listLearningRuns"
  | "startLearningRun"
  | "listLearningCandidates"
  | "getLearningCandidate"
  | "getLearningInsightEvidence"
  | "reviewLearningCandidate"
>;

/** The HTTP status and Intelligence error code a Learning request failed with. */
export function requestFailure(error: unknown): {
  status?: number;
  code?: string;
} {
  if (error === null || typeof error !== "object") return {};
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { code } : {}),
  };
}

/** Why Learning has no model on this machine, as OpenBot Desktop recorded it. */
export type LearningModelUnavailable = "unsupported";

/**
 * Desktop's reason, from `OPENBOT_LEARNING_MODEL_UNAVAILABLE`, or undefined. Only Desktop writes the
 * setting, so an OpenBot whose Learning runs on an organization's Intelligence keeps the message for
 * whoever runs that back end.
 */
export function learningModelUnavailable(
  environment: Record<string, string | undefined>,
): LearningModelUnavailable | undefined {
  return environment.OPENBOT_LEARNING_MODEL_UNAVAILABLE?.trim() ===
    "unsupported"
    ? "unsupported"
    : undefined;
}

/** What Learn now says when the Learning agent has no model. */
export function noLearningModel(
  unavailable: LearningModelUnavailable | undefined,
): string {
  return unavailable === "unsupported"
    ? "Learning can't run on the model you signed in with. To use it, sign OpenBot in with an OpenAI or Anthropic API key, or a Claude or ChatGPT plan."
    : "The backend has no Learning model yet. Give its Learning agent a model and key, then try again.";
}

/** What to tell an admin when Intelligence refused a Learning request, and with which status. */
export function learningFailure(
  error: unknown,
  unavailable?: LearningModelUnavailable,
): {
  status: ContentfulStatusCode;
  error: string;
} {
  const { status, code } = requestFailure(error);
  if (status === 404 && code === "ROUTE_NOT_FOUND")
    return {
      status: 409,
      error:
        "Learning is switched off in the backend. Turn it on there (learning.enabled in its Helm chart).",
    };
  if (code === "LEARNING_CONTAINER_NOT_FOUND")
    return {
      status: 404,
      error: "This Learning container doesn't exist in the backend yet.",
    };
  if (code === "LEARNING_CANDIDATE_NOT_FOUND")
    return {
      status: 404,
      error: "The backend no longer has this skill. Refresh the list.",
    };
  if (code === "LEARNING_CANDIDATE_CONFLICT")
    return {
      status: 409,
      error: "This skill was already reviewed. Refresh the list to see it.",
    };
  if (code === "LEARNING_NOT_ENABLED")
    return {
      status: 403,
      error: "The backend's licence doesn't include Learning.",
    };
  if (code === "LEARNING_MODEL_NOT_CONFIGURED")
    return {
      status: 409,
      error: noLearningModel(unavailable),
    };
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED")
    return {
      status: 429,
      error: "The backend is busy. Try again in a minute.",
    };
  return {
    status: 502,
    error: "Couldn't reach Learning in the backend. Try again.",
  };
}

/** The codes Intelligence gives a run whose Learning agent did not finish a phase. */
const AGENT_FAILURES = new Set([
  "BatchInsightAgentFailed",
  "ReductionAgentFailed",
  "SkillProposalAgentFailed",
  "MalformedBatchOutput",
]);

/** The codes Intelligence gives a run its own queue or jobs stopped. */
const BACK_END_FAILURES = new Set([
  "QueueDeadLettered",
  "KubernetesJobError",
  "TransientReducerError",
]);

/**
 * Why a failed run stopped, in words for the person, or null for a run that did not fail.
 *
 * Intelligence records a code, never the Learning agent's own error (`learning-agent-client.ts` wraps
 * it "without exposing response text"). Where Learning thinks on the person's plan through this
 * server (`calls`), what reached the endpoint while the run went says the rest: nothing at all is a
 * Learning agent that could not reach OpenBot, which is what "Connection error." was on every call.
 */
export function runFailure(
  run: Pick<
    Run,
    "status" | "failureCode" | "createdAt" | "startedAt" | "completedAt"
  >,
  calls?: LearningModelCalls,
  now: () => number = Date.now,
): string | null {
  if (run.status !== "failed") return null;
  const code = run.failureCode ?? "";
  if (code === "LEARNING_MODEL_NOT_CONFIGURED")
    return "Learning has no model to think with. Sign OpenBot in to a model, then choose Learn now.";
  if (AGENT_FAILURES.has(code)) {
    if (calls) {
      const from = Date.parse(run.startedAt ?? run.createdAt);
      const to = run.completedAt ? Date.parse(run.completedAt) : now();
      const seen = calls.between(from, to);
      if (seen.includes("sign-in"))
        return "Your model plan needs signing in again. Sign in to it in OpenBot, then choose Learn now.";
      if (seen.includes("refused"))
        return "Learning couldn't sign in to OpenBot. Quit OpenBot and open it again, then choose Learn now.";
      if (seen.length === 0)
        return "Learning couldn't reach OpenBot to use your model plan. Quit OpenBot and open it again, then choose Learn now.";
      if (!seen.includes("answered") || seen.includes("unanswered"))
        return "Your model plan didn't answer Learning. Try Learn now again in a few minutes.";
    }
    return "Learning's model didn't finish. Check that your model key works and has credit, then choose Learn now.";
  }
  if (BACK_END_FAILURES.has(code))
    return "Learning was stopped before it finished. Choose Learn now to try again.";
  return "Learning stopped before it finished. Choose Learn now to try again.";
}

export const CANDIDATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most Insights one proposal shows evidence for. */
export const MAX_INSIGHTS = 10;
/** The longest cited message shown, in characters. */
export const MAX_MESSAGE = 4_000;

export type Candidate = Awaited<
  ReturnType<LearningManagement["listLearningCandidates"]>
>[number];
export type CandidateDetail = Awaited<
  ReturnType<LearningManagement["getLearningCandidate"]>
>;
export type Evidence = Awaited<
  ReturnType<LearningManagement["getLearningInsightEvidence"]>
>[number];

export type Run = Awaited<
  ReturnType<LearningManagement["listLearningRuns"]>
>[number];

export function runSummary(
  run: Run,
  calls?: LearningModelCalls,
  now: () => number = Date.now,
): LearningRunSummary {
  return {
    id: run.id,
    status: run.status,
    trigger: run.triggerSource,
    proposals: run.candidateCount,
    insights: run.insightCount,
    failureCode: run.failureCode,
    failure: runFailure(run, calls, now),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

export function proposal(candidate: Candidate): LearningProposal {
  return {
    id: candidate.id,
    title: candidate.title,
    description: candidate.description,
    reason: candidate.reason,
    operation: candidate.operation,
    status: candidate.status,
    createdAt: candidate.createdAt,
    reviewedAt: candidate.reviewedAt,
  };
}

export function evidence(entry: Evidence): LearningEvidence {
  if ("kind" in entry && entry.kind === "trajectory")
    return {
      kind: "recording",
      id: entry.trajectoryId,
      title: null,
      available: entry.trajectoryPresent && entry.unavailable === null,
      eventCount: entry.eventCount,
      events: entry.events.map((event) => event.name),
    };
  const thread = entry as Extract<Evidence, { threadId: string }>;
  return {
    kind: "conversation",
    id: thread.threadId,
    title: thread.threadName,
    available: thread.threadPresent && thread.unavailable === null,
    messages: thread.cited.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, MAX_MESSAGE),
    })),
  };
}

export function proposalDetail(
  candidate: CandidateDetail,
  insights: LearningProposalDetail["insights"],
): LearningProposalDetail {
  const files = [...candidate.bundle.files]
    .sort((a, b) =>
      a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : 0,
    )
    .map((file) => ({ path: file.path, content: file.content }));
  return { ...proposal(candidate), files, insights };
}

/** Every proposal of a container, newest first as Intelligence lists them. */
export async function readProposals(
  manage: LearningManagement,
  containerId: string,
): Promise<LearningProposal[]> {
  const candidates = await manage.listLearningCandidates({ containerId });
  return candidates.map(proposal);
}

/**
 * One proposal with its files and the evidence behind it. `titles` names recordings by id; when it
 * fails, the recordings are shown without a title rather than the proposal not loading.
 */
export async function readProposal(
  manage: LearningManagement,
  containerId: string,
  candidateId: string,
  titles?: (ids: string[]) => Promise<Map<string, string | null>>,
): Promise<LearningProposalDetail> {
  const candidate = await manage.getLearningCandidate({
    containerId,
    candidateId,
  });
  const insights = await Promise.all(
    candidate.supportingInsights
      .slice(0, MAX_INSIGHTS)
      .map(async (insight) => ({
        id: insight.id,
        statement: insight.statement,
        impact: insight.impact,
        evidence: await manage
          .getLearningInsightEvidence({ containerId, insightId: insight.id })
          .then((entries) => entries.map(evidence))
          .catch(() => null),
      })),
  );
  if (titles) {
    const ids = [
      ...new Set(
        insights.flatMap((insight) =>
          (insight.evidence ?? []).flatMap((item) =>
            item.kind === "recording" ? [item.id] : [],
          ),
        ),
      ),
    ];
    if (ids.length > 0) {
      const found = await titles(ids).catch(() => null);
      if (found)
        for (const insight of insights)
          for (const item of insight.evidence ?? [])
            if (item.kind === "recording")
              item.title = found.get(item.id) ?? null;
    }
  }
  return proposalDetail(candidate, insights);
}

/** The most approved proposals of one Skill whose evidence is read for the recordings it was learned from. */
export const MAX_SOURCE_PROPOSALS = 3;

/**
 * The recordings a published Skill was learned from, as trajectory ids in the order its evidence cites them, each with
 * whether Intelligence still has it.
 *
 * A published Skill carries no word of where it came from: Intelligence's snapshot has only its name, description and
 * files. The proposal that published it does, and Intelligence keeps reviewed proposals in the list, so the Skill's
 * sources are read from its approved proposals: the ones whose title is the Skill's name (Intelligence holds a
 * proposal's title to its SKILL.md name), newest first, back to the last approved removal of that name, since a Skill
 * removed and learned again starts over. The same for a Skill approved by hand and one approved automatically.
 */
export async function readSkillRecordings(
  manage: LearningManagement,
  containerId: string,
  skillName: string,
): Promise<{ id: string; available: boolean }[]> {
  const candidates = await manage.listLearningCandidates({ containerId });
  const published: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== "approved" || candidate.title !== skillName)
      continue;
    if (candidate.operation === "remove") break;
    published.push(candidate);
    if (published.length === MAX_SOURCE_PROPOSALS) break;
  }
  const recordings = new Map<string, boolean>();
  for (const candidate of published) {
    const detail = await manage.getLearningCandidate({
      containerId,
      candidateId: candidate.id,
    });
    const cited = await Promise.all(
      detail.supportingInsights.slice(0, MAX_INSIGHTS).map((insight) =>
        manage
          .getLearningInsightEvidence({ containerId, insightId: insight.id })
          .then((entries) => entries.map(evidence))
          // One Insight's evidence that can't be read hides only its own recordings.
          .catch(() => []),
      ),
    );
    for (const item of cited.flat())
      if (item.kind === "recording")
        recordings.set(
          item.id,
          (recordings.get(item.id) ?? false) || item.available,
        );
  }
  return [...recordings].map(([id, available]) => ({ id, available }));
}

/** Logs a failure while taking OpenBot's own record back, or while finishing it. */
function logRecordFailure(type: string, candidateId: string, error: unknown) {
  console.error(
    JSON.stringify({
      type,
      candidateId,
      errorType: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * Whether Intelligence surely did not take the review that failed with `error`: only an answer with a 4xx. A timeout,
 * a network error or a 5xx may still land, and a proposal that reads as pending right after one can be published a
 * moment later, so none of them counts.
 */
function surelyRefused(error: unknown): boolean {
  const { status } = requestFailure(error);
  return status !== undefined && status >= 400 && status < 500;
}

/**
 * What a `before` step hands `reviewProposal`: OpenBot's own record of the review, in two halves. A bare function is
 * the `undo` alone.
 */
export type ReviewSteps = {
  /** Takes the record back. Runs only when Intelligence surely refused the review (a 4xx). */
  undo?: () => Promise<void>;
  /** Finishes the record. Runs only once Intelligence has taken the review. */
  after?: () => Promise<void>;
};

/**
 * Approves or rejects a proposal. `before` runs once the proposal is read and before Intelligence is asked, so OpenBot
 * can write its own record first (callers pass it only on approve). Its `undo` takes that record back only when
 * Intelligence surely refused, with a 4xx; on any other failure the record stays, since the skill may be published
 * after all, and a record of a skill that never appears only holds it back. Its `after` runs once Intelligence has
 * taken the review, for a record that must not change before then. If `before` throws, Intelligence is never asked. A
 * failing undo or `after` is logged: an undo never hides Intelligence's error, which is what the caller gets, and an
 * `after` never turns the review Intelligence took into a failure.
 */
export async function reviewProposal({
  manage,
  containerId,
  candidateId,
  action,
  before,
}: {
  manage: LearningManagement;
  containerId: string;
  candidateId: string;
  action: "approve" | "reject";
  before?: (
    detail: LearningProposalDetail,
  ) => Promise<ReviewSteps | (() => Promise<void>)>;
}): Promise<{
  id: string;
  status: "approved" | "rejected";
  operation: "add" | "update" | "remove";
  title: string;
}> {
  const candidate = await manage.getLearningCandidate({
    containerId,
    candidateId,
  });
  const handed = before ? await before(proposalDetail(candidate, [])) : {};
  const steps: ReviewSteps =
    typeof handed === "function" ? { undo: handed } : handed;
  let review: Awaited<
    ReturnType<LearningManagement["reviewLearningCandidate"]>
  >;
  try {
    review = await manage.reviewLearningCandidate({
      containerId,
      candidateId,
      action,
    });
  } catch (error) {
    if (steps.undo && surelyRefused(error)) {
      try {
        await steps.undo();
      } catch (undoError) {
        logRecordFailure("learning-review-undo-failed", candidateId, undoError);
      }
    }
    throw error;
  }
  if (steps.after) {
    try {
      await steps.after();
    } catch (afterError) {
      logRecordFailure("learning-review-after-failed", candidateId, afterError);
    }
  }
  return {
    id: candidateId,
    status: review.status,
    operation: review.operation,
    title: candidate.title,
  };
}
