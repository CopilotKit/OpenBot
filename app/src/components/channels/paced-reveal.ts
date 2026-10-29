import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";

/**
 * A streaming reply arrives in bursts: nothing for a moment, then a sentence at once. Drawn as it
 * arrives, it reads as stuttering. Revealed at a steady pace a little behind what has arrived, it
 * reads as being written. The pace has a floor, so a slow stream still moves, and a catch-up
 * budget, so a big burst is worked off in well under a second rather than queued behind the floor.
 *
 * Revealed a word at a time: a prefix ends at the end of the text or just before whitespace, and
 * while the stream is still going it stops short of the last word, because that word may be half
 * sent — until the text has not grown for TAIL_SETTLES_MS, when the reply has ended its sentence
 * and the run is busy with something else.
 */

/** The slowest the reveal ever goes, so a trickle of text still moves. */
export const MIN_CHARS_PER_SECOND = 90;
/** While streaming: how long a backlog takes to work off, at most, before the floor takes over. */
export const CATCH_UP_MS = 400;
/** After the stream ends: everything is out this long after, however much was still to show. */
export const FINISH_MS = 300;

const MIN_CHARS_PER_MS = MIN_CHARS_PER_SECOND / 1000;

/** One frame at 60Hz, and the most one step may count: a tab in the background stalls frames. */
const FRAME_MS = 16;
const MAX_FRAME_MS = 50;

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character);
}

/**
 * The longest run that counts as one word. Text with no spaces (Chinese, Japanese, a long link) has
 * no word to stop at; past this it is revealed a character at a time rather than held whole.
 */
export const LONGEST_WORD = 24;
/** A tail that has not grown for this long is the end of the reply, not half a word. */
export const TAIL_SETTLES_MS = 250;

/** The furthest prefix that may be shown: all of it, or while the tail may be half sent, up to it. */
function limitOf(text: string, holdTail: boolean): number {
  if (!holdTail) return text.length;
  const end = Math.max(0, text.length - LONGEST_WORD);
  for (let index = text.length - 1; index >= end; index--) {
    if (isSpace(text[index])) return index;
  }
  return end;
}

export function nextReveal({
  text,
  shown,
  elapsedMs,
  streaming,
  holdTail = streaming,
  finishInMs,
}: {
  text: string;
  shown: number;
  elapsedMs: number;
  streaming: boolean;
  /** Whether the last word may still be arriving. While streaming, until the text settles. */
  holdTail?: boolean;
  finishInMs: number;
}): number {
  const floor = Math.min(shown, text.length);
  const limit = limitOf(text, streaming && holdTail);
  if (floor >= limit) return floor;

  const backlog = text.length - floor;
  const budget = streaming ? CATCH_UP_MS : Math.max(finishInMs, 1);
  const rate = Math.max(MIN_CHARS_PER_MS, backlog / budget);
  const target = Math.min(
    limit,
    floor + Math.max(1, Math.ceil(rate * elapsedMs)),
  );

  // Forward to the end of the word the target falls in, unless it is too long to be one.
  const stop = Math.min(limit, target + LONGEST_WORD);
  let next = target;
  while (next < stop && !isSpace(text[next])) next++;
  return next === stop && stop < limit ? target : next;
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
  const grewAtRef = useRef(0);
  const lengthRef = useRef(text.length);
  if (text.length !== lengthRef.current) {
    lengthRef.current = text.length;
    grewAtRef.current = performance.now();
  }

  if (streaming) {
    finishAtRef.current = null;
  } else if (finishAtRef.current === null) {
    finishAtRef.current = performance.now() + FINISH_MS;
  }

  const pending = !reducedMotion && shown < text.length;

  /*
   * ONE LOOP FOR AS LONG AS THERE IS TEXT TO SHOW, reading the newest text from refs. Tokens arrive
   * every 10 to 20ms, between frames; restarting the loop on each one restarted its clock too, so
   * the next frame measured the few ms since the token rather than the ~16ms since the last frame,
   * and the reveal ran at a fraction of its pace, then dumped the backlog when the stream ended.
   */
  const textRef = useRef(text);
  textRef.current = text;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  useEffect(() => {
    if (!pending) return;
    let last: number | null = null;
    let frame = window.requestAnimationFrame(function step(now) {
      // The first frame of a loop has no previous one; a frame's worth keeps it moving.
      const elapsedMs = Math.min(
        MAX_FRAME_MS,
        Math.max(0, now - (last ?? now - FRAME_MS)),
      );
      last = now;
      const finishAt = finishAtRef.current;
      const current = textRef.current;
      setShown((shownNow) =>
        nextReveal({
          text: current,
          shown: shownNow,
          elapsedMs,
          streaming: streamingRef.current,
          holdTail: now - grewAtRef.current < TAIL_SETTLES_MS,
          finishInMs: finishAt === null ? FINISH_MS : finishAt - now,
        }),
      );
      frame = window.requestAnimationFrame(step);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pending]);

  return pending ? text.slice(0, shown) : text;
}
