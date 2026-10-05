import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * Types a conversation's name in as it arrives, so the line reads as learning something rather than
 * as a glitch. Only on arrival: otherwise opening the app sets the whole roster typing at once.
 */

/** Per character, not per title, so every length types at the same speed. Capped so none outstays. */
export const TYPING_SECONDS_PER_CHARACTER = 0.014;
export const TYPING_MAX_SECONDS = 0.45;

export function typingSeconds(length: number): number {
  return Math.min(length * TYPING_SECONDS_PER_CHARACTER, TYPING_MAX_SECONDS);
}

/** Naming is none-to-some. A name replacing another name is not this, and must not replay. */
export function isNaming(
  previous: string | undefined,
  next: string | undefined,
): boolean {
  return !previous && Boolean(next);
}

export type TypedReveal = {
  /** What to draw right now: the whole name, or as much of it as has landed. */
  text: string | undefined;
  /** Whether the characters are still arriving, so the caller can show a cursor. */
  typing: boolean;
};

export function useTypedReveal(summary: string | undefined): TypedReveal {
  const reduce = useReducedMotion();
  const previous = useRef(summary);
  const firstRun = useRef(true);
  const [typed, setTyped] = useState<number | null>(null);

  useEffect(() => {
    const from = previous.current;
    previous.current = summary;
    // A row that arrives already named is not a naming.
    const mounting = firstRun.current;
    firstRun.current = false;
    if (mounting || !summary || !isNaming(from, summary)) return;
    // The gentler version of a reveal made entirely of movement is no movement.
    if (reduce) return;

    let frame = 0;
    const started = performance.now();
    const total = typingSeconds(summary.length) * 1000;
    // Linear, because this is constant motion. An eased typewriter reads as a machine hesitating.
    const step = (now: number) => {
      const progress = Math.min((now - started) / total, 1);
      setTyped(Math.round(progress * summary.length));
      if (progress < 1) {
        frame = requestAnimationFrame(step);
        return;
      }
      // Null, not the full length, so later renders draw the string rather than re-slicing it.
      setTyped(null);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [summary, reduce]);

  if (typed === null || !summary) return { text: summary, typing: false };
  return { text: summary.slice(0, typed), typing: true };
}
