import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  blinkCurve,
  clamp,
  drawBotOrb,
  FINISH_HELD,
  FINISH_S,
  mulberry32,
  nodCurve,
  type OrbPaletteName,
  type OrbPose,
  restLook,
  type Track,
  type TrackKey,
  track,
} from "./bot-orb-draw";
import { pointer, subscribeFrame, subscribePointer } from "./orb-clock";

/**
 * What the orb is doing: resting, listening to you type, working, or landing a finished thing.
 * `finished` is a moment rather than a state: something the person allowed is done, and the orb
 * plays a check with a burst of rays once, over whatever it was doing, which carries on under it.
 * Hold it for `FINISH_MS`, then pass the state it was in before.
 */
export type BotOrbState =
  | "idle"
  | "listening"
  | "thinking"
  | "done"
  | "finished";

/** How long a finish plays: the check, its rays, and the eyes coming back. */
export const FINISH_MS = FINISH_S * 1000;

type Look = readonly [number, number];
const LOOK_AT_YOU: Look = [0, 0.04];
/** Up and aside, as if thinking it over. */
const LOOK_UP: Look = [-0.36, -0.5];
/** Down at what you are typing. */
const LOOK_DOWN: Look = [0.1, 0.6];
const LOOKS: Record<BotOrbState, Look> = {
  idle: LOOK_AT_YOU,
  listening: LOOK_DOWN,
  thinking: LOOK_UP,
  done: LOOK_AT_YOU,
  finished: LOOK_AT_YOU,
};
/** Seconds between blinks, before each one's jitter. */
const BLINK_EVERY = 4.2;
/** How far the canvas draws past the footprint on every side, as a share of the size. */
const SPILL = 0.5;
/** Backing pixels per CSS pixel, at most: sharp on a 3× screen without a huge canvas. */
const MAX_DPR = 3;
/** Below this footprint, in CSS px, an orb only blinks and watches: no glances, no breath. */
const SMALL = 40;
/** How much of its look an orb gives the pointer: all of it at rest, some while it listens or works. */
const WATCH: Record<BotOrbState, number> = {
  idle: 1,
  listening: 0.5,
  thinking: 0.35,
  done: 1,
  finished: 1,
};
/** The pointer perks it up within this share of its size from its centre… */
const NOTICE_NEAR = 0.9;
/** …and has to go past this one before it can perk it up again. */
const NOTICE_FAR = 1.3;

/** Every track the state drives, and when the things that play once last happened. */
type Motion = {
  listen: Track;
  think: Track;
  done: Track;
  smile: Track;
  ax: Track;
  ay: Track;
  doneAt: number;
  noticedAt: number;
  finishedAt: number;
  nods: number[];
};

const still = (v: number): Track => ({ from: v, keys: [] });

/** The motion at rest in `state`, as it is on the first frame. */
function settled(state: BotOrbState): Motion {
  const look = LOOKS[state];
  return {
    listen: still(state === "listening" ? 1 : 0),
    think: still(state === "thinking" ? 1 : 0),
    done: still(0),
    smile: still(state === "done" ? 1 : 0),
    ax: still(look[0]),
    ay: still(look[1]),
    doneAt: -1,
    noticedAt: -1,
    finishedAt: state === "finished" ? 0 : -1,
    nods: [],
  };
}

/** The track restarted from its value at `now`, heading for the new key. */
const retarget = (tr: Track, now: number, key: TrackKey): Track => ({
  from: track(tr, now),
  keys: [key],
});

/** Moves every track toward `state` from time `now`, each on its own spring or ease. */
function enter(m: Motion, state: BotOrbState, now: number): Motion {
  const look = LOOKS[state];
  const gaze =
    state === "thinking"
      ? ([6.5, 0.85] as const)
      : state === "listening"
        ? ([15, 0.6] as const)
        : ([12, 0.8] as const);
  const next: Motion = {
    ...m,
    listen: retarget(
      m.listen,
      now,
      state === "listening"
        ? { at: now, to: 1, spring: [14, 0.5] }
        : { at: now, to: 0, ease: 0.45 },
    ),
    think: retarget(m.think, now, {
      at: now,
      to: state === "thinking" ? 1 : 0,
      ease: state === "thinking" ? 0.4 : 0.45,
    }),
    smile: retarget(m.smile, now, {
      at: now + (state === "done" ? 0.08 : 0),
      to: state === "done" ? 1 : 0,
      ease: state === "done" ? 0.4 : 0.8,
    }),
    ax: retarget(m.ax, now, { at: now, to: look[0], spring: gaze }),
    ay: retarget(m.ay, now, { at: now, to: look[1], spring: gaze }),
    done: retarget(m.done, now, { at: now, to: 0, ease: 0.45 }),
  };
  if (state === "listening") next.noticedAt = now;
  if (state === "done") {
    // It lands: a glow that springs up and settles away, a ping and a nod.
    next.done = {
      from: track(m.done, now),
      keys: [
        { at: now, to: 1, spring: [11, 0.42] },
        { at: now + 1.4, to: 0, ease: 1.2 },
      ],
    };
    next.doneAt = now;
    next.nods = [now + 0.1];
  }
  return next;
}

/**
 * The pose at `t` seconds on the orb's clock. `seed` keeps two orbs from blinking and glancing in
 * step. A small orb keeps still apart from its blinks, so a list of them doesn't fidget.
 */
function poseAt(
  m: Motion,
  t: number,
  seed: number,
  { reduced, small }: { reduced: boolean; small: boolean },
): OrbPose {
  const listen = track(m.listen, t);
  const think = clamp(track(m.think, t));
  // Left alone it glances about now and then; while it listens or works it keeps its eyes on that.
  const calm = reduced || small ? 0 : (1 - clamp(listen)) * (1 - think);
  const glance = restLook(t, 3.6, seed);
  let blink = 0;
  if (!reduced) {
    const k = Math.floor(t / BLINK_EVERY);
    for (const n of [k - 1, k]) {
      const at = n * BLINK_EVERY + 1.3 + mulberry32(seed + n)() * 1.6;
      blink = Math.max(blink, blinkCurve(t - at));
    }
  }
  return {
    ta: t,
    listen,
    think,
    done: Math.max(0, track(m.done, t)),
    smile: clamp(track(m.smile, t)),
    tilt: 0.5 * glance[2] * calm,
    ax: track(m.ax, t) + 0.6 * glance[0] * calm,
    ay: track(m.ay, t) + 0.6 * glance[1] * calm,
    blink,
    nod: m.nods.reduce((n, at) => n + nodCurve(t - at), 0),
    doneAge: m.doneAt < 0 ? -1 : t - m.doneAt,
    noticeAge: m.noticedAt < 0 ? -1 : t - m.noticedAt,
    // Still, a finish is its check without the burst.
    finishAge: m.finishedAt < 0 ? -1 : reduced ? FINISH_HELD : t - m.finishedAt,
    breath: small ? 0 : Math.sin((Math.PI * 2 * t) / 5.5),
  };
}

/**
 * An orb watching the pointer: the look it is heading for (`tx`, `ty`), where its eyes are on a
 * spring (`x`, `y`, with their speeds), how much of its look it gives the pointer (`w`), whether it
 * can see the pointer at all, and whether the pointer is close enough to have perked it up. `epoch`
 * and `last` are the pointer's epoch and the time when it last looked.
 */
export type Gaze = {
  tx: number;
  ty: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  seen: boolean;
  near: boolean;
  epoch: number;
  last: number;
};

export const restingGaze = (): Gaze => ({
  tx: 0,
  ty: 0,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  w: 0,
  seen: false,
  near: false,
  epoch: -1,
  last: -1,
});

type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;

/**
 * Moves `gaze` on to time `t` for an orb in `state`, measuring where the orb is on screen only when
 * the pointer, the scroll or the window has changed. True on the frame the pointer comes close,
 * which perks the orb up; a listening orb has already noticed you, so it never perks.
 */
export function followPointer(
  gaze: Gaze,
  t: number,
  state: BotOrbState,
  measure: () => Box,
): boolean {
  const dt = gaze.last < 0 ? 0 : Math.min(1 / 30, Math.max(0, t - gaze.last));
  gaze.last = t;
  let perked = false;
  if (gaze.epoch !== pointer.epoch) {
    gaze.epoch = pointer.epoch;
    const box = measure();
    const dx = pointer.x - (box.left + box.width / 2);
    const dy = pointer.y - (box.top + box.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    // Right over it, it looks straight out at you; the further away, the further round it turns.
    const reach = d / (d + Math.max(48, box.width * 1.6));
    gaze.tx = (dx / d) * reach * 0.95;
    gaze.ty = (dy / d) * reach;
    gaze.seen = pointer.on && box.width > 0;
    const near =
      gaze.seen && d < box.width * (gaze.near ? NOTICE_FAR : NOTICE_NEAR);
    perked = near && !gaze.near && state !== "listening";
    gaze.near = near;
  }
  gaze.vx += ((gaze.tx - gaze.x) * 150 - gaze.vx * 19) * dt;
  gaze.vy += ((gaze.ty - gaze.y) * 150 - gaze.vy * 19) * dt;
  gaze.x += gaze.vx * dt;
  gaze.y += gaze.vy * dt;
  gaze.w += ((gaze.seen ? WATCH[state] : 0) - gaze.w) * (1 - Math.exp(-dt * 5));
  return perked;
}

/** Its own look, glances and all, gives way to the pointer by as much as it is watching. */
function lookAt(pose: OrbPose, gaze: Gaze): OrbPose {
  return {
    ...pose,
    ax: pose.ax + (gaze.x - pose.ax) * gaze.w,
    ay: pose.ay + (gaze.y - pose.ay) * gaze.w,
    tilt: pose.tilt + (-0.12 * gaze.x - pose.tilt) * gaze.w,
  };
}

/**
 * Sizes the canvas for a footprint of `size` and returns how to draw a pose on it, or null where
 * there is no 2D context to draw with.
 */
function surface(canvas: HTMLCanvasElement, size: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const box = size * (1 + 2 * SPILL);
  const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
  canvas.width = Math.round(box * dpr);
  canvas.height = Math.round(box * dpr);
  return (pose: OrbPose, palette: OrbPaletteName) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box, box);
    ctx.translate(box / 2, box / 2);
    drawBotOrb(ctx, size, pose, {
      dark: document.documentElement.classList.contains("dark"),
      palette,
    });
  };
}

let seeds = 0;
const secondsSince = (start: number) => (performance.now() - start) / 1000;

/**
 * A Bot's orb, in `palette`. `size` is its footprint in CSS px; its glow spills past it. It breathes
 * and glances about when idle, watches what you type when listening, swirls while thinking, and
 * lands with a ping and a smile when done. Passed `finished`, its eyes give way to a check while
 * short rays burst out round it, and then it is back as it was. Wherever the pointer is, its eyes
 * follow it: fully at rest, partly while it listens or works, with a small perk when the pointer
 * comes close. An orb under 40 px only blinks and watches.
 *
 * Every orb on the page draws on one shared animation frame, and only while it is on screen and the
 * tab is shown. With reduced motion, or `still`, it is a still in the state's pose, drawn again
 * only when the state or the theme changes, and its eyes stay put.
 */
export function BotOrb({
  className,
  palette,
  size,
  state = "idle",
  still = false,
}: {
  className?: string;
  palette: OrbPaletteName;
  size: number;
  state?: BotOrbState;
  still?: boolean;
}) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = (useReducedMotion() ?? false) || still;
  const clock = useRef<{ start: number; seed: number } | null>(null);
  clock.current ??= { start: performance.now(), seed: ++seeds * 7 };
  const motion = useRef<Motion | null>(null);
  const shown = useRef<BotOrbState | null>(null);
  const current = useRef<BotOrbState>(state);
  const gaze = useRef<Gaze | null>(null);
  gaze.current ??= restingGaze();

  // It starts at rest in its first state, except that a first "done" still lands. After that a
  // change moves every track from where it is, so a change mid-motion never jumps. A finish moves
  // no track: it plays over the state it was in, and coming back to that state changes nothing.
  useEffect(() => {
    current.current = state;
    if (!clock.current) return;
    const t = secondsSince(clock.current.start);
    if (state === "finished") {
      motion.current = {
        ...(motion.current ?? settled("idle")),
        finishedAt: t,
      };
      return;
    }
    if (shown.current === state) return;
    const before = motion.current;
    motion.current =
      shown.current === null && state !== "done"
        ? { ...settled(state), finishedAt: before?.finishedAt ?? -1 }
        : enter(before ?? settled("idle"), state, t);
    shown.current = state;
  }, [state]);

  // A still: a composed picture in the state's pose, eyes open, its look held, no ping; finished,
  // the check in place of the eyes, with no burst, for as long as it is held. Nothing draws it
  // again on its own, so it is redrawn when the theme flips the root's `dark` class.
  useEffect(() => {
    const canvas = canvasRef.current;
    const draw = reduced && canvas ? surface(canvas, size) : null;
    if (!draw || !clock.current) return;
    const { seed } = clock.current;
    const held =
      state === "finished"
        ? { ...settled(shown.current ?? "idle"), finishedAt: 0 }
        : settled(state);
    const paint = () =>
      draw(
        poseAt(held, 1.6, seed, { reduced: true, small: size < SMALL }),
        palette,
      );
    paint();
    const theme = new MutationObserver(paint);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => theme.disconnect();
  }, [reduced, size, palette, state]);

  // Alive: drawn on the shared clock while it is on screen. It counts as on screen until an
  // IntersectionObserver says otherwise, and always where there is none to ask. It reads the theme
  // on every frame, so a flip shows on the next one.
  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    const draw = !reduced && canvas ? surface(canvas, size) : null;
    if (!draw || !box || !clock.current || !gaze.current) return;
    const { start, seed } = clock.current;
    const eyes = gaze.current;
    const small = size < SMALL;
    const measure = () => box.getBoundingClientRect();
    const frame = (now: number) => {
      const t = Math.max(0, (now - start) / 1000);
      const state = current.current;
      if (followPointer(eyes, t, state, measure) && motion.current) {
        motion.current = { ...motion.current, noticedAt: t };
      }
      const pose = poseAt(motion.current ?? settled(state), t, seed, {
        reduced: false,
        small,
      });
      draw(lookAt(pose, eyes), palette);
    };
    let unsubscribe: (() => void) | null = null;
    const onScreen = (on: boolean) => {
      if (on && !unsubscribe) unsubscribe = subscribeFrame(frame);
      if (!on && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
    const sight =
      "IntersectionObserver" in window
        ? new IntersectionObserver((entries) =>
            // The newest entry is where it is now.
            onScreen(entries.at(-1)?.isIntersecting ?? false),
          )
        : null;
    sight?.observe(box);
    onScreen(true);
    const unwatch = subscribePointer();
    return () => {
      sight?.disconnect();
      onScreen(false);
      unwatch();
    };
  }, [reduced, size, palette]);

  const spill = size * SPILL;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none relative inline-block shrink-0",
        className,
      )}
      data-palette={palette}
      data-state={state}
      ref={boxRef}
      style={{ width: size, height: size }}
    >
      <canvas
        className="absolute"
        ref={canvasRef}
        style={{
          left: -spill,
          top: -spill,
          width: size + 2 * spill,
          height: size + 2 * spill,
        }}
      />
    </span>
  );
}
