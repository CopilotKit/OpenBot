import type { Box } from "./geometry";

/** How long a marker for an action stays, in real milliseconds. */
export const MARKER_MS = 1200;

export type ActionMark = {
  id: number;
  label: string;
  /** Over the window, in the coordinates of the wrapper around it; null when the step found nothing. */
  box: Box | null;
};

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
