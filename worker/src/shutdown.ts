/**
 * Stopping the worker loop without losing a run.
 *
 * The loop in `index.ts` used to be `for (;;)` with no signal handling, so SIGTERM in
 * Docker/Kubernetes killed it mid-sweep: a claimed `routine.fire` item stayed claimed
 * until its lease expired instead of being picked back up promptly, and a laptop
 * restart landed mid-`fetch` with nothing saying so. This module holds the one flag
 * the loop checks — between phases and around the sleep — so a second SIGTERM still
 * exits promptly but the first one lets the in-flight tick finish.
 *
 * Kept separate from `index.ts` so the flag and the interruptible sleep are
 * unit-testable without signals, timers, or a database.
 */

export type ShutdownController = {
  /** True once SIGTERM/SIGINT (or `requestShutdown`) has arrived. */
  readonly shutdownRequested: boolean;
  requestShutdown: (signal: string) => void;
  install: () => () => void;
};

export function createShutdownController(
  onShutdown?: (signal: string) => void,
): ShutdownController & { shutdownRequested: boolean } {
  let requested = false;
  const controller = {
    get shutdownRequested() {
      return requested;
    },
    requestShutdown(signal: string) {
      if (requested) return;
      requested = true;
      console.info(
        JSON.stringify({ type: "worker-shutdown-requested", signal }),
      );
      onShutdown?.(signal);
    },
    install() {
      const onSigterm = () => controller.requestShutdown("SIGTERM");
      const onSigint = () => controller.requestShutdown("SIGINT");
      process.on("SIGTERM", onSigterm);
      process.on("SIGINT", onSigint);
      return () => {
        process.off("SIGTERM", onSigterm);
        process.off("SIGINT", onSigint);
      };
    },
  };
  return controller;
}

/**
 * Sleep that wakes early when shutdown arrives, so SIGTERM during the 30s wait does
 * not hold the container past its grace period. Resolves true when the full delay
 * elapsed and false when shutdown cut it short.
 */
export function interruptibleSleep(
  ms: number,
  isShutdown: () => boolean,
  timer: typeof setTimeout = setTimeout,
): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!isShutdown());
  return new Promise((resolve) => {
    const started = Date.now();
    const step = 50;
    const tick = () => {
      if (isShutdown()) {
        resolve(false);
        return;
      }
      if (Date.now() - started >= ms) {
        resolve(true);
        return;
      }
      timer(tick, Math.min(step, ms));
    };
    timer(tick, Math.min(step, ms));
  });
}
