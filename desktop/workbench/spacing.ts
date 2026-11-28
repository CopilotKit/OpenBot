// The Spacing check: how the page sits around the window's own buttons (titleBar.ts). Pure geometry
// on boxes; layoutWatch.ts reads the boxes from the page.
//
// - Clearance: nothing of the page, and no edge or rounded corner of a panel, comes within
//   CLEARANCE_PX of the buttons. Edges on the window's own edges do not count: they are not seen.
// - Column: the buttons fit the column they sit over (the sidebar's strip) with CLEARANCE_PX on
//   each side, and sit in its middle, over the column's own icons.
// - Row: the buttons' middle lines up with the row beside them (Admin's "Back to app"), and a panel
//   does not start beside them with its top above their middle and its corner next to them.
import type { Box } from "./geometry";

/** The least room between the window's buttons and anything of the page, in px. */
export const CLEARANCE_PX = 8;
/** Middles this close are the same middle (a rounding, not a design). */
export const ALIGN_TOLERANCE_PX = 2;
/** How far right of the buttons an item still counts as on their row. */
export const ROW_REACH_PX = 200;
/**
 * A column at most this many times the buttons' room (their width and CLEARANCE_PX each side) is a
 * rail of icons, where the buttons belong in the middle. In a wider sidebar macOS puts them at its
 * top left, so only the fit and the clearance count there.
 */
export const RAIL_FACTOR = 2;
/** How far below the buttons the column's first item is looked for. */
export const COLUMN_REACH_PX = 64;

export type SpacingRule = "clearance" | "column" | "fit" | "row";

/** One element of the page near the buttons, as the check sees it. */
export type SpacingElement = {
  label: string;
  box: Box;
  /** Content a person reads or presses: text, a control, an image. */
  content: boolean;
  /** A painted box: a border, a background unlike its parent's, or a rounded corner. */
  panel: boolean;
};

export type SpacingIssue = {
  rule: SpacingRule;
  /** The element the issue is about, or "The window buttons" for the column. */
  label: string;
  /** The element's box, or the column's. */
  box: Box;
  /** How bad, in px: how far inside the clearance, how far off the middle, how much too narrow. */
  size: number;
  /** The sentence the warnings and the findings show. */
  text: string;
};

export const BUTTONS_LABEL = "The window buttons";

const right = (b: Box) => b.x + b.width;
const bottom = (b: Box) => b.y + b.height;
const middleX = (b: Box) => b.x + b.width / 2;
const middleY = (b: Box) => b.y + b.height / 2;
const round = (n: number) => Math.round(n * 10) / 10;

/** The shortest distance between two boxes: 0 when they touch or overlap. */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, b.x - right(a), a.x - right(b));
  const dy = Math.max(0, b.y - bottom(a), a.y - bottom(b));
  return Math.hypot(dx, dy);
}

function overlaps(a: Box, b: Box): boolean {
  return (
    Math.min(right(a), right(b)) > Math.max(a.x, b.x) &&
    Math.min(bottom(a), bottom(b)) > Math.max(a.y, b.y)
  );
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    right(outer) >= right(inner) &&
    bottom(outer) >= bottom(inner)
  );
}

/**
 * The distance from the buttons to the nearest edge of a panel that holds them, leaving out its
 * edges that lie on the window's own edges. Null when every edge is on the window's edge.
 */
function innerGap(
  buttons: Box,
  panel: Box,
  viewport: { width: number; height: number },
): number | null {
  const sides = [
    panel.x > 1 ? buttons.x - panel.x : null,
    panel.y > 1 ? buttons.y - panel.y : null,
    right(panel) < viewport.width - 1 ? right(panel) - right(buttons) : null,
    bottom(panel) < viewport.height - 1
      ? bottom(panel) - bottom(buttons)
      : null,
  ].filter((n): n is number => n !== null);
  return sides.length > 0 ? Math.min(...sides) : null;
}

/** True for a box as big as the window: the page's own background. */
function wholeWindow(box: Box, viewport: { width: number; height: number }) {
  return (
    box.x <= 1 &&
    box.y <= 1 &&
    right(box) >= viewport.width - 1 &&
    bottom(box) >= viewport.height - 1
  );
}

/** Rule a: content, and panels' edges, within CLEARANCE_PX of the buttons or over them. */
export function clearanceIssues(
  buttons: Box,
  elements: readonly SpacingElement[],
  viewport: { width: number; height: number },
): SpacingIssue[] {
  const issues: SpacingIssue[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    if (!element.content && !element.panel) continue;
    if (wholeWindow(element.box, viewport)) continue;
    let gap: number | null;
    if (contains(element.box, buttons)) {
      // A box that holds the buttons: only a panel's edges show, and only those not on the
      // window's edge. Content that holds them (a wrapper) is not near them itself.
      gap = element.panel ? innerGap(buttons, element.box, viewport) : null;
    } else {
      gap = boxGap(buttons, element.box);
    }
    if (gap === null || gap >= CLEARANCE_PX) continue;
    const key = `${element.label}|${Math.round(element.box.x)},${Math.round(element.box.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const over =
      overlaps(buttons, element.box) && !contains(element.box, buttons);
    issues.push({
      rule: "clearance",
      label: element.label,
      box: element.box,
      size: round(CLEARANCE_PX - Math.max(0, gap)),
      text: over
        ? `${element.label} is under the window buttons`
        : `${element.label} is ${Math.max(0, Math.round(gap))} px from the window buttons`,
    });
  }
  return issues;
}

/**
 * The column the buttons sit over: the narrowest box at least as wide as the buttons that holds
 * their middle, starts at or above them, runs well below them, and is less than half the window
 * wide (the sidebar, not the page). Its gutter runs on to a panel that starts just past it (the
 * inset panel beside a sidebar), since that edge is the column's edge a person sees. Null when
 * none does.
 */
export function buttonsColumn(
  buttons: Box,
  elements: readonly SpacingElement[],
  viewport: { width: number; height: number },
): SpacingElement | null {
  const cx = middleX(buttons);
  const cy = middleY(buttons);
  let best: SpacingElement | null = null;
  for (const element of elements) {
    const b = element.box;
    if (b.x > cx || right(b) < cx || b.y > buttons.y || bottom(b) < cy)
      continue;
    if (b.width < buttons.width || b.width >= viewport.width / 2) continue;
    if (bottom(b) - bottom(buttons) < COLUMN_REACH_PX) continue;
    if (!best || b.width < best.box.width) best = element;
  }
  if (!best) return null;
  const edge = elements
    .filter(
      (e) =>
        e.panel &&
        e.box.x >= right(best.box) &&
        e.box.x <= right(buttons) + CLEARANCE_PX &&
        e.box.y < bottom(buttons) &&
        bottom(e.box) > buttons.y,
    )
    .sort((a, b) => a.box.x - b.box.x)[0];
  if (!edge) return best;
  return {
    ...best,
    label: `${best.label} up to ${edge.label}`,
    box: { ...best.box, width: edge.box.x - best.box.x },
  };
}

/**
 * Rule b, the column: the buttons fit it with room on each side, and, in a rail of icons (at most
 * RAIL_FACTOR times their room), sit in its middle.
 */
export function columnIssues(
  buttons: Box,
  column: SpacingElement | null,
  elements: readonly SpacingElement[],
): SpacingIssue[] {
  if (!column) return [];
  const col = column.box;
  const issues: SpacingIssue[] = [];
  const need = buttons.width + 2 * CLEARANCE_PX;
  if (col.width < need) {
    issues.push({
      rule: "fit",
      label: BUTTONS_LABEL,
      box: col,
      size: round(need - col.width),
      text: `${BUTTONS_LABEL} do not fit their column: ${Math.round(col.width)} px for ${Math.round(need)} px`,
    });
  }
  const off = middleX(buttons) - middleX(col);
  const rail = col.width <= RAIL_FACTOR * need;
  if (rail && Math.abs(off) > ALIGN_TOLERANCE_PX) {
    // The column's first item under the buttons (the orb, the first icon) names what they miss.
    const first = elements
      .filter(
        (e) =>
          e.content &&
          contains(col, e.box) &&
          e.box.y >= bottom(buttons) &&
          e.box.y - bottom(buttons) <= COLUMN_REACH_PX,
      )
      .sort((a, b) => a.box.y - b.box.y)[0];
    const side = off > 0 ? "right" : "left";
    const under = first ? ` and of ${first.label} under them` : "";
    issues.push({
      rule: "column",
      label: BUTTONS_LABEL,
      box: col,
      size: round(Math.abs(off)),
      text: `${BUTTONS_LABEL} sit ${Math.round(Math.abs(off))} px ${side} of the middle of their column (${column.label}, ${Math.round(col.width)} px wide)${under}: ${Math.round(buttons.x - col.x)} px from its left edge, ${Math.round(right(col) - right(buttons))} px from its right`,
    });
  }
  return issues;
}

/**
 * Rule b, the row: the nearest item on the buttons' row to their right has the same middle, and no
 * panel beside them starts above their middle (its corner then sits beside them, neither above
 * nor in line with them).
 */
export function rowIssues(
  buttons: Box,
  elements: readonly SpacingElement[],
): SpacingIssue[] {
  const issues: SpacingIssue[] = [];
  const cy = middleY(buttons);
  const band = {
    top: buttons.y - CLEARANCE_PX,
    bottom: bottom(buttons) + CLEARANCE_PX,
  };
  const beside = elements
    .filter(
      (e) =>
        e.content &&
        e.box.x >= right(buttons) &&
        e.box.x - right(buttons) <= ROW_REACH_PX &&
        e.box.height <= 3 * buttons.height + CLEARANCE_PX &&
        e.box.y < band.bottom &&
        bottom(e.box) > band.top,
    )
    .sort((a, b) => a.box.x - b.box.x)[0];
  if (beside) {
    const off = middleY(beside.box) - cy;
    if (Math.abs(off) > ALIGN_TOLERANCE_PX)
      issues.push({
        rule: "row",
        label: beside.label,
        box: beside.box,
        size: round(Math.abs(off)),
        text: `${BUTTONS_LABEL}' middle is ${Math.round(Math.abs(off))} px ${off > 0 ? "above" : "below"} the middle of ${beside.label} beside them`,
      });
  }
  for (const panel of elements) {
    if (!panel.panel) continue;
    const b = panel.box;
    if (b.x < right(buttons) - 1 || b.x - right(buttons) > 3 * CLEARANCE_PX)
      continue;
    if (b.y <= 1 || b.y >= cy || bottom(b) <= buttons.y) continue;
    issues.push({
      rule: "row",
      label: panel.label,
      box: b,
      size: round(cy - b.y),
      text: `${panel.label} starts ${Math.round(cy - b.y)} px above the window buttons' middle, so its corner sits beside them: neither above them nor in line with their row`,
    });
    break;
  }
  return issues;
}

/** Every Spacing issue of a page whose window buttons are at `buttons`. */
export function spacingIssues(
  buttons: Box,
  elements: readonly SpacingElement[],
  viewport: { width: number; height: number },
): SpacingIssue[] {
  return [
    ...clearanceIssues(buttons, elements, viewport),
    ...columnIssues(
      buttons,
      buttonsColumn(buttons, elements, viewport),
      elements,
    ),
    ...rowIssues(buttons, elements),
  ];
}

/** The part of the page the check reads: what is near enough the buttons to matter. */
export function spacingZone(buttons: Box): Box {
  return {
    x: 0,
    y: 0,
    width: right(buttons) + ROW_REACH_PX,
    height: bottom(buttons) + COLUMN_REACH_PX + CLEARANCE_PX,
  };
}
