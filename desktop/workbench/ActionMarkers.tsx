import type { Box } from "./geometry";

/** How long a marker for an action stays at most, in real milliseconds. */
export const MARKER_MS = 1200;

/**
 * How long a marker stays as a ghost after its element left, in real milliseconds. A click often
 * changes the screen at once, so without it the marker showed for 8 to 43 ms and its cause was
 * almost never seen.
 */
export const GHOST_MS = 500;

export type ActionMark = {
  id: number;
  label: string;
  /** Over the window, in the coordinates of the wrapper around it; null when the step found nothing. */
  box: Box | null;
  /** The element the action acted on, measured again while the marker shows. */
  target?: Element | null;
  /**
   * When its element left (real ms, performance.now()): the marker is then a ghost, dashed and
   * fading, at the element's last box. Null or missing while it follows its element.
   */
  ghostSince?: number | null;
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
 * What one marker is on an animation frame at real time `now`. While its element is on screen it
 * follows it, also when it was a ghost (an element that came back is never under a ghost). When
 * the element left, the marker stays as a ghost at the last box for GHOST_MS, then goes (null).
 * A marker that never had a box goes at once.
 */
export function markAt(
  mark: ActionMark,
  measure: (target: Element) => Box | null,
  now: number,
): ActionMark | null {
  const target = mark.target;
  const step = followTarget(target, () => (target ? measure(target) : null));
  if (!step.drop) {
    if (!target) return mark;
    if (mark.ghostSince == null && sameBox(step.box, mark.box)) return mark;
    return { ...mark, box: step.box, ghostSince: null };
  }
  if (mark.box === null) return null;
  if (mark.ghostSince == null) return { ...mark, ghostSince: now };
  return now - mark.ghostSince >= GHOST_MS ? null : mark;
}

/**
 * One animation frame for all markers, at real time `now`: each follows its element, is a ghost,
 * or goes. Gives the same array when nothing changed.
 */
export function followMarks(
  marks: readonly ActionMark[],
  measure: (target: Element) => Box | null,
  now: number = performance.now(),
): readonly ActionMark[] {
  let changed = false;
  const next: ActionMark[] = [];
  for (const mark of marks) {
    const step = markAt(mark, measure, now);
    if (step !== mark) changed = true;
    if (step) next.push(step);
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

/**
 * True when a ghost's label fits inside its box, on one line or wrapped at its spaces. 12 px
 * semibold text is at most about 7.5 px a character and 17 px a line; the padding and the outline
 * take 12 px of the width and 4 px of the height.
 */
export function labelFitsInside(
  label: string,
  box: { width: number; height: number },
): boolean {
  const room = Math.floor((box.width - 12) / 7.5);
  let lines = 1;
  let line = 0;
  for (const word of label.split(/\s+/)) {
    if (word.length > room) return false;
    if (line === 0) line = word.length;
    else if (line + 1 + word.length <= room) line += 1 + word.length;
    else {
      lines++;
      line = word.length;
    }
  }
  return lines * 17 + 4 <= box.height;
}

/** The marker's colors and font, from the app's tokens (geometry in windowFrame.css). */
const LABEL = "wb-action-label rounded-sm font-mono text-xs font-semibold";
const LABEL_SHOWN = `${LABEL} bg-primary text-primary-foreground`;
/** The ghost's label is quieter, so the new screen's text under it still shows. */
const LABEL_GHOST = `${LABEL} border border-primary/60 bg-background/80 text-foreground`;

function Mark({ mark, next }: { mark: ActionMark; next: boolean }) {
  const ghost = !next && mark.ghostSince != null;
  const state = next ? "next" : ghost ? "ghost" : "shown";
  const className = ghost ? "wb-action wb-action-ghost" : "wb-action";
  if (!mark.box)
    return (
      <div
        className={className}
        data-action-mark={state}
        style={{ left: 8, top: 8 }}
      >
        <span
          className={LABEL_SHOWN}
          data-action-part="label"
        >{`${mark.label} (not found)`}</span>
      </div>
    );
  const { x, y, width, height } = mark.box;
  return (
    <div
      className={className}
      data-action-mark={state}
      style={{ left: x, top: y, width, height }}
    >
      <span
        className={
          ghost
            ? "wb-action-box border-dashed border-primary/60"
            : "wb-action-box border-primary"
        }
        data-action-part="box"
      />
      {!next && !ghost && (
        <span
          className="wb-action-ring border-primary"
          data-action-part="ring"
        />
      )}
      <span
        className={
          ghost
            ? labelFitsInside(mark.label, mark.box)
              ? `${LABEL_GHOST} wb-action-label-inside`
              : LABEL_GHOST
            : LABEL_SHOWN
        }
        data-action-part="label"
      >
        {next ? `Next: ${mark.label}` : mark.label}
      </span>
    </div>
  );
}

/**
 * Shows what the bot did: an outline, a ring and a label over each element a click or a type step
 * acted on (a dashed ghost at its last place when the element left), and the element of the next
 * action when the run stopped before it. It is drawn next to
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
