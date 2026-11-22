import type { Box } from "./geometry";

/** How long a marker for an action stays at most, in real milliseconds. */
export const MARKER_MS = 1200;

export type ActionMark = {
  id: number;
  label: string;
  /** Over the window, in the coordinates of the wrapper around it; null when the step found nothing. */
  box: Box | null;
  /** The element the action acted on, measured again while the marker shows. */
  target?: Element | null;
};

/** The part of an element that followTarget reads. */
export type Followed = {
  isConnected: boolean;
  checkVisibility?: () => boolean;
};

/**
 * What a marker does on an animation frame. A marker stays on the element it names, or goes:
 * "drop" when its element left the document (a new screen, a reload), is hidden, or has no size;
 * else its new box. A marker without an element (the step found nothing) keeps its box.
 */
export function followTarget(
  target: Followed | null | undefined,
  measure: () => Box | null,
): { drop: true } | { drop: false; box: Box | null } {
  if (!target) return { drop: false, box: null };
  if (!target.isConnected) return { drop: true };
  if (target.checkVisibility && !target.checkVisibility())
    return { drop: true };
  const box = measure();
  if (!box || box.width <= 0 || box.height <= 0) return { drop: true };
  return { drop: false, box };
}

/** True when two boxes are the same to the pixel, so a frame with no change sets no state. */
export function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/**
 * One animation frame for all markers: each follows its element or goes. Gives the same array
 * when nothing changed.
 */
export function followMarks(
  marks: readonly ActionMark[],
  measure: (target: Element) => Box | null,
): readonly ActionMark[] {
  let changed = false;
  const next: ActionMark[] = [];
  for (const mark of marks) {
    const target = mark.target;
    const step = followTarget(target, () => (target ? measure(target) : null));
    if (step.drop) {
      changed = true;
      continue;
    }
    if (target && !sameBox(step.box, mark.box)) {
      changed = true;
      next.push({ ...mark, box: step.box });
    } else next.push(mark);
  }
  return changed ? next : marks;
}

/**
 * The box of `target` (an element in the window's iframe) in the coordinates of `wrap`, an element
 * of the parent page around the window. The window can be zoomed: `frameWidth` is its width in
 * its own pixels.
 */
export function boxOverFrame(
  wrap: Element,
  iframe: HTMLIFrameElement,
  target: Element,
  frameWidth: number,
): Box {
  const outer = wrap.getBoundingClientRect();
  const frame = iframe.getBoundingClientRect();
  const scale =
    frameWidth > 0 && frame.width > 0 ? frame.width / frameWidth : 1;
  const box = target.getBoundingClientRect();
  return {
    x: frame.left - outer.left + box.x * scale,
    y: frame.top - outer.top + box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

function Mark({ mark, next }: { mark: ActionMark; next: boolean }) {
  const className = `wb-action${next ? " wb-action-next" : ""}`;
  if (!mark.box)
    return (
      <div className={className} style={{ left: 8, top: 8 }}>
        <span className="wb-action-label">{`${mark.label} (not found)`}</span>
      </div>
    );
  const { x, y, width, height } = mark.box;
  return (
    <div className={className} style={{ left: x, top: y, width, height }}>
      <span className="wb-action-box" />
      {!next && <span className="wb-action-ring" />}
      <span className="wb-action-label">
        {next ? `Next: ${mark.label}` : mark.label}
      </span>
    </div>
  );
}

/**
 * Shows what the bot did: an outline, a ring and a label over each element a click or a type step
 * acted on, and the element of the next action when the run stopped before it. It is drawn next to
 * the window element and not in it, so a shot of the window does not show it.
 */
export function ActionMarkers({
  marks,
  next,
}: {
  marks: readonly ActionMark[];
  next: ActionMark | null;
}) {
  if (marks.length === 0 && !next) return null;
  return (
    <div className="wb-actions" data-workbench-actions aria-hidden="true">
      {next && <Mark mark={next} next />}
      {marks.map((mark) => (
        <Mark key={mark.id} mark={mark} next={false} />
      ))}
    </div>
  );
}
