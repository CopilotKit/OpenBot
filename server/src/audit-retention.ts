/**
 * Housekeeping on a schedule: old turn screenshots and the check-in ledger.
 *
 * The audit trail's retention used to run here too, against this deployment's own `audit_events`.
 * The trail lives in Intelligence now and Intelligence keeps it to the windows this deployment sets
 * at boot (`audit-trail/retention.ts`), with the same append-only rule: a delete must declare its
 * window and cannot reach a row inside it. What stays here is the working state that is not a trail.
 */
import {
  FRAME_RETENTION_MS,
  type PageFrameStore,
} from "./computer/page-frames";
import type { ProactiveStore } from "./proactive/store";

export type RetentionSweeper = { stop: () => void };

/**
 * Sweep on an interval, starting shortly after boot.
 *
 * Not immediately at boot: a deployment rolling several servers would have all of them contend for
 * the lock in the same second, and the one that wins would compete with start-up for the database.
 */
export function startRetentionSweeps(
  // Their only other caller runs in `computers.mode: sandbox` alone.
  pageFrames?: PageFrameStore,
  options: {
    intervalMs?: number;
    firstRunMs?: number;
    /**
     * The check-in ledger and old pings (proactive/store.ts): working state, not a trail, and an
     * hourly check-in per person and Bot writes 24 ledger rows a day that nothing reads after a month.
     */
    proactive?: Pick<ProactiveStore, "prune">;
  } = {},
): RetentionSweeper {
  const { proactive } = options;
  if (!pageFrames && !proactive) return { stop: () => undefined };

  const intervalMs = options.intervalMs ?? 60 * 60_000;
  const firstRunMs = options.firstRunMs ?? 60_000;
  const timers: ReturnType<typeof setInterval>[] = [];

  const run = () => {
    if (pageFrames) {
      void pageFrames
        .purge(FRAME_RETENTION_MS)
        .then((removed) => {
          if (removed === 0) return;
          console.info(JSON.stringify({ type: "page-frames-swept", removed }));
        })
        .catch((error) => {
          console.error(
            JSON.stringify({
              type: "page-frames-sweep-failed",
              note: "Old turn screenshots were not removed. Nothing is broken; the table is larger than it should be.",
              error: String(error),
            }),
          );
        });
    }
    if (proactive) {
      void proactive
        .prune()
        .then(({ runs, pings }) => {
          if (runs === 0 && pings === 0) return;
          console.info(
            JSON.stringify({ type: "proactive-ledger-swept", runs, pings }),
          );
        })
        .catch((error) => {
          console.error(
            JSON.stringify({
              type: "proactive-ledger-sweep-failed",
              note: "Old check-in runs and pings were not removed. Nothing is broken; the tables are larger than they need to be.",
              error: String(error),
            }),
          );
        });
    }
  };

  const first = setTimeout(() => {
    run();
    const repeating = setInterval(run, intervalMs);
    // Housekeeping should not hold the process open.
    repeating.unref?.();
    timers.push(repeating);
  }, firstRunMs);
  first.unref?.();

  return {
    stop: () => {
      clearTimeout(first);
      for (const timer of timers) clearInterval(timer);
    },
  };
}
