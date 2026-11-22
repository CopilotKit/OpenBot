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
};

export function WarningsList({
  warnings,
  onSeek,
  onHover,
  onPin,
  onLeave,
  highlight = null,
  hoverDelay = HOVER_DELAY_MS,
}: WarningsListProps) {
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

  const newestFirst = warnings
    .map((warning, index) => ({ warning, index }))
    .sort((a, b) => b.warning.at - a.warning.at || b.index - a.index);
  return (
    // The pointer leaving the list is not an action of its own; the rows are buttons.
    // biome-ignore lint/a11y/noStaticElementInteractions: a hover preview only
    <section
      onMouseLeave={(event) => {
        if (!moved(event, false)) return;
        cancel();
        onLeave?.();
      }}
    >
      <h3>{`Layout warnings (${warnings.length})`}</h3>
      {newestFirst.length === 0 ? (
        <p>No layout warnings.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {newestFirst.map(({ warning, index }) => {
            const key = warningKey(warning);
            const current = highlight?.key === key ? highlight : null;
            return (
              <li key={index}>
                <button
                  type="button"
                  className={current ? "wb-warning-current" : undefined}
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
