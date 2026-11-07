import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { isThreadBusy } from "@openbot/toolkit/lease";
import { BOT_PAUSED_REASON, isBotPaused } from "../agents/lifecycle";
import type { WorkQueue } from "../work/queue";
import type { ResponsibilityRunContext, ResponsibilityStore } from "./types";

export const RESPONSIBILITY_RUN_KIND = "responsibility.run";
export type RunResponsibilityTurn = (
  input: ResponsibilityRunContext & { signal: AbortSignal },
) => Promise<{ replyText: string }>;
export type ResponsibilityDispatchReport = {
  succeeded: string[];
  waiting: string[];
  skipped: string[];
  /** Put back to wait for a conversation another run was using. Nothing ran. */
  busy: string[];
  failed: { runId: string; error: string }[];
};

/**
 * How long a run waits for a conversation another run is using: `firstMs`, doubling, never more than
 * `maxMs` between tries, for at most `tries` tries before the run fails.
 *
 * FOUND LIVE: "Create a goal … then run it now" in one message started the goal's run while the Bot
 * was still answering in that conversation. Intelligence refused the run's lock with 409
 * `THREAD_LOCK_FAILED`, marked retryable, and the run was recorded as failed with the platform's
 * response body as its reason. The defaults wait about nine minutes in all: far longer than a
 * Bot's answer, and short enough that a goal stuck behind something else says so the same day.
 */
export type BusyRetry = { firstMs: number; maxMs: number; tries: number };
export const BUSY_RETRY: BusyRetry = {
  firstMs: 5_000,
  maxMs: 60_000,
  tries: 12,
};

/** The longest a run waits in all, in whole minutes, for the sentence that says it gave up. */
function waitedFor({ firstMs, maxMs, tries }: BusyRetry): string {
  let total = 0;
  for (let index = 0; index < tries; index += 1)
    total += Math.min(firstMs * 2 ** index, maxMs);
  const minutes = Math.max(1, Math.round(total / 60_000));
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

function errorText(error: unknown) {
  return Array.from(error instanceof Error ? error.message : String(error))
    .slice(0, 1000)
    .join("");
}

export function createResponsibilityEngine(options: {
  store: Pick<
    ResponsibilityStore,
    "ingestEvent" | "beginRun" | "settleRun" | "requeueRun"
  >;
  queue: Pick<WorkQueue, "claim" | "renew" | "finish" | "release">;
  runTurn: RunResponsibilityTurn;
  onReply?: (
    context: ResponsibilityRunContext,
    replyText: string,
  ) => Promise<void>;
  busyRetry?: BusyRetry;
}) {
  const { store, queue, runTurn, onReply } = options;
  const busyRetry = options.busyRetry ?? BUSY_RETRY;
  return {
    ingest: (event: unknown) => store.ingestEvent(event),
    async dispatch(input: {
      owner: string;
      limit?: number;
      leaseMs?: number;
    }): Promise<ResponsibilityDispatchReport> {
      const leaseMs = input.leaseMs ?? 15 * 60_000;
      if (leaseMs < 1000)
        throw new Error("Responsibility lease must be at least one second.");
      const report: ResponsibilityDispatchReport = {
        succeeded: [],
        waiting: [],
        skipped: [],
        busy: [],
        failed: [],
      };
      const items = await queue.claim({
        kind: RESPONSIBILITY_RUN_KIND,
        owner: input.owner,
        leaseMs,
        limit: input.limit ?? 5,
        maxAttempts: 2,
      });
      for (const item of items) {
        const runId = item.payload.runId;
        if (typeof runId !== "string" || !runId)
          throw new Error("Responsibility work item has no run ID.");
        if (
          !(await queue.renew({
            kind: RESPONSIBILITY_RUN_KIND,
            key: item.key,
            owner: input.owner,
            leaseMs,
          }))
        )
          throw new Error("Responsibility work lease expired before dispatch.");
        const context = await store.beginRun(runId, {
          recovered: item.attempts > 1,
        });
        if (!context) {
          await finish(item.key);
          report.skipped.push(runId);
          continue;
        }
        // A paused Bot's run is skipped, not failed. See agents/lifecycle.ts.
        if (await isBotPaused(context.ownerUserId, context.agentId)) {
          await store.settleRun(runId, {
            status: "skipped",
            error: BOT_PAUSED_REASON,
          });
          await finish(item.key);
          report.skipped.push(runId);
          continue;
        }
        const controller = new AbortController();
        /** Put back on the queue to wait for its conversation, so not finished here. */
        let released = false;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let renewing: Promise<void> | undefined;
        let lostLease: Error | undefined;
        const scheduleRenewal = () => {
          timer = setTimeout(
            () => {
              renewing = renew();
            },
            Math.floor(leaseMs / 3),
          );
        };
        const renew = async () => {
          try {
            const held = await queue.renew({
              kind: RESPONSIBILITY_RUN_KIND,
              key: item.key,
              owner: input.owner,
              leaseMs,
            });
            if (!held) throw new Error("Responsibility work lease was lost.");
          } catch (error) {
            lostLease =
              error instanceof Error ? error : new Error(String(error));
            controller.abort(lostLease);
          }
          if (!stopped && !lostLease) scheduleRenewal();
        };
        scheduleRenewal();
        try {
          const result = await runTurn({
            ...context,
            signal: controller.signal,
          });
          if (lostLease) throw lostLease;
          await store.settleRun(runId, {
            status: "succeeded",
            replyText: result.replyText,
          });
          report.succeeded.push(runId);
          if (onReply) {
            try {
              await onReply(context, result.replyText);
            } catch (error) {
              report.failed.push({
                runId,
                error: `Reply delivery failed: ${errorText(error)}`,
              });
            }
          }
        } catch (error) {
          if (error instanceof HeadlessToolSuspension) {
            await store.settleRun(runId, {
              status: "waiting",
              waiting: error.waiting,
              error: errorText(error),
            });
            report.waiting.push(runId);
          } else if (isThreadBusy(error) && !lostLease) {
            /*
             * ANOTHER RUN HAS THE CONVERSATION, SO NOTHING RAN. The lock is taken before anything
             * is streamed, and the platform said to try again: the run goes back to queued and the
             * item back on the queue, uncounted, to be tried after a wait that doubles. Only once
             * the waits are spent is it a failure, in words a person reads.
             */
            const waited = Number(
              (item.payload as { busyRetries?: unknown }).busyRetries ?? 0,
            );
            const tries = Number.isFinite(waited) ? waited : 0;
            if (tries >= busyRetry.tries) {
              const reason = `This goal's conversation was busy for about ${waitedFor(busyRetry)}, so the run never started and nothing was done. Run the goal again when the conversation is free.`;
              await store.settleRun(runId, { status: "failed", error: reason });
              report.failed.push({ runId, error: reason });
            } else if (!(await store.requeueRun(runId))) {
              report.skipped.push(runId);
            } else {
              released = await queue.release({
                kind: RESPONSIBILITY_RUN_KIND,
                key: item.key,
                owner: input.owner,
                delayMs: Math.min(
                  busyRetry.firstMs * 2 ** tries,
                  busyRetry.maxMs,
                ),
                reason: errorText(error),
                uncounted: true,
                payload: { busyRetries: tries + 1 },
              });
              if (!released)
                throw new Error(
                  "Responsibility work lease was lost before the run could wait.",
                );
              report.busy.push(runId);
            }
          } else {
            const reason = errorText(error);
            await store.settleRun(runId, { status: "failed", error: reason });
            report.failed.push({ runId, error: reason });
          }
        } finally {
          stopped = true;
          if (timer) clearTimeout(timer);
          await renewing;
          if (!released) await finish(item.key);
        }
      }
      return report;
      async function finish(key: string) {
        const finished = await queue.finish({
          kind: RESPONSIBILITY_RUN_KIND,
          key,
          owner: input.owner,
        });
        if (!finished)
          throw new Error(
            "Responsibility work lease was lost before completion.",
          );
      }
    },
  };
}

export type ResponsibilityEngine = ReturnType<
  typeof createResponsibilityEngine
>;
