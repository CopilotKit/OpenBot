import { BOT_PAUSED_REASON, isBotPaused } from "../agents/lifecycle";
import { HeadlessToolSuspension } from "../computer/headless-tools";
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
  failed: { runId: string; error: string }[];
};

function errorText(error: unknown) {
  return Array.from(error instanceof Error ? error.message : String(error))
    .slice(0, 1000)
    .join("");
}

export function createResponsibilityEngine(options: {
  store: Pick<ResponsibilityStore, "ingestEvent" | "beginRun" | "settleRun">;
  queue: Pick<WorkQueue, "claim" | "renew" | "finish">;
  runTurn: RunResponsibilityTurn;
  onReply?: (
    context: ResponsibilityRunContext,
    replyText: string,
  ) => Promise<void>;
}) {
  const { store, queue, runTurn, onReply } = options;
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
          } else {
            const reason = errorText(error);
            await store.settleRun(runId, { status: "failed", error: reason });
            report.failed.push({ runId, error: reason });
          }
        } finally {
          stopped = true;
          if (timer) clearTimeout(timer);
          await renewing;
          await finish(item.key);
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
