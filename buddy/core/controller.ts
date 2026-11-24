import type {
  BuddyControllerOptions,
  BuddyControllerState,
  PoseClips,
  SetPoseOptions,
} from "./types.ts";

export type BuddyController = {
  getState: () => BuddyControllerState;
  subscribe: (listener: () => void) => () => void;
  setPose: (pose: string, opts?: SetPoseOptions) => void;
  queuePose: (pose: string, opts?: SetPoseOptions) => void;
  /** Return to the home pose now, clearing any queued pose. */
  rest: () => void;
  /** Tell the controller the current (non-looping) clip finished. */
  ended: () => void;
  /** Update clips / homePose / avatarUrl live (the buddy follows a new home). */
  setOptions: (next: Partial<BuddyControllerOptions>) => void;
  destroy: () => void;
};

function resolveHome(clips: PoseClips, homePose?: string): string {
  if (homePose && clips[homePose]) return homePose;
  if (clips["idle"]) return "idle";
  const first = Object.keys(clips)[0];
  return first ?? homePose ?? "idle";
}

/**
 * The pose-playback state machine. There's always a resting "home" pose that
 * loops; transient poses play over it. A one-shot pose plays once then returns
 * home (driven by `ended()`); a looping pose holds until changed. `home` is
 * live — change it via setOptions and the buddy follows it while resting.
 */
export function createBuddyController(
  initial: BuddyControllerOptions,
): BuddyController {
  let clips: PoseClips = initial.clips ?? {};
  let homePose = initial.homePose;
  let avatarUrl = initial.avatarUrl ?? null;
  let home = resolveHome(clips, homePose);

  let pose = home;
  let loop = true;
  let key = 0;

  let returnHomeOnEnd = false;
  let atHome = true;
  // A FIFO chain of poses waiting to play. queuePose (and setPose with
  // `queue: true`) append; ended() advances the head; an immediate setPose or
  // rest() clears it. A chain head queued behind a *looping* clip would never
  // get an ended() — so appending while the current clip loops plays now
  // (interrupts the loop and starts the chain).
  let chain: Array<{ pose: string; opts: SetPoseOptions }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const listeners = new Set<() => void>();

  // Cached snapshot: getState returns a stable reference until something
  // actually changes, so useSyncExternalStore-style consumers don't loop.
  let snapshot: BuddyControllerState;
  const compute = (): BuddyControllerState => ({
    pose,
    home,
    videoSrc: clips[pose] ?? clips[home] ?? null,
    avatarUrl,
    poseKey: `${pose}#${key}`,
    loop,
  });
  const same = (a: BuddyControllerState, b: BuddyControllerState) =>
    a.pose === b.pose &&
    a.home === b.home &&
    a.videoSrc === b.videoSrc &&
    a.avatarUrl === b.avatarUrl &&
    a.poseKey === b.poseKey &&
    a.loop === b.loop;
  const emit = () => {
    const next = compute();
    if (same(snapshot, next)) return;
    snapshot = next;
    listeners.forEach((l) => l());
  };

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  function play(requested: string, opts: SetPoseOptions = {}): void {
    clearTimer();
    const target = clips[requested] ? requested : home;
    const isHome = target === home;
    const nextLoop = opts.loop ?? (isHome || opts.for != null);
    returnHomeOnEnd = opts.returnHome ?? (!isHome && !nextLoop);
    atHome = isHome;
    pose = target;
    loop = nextLoop;
    key += 1;
    if (opts.for != null && !isHome) {
      timer = setTimeout(() => play(home), opts.for);
    }
    emit();
  }

  // Pop and play the head of the chain. No-op on an empty chain.
  const advance = () => {
    const next = chain.shift();
    if (next) play(next.pose, next.opts);
  };

  const enqueue = (p: string, opts: SetPoseOptions) => {
    chain.push({ pose: p, opts: { ...opts, queue: false } });
    // Play-now: nothing will emit ended() while the current clip loops, so the
    // head would wait forever — start it immediately instead.
    if (loop) advance();
  };

  const setPose = (p: string, opts: SetPoseOptions = {}) => {
    if (opts.queue) {
      enqueue(p, opts);
      return;
    }
    // An immediate pose resets the chain: anything pending is dropped so a stale
    // queued pose can't fire when this one ends.
    chain = [];
    play(p, opts);
  };

  const queuePose = (p: string, opts: SetPoseOptions = {}) => enqueue(p, opts);

  const rest = () => {
    chain = [];
    play(home);
  };

  const ended = () => {
    if (chain.length) {
      advance();
      return;
    }
    if (returnHomeOnEnd && pose !== home) play(home);
  };

  const setOptions = (next: Partial<BuddyControllerOptions>) => {
    if (next.clips !== undefined) clips = next.clips ?? {};
    if (next.homePose !== undefined) homePose = next.homePose;
    if (next.avatarUrl !== undefined) avatarUrl = next.avatarUrl ?? null;
    home = resolveHome(clips, homePose);
    // Follow a changed home while resting; snap home if the active pose vanished.
    if (atHome && pose !== home) play(home);
    else if (!clips[pose]) play(home);
    else emit();
  };

  snapshot = compute();
  const getState = (): BuddyControllerState => snapshot;

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = () => {
    clearTimer();
    listeners.clear();
  };

  return {
    getState,
    subscribe,
    setPose,
    queuePose,
    rest,
    ended,
    setOptions,
    destroy,
  };
}
