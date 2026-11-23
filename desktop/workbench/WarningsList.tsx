import { type MouseEvent, useEffect, useRef, useState } from "react";
import {
  CLASS_LABELS,
  type Movement,
  RULE_LABELS,
  splitWarnings,
  warningMark,
} from "./findings";
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
 * every row it found now, and every row it had before that it has not found yet and that is still
 * ahead of `at`. The list then does not shrink under the pointer; the rows not found yet show
 * muted (see `found`).
 *
 * `at` (ms) is the time of the last check of the window that found `current` (the layout watch's
 * `checkedAt`): 0 for a new window, so a seek back keeps every row. A kept row earlier than that is
 * gone from the run (the frame reloaded after a fix, for example), so it is dropped, not left muted
 * as "later in the run". A check stamps what it finds with its own time, so a row the run finds
 * again is in `current` by the time `at` passes it.
 */
export function mergeRunWarnings(
  kept: readonly Warning[],
  current: readonly Warning[],
  at: number,
): Warning[] {
  const now = new Set(current.map(warningKey));
  return [
    ...current,
    ...kept.filter((w) => !now.has(warningKey(w)) && w.at >= at),
  ];
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
  /**
   * The run the rows are from. While the pointer is in the list, the list keeps the rows it
   * shows; a new run (a new scene, for example) shows its own rows at once.
   */
  run?: string;
  /**
   * The class of each move by its mark (`classifyMoves`, as the findings use). Given: the expected
   * moves hide behind "Show expected moves", and each move row names its class. Not given: every
   * row shows.
   */
  movements?: ReadonlyMap<string, Movement>;
};

/** The class a move row names: the class of a bug, or the rule of an expected move. */
function movementTag(movement: Movement): string {
  return movement.class === "expected"
    ? `${CLASS_LABELS.expected}: ${RULE_LABELS[movement.rule].toLowerCase()}`
    : CLASS_LABELS[movement.class];
}

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
  run,
  movements,
}: WarningsListProps) {
  const [showExpected, setShowExpected] = useState(false);
  /**
   * While the pointer is in the list, the rows stay the same: a seek back that drops a row or
   * finds a new one would move the row under the pointer. A row the run does not have now shows
   * muted. The rows of now show when the pointer leaves the list.
   */
  const [inside, setInside] = useState(false);
  const shownRef = useRef<{ run?: string; warnings: readonly Warning[] }>({
    run,
    warnings,
  });
  if (!inside || shownRef.current.run !== run)
    shownRef.current = { run, warnings };
  const frozen = shownRef.current.warnings !== warnings;
  const shown = shownRef.current.warnings;
  const foundKeys =
    found || frozen ? new Set((found ?? warnings).map(warningKey)) : null;
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

  const split = movements
    ? splitWarnings(shown, movements)
    : { shown: [...shown], expected: [] };
  const listed = showExpected
    ? [...split.shown, ...split.expected]
    : split.shown;
  const sorted = sortWarnings(listed);
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
      onMouseEnter={() => setInside(true)}
      onMouseLeave={(event) => {
        if (!moved(event, false)) return;
        setInside(false);
        cancel();
        onLeave?.();
      }}
    >
      <h3>
        {`Layout warnings (${split.shown.length})`}
        {seekingTo !== null && (
          <span className="wb-warning-status" role="status">
            {`Seeking to ${formatTime(seekingTo)}…`}
          </span>
        )}
      </h3>
      {split.expected.length > 0 && (
        <label className="wb-warning-expected">
          <input
            type="checkbox"
            checked={showExpected}
            onChange={(event) => setShowExpected(event.target.checked)}
          />
          {`Show expected moves (${split.expected.length})`}
        </label>
      )}
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
                  {movements?.has(warningMark(warning)) && (
                    <span className="wb-warning-class">
                      {movementTag(
                        movements.get(warningMark(warning)) as Movement,
                      )}
                    </span>
                  )}
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
