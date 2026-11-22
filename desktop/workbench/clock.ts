// A controlled page clock for the workbench. It replaces the time functions of
// a target (the iframe window that loads OpenBot Desktop) so that the
// workbench can play, pause, step and seek time deterministically.

export const SCENE_EPOCH = Date.UTC(2026, 10, 22, 9, 0, 0);

export interface ClockTarget {
  Date: DateConstructor;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  performance: { now(): number };
}

export interface PageClock {
  /** Milliseconds since the scene start. */
  now(): number;
  /** 1, 10, or Infinity (as fast as possible, yielding to the real event loop between timers). */
  play(speed: number): void;
  pause(): void;
  playing(): boolean;
  /** Runs the next due timer or scheduled item and returns its time; null when none. */
  stepToNext(): number | null;
  /** Runs everything due up to `ms` in time order, synchronously. `ms < now()` is a no-op. */
  advanceTo(ms: number): void;
  /** Runs `run` once at absolute clock time `at` ms. */
  schedule(at: number, run: () => void): void;
  /** Called whenever now() changes. Returns an unsubscribe function. */
  onTick(listener: (ms: number) => void): () => void;
  /** Restores the target's original functions. */
  uninstall(): void;
}

interface Timer {
  id: number;
  due: number;
  seq: number;
  /** Interval in ms for setInterval; null for one-shot timers. */
  interval: number | null;
  run: () => void;
}

const RUNAWAY_LIMIT = 100_000;
const REAL_FRAME_MS = 16;

function toDelay(value: unknown, min: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, n);
}

function report(error: unknown): void {
  const reportError = (globalThis as { reportError?: (e: unknown) => void })
    .reportError;
  if (typeof reportError === "function") reportError(error);
  else console.error(error);
}

export function installClock(
  start: number,
  target: ClockTarget = globalThis,
): PageClock {
  // Capture the real functions BEFORE replacing them; real time drives play().
  const original = {
    Date: target.Date,
    setTimeout: target.setTimeout,
    clearTimeout: target.clearTimeout,
    setInterval: target.setInterval,
    clearInterval: target.clearInterval,
  };
  const perf = target.performance;
  const perfHadOwnNow = Object.hasOwn(perf, "now");
  const originalPerfNow = perf.now;
  const RealDate = original.Date;
  const realSetTimeout = original.setTimeout;
  const realClearTimeout = original.clearTimeout;

  let current = 0;
  let nextId = 1;
  let nextSeq = 0;
  const timers = new Map<number, Timer>();
  const listeners = new Set<(ms: number) => void>();

  let speed = 0;
  let isPlaying = false;
  let realHandle: ReturnType<typeof setTimeout> | null = null;
  let lastReal = 0;

  function setNow(ms: number): void {
    if (ms === current) return;
    current = ms;
    for (const listener of [...listeners]) {
      try {
        listener(ms);
      } catch (error) {
        report(error);
      }
    }
  }

  function add(due: number, interval: number | null, run: () => void): number {
    const id = nextId++;
    timers.set(id, { id, due, seq: nextSeq++, interval, run });
    return id;
  }

  function earliest(): Timer | null {
    let best: Timer | null = null;
    for (const timer of timers.values()) {
      if (
        best === null ||
        timer.due < best.due ||
        (timer.due === best.due && timer.seq < best.seq)
      ) {
        best = timer;
      }
    }
    return best;
  }

  function fire(timer: Timer): void {
    setNow(Math.max(current, timer.due));
    if (timer.interval === null) {
      timers.delete(timer.id);
    } else {
      // Reschedule before running so that clearInterval inside the callback works.
      timer.due += timer.interval;
      timer.seq = nextSeq++;
    }
    try {
      timer.run();
    } catch (error) {
      report(error);
    }
  }

  function advanceTo(ms: number): void {
    if (!(ms >= current)) return;
    let count = 0;
    for (;;) {
      const timer = earliest();
      if (timer === null || timer.due > ms) break;
      if (++count > RUNAWAY_LIMIT) {
        console.error(
          `PageClock: stopped after ${RUNAWAY_LIMIT} timers in one advance (runaway guard).`,
        );
        return;
      }
      fire(timer);
    }
    setNow(ms);
  }

  function stepToNext(): number | null {
    const timer = earliest();
    if (timer === null) return null;
    const due = Math.max(current, timer.due);
    fire(timer);
    return due;
  }

  function cancelReal(): void {
    if (realHandle !== null) {
      realClearTimeout(realHandle);
      realHandle = null;
    }
  }

  function loop(): void {
    realHandle = null;
    if (!isPlaying) return;
    if (speed === Number.POSITIVE_INFINITY) {
      // One timer per real turn so the page can render between timers.
      const ran = stepToNext() !== null;
      if (!isPlaying) return;
      realHandle = realSetTimeout(loop, ran ? 0 : REAL_FRAME_MS);
      return;
    }
    const realNow = RealDate.now();
    const elapsed = realNow - lastReal;
    lastReal = realNow;
    advanceTo(current + elapsed * speed);
    if (!isPlaying) return;
    realHandle = realSetTimeout(loop, REAL_FRAME_MS);
  }

  function play(nextSpeed: number): void {
    cancelReal();
    if (!(nextSpeed > 0)) {
      isPlaying = false;
      return;
    }
    speed = nextSpeed;
    isPlaying = true;
    lastReal = RealDate.now();
    realHandle = realSetTimeout(loop, 0);
  }

  function pause(): void {
    isPlaying = false;
    cancelReal();
  }

  class ClockDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(start + current);
      else super(...(args as [number]));
    }

    static override now(): number {
      return start + current;
    }
  }

  const fakeSetTimeout = (
    handler: unknown,
    delay?: unknown,
    ...args: unknown[]
  ): number => {
    if (typeof handler !== "function") return 0;
    return add(current + toDelay(delay, 0), null, () =>
      (handler as (...a: unknown[]) => void)(...args),
    );
  };

  const fakeSetInterval = (
    handler: unknown,
    delay?: unknown,
    ...args: unknown[]
  ): number => {
    if (typeof handler !== "function") return 0;
    const interval = toDelay(delay, 1);
    return add(current + interval, interval, () =>
      (handler as (...a: unknown[]) => void)(...args),
    );
  };

  const fakeClear = (handle: unknown): void => {
    if (typeof handle === "number") timers.delete(handle);
  };

  target.Date = ClockDate as unknown as DateConstructor;
  target.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;
  target.setInterval = fakeSetInterval as unknown as typeof setInterval;
  target.clearTimeout = fakeClear as unknown as typeof clearTimeout;
  target.clearInterval = fakeClear as unknown as typeof clearInterval;
  perf.now = () => current;

  return {
    now: () => current,
    play,
    pause,
    playing: () => isPlaying,
    stepToNext,
    advanceTo,
    schedule(at, run) {
      add(Math.max(current, at), null, run);
    },
    onTick(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    uninstall() {
      pause();
      timers.clear();
      listeners.clear();
      target.Date = original.Date;
      target.setTimeout = original.setTimeout;
      target.clearTimeout = original.clearTimeout;
      target.setInterval = original.setInterval;
      target.clearInterval = original.clearInterval;
      if (perfHadOwnNow) perf.now = originalPerfNow;
      else delete (perf as { now?: () => number }).now;
    },
  };
}
