import { useCallback, useRef, useState } from "react";

/**
 * How many rows a conversation opens with, and how many more are drawn each time the reader nears
 * the top. Twenty fills a tall screen with margin, so the reader never sees the edge of what is
 * drawn on open; the rest of a long history costs nothing until somebody scrolls up to it.
 */
export const PAGE_ROWS = 20;

/** How close to the top, in pixels, the reader gets before the previous page is drawn above. */
export const LOAD_MARGIN_PX = 800;

/** The index of the first row drawn when a conversation of `count` rows opens. */
export function openingFrom(count: number): number {
  return Math.max(0, count - PAGE_ROWS);
}

/** The index of the first row drawn once the page before `from` is added. */
export function earlierFrom(from: number): number {
  return Math.max(0, from - PAGE_ROWS);
}

/**
 * Whether the reader is near enough the top to draw the page before. An unmeasured viewport
 * (`scrollHeight` 0: nothing laid out yet) decides nothing.
 */
export function shouldDrawEarlier(view: {
  from: number;
  scrollTop: number;
  scrollHeight: number;
}): boolean {
  return (
    view.from > 0 && view.scrollHeight > 0 && view.scrollTop < LOAD_MARGIN_PX
  );
}

/**
 * Which rows are drawn: `items.slice(from)`. `split` is where drawing started when the conversation
 * opened, fixed for as long as it stays open; rows before it were added later, above, and render in
 * a region of their own (see the `contents` block in `chat-transcript.tsx`).
 *
 * Forgotten while restoring, the same way the opening stagger is, so a conversation opened again
 * (or another channel) starts from its newest page.
 */
export function useTranscriptPages(
  count: number,
  restoring: boolean,
): {
  from: number;
  split: number;
  drawEarlier: () => void;
  drawTo: (index: number) => void;
} {
  /* One object per opening, so a page drawn for an earlier opening is recognisably not this one's. */
  const openingRef = useRef<{ split: number } | null>(null);
  const [earlier, setEarlier] = useState<{
    opening: { split: number };
    from: number;
  } | null>(null);

  if (restoring) {
    openingRef.current = null;
  } else if (openingRef.current === null) {
    openingRef.current = { split: openingFrom(count) };
  }
  const opening = openingRef.current;
  const split = Math.min(opening?.split ?? 0, count);
  const from =
    earlier !== null && earlier.opening === opening
      ? Math.min(earlier.from, split)
      : split;

  const fromRef = useRef(from);
  fromRef.current = from;
  const drawEarlier = useCallback(() => {
    const current = openingRef.current;
    if (current === null || fromRef.current === 0) return;
    setEarlier({ opening: current, from: earlierFrom(fromRef.current) });
  }, []);
  /* Every page down to the row at `index`, for a jump to a turn that has not been drawn yet. */
  const drawTo = useCallback((index: number) => {
    const current = openingRef.current;
    if (current === null || index >= fromRef.current) return;
    setEarlier({ opening: current, from: Math.max(0, index) });
  }, []);

  return { from, split, drawEarlier, drawTo };
}
