import type { Box } from "./geometry";
import type { Warning } from "./layoutWatch";

/**
 * Where the window's top left is in the coordinates of the wrapper around the window, and how many
 * wrapper pixels one window pixel takes (the zoom).
 */
export type FrameOrigin = { x: number; y: number; scale: number };

/** The part of a move that is smaller than this share of the larger part is not named. */
const MINOR_SHARE = 0.25;
/** A move of this many pixels or less on one axis is not named (as in compare). */
const MOVE_PX = 2;
/** An arrow shorter than this is not drawn: the two boxes show the move. */
const MIN_ARROW = 8;
const HEAD_LENGTH = 10;
const HEAD_HALF_WIDTH = 5;
/** Room for a label above a box; with less, the label goes below. */
const LABEL_ROOM = 24;

/** The words for a move: "moved 157 px down", or both axes when it is diagonal. */
export function movementLabel(dx: number, dy: number): string {
  const x = Math.round(dx);
  const y = Math.round(dy);
  const big = Math.max(Math.abs(x), Math.abs(y));
  if (big === 0) return "moved 0 px";
  const named = (n: number) =>
    Math.abs(n) === big ||
    (Math.abs(n) > MOVE_PX && Math.abs(n) >= big * MINOR_SHARE);
  const across = { n: x, words: x > 0 ? "right" : "left" };
  const down = { n: y, words: y > 0 ? "down" : "up" };
  const parts = (Math.abs(x) >= Math.abs(y) ? [across, down] : [down, across])
    .filter((part) => part.n !== 0 && named(part.n))
    .map((part) => `${Math.abs(part.n)} px ${part.words}`);
  return `moved ${parts.join(" and ")}`;
}

/** How much of a cut-off element's content is hidden, in window pixels, across and down. */
export function hiddenBy(warning: Extract<Warning, { kind: "clipped" }>): {
  x: number;
  y: number;
} {
  return {
    x: Math.max(0, Math.round(warning.scrollWidth - warning.box.width)),
    y: Math.max(0, Math.round(warning.scrollHeight - warning.box.height)),
  };
}

/** The words on the highlight of a warning. */
export function highlightLabel(warning: Warning): string {
  switch (warning.kind) {
    case "moved":
      return movementLabel(warning.dx, warning.dy);
    case "clipped": {
      const hidden = Math.max(hiddenBy(warning).x, hiddenBy(warning).y);
      return hidden > 0 ? `cut off by ${hidden} px` : "cut off";
    }
    case "outside":
      return `${Math.round(warning.overBy)} px outside the window`;
    case "spacing":
      return spacingLabel(warning);
    case "spinners":
      return `${warning.count} spinners at once`;
  }
}

/** The words on a Spacing highlight: the rule's measure, short. */
export function spacingLabel(
  warning: Extract<Warning, { kind: "spacing" }>,
): string {
  const n = Math.round(warning.size);
  switch (warning.rule) {
    case "clearance":
      return `${Math.max(0, 8 - n)} px from the window buttons`;
    case "column":
      return `window buttons ${n} px off the column's middle`;
    case "fit":
      return `column ${n} px too narrow for the window buttons`;
    case "row":
      return `${n} px off the window buttons' row`;
  }
}

/** The parts of a box that go past the edges of a window of this size. */
export function outsideParts(
  box: Box,
  viewport: { width: number; height: number },
): Box[] {
  const parts: Box[] = [];
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  if (box.x < 0) parts.push({ ...box, width: Math.min(-box.x, box.width) });
  if (right > viewport.width) {
    const x = Math.max(box.x, viewport.width);
    parts.push({ ...box, x, width: right - x });
  }
  if (box.y < 0) parts.push({ ...box, height: Math.min(-box.y, box.height) });
  if (bottom > viewport.height) {
    const y = Math.max(box.y, viewport.height);
    parts.push({ ...box, y, height: bottom - y });
  }
  return parts;
}

export type Arrow = { x1: number; y1: number; x2: number; y2: number };

/** What a highlight draws, in the wrapper's coordinates. */
export type HighlightShapes = {
  kind: Warning["kind"];
  /** Where a moved element was (dashed). */
  ghost: Box | null;
  /** Where the element is now. */
  box: Box;
  arrow: Arrow | null;
  /** Content that is cut off, or the part outside the window. */
  shaded: Box[];
  label: string;
  /** The label goes below the box when there is no room above it. */
  labelBelow: boolean;
  /** The box the label sits on: the box, or the window's buttons for a Spacing warning. */
  labelAt: Box;
};

function place(box: Box, origin: FrameOrigin): Box {
  return {
    x: origin.x + box.x * origin.scale,
    y: origin.y + box.y * origin.scale,
    width: box.width * origin.scale,
    height: box.height * origin.scale,
  };
}

function center(box: Box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The shapes of a warning's highlight over a window at `origin`. */
export function highlightShapes(
  warning: Warning,
  origin: FrameOrigin,
  viewport: { width: number; height: number },
): HighlightShapes {
  let ghost: Box | null = null;
  let frameBox: Box;
  let shaded: Box[] = [];
  if (warning.kind === "moved") {
    ghost = place(warning.from, origin);
    frameBox = warning.to;
  } else if (warning.kind === "clipped") {
    frameBox = warning.box;
    const hidden = hiddenBy(warning);
    const { x, y, width, height } = warning.box;
    if (hidden.x > 0) shaded.push({ x: x + width, y, width: hidden.x, height });
    if (hidden.y > 0)
      shaded.push({ x, y: y + height, width, height: hidden.y });
  } else if (warning.kind === "spacing") {
    frameBox = warning.box;
    // The window's buttons, shaded: what the element is too near.
    shaded = [warning.buttons];
  } else if (warning.kind === "spinners") {
    // A box around all of them, and each spinner shaded.
    frameBox = warning.box;
    shaded = warning.boxes;
  } else {
    frameBox = warning.box;
    shaded = outsideParts(warning.box, viewport);
  }
  const box = place(frameBox, origin);
  const labelAt =
    warning.kind === "spacing" ? place(warning.buttons, origin) : box;
  let arrow: Arrow | null = null;
  if (ghost) {
    const from = center(ghost);
    const to = center(box);
    if (Math.hypot(to.x - from.x, to.y - from.y) >= MIN_ARROW)
      arrow = { x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  }
  return {
    kind: warning.kind,
    ghost,
    box,
    arrow,
    shaded: shaded.map((part) => place(part, origin)),
    label: highlightLabel(warning),
    labelBelow: labelAt.y - origin.y < LABEL_ROOM,
    labelAt,
  };
}

/** The line of an arrow, ended where its head starts, and the three points of the head. */
function arrowParts({ x1, y1, x2, y2 }: Arrow) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  const baseX = x2 - ux * HEAD_LENGTH;
  const baseY = y2 - uy * HEAD_LENGTH;
  const head = [
    [x2, y2],
    [baseX - uy * HEAD_HALF_WIDTH, baseY + ux * HEAD_HALF_WIDTH],
    [baseX + uy * HEAD_HALF_WIDTH, baseY - ux * HEAD_HALF_WIDTH],
  ]
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
  return { line: { x1, y1, x2: baseX, y2: baseY }, head };
}

function at(box: Box) {
  return { left: box.x, top: box.y, width: box.width, height: box.height };
}

/**
 * Shows a layout warning over the window: where a moved element was and where it went, the hidden
 * part of cut-off text, or the part of an element outside the window. It is drawn next to the
 * window element and not in it, so a shot of the window does not show it.
 */
export function WarningHighlight({
  warning,
  origin,
  viewport,
}: {
  warning: Warning;
  origin: FrameOrigin;
  viewport: { width: number; height: number };
}) {
  const shapes = highlightShapes(warning, origin, viewport);
  const arrow = shapes.arrow ? arrowParts(shapes.arrow) : null;
  // A problem in the app's destructive color, a move in its ring color. Each line has a 1px halo
  // in the page's background, so it reads on a light and on a dark window.
  const tone = shapes.kind === "moved" ? MOVE_TONE : PROBLEM_TONE;
  return (
    <div
      className={`wb-highlight wb-highlight-${shapes.kind}`}
      data-workbench-highlight={shapes.kind}
      aria-hidden="true"
    >
      {shapes.shaded.map((part) => (
        <span
          key={`${part.x},${part.y},${part.width},${part.height}`}
          className={`wb-highlight-shade outline outline-background ${tone.shade}`}
          style={at(part)}
        />
      ))}
      {shapes.ghost && (
        <span
          className={`wb-highlight-ghost border-2 border-dashed shadow-[0_0_0_1px_var(--background)] ${tone.ghost}`}
          data-highlight-box="from"
          style={at(shapes.ghost)}
        />
      )}
      <span
        className={`wb-highlight-box border-2 shadow-[0_0_0_1px_var(--background),inset_0_0_0_1px_var(--background)] ${tone.box}`}
        data-highlight-box={shapes.ghost ? "to" : "box"}
        style={at(shapes.box)}
      />
      {arrow && (
        <svg
          className="wb-highlight-arrow"
          width="1"
          height="1"
          aria-hidden="true"
        >
          <line
            className="fill-background stroke-background stroke-4"
            strokeLinejoin="round"
            {...arrow.line}
          />
          <polygon
            className="fill-background stroke-background stroke-4"
            strokeLinejoin="round"
            points={arrow.head}
          />
          <line
            className={`stroke-2 ${tone.stroke}`}
            strokeLinecap="round"
            {...arrow.line}
          />
          <polygon className={tone.fill} points={arrow.head} />
        </svg>
      )}
      <span
        data-highlight-label
        className={`wb-highlight-label rounded-sm px-1.5 py-0.5 text-xs leading-4 font-semibold whitespace-nowrap text-background shadow-[0_0_0_1px_var(--background)] ${tone.label}${shapes.labelBelow ? " wb-highlight-label-below" : ""}`}
        style={{
          left: shapes.labelAt.x,
          top: shapes.labelBelow
            ? shapes.labelAt.y + shapes.labelAt.height
            : shapes.labelAt.y,
        }}
      >
        {shapes.label}
      </span>
    </div>
  );
}

/** The app's tokens a highlight draws with. Whole class names, so Tailwind finds them. */
const PROBLEM_TONE = {
  box: "border-destructive bg-destructive/10",
  ghost: "border-destructive bg-destructive/10",
  shade: "bg-destructive/40",
  stroke: "stroke-destructive",
  fill: "fill-destructive",
  label: "bg-destructive",
};
const MOVE_TONE = {
  box: "border-ring bg-ring/10",
  ghost: "border-ring bg-ring/10",
  shade: "bg-ring/40",
  stroke: "stroke-ring",
  fill: "fill-ring",
  label: "bg-ring",
};

/**
 * Where the window `iframe` is in the coordinates of `wrap`, an element of the parent page around
 * the window. `frameWidth` is the window's width in its own pixels, so the zoom is taken out.
 */
export function frameOrigin(
  wrap: Element,
  iframe: HTMLIFrameElement,
  frameWidth: number,
): FrameOrigin {
  const outer = wrap.getBoundingClientRect();
  const frame = iframe.getBoundingClientRect();
  return {
    x: frame.left - outer.left,
    y: frame.top - outer.top,
    scale: frameWidth > 0 && frame.width > 0 ? frame.width / frameWidth : 1,
  };
}
