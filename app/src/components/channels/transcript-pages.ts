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
 * BOTH ARE HELD AS ROWS, NOT INDICES. Rows are added and removed above them while a conversation is
 * open — history recovered from storage merges in a prefix, tool steps regroup — and an index then
 * named a different row: rows crossed the boundary into the live region under another parent, where
 * they remounted, replayed their entrance and re-typed from nothing, and landed mid-list where the
 * scroller reads a new turn. A row that has gone keeps the index it last had.
 *
 * Forgotten while restoring, the same way the opening stagger is, so a conversation opened again
 * (or another channel) starts from its newest page.
 */
export function useTranscriptPages(
  ids: readonly string[],
  restoring: boolean,
): {
  from: number;
  split: number;
  drawEarlier: () => void;
  drawTo: (index: number) => void;
} {
  /* One object per opening, so a page drawn for an earlier opening is recognisably not this one's. */
  const openingRef = useRef<{ split: Mark } | null>(null);
  const [earlier, setEarlier] = useState<{
    opening: { split: Mark };
    from: Mark;
  } | null>(null);

  if (restoring) {
    openingRef.current = null;
  } else if (openingRef.current === null) {
    openingRef.current = { split: markAt(ids, openingFrom(ids.length)) };
  }
  const opening = openingRef.current;
  const split = opening === null ? 0 : place(ids, opening.split);
  const from =
    earlier !== null && earlier.opening === opening
      ? Math.min(place(ids, earlier.from), split)
      : split;

  const stateRef = useRef({ ids, from });
  stateRef.current = { ids, from };
  const drawFrom = useCallback((index: number) => {
    const current = openingRef.current;
    const { ids: now, from: drawn } = stateRef.current;
    if (current === null || index >= drawn) return;
    setEarlier({ opening: current, from: markAt(now, Math.max(0, index)) });
  }, []);
  const drawEarlier = useCallback(
    () => drawFrom(earlierFrom(stateRef.current.from)),
    [drawFrom],
  );

  /* `drawTo`: every page down to the row at `index`, for a jump to a turn not drawn yet. */
  return { from, split, drawEarlier, drawTo: drawFrom };
}

/**
 * A row the boundary sits on, and the index it had when last seen. `id` null is the very start of a
 * conversation that had no rows: rows arriving into it are live.
 */
type Mark = { id: string | null; index: number };

function markAt(ids: readonly string[], index: number): Mark {
  return { id: ids[index] ?? null, index: Math.min(index, ids.length) };
}

function place(ids: readonly string[], mark: Mark): number {
  if (mark.id === null) return Math.min(mark.index, ids.length);
  const index = ids.indexOf(mark.id);
  if (index !== -1) {
    mark.index = index;
    return index;
  }
  return Math.min(mark.index, ids.length);
}
