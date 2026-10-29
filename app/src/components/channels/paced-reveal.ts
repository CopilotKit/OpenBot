import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * A streaming reply arrives in bursts: nothing for a moment, then a sentence at once. Drawn as it
 * arrives, it reads as stuttering. Revealed at a steady pace a little behind what has arrived, it
 * reads as being written. The pace has a floor, so a slow stream still moves, and a catch-up
 * budget, so a big burst is worked off in well under a second rather than queued behind the floor.
 *
 * Revealed a word at a time: a prefix always ends at the end of the text or just before
 * whitespace, and while the stream is still going it never passes the last whitespace, because
 * the word after it may be half sent.
 */

/** The slowest the reveal ever goes, so a trickle of text still moves. */
export const MIN_CHARS_PER_SECOND = 90;
/** While streaming: how long a backlog takes to work off, at most, before the floor takes over. */
export const CATCH_UP_MS = 400;
/** After the stream ends: everything is out this long after, however much was still to show. */
export const FINISH_MS = 300;

const MIN_CHARS_PER_MS = MIN_CHARS_PER_SECOND / 1000;

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

/** The furthest prefix that may be shown: all of it, or while streaming up to the last space. */
function limitOf(text: string, streaming: boolean): number {
  if (!streaming) return text.length;
  for (let index = text.length - 1; index >= 0; index--) {
    if (isSpace(text[index])) return index;
  }
  return 0;
}

export function nextReveal({
  text,
  shown,
  elapsedMs,
  streaming,
  finishInMs,
}: {
  text: string;
  shown: number;
  elapsedMs: number;
  streaming: boolean;
  finishInMs: number;
}): number {
  const floor = Math.min(shown, text.length);
  const limit = limitOf(text, streaming);
  if (floor >= limit) return floor;

  const backlog = text.length - floor;
  const budget = streaming ? CATCH_UP_MS : Math.max(finishInMs, 1);
  const rate = Math.max(MIN_CHARS_PER_MS, backlog / budget);
  const target = Math.min(
    limit,
    floor + Math.max(1, Math.ceil(rate * elapsedMs)),
  );

  // Forward to the end of the word the target falls in.
  let next = target;
  while (next < limit && !isSpace(text[next])) next++;
  return next;
}

/**
 * The part of `text` to draw now. A message that was already there when the conversation opened
 * starts fully shown and only paces what grows after; one that arrived live starts from nothing.
 * Reduced motion draws text as it arrives.
 */
export function usePacedReveal(
  text: string,
  { live, streaming }: { live: boolean; streaming: boolean },
): string {
  const reducedMotion = useReducedMotion() ?? false;
  const [shown, setShown] = useState(() => (live ? 0 : text.length));
  const finishAtRef = useRef<number | null>(null);

  if (streaming) {
    finishAtRef.current = null;
  } else if (finishAtRef.current === null) {
    finishAtRef.current = performance.now() + FINISH_MS;
  }

  const pending = !reducedMotion && shown < text.length;

  useEffect(() => {
    if (!pending) return;
    let last = performance.now();
    let frame = window.requestAnimationFrame(function step(now) {
      const elapsedMs = Math.max(0, now - last);
      last = now;
      const finishAt = finishAtRef.current;
      setShown((current) =>
        nextReveal({
          text,
          shown: current,
          elapsedMs,
          streaming,
          finishInMs: finishAt === null ? FINISH_MS : finishAt - now,
        }),
      );
      frame = window.requestAnimationFrame(step);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pending, text, streaming]);

  return pending ? text.slice(0, shown) : text;
}
