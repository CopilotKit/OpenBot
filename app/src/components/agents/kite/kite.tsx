import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { subscribeFrame } from "./frame-clock";
import {
  drawKite,
  type KitePattern,
  type KiteState,
  type KiteTimeline,
  kiteBleed,
  needsFrames,
  OPENBOT_PATTERN,
  OPENBOT_SLOT,
  poseAt,
  STILL_MAX,
} from "./kite-draw";
import { botLivery } from "./livery";

/** Backing pixels per CSS pixel, at most: sharp on a 3× screen without a huge canvas. */
const MAX_DPR = 3;
/** Where a kite's clock starts its first state: long enough ago that it is already settled. */
const SETTLED = -9;
/**
 * The least time between two frames of a kite at 32 px and under, in ms. Only its square moves, a
 * few px, so about thirty a second is plenty where a fast screen would draw every one 120 times.
 */
const SMALL_FRAME_MS = 30;

// ---------- dark mode ----------

/*
 * The app is dark when the root carries `.dark` (see lib/theme.ts). One observer serves every kite
 * on the page, and only while one is mounted.
 */
const darkListeners = new Set<() => void>();
let darkObserver: MutationObserver | null = null;

function subscribeDark(onChange: () => void) {
  darkListeners.add(onChange);
  if (!darkObserver) {
    darkObserver = new MutationObserver(() => {
      for (const listener of darkListeners) listener();
    });
    darkObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
  return () => {
    darkListeners.delete(onChange);
    if (darkListeners.size === 0) {
      darkObserver?.disconnect();
      darkObserver = null;
    }
  };
}

const isDark = () => document.documentElement.classList.contains("dark");

function useDarkMode(): boolean {
  return useSyncExternalStore(subscribeDark, isDark, () => false);
}

// ---------- screen resolution ----------

/*
 * Page zoom and moving a window to another screen change `devicePixelRatio`. A resting kite asks
 * for no frames, so without this it would keep the old resolution and go soft. The media query
 * matches only the current ratio, so its change event is the moment the ratio changes; it is then
 * replaced by one for the new ratio.
 */
function subscribeResolution(onChange: () => void) {
  let query: MediaQueryList | null = null;
  function listen() {
    query?.removeEventListener("change", changed);
    query =
      window.matchMedia?.(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      ) ?? null;
    query?.addEventListener("change", changed);
  }
  function changed() {
    listen();
    onChange();
  }
  listen();
  return () => query?.removeEventListener("change", changed);
}

const resolution = () => Math.min(MAX_DPR, window.devicePixelRatio || 1);

function useResolution(): number {
  return useSyncExternalStore(subscribeResolution, resolution, () => 1);
}

// ---------- the kite ----------

export type KiteProps = {
  /** The slot's size in CSS px. The status dot reaches a few px past it, outside the layout. */
  size: number;
  /** Colour slot, 0..7 in `KITE_COLORS` order. */
  slot: number;
  pattern?: KitePattern;
  state?: KiteState;
  /** Seeds the blink schedule, so two Bots never blink together. */
  seed?: number;
  /**
   * Held on its state's still, as reduced motion holds it: for a kite nobody can see right now,
   * such as a picture scrolled off screen, so nothing keeps drawing what nobody watches.
   */
  still?: boolean;
  /**
   * The state it was in before it appeared, so its first state plays its entrance: a kite that
   * mounts done after working hops and grows its green dot. Absent, it appears already settled.
   */
  enterFrom?: KiteState;
  /** Its accessible name. Absent, the kite is decorative and hidden from screen readers. */
  label?: string;
  className?: string;
};

/**
 * OpenBot's mascot on a canvas, drawn from the pure function of time in `kite-draw.ts`.
 *
 * A kite draws once and then only while it has something to animate: a change of state, working's
 * pulse, waiting's nudge, and above 32 px a face's blink. Every kite that is animating shares one
 * frame loop. It honours reduced motion and the app's dark mode, holds still at 32 px and under
 * (only its dot moves), and shows no face under 22 px.
 */
export function Kite({
  size,
  slot,
  pattern = "solid",
  state = "idle",
  seed = 1,
  still = false,
  enterFrom,
  label,
  className,
}: KiteProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion() === true;
  const dark = useDarkMode();
  const dpr = useResolution();
  // The kite's own clock and the states it has been through. Refs, never state: a frame of the
  // animation never re-renders React.
  const clock = useRef<{ start: number; timeline: KiteTimeline } | null>(null);
  if (clock.current === null) {
    clock.current = {
      start: performance.now(),
      timeline: [{ s: enterFrom ?? state, t: SETTLED }],
    };
  }
  const bleed = kiteBleed(size);

  // Before the browser paints, so a kite that mounts is never shown as an empty frame.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const kite = clock.current;
    if (!canvas || !kite) return;
    const now = () => (performance.now() - kite.start) / 1000;
    const last = kite.timeline[kite.timeline.length - 1];
    // A new state blends from the one before it.
    if (last.s !== state) kite.timeline = [last, { s: state, t: now() }];
    const changedAt = kite.timeline[kite.timeline.length - 1].t;
    const hold = reduced || still;

    const draw = (t: number): boolean => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      const box = size + 2 * bleed;
      const backing = Math.round(box * dpr);
      if (canvas.width !== backing || canvas.height !== backing) {
        canvas.width = backing;
        canvas.height = backing;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box, box);
      // Whole pixels at the centre keep the pixel eyes on their grid.
      const centre = bleed + Math.round(size / 2);
      drawKite(ctx, {
        S: size,
        x: centre,
        y: centre,
        slot,
        pattern,
        dark,
        pose: poseAt(kite.timeline, t, seed, size, hold),
        seed,
      });
      return true;
    };

    const busy = (t: number) =>
      !hold && needsFrames(state, size, t - changedAt);
    const t0 = now();
    if (!draw(t0) || !busy(t0)) return;
    let stop: (() => void) | null = null;
    let drewAt = Number.NEGATIVE_INFINITY;
    stop = subscribeFrame((frame) => {
      if (size <= STILL_MAX && frame - drewAt < SMALL_FRAME_MS) return;
      drewAt = frame;
      const t = now();
      draw(t);
      if (!busy(t)) {
        stop?.();
        stop = null;
      }
    });
    return () => stop?.();
  }, [state, size, slot, pattern, seed, dark, dpr, reduced, still, bleed]);

  // The canvas is laid out in shares of the slot, so a parent that resizes the slot scales the
  // drawing with it rather than cropping it.
  const reach = `${(-bleed / size) * 100}%`;
  const span = `${((size + 2 * bleed) / size) * 100}%`;
  const props = {
    className: cn("relative inline-block shrink-0", className),
    "data-kite": "",
    "data-pattern": pattern,
    "data-slot": slot,
    "data-state": state,
    style: { height: size, width: size },
  };
  const canvas = (
    <canvas
      className="pointer-events-none absolute"
      ref={canvasRef}
      style={{ height: span, left: reach, top: reach, width: span }}
    />
  );
  // A picture: named, its canvas inside it presentational; or, with no name, hidden altogether.
  return label ? (
    <span aria-label={label} role="img" {...props}>
      {canvas}
    </span>
  ) : (
    <span aria-hidden="true" {...props}>
      {canvas}
    </span>
  );
}

/**
 * A Bot as its kite, in the colour and sail pattern its seed picks (`botLivery`), so renaming a
 * Bot keeps its look. Announced by the Bot's name.
 */
export function BotKite({
  seed,
  name,
  size = 32,
  state = "idle",
  still,
  className,
}: {
  seed: string;
  name: string;
  size?: number;
  state?: KiteState;
  still?: boolean;
  className?: string;
}) {
  const livery = botLivery(seed);
  return (
    <Kite
      className={className}
      label={name}
      pattern={livery.pattern}
      seed={livery.seed}
      size={size}
      slot={livery.slot}
      state={state}
      still={still}
    />
  );
}

/**
 * OpenBot's own kite: violet quarters, for the product rather than one Bot, as sign-in,
 * onboarding and the skins' frames draw it. Decorative unless given a `label`.
 */
export function OpenBotKite({
  size,
  state = "idle",
  still,
  enterFrom,
  label,
  className,
}: {
  size: number;
  state?: KiteState;
  still?: boolean;
  enterFrom?: KiteState;
  label?: string;
  className?: string;
}) {
  return (
    <Kite
      className={className}
      enterFrom={enterFrom}
      label={label}
      pattern={OPENBOT_PATTERN}
      seed={7}
      size={size}
      slot={OPENBOT_SLOT}
      state={state}
      still={still}
    />
  );
}
