import type { LearningSource } from "@openbot/shared/learning";
import { type AuditStore, recordAuditEvent } from "../audit";
import { recordApprovalBefore, type SkillApprovalStore } from "./approvals";
import {
  type LearningManagement,
  readProposals,
  requestFailure,
  reviewProposal,
} from "./review";

function logFailure(
  error: unknown,
  where: { containerId: string; candidateId?: string },
) {
  const { status, code } = requestFailure(error);
  console.error(
    JSON.stringify({
      type: "learning-auto-approve-failed",
      ...where,
      errorType: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
      ...(status !== undefined ? { status } : {}),
      ...(code !== undefined ? { code } : {}),
    }),
  );
}

/**
 * The personal edition's sweep: approves every pending proposal of the person's Learning sources while automatic
 * approval is on, recording a person's approval for skills learned from recordings first. One sweep runs at a time; a
 * call while one runs gets that sweep. A proposal another review already settled (409) counts as done; any other
 * failure, of one proposal or one source, is logged and the sweep goes on.
 */
export function createAutoApprover(deps: {
  manage: LearningManagement;
  enabled: () => Promise<boolean>;
  sources: () => Promise<LearningSource[]>;
  approvals: SkillApprovalStore;
  userId: string;
  audit?: AuditStore;
}): { sweep(): Promise<{ approved: number }> } {
  let running: Promise<{ approved: number }> | undefined;

  async function approveOne(
    source: LearningSource,
    candidateId: string,
  ): Promise<boolean> {
    let review: Awaited<ReturnType<typeof reviewProposal>>;
    try {
      review = await reviewProposal({
        manage: deps.manage,
        containerId: source.containerId,
        candidateId,
        action: "approve",
        before:
          source.kind === "recordings"
            ? recordApprovalBefore(deps.approvals, deps.userId, "person")
            : undefined,
      });
    } catch (error) {
      if (requestFailure(error).code !== "LEARNING_CANDIDATE_CONFLICT")
        logFailure(error, { containerId: source.containerId, candidateId });
      return false;
    }
    // The proposal is approved; a failing audit write is logged and doesn't take that back.
    try {
      if (deps.audit)
        await recordAuditEvent(deps.audit, {
          eventType: "configuration.changed",
          targetType: "learning_skill",
          targetId: candidateId,
          actorUserId: deps.userId,
          payload: {
            change: "skill_approved",
            containerId: source.containerId,
            title: review.title,
            operation: review.operation,
            by: "automatic",
          },
        });
    } catch (error) {
      logFailure(error, { containerId: source.containerId, candidateId });
    }
    return true;
  }

  async function run(): Promise<{ approved: number }> {
    if (!(await deps.enabled())) return { approved: 0 };
    let approved = 0;
    for (const source of await deps.sources()) {
      let pending: string[];
      try {
        pending = (await readProposals(deps.manage, source.containerId))
          .filter((proposal) => proposal.status === "pending_review")
          .map((proposal) => proposal.id);
      } catch (error) {
        logFailure(error, { containerId: source.containerId });
        continue;
      }
      for (const candidateId of pending)
        if (await approveOne(source, candidateId)) approved++;
    }
    return { approved };
  }

  return {
    sweep() {
      if (running) return running;
      running = run().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
