import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * NO REACT WORK OUTLIVES THE DOCUMENT IT WAS FOR.
 *
 * Every DOM test file registers happy-dom in `beforeAll` and calls `GlobalRegistrator.unregister()`
 * in `afterAll`, which takes `window` and `document` away at once. React's scheduler is not told: a
 * render or an effect flush it posted before then still runs afterwards, and the first thing either
 * does is read `window.event`. Bun reports the error as `# Unhandled error between tests`, so every
 * test passes and the run fails, under the name of whichever file it reached next. It is enough for
 * a screen that polls every 10ms to have been on show during the file's last `waitFor`:
 * computer-close-button.test.tsx failed that way in about one run in three on a loaded machine, and
 * on main's CI.
 *
 * `settleReactWork` (settle-react-work.ts) fixes that for a file that remembers to await it. This
 * makes it impossible to forget. `unregister` itself, for every file, first
 *
 *   1. runs, there and then, whatever React's scheduler has posted, while the document still exists;
 *   2. unmounts every root `@testing-library/react` rendered that the file did not clean up, so
 *      nothing is left on screen to schedule more;
 *   3. runs whatever unmounting posted;
 *
 * and only then takes the document away. All of it is synchronous, because most files call
 * `unregister()` without awaiting it, and the next file registers its own document straight after.
 *
 * Running the scheduler's queue on demand needs the callback it posts. The scheduler posts with
 * `setImmediate`, which it reads ONCE, when it is first evaluated (the branch at the foot of
 * scheduler.development.js). So it is evaluated here, before anything else can, with a
 * `setImmediate` that remembers what is posted, and the real one is put back straight away. Nothing
 * else changes: a posted callback still runs on its own immediate as before, unless a teardown ran
 * it first, in which case that immediate is cancelled.
 *
 * Done for each copy of React a root `bun test` reaches: the app's, which the extension and shared
 * resolve as well, and the desktop app's own, which its lockfile pins.
 */

/** More scheduler slices than any teardown needs. Past this, something keeps scheduling itself. */
const MOST_SLICES = 1_000;

type Registrator = {
  readonly isRegistered: boolean;
  unregister(): Promise<void>;
};
type Scheduler = {
  unstable_scheduleCallback(priority: number, callback: () => void): unknown;
  unstable_ImmediatePriority: number;
};

const require = createRequire(import.meta.url);
// Read before any test file can register happy-dom, whose window brings its own timers.
const setImmediateBeforeAnyDom = globalThis.setImmediate;
const clearImmediateBeforeAnyDom = globalThis.clearImmediate;

const flushes: (() => void)[] = [];
/** `@testing-library/react`'s own module, by path: its `cleanup` is called only once a file loaded it. */
const testingLibraries: string[] = [];
const schedulers = new Set<string>();
const registrators = new Set<string>();

for (const [project, required] of [
  ["..", true],
  ["../../desktop", false],
] as const) {
  const dir = join(import.meta.dir, project);
  const resolve = (specifier: string, from = dir) =>
    realpathSync(Bun.resolveSync(specifier, from));
  let scheduler: string;
  let testingLibrary: string;
  let registrator: string;
  try {
    scheduler = resolve("scheduler", dirname(resolve("react-dom/client")));
    testingLibrary = join(
      dirname(resolve("@testing-library/react")),
      "pure.js",
    );
    registrator = resolve("@happy-dom/global-registrator");
  } catch (error) {
    // The desktop app installs its own dependencies, and without them none of its DOM tests run either.
    if (required) throw error;
    continue;
  }

  if (!schedulers.has(scheduler)) {
    schedulers.add(scheduler);
    flushes.push(holdScheduler(scheduler));
  }
  if (!testingLibraries.includes(testingLibrary))
    testingLibraries.push(testingLibrary);
  if (registrators.has(registrator)) continue;
  registrators.add(registrator);
  const { GlobalRegistrator } = (await import(registrator)) as {
    GlobalRegistrator: Registrator;
  };
  const unregister = GlobalRegistrator.unregister;
  GlobalRegistrator.unregister = () => {
    if (!GlobalRegistrator.isRegistered)
      return unregister.call(GlobalRegistrator);
    try {
      settleReact();
    } catch (error) {
      // The document still goes, so the next file starts on a clean slate; the failure is this one's.
      return unregister.call(GlobalRegistrator).then(() => {
        throw error;
      });
    }
    return unregister.call(GlobalRegistrator);
  };
}

function settleReact(): void {
  for (const flush of flushes) flush();
  for (const path of testingLibraries) {
    const loaded = require.cache[path]?.exports as
      | { cleanup?: () => void }
      | undefined;
    loaded?.cleanup?.();
  }
  for (const flush of flushes) flush();
}

/**
 * Evaluates React's scheduler at `path` with a `setImmediate` that remembers what it posts, and
 * returns what runs everything it has posted, now.
 */
function holdScheduler(path: string): () => void {
  type Posted = {
    run: () => void;
    handle: ReturnType<typeof setImmediate>;
  };
  const posted = new Set<Posted>();
  const remembering = (callback: () => void) => {
    const entry = { run: callback } as Posted;
    entry.handle = setImmediateBeforeAnyDom(() => {
      posted.delete(entry);
      callback();
    });
    posted.add(entry);
    return entry.handle;
  };
  globalThis.setImmediate = remembering as typeof setImmediate;
  let scheduler: Scheduler;
  try {
    scheduler = require(path) as Scheduler;
  } finally {
    globalThis.setImmediate = setImmediateBeforeAnyDom;
  }

  const flush = () => {
    for (let slice = 0; posted.size > 0; slice++) {
      if (slice === MOST_SLICES)
        throw new Error(
          `React was still scheduling work after ${MOST_SLICES} slices of a test file's teardown, so something on screen keeps scheduling itself.`,
        );
      const [entry] = posted as Iterable<Posted>;
      if (!entry) break;
      posted.delete(entry);
      clearImmediateBeforeAnyDom(entry.handle);
      entry.run();
    }
  };

  // A callback scheduled now has to come through the hook, or the hold did not take.
  scheduler.unstable_scheduleCallback(
    scheduler.unstable_ImmediatePriority,
    () => undefined,
  );
  if (posted.size !== 1)
    throw new Error(
      `React's scheduler at ${path} was evaluated before app/tests/react-teardown.ts could hold its queue, so React work could outlive a test file's document again. Import this before anything that loads react-dom.`,
    );
  flush();
  return flush;
}
