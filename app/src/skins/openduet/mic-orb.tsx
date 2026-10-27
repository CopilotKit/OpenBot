import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  blinkCurve,
  clamp,
  drawMicOrb,
  FINISH_HELD,
  FINISH_S,
  mulberry32,
  nodCurve,
  type OrbColour,
  type OrbPose,
  restLook,
  type Track,
  type TrackKey,
  track,
} from "./mic-orb-draw";

/**
 * What the orb is doing: resting, listening to you type, working, or landing a finished thing.
 * `finished` is a moment rather than a state: something the person allowed is done, and the orb
 * plays a check with a burst of rays once, over whatever it was doing, which carries on under it.
 * Hold it for `FINISH_MS`, then pass the state it was in before.
 */
export type MicOrbState =
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
const LOOKS: Record<MicOrbState, Look> = {
  idle: LOOK_AT_YOU,
  listening: LOOK_DOWN,
  thinking: LOOK_UP,
  done: LOOK_AT_YOU,
  finished: LOOK_AT_YOU,
};
/** Seconds between blinks, before each one's jitter. */
const BLINK_EVERY = 4.2;
/** Seconds the canvas draws past the footprint on every side, as a share of the size. */
const SPILL = 0.5;
/** Backing pixels per CSS pixel, at most: sharp on a 3× phone without a huge canvas. */
const MAX_DPR = 3;

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
  keys: number[];
};

const still = (v: number): Track => ({ from: v, keys: [] });

/** The motion at rest in `state`, as it is on the first frame. */
function settled(state: MicOrbState): Motion {
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
    keys: [],
  };
}

/** The track restarted from its value at `now`, heading for the new key. */
const retarget = (tr: Track, now: number, key: TrackKey): Track => ({
  from: track(tr, now),
  keys: [key],
});

/** Moves every track toward `state` from time `now`, with the springs and eases the film uses. */
function enter(m: Motion, state: MicOrbState, now: number): Motion {
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
    // It lands: a glow that springs up and settles away, a ping, a flash of the grilles and a nod.
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

/** The pose at `t` seconds on the orb's clock. `seed` keeps two orbs from blinking and glancing in step. */
function poseAt(m: Motion, t: number, seed: number, reduced: boolean): OrbPose {
  const listen = track(m.listen, t);
  const think = clamp(track(m.think, t));
  // Left alone it glances about now and then; while it listens or works it keeps its eyes on that.
  const calm = reduced ? 0 : (1 - clamp(listen)) * (1 - think);
  const glance = restLook(t, 3.6, seed);
  let blink = 0;
  if (!reduced) {
    const k = Math.floor(t / BLINK_EVERY);
    for (const n of [k - 1, k]) {
      const at = n * BLINK_EVERY + 1.3 + mulberry32(seed + n)() * 1.6;
      blink = Math.max(blink, blinkCurve(t - at));
    }
  }
  let key = 0;
  for (const at of m.keys) {
    const tau = t - at;
    if (tau >= 0 && tau < 0.5) key += Math.exp(-tau / 0.075);
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
    key: Math.min(1, key),
    doneAge: m.doneAt < 0 ? -1 : t - m.doneAt,
    noticeAge: m.noticedAt < 0 ? -1 : t - m.noticedAt,
    // Still, a finish is its check without the burst.
    finishAge: m.finishedAt < 0 ? -1 : reduced ? FINISH_HELD : t - m.finishedAt,
    breath: Math.sin((Math.PI * 2 * t) / 5.5),
  };
}

let seeds = 0;
const secondsSince = (start: number) => (performance.now() - start) / 1000;

/**
 * OpenDuet's presence, the mic orb, in Ocean. `size` is its footprint in CSS px; its glow spills
 * past it. It breathes and glances about when idle, opens its grilles and watches what you type
 * when listening (pass `keystrokes`, any number that changes on each keystroke, to light them), works
 * with a light scanning the grilles when thinking, and lands with a ping and a smile when done.
 * Passed `finished`, its eyes give way to a check while short rays burst out round it, and then it
 * is back as it was.
 *
 * With reduced motion, or `still`, it is a still in the state's pose, drawn again only when the state
 * or the theme changes. `still` is for an avatar: a portrait among other Bots' portraits, and cheap
 * enough to repeat down a list.
 */
export function MicOrb({
  className,
  colour = "ocean",
  keystrokes,
  size,
  state = "idle",
  still = false,
}: {
  className?: string;
  /** Ocean is OpenDuet's own; another Bot wears one of the others (`AbstractAvatar`). */
  colour?: OrbColour;
  keystrokes?: number;
  size: number;
  state?: MicOrbState;
  still?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = (useReducedMotion() ?? false) || still;
  const clock = useRef<{ start: number; seed: number } | null>(null);
  clock.current ??= { start: performance.now(), seed: ++seeds * 7 };
  const motion = useRef<Motion | null>(null);
  const shown = useRef<MicOrbState | null>(null);

  // It starts at rest in its first state, except that a first "done" still lands. After that a
  // change moves every track from where it is, so a change mid-motion never jumps. A finish moves
  // no track: it plays over the state it was in, and coming back to that state changes nothing.
  useEffect(() => {
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

  const typed = useRef(keystrokes);
  useEffect(() => {
    if (keystrokes === typed.current || !clock.current || !motion.current)
      return;
    typed.current = keystrokes;
    const t = secondsSince(clock.current.start);
    motion.current.keys = [
      ...motion.current.keys.filter((at) => t - at < 0.5),
      t,
    ];
  }, [keystrokes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const { start, seed } = clock.current ?? { start: 0, seed: 1 };
    if (!canvas || !ctx) return;
    const box = size * (1 + 2 * SPILL);
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    canvas.width = Math.round(box * dpr);
    canvas.height = Math.round(box * dpr);
    const draw = (pose: OrbPose) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box, box);
      ctx.translate(box / 2, box / 2);
      drawMicOrb(ctx, size, pose, {
        dark: canvas.closest(".dark") !== null,
        colour,
      });
    };
    if (reduced) {
      // A composed still in the state's pose: eyes open, its look held, no ping; finished, the check
      // in place of the eyes, with no burst, for as long as it is held. Nothing draws it again on its
      // own, so it is redrawn when the theme flips the root's `dark` class.
      const held =
        state === "finished"
          ? { ...settled(shown.current ?? "idle"), finishedAt: 0 }
          : settled(state);
      const paint = () => draw(poseAt(held, 1.6, seed, true));
      paint();
      const theme = new MutationObserver(paint);
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
      });
      return () => theme.disconnect();
    }
    let frame = requestAnimationFrame(function loop() {
      draw(
        poseAt(
          motion.current ?? settled(state),
          secondsSince(start),
          seed,
          false,
        ),
      );
      frame = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(frame);
  }, [size, reduced, state, colour]);

  const spill = size * SPILL;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none relative inline-block shrink-0",
        className,
      )}
      data-colour={colour}
      data-state={state}
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
