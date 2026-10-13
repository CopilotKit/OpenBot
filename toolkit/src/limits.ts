/**
 * The limits a headless turn runs under, in one place.
 *
 * No imports, on purpose: the routines sweep runs as a CronJob and derives its own cutoff from
 * `turnTimeoutMs`, so it reads this file without pulling the turn runner, the Intelligence client and
 * everything behind them into that process.
 */
export const TURN_LIMITS = {
  /** How long one headless turn may take before it is stopped. */
  turnTimeoutMs: 5 * 60_000,

  /**
   * The gap between stopping a turn and giving up on it.
   *
   * `abortRun` on `RunSelectedAgent` reaches the agent the run turned into, and that agent does not
   * exist until `build()` resolves (`copilot.ts:649, 664-673`): during that window the wrapper has no
   * `inner`, so abort is a no-op and the deadline cannot actually stop anything. This is the backstop
   * that settles the promise anyway, so a firing cannot hang for ever on a build that never finishes.
   */
  abortGraceMs: 5_000,

  /**
   * The lock lifetime this turn asks for, and how often it renews.
   *
   * The same relationship the runtime's own handler uses: renew comfortably inside the lifetime so one
   * slow request does not drop a lock we still hold. The lifetime matters to a person: while it is
   * held, their browser's next message is refused with 409 "Thread lock denied" (`run.mjs:91`), so a
   * lock leaked by a failed routine locks them out of their own conversation for that long.
   *
   * ADVISORY. The Intelligence platform currently ignores the requested lifetime: its acquire and
   * renew both apply its own fixed 120 seconds (`THREAD_LOCK_TTL_SECONDS` in
   * `apps/app-api/src/routes/thread-lock.ts`). So a leaked lock lasts up to two minutes today, and
   * this number only takes effect if the platform starts honouring it. Renewing every 15s is well
   * inside either.
   */
  lockTtlSeconds: 20,
  heartbeatMs: 15_000,
} as const;
