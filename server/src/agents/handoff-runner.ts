/**
 * Delivering a hop: running the Bot that was addressed, and putting its answer in the conversation.
 *
 * The other half of `handoff.ts`. Deciding happens inside somebody's run and has to be quick and
 * fail closed; delivering is a whole agent turn against a model, and it has to survive the pod it
 * started on. So the two are separated by the queue rather than by a function call.
 *
 * CLAIMED, NOT ASSIGNED. Any replica may take any hop, which is what makes this work on a cluster
 * where the Bot being addressed is very unlikely to be on the pod that addressed it. The lease is
 * renewed for as long as the run takes, because a run is minutes and a lease that lapses mid-answer
 * hands the same hop to a second replica and bills for it twice.
 */
import { type AuditStore, recordAuditEvent } from "../audit";
import type { WorkQueue } from "../work/queue";
import { HANDOFF_KIND } from "./handoff";

/** What a hop carries, as `handoff.ts` wrote it. */
export type HandoffWork = {
  fromBotId: string;
  toBotId: string;
  actorId: string;
  threadId: string;
  runId: string;
  depth: number;
  task: string;
  constraints?: string;
  expecting?: string;
};

export type HandoffDelivery = {
  /**
   * Run the addressed Bot against the conversation, and resolve when its turn is on record.
   *
   * Rejecting means the hop did not happen and is worth another go. Resolving means it did, whatever
   * the Bot said: a Bot that answers "I could not find that" has answered, and retrying would ask it
   * the same question again and bill for the same non-answer.
   */
  deliver: (input: {
    work: HandoffWork;
    /** The message the addressed Bot sees, already attributed by the deployment. */
    message: string;
    /** The signed statement of the run it is starting, carrying its depth. */
    assertion: string;
  }) => Promise<void>;
};

export type HandoffRunReport = {
  delivered: string[];
  skipped: { key: string; reason: string }[];
};

/**
 * How often a claim is refreshed while a hop is being delivered.
 *
 * Comfortably inside the lease, because a renewal that lands after it has lapsed is not a renewal:
 * the item has already gone to somebody else, and this one is now the second replica running it.
 */
const RENEW_EVERY_MS = 20_000;

export function createHandoffRunner(options: {
  queue: WorkQueue;
  delivery: HandoffDelivery;
  /** Who this replica is, for the lease. */
  owner: string;
  /** How the deployment signs what the addressed Bot's run is. */
  sign: (work: HandoffWork) => string;
  auditStore: AuditStore;
  /** How long a claim lasts before anything may take it back. */
  leaseMs?: number;
  /** How many hops one sweep will take. */
  limit?: number;
}) {
  const {
    queue,
    delivery,
    owner,
    sign,
    auditStore,
    leaseMs = 60_000,
    limit = 5,
  } = options;

  return {
    /** Deliver whatever this replica can claim. */
    async sweep(): Promise<HandoffRunReport> {
      const claimed = await queue.claim({
        kind: HANDOFF_KIND,
        owner,
        leaseMs,
        limit,
      });
      const report: HandoffRunReport = { delivered: [], skipped: [] };

      for (const item of claimed) {
        const work = item.payload as unknown as HandoffWork;
        if (!work?.toBotId || !work.threadId) {
          /*
           * A hop nothing can be done with. Finished rather than released, because releasing it puts
           * the same unusable row back on the queue for ever.
           */
          await queue.finish({ kind: HANDOFF_KIND, key: item.key, owner });
          report.skipped.push({ key: item.key, reason: "not a hop" });
          continue;
        }

        /*
         * A hop that has already been tried is not a fresh one, and the difference matters here more
         * than anywhere else this queue is used: a first attempt has certainly not run the other
         * Bot, while a second may already have run it, spent a model call and posted an answer
         * before its owner died. Recorded rather than guessed at, so somebody reading the trail can
         * tell a duplicate answer from a mystery.
         */
        if (item.attempts > 1) {
          await recordAuditEvent(auditStore, {
            eventType: "agent.handoff_retried",
            targetType: "agent",
            targetId: work.toBotId,
            ...(work.actorId ? { actorUserId: work.actorId } : {}),
            payload: {
              from: work.fromBotId,
              to: work.toBotId,
              run: work.runId,
              attempt: item.attempts,
              note: "A previous attempt may already have run this Bot.",
            },
          });
        }

        const heartbeat = setInterval(() => {
          void queue
            .renew({ kind: HANDOFF_KIND, key: item.key, owner, leaseMs })
            .catch(() => {});
        }, RENEW_EVERY_MS);

        try {
          await delivery.deliver({
            work,
            message: attribute(work),
            assertion: sign(work),
          });
          await queue.finish({ kind: HANDOFF_KIND, key: item.key, owner });
          report.delivered.push(work.toBotId);
          await recordAuditEvent(auditStore, {
            eventType: "agent.handoff_delivered",
            targetType: "agent",
            targetId: work.toBotId,
            ...(work.actorId ? { actorUserId: work.actorId } : {}),
            payload: {
              from: work.fromBotId,
              to: work.toBotId,
              run: work.runId,
              depth: work.depth,
            },
          });
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : "could not be delivered";
          /*
           * Released and pushed out rather than dropped. The work still wants doing, and whatever
           * refused it once will probably refuse it again in the next second.
           */
          await queue.release({
            kind: HANDOFF_KIND,
            key: item.key,
            owner,
            delayMs: 60_000,
            reason,
          });
          report.skipped.push({ key: item.key, reason });
          await recordAuditEvent(auditStore, {
            eventType: "agent.handoff_failed",
            targetType: "agent",
            targetId: work.toBotId,
            ...(work.actorId ? { actorUserId: work.actorId } : {}),
            payload: {
              from: work.fromBotId,
              to: work.toBotId,
              run: work.runId,
              attempt: item.attempts,
              reason,
            },
          });
        } finally {
          clearInterval(heartbeat);
        }
      }

      return report;
    },
  };
}

/**
 * What the addressed Bot is shown.
 *
 * WHO IS ASKING IS STAMPED HERE, from the row this deployment wrote, and never taken from anything a
 * model produced. A Bot able to write its own attribution is a Bot able to claim to be another one,
 * and the whole point of naming the sender is that the answer can be trusted to say who wanted it.
 *
 * The parts stay parts. The asking model was made to name the task, its constraints and what a good
 * answer looks like precisely so the receiving one does not have to infer them out of a paragraph,
 * and flattening them back into prose here would throw that away at the last step.
 */
function attribute(work: HandoffWork): string {
  const lines = [
    `${work.fromBotId} has asked you to help with this, on behalf of the person in this conversation.`,
    "",
    `Task: ${work.task}`,
  ];
  if (work.constraints) lines.push(`Constraints: ${work.constraints}`);
  if (work.expecting)
    lines.push(`What a good answer looks like: ${work.expecting}`);
  lines.push(
    "",
    "Answer in this conversation as yourself. The person can see it, so write it for them rather than for the Bot that asked.",
  );
  return lines.join("\n");
}
