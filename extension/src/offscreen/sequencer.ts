/** Core's scheme: start at Date.now() * 1000; never at or below anything issued before a restart. */
export const SEQ_RESTART_GAP = 1_000_000;

const SAVE_DEBOUNCE_MS = 250;

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export async function createSequencer(deps: {
  now(): number;
  load(): Promise<number | null>;
  save(last: number): Promise<void>;
  timers?: Timers;
}): Promise<{ next(): number; flush(): Promise<void> }> {
  const timers = deps.timers ?? realTimers;
  const loaded = await deps.load();
  let last = Math.max(deps.now() * 1000, (loaded ?? 0) + SEQ_RESTART_GAP) - 1;
  let issued = false;
  let handle: unknown;
  let scheduled = false;

  const cancel = () => {
    if (scheduled) timers.clear(handle);
    scheduled = false;
  };
  const save = () => deps.save(last);

  return {
    next() {
      last += 1;
      issued = true;
      if (!scheduled) {
        scheduled = true;
        handle = timers.set(() => {
          scheduled = false;
          void save();
        }, SAVE_DEBOUNCE_MS);
      }
      return last;
    },
    async flush() {
      cancel();
      if (issued) await save();
    },
  };
}
