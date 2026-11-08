import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type {
  LearningEvidence,
  LearningProposal,
  LearningProposalDetail,
  LearningRunSummary,
} from "@openbot/shared/learning";
import type { ContentfulStatusCode } from "hono/utils/http-status";

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

/** What to tell an admin when Intelligence refused a Learning request, and with which status. */
export function learningFailure(error: unknown): {
  status: ContentfulStatusCode;
  error: string;
} {
  const { status, code } = requestFailure(error);
  if (status === 404 && code === "ROUTE_NOT_FOUND")
    return {
      status: 409,
      error:
        "Learning is switched off in the back end. Turn it on there (learning.enabled in its Helm chart).",
    };
  if (code === "LEARNING_CONTAINER_NOT_FOUND")
    return {
      status: 404,
      error: "This Learning container doesn't exist in the back end yet.",
    };
  if (code === "LEARNING_CANDIDATE_NOT_FOUND")
    return {
      status: 404,
      error: "The back end no longer has this skill. Refresh the list.",
    };
  if (code === "LEARNING_CANDIDATE_CONFLICT")
    return {
      status: 409,
      error: "This skill was already reviewed. Refresh the list to see it.",
    };
  if (code === "LEARNING_NOT_ENABLED")
    return {
      status: 403,
      error: "The back end's licence doesn't include Learning.",
    };
  if (code === "LEARNING_MODEL_NOT_CONFIGURED")
    return {
      status: 409,
      error:
        "The back end has no Learning model yet. Give its Learning agent a model and key, then try again.",
    };
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED")
    return {
      status: 429,
      error: "The back end is busy. Try again in a minute.",
    };
  return {
    status: 502,
    error: "Couldn't reach Learning in the back end. Try again.",
  };
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

export function runSummary(run: Run): LearningRunSummary {
  return {
    id: run.id,
    status: run.status,
    trigger: run.triggerSource,
    proposals: run.candidateCount,
    insights: run.insightCount,
    failureCode: run.failureCode,
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
