import type { LearningSource } from "@openbot/shared/learning";
import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import {
  recordApprovalBefore,
  type SkillApprovalStore,
  UnnamedSkillError,
} from "./approvals";
import {
  type LearningManagement,
  readProposals,
  requestFailure,
  reviewProposal,
} from "./review";

function logFailure(
  error: unknown,
  where: { containerId?: string; candidateId?: string },
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
 * approval is on, recording a person's approval for skills learned from recordings first. Whether it is on is read
 * again before each proposal, so switching it off stops a sweep part-way. One sweep runs at a time; a call while one
 * runs waits for it and then gets one more sweep, shared by every call made meanwhile, so a sweep always starts after
 * the call that asked for it. A proposal another review already settled (LEARNING_CANDIDATE_CONFLICT) is skipped
 * quietly and not counted. A skill from recordings with no name can't be recorded as the person's: it is logged once
 * and skipped by later sweeps in this process (a changed skill is a new proposal, with a new id). Any other failure, of
 * one proposal or one source, is logged and the sweep goes on. A sweep never rejects: settings that can't be read are
 * logged and approve nothing.
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
  let queued: Promise<{ approved: number }> | undefined;
  /** Proposals with no skill name, as container and candidate id: logged once, then left for the person. */
  const unnamed = new Set<string>();
  const key = (containerId: string, candidateId: string) =>
    JSON.stringify([containerId, candidateId]);

  /** Whether automatic approval is still on; a failed read is logged and counts as off. */
  async function stillOn(): Promise<boolean> {
    try {
      return await deps.enabled();
    } catch (error) {
      logFailure(error, {});
      return false;
    }
  }

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
      if (error instanceof UnnamedSkillError)
        unnamed.add(key(source.containerId, candidateId));
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
          // Not the person approving: Activity shows the deployment, and `by` says it was automatic.
          initiator: DEPLOYMENT_INITIATOR,
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
    let sources: LearningSource[];
    try {
      if (!(await deps.enabled())) return { approved: 0 };
      sources = await deps.sources();
    } catch (error) {
      logFailure(error, {});
      return { approved: 0 };
    }
    let approved = 0;
    for (const source of sources) {
      let pending: string[];
      try {
        pending = (await readProposals(deps.manage, source.containerId))
          .filter((proposal) => proposal.status === "pending_review")
          .map((proposal) => proposal.id);
      } catch (error) {
        // A person who never recorded has no space yet: nothing is pending, and nothing is wrong.
        if (requestFailure(error).code !== "LEARNING_CONTAINER_NOT_FOUND")
          logFailure(error, { containerId: source.containerId });
        continue;
      }
      for (const candidateId of pending) {
        if (unnamed.has(key(source.containerId, candidateId))) continue;
        if (!(await stillOn())) return { approved };
        if (await approveOne(source, candidateId)) approved++;
      }
    }
    return { approved };
  }

  function start(): Promise<{ approved: number }> {
    const current = run().finally(() => {
      if (running === current) running = undefined;
    });
    running = current;
    return current;
  }

  return {
    sweep() {
      if (queued) return queued;
      if (!running) return start();
      // Settings may have changed since the running sweep read them: run once more after it, for every call meanwhile.
      queued = running.then(
        () => {
          queued = undefined;
          return start();
        },
        () => {
          queued = undefined;
          return start();
        },
      );
      return queued;
    },
  };
}
