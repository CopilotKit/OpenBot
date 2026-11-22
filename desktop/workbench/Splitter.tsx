import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { clamp } from "./viewerPrefs";

/** The keyboard step of a splitter, in pixels. Shift moves four steps. */
export const SPLIT_STEP = 8;

export type SplitterProps = {
  /** "x" drags left and right (between columns); "y" drags up and down. */
  axis: "x" | "y";
  /** What the handle sizes, for screen readers: "Scene column width". */
  label: string;
  /** The size now, in pixels. */
  size(): number;
  min: number;
  max: number;
  /** 1 when a drag right (or down) makes the panel bigger; -1 when it makes it smaller. */
  grow: 1 | -1;
  onSize(px: number): void;
  /** A double-click or Escape-free reset: back to the default size. */
  onReset(): void;
  /** The size shown to screen readers; null when the panel has its default, automatic size. */
  value: number | null;
};

/**
 * A drag handle between two panels. A drag, the arrow keys (Shift for bigger steps), Home and End
 * set the size; a double-click puts the default size back.
 */
export function Splitter(props: SplitterProps) {
  const dragRef = useRef<{ from: number; start: number } | null>(null);
  const { axis, min, max, grow } = props;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // The pointer stays with the handle over the window's iframe too.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      from: axis === "x" ? event.clientX : event.clientY,
      start: props.size(),
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const at = axis === "x" ? event.clientX : event.clientY;
    props.onSize(
      Math.round(clamp(drag.start + (at - drag.from) * grow, min, max)),
    );
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? SPLIT_STEP * 4 : SPLIT_STEP;
    const less = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const more = axis === "x" ? "ArrowRight" : "ArrowDown";
    let next: number | null = null;
    if (event.key === less) next = props.size() - step * grow;
    else if (event.key === more) next = props.size() + step * grow;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") {
      event.preventDefault();
      props.onReset();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    props.onSize(Math.round(clamp(next, min, max)));
  };

  return (
    // A focusable separator is the ARIA window splitter pattern: it takes the arrow keys.
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot take focus or a drag
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={props.label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={props.value ?? undefined}
      title={`${props.label}: drag, or use the arrow keys. Double-click to reset.`}
      className={`wb-split wb-split-${axis}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={props.onReset}
      onKeyDown={onKeyDown}
    />
  );
}
