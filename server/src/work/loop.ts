/**
 * Running something over and over, one at a time.
 *
 * A `setInterval` fires on the clock whether or not the last run has finished, which is right for
 * housekeeping that takes milliseconds and wrong for anything that takes a turn. The sweep this was
 * written for claims work with `for update skip locked`, so overlapping runs do not contend over the
 * same row: they each take a DIFFERENT batch, which is the worse failure. One delivery may run for
 * its whole deadline, and a two-second interval starts a hundred and fifty more sweeps while it
 * does, each claiming another batch and starting its own agent runs. The concurrency has no bound
 * but the backlog.
 *
 * So the next run is scheduled when the last one ends, and the gap is measured from the end rather
 * than from the start. An idle deployment also stops paying for a claim every two seconds.
 */
export type Repeating = {
  /** Stop scheduling. A run already in flight is left to finish. */
  stop: () => void;
};

export function repeatAfterEach(
  work: () => Promise<void>,
  everyMs: number,
  /**
   * The timer, so a test can drive this without waiting in real time.
   *
   * Defaulted rather than required: every caller in this deployment wants the real one, and a seam
   * nobody uses in production is a seam that can be wrong without anybody noticing.
   */
  schedule: (
    run: () => void,
    ms: number,
  ) => { unref?: () => void } = setTimeout,
): Repeating {
  let stopped = false;
  const next = () => {
    if (stopped) return;
    const timer = schedule(() => {
      if (stopped) return;
      /*
       * Both outcomes schedule the next run, and the failure is swallowed HERE rather than left to
       * `finally`.
       *
       * A loop that stopped the first time the database blinked would stay stopped until somebody
       * restarted the pod, silently. But `finally` re-raises what it caught, so `void work().finally`
       * keeps looping and leaves an unhandled rejection behind every failed run — which on Bun ends
       * the process by default, turning a blink into a crash loop.
       *
       * Swallowed rather than reported because the caller is the one that knows what a failure
       * means: `sweep` already logs its own. A caller that wants this to be loud should say so in
       * `work` rather than throwing past it.
       */
      void work().then(next, next);
    }, everyMs);
    // Unref'd where the timer supports it, so this never holds the process open on its own. A pod
    // draining should drain.
    timer.unref?.();
  };
  next();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
