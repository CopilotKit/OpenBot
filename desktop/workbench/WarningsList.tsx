import { type MouseEvent, useEffect, useRef } from "react";
import type { Warning } from "./layoutWatch";
import { formatTime } from "./RunControls";

export function warningText(warning: Warning): string {
  const when = formatTime(warning.at);
  switch (warning.kind) {
    case "moved":
      return `${warning.label} moved ${Math.round(Math.hypot(warning.dx, warning.dy))}px at ${when} (${warning.cause})`;
    case "clipped":
      return `${warning.label} is cut off at ${when}`;
    case "outside":
      return `${warning.label} is ${Math.round(warning.overBy)}px outside the window at ${when}`;
  }
}

/** The same key for the same warning, also after a seek back finds the warnings again. */
export function warningKey(warning: Warning): string {
  return `${warning.kind}|${warning.at}|${warning.label}`;
}

/**
 * The rows of a run after the run found `current` again (a seek back replays it from the start):
 * every row it found now, and every row it had before that it has not found yet. The list then
 * does not shrink under the pointer; the rows not found yet show muted (see `found`).
 */
export function mergeRunWarnings(
  kept: readonly Warning[],
  current: readonly Warning[],
): Warning[] {
  const now = new Set(current.map(warningKey));
  return [...current, ...kept.filter((w) => !now.has(warningKey(w)))];
}

/** How long the pointer stays on a row before the row's warning shows, in milliseconds. */
export const HOVER_DELAY_MS = 250;

/** The warning that shows over the window. */
export type ListHighlight = { key: string; pinned: boolean; jumping: boolean };

export type WarningsListProps = {
  warnings: readonly Warning[];
  /** A click seeks to the warning's time, when `onPin` is not given. */
  onSeek(ms: number): void;
  /** The pointer stayed on a row for `hoverDelay` milliseconds. */
  onHover?(warning: Warning): void;
  /** A click on a row: keep its warning shown. */
  onPin?(warning: Warning): void;
  /** The pointer left the list. */
  onLeave?(): void;
  highlight?: ListHighlight | null;
  hoverDelay?: number;
  /**
   * Set while the page seeks to a warning's time: the list keeps the rows it had before the seek
   * (the page passes them), and the heading says where it goes.
   */
  seekingTo?: number | null;
  /**
   * The warnings the run found up to now. A row of `warnings` that is not here is from before a
   * seek back, later than the time: it shows muted, and a click still seeks to it. Not given:
   * every row shows as found.
   */
  found?: readonly Warning[];
};

/** A fixed order, so a seek that finds the warnings again does not move a row under the pointer: by time, then by label. */
export function sortWarnings(warnings: readonly Warning[]): Warning[] {
  return [...warnings].sort(
    (a, b) =>
      a.at - b.at ||
      a.label.localeCompare(b.label) ||
      a.kind.localeCompare(b.kind),
  );
}

export function WarningsList({
  warnings,
  onSeek,
  onHover,
  onPin,
  onLeave,
  highlight = null,
  hoverDelay = HOVER_DELAY_MS,
  seekingTo = null,
  found,
}: WarningsListProps) {
  const foundKeys = found ? new Set(found.map(warningKey)) : null;
  const timerRef = useRef<{
    key: string;
    handle: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** Where the pointer was at the last move on a row. */
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  const cancel = () => {
    if (timerRef.current) clearTimeout(timerRef.current.handle);
    timerRef.current = null;
  };
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current.handle);
    },
    [],
  );

  /**
   * True when the pointer really moved. The browser also sends pointer events when the list changes
   * under a pointer that stays still (a seek back finds the warnings again); those do not count.
   */
  const moved = (event: MouseEvent, keep: boolean) => {
    const last = pointRef.current;
    const same =
      last !== null && last.x === event.clientX && last.y === event.clientY;
    if (keep) pointRef.current = { x: event.clientX, y: event.clientY };
    return !same;
  };

  const rest = (event: MouseEvent, warning: Warning) => {
    if (!moved(event, true)) return;
    const key = warningKey(warning);
    if (timerRef.current?.key === key) return;
    cancel();
    const handle = setTimeout(() => {
      timerRef.current = null;
      onHoverRef.current?.(warning);
    }, hoverDelay);
    timerRef.current = { key, handle };
  };

  const sorted = sortWarnings(warnings);
  /** The same warning can show twice; the second one gets "#2" on its key. */
  const seen = new Map<string, number>();
  const rows = sorted.map((warning) => {
    const base = warningKey(warning);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { warning, rowKey: n === 1 ? base : `${base}#${n}` };
  });
  return (
    // The pointer leaving the list is not an action of its own; the rows are buttons.
    // biome-ignore lint/a11y/noStaticElementInteractions: a hover preview only
    <section
      className="wb-warnings"
      aria-busy={seekingTo !== null ? true : undefined}
      onMouseLeave={(event) => {
        if (!moved(event, false)) return;
        cancel();
        onLeave?.();
      }}
    >
      <h3>
        {`Layout warnings (${warnings.length})`}
        {seekingTo !== null && (
          <span className="wb-warning-status" role="status">
            {`Seeking to ${formatTime(seekingTo)}…`}
          </span>
        )}
      </h3>
      {rows.length === 0 ? (
        <p>No layout warnings.</p>
      ) : (
        <ul className="wb-warning-list">
          {rows.map(({ warning, rowKey }) => {
            const key = warningKey(warning);
            const current = highlight?.key === key ? highlight : null;
            const later = foundKeys !== null && !foundKeys.has(key);
            const className =
              [
                current ? "wb-warning-current" : "",
                later ? "wb-warning-later" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined;
            return (
              <li key={rowKey}>
                <button
                  type="button"
                  className={className}
                  title={
                    later
                      ? "Later in the run: the run has not got there since the seek."
                      : undefined
                  }
                  aria-pressed={onPin ? current?.pinned === true : undefined}
                  onMouseMove={(event) => rest(event, warning)}
                  onMouseLeave={(event) => {
                    if (moved(event, false)) cancel();
                  }}
                  onClick={() => {
                    cancel();
                    if (onPin) onPin(warning);
                    else onSeek(warning.at);
                  }}
                >
                  {warningText(warning)}
                  {current?.jumping && (
                    <span className="wb-warning-status" role="status">
                      Jumping…
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
