// Builds the prompt for the "Copy as prompt" button of the workbench Comment
// mode. The prompt is a self-contained markdown message for a coding agent.

import type { AppHost } from "./appContract";
import { type ComponentInfo, formatChain } from "./componentChain";
import type { Box } from "./geometry";
import type { WindowSettings } from "./urlState";

export type PickedElement = {
  label: string;
  box: Box;
  gaps: {
    top: number | null;
    right: number | null;
    bottom: number | null;
    left: number | null;
  };
  offGrid: { x: number; y: number };
  styles: Record<string, string>;
  chain: ComponentInfo[];
  text: string;
};

export type CommentTarget =
  | { kind: "element"; element: PickedElement }
  | { kind: "area"; area: Box; elements: PickedElement[] };

export type CommentContext = {
  comment: string;
  scene: { id: string; title: string };
  window: WindowSettings;
  link: string;
  /** Set for an app scene: the route of the app frame and where the app runs. */
  app?: { route: string; host: AppHost };
};

const MAX_TEXT = 200;
const MAX_ROWS = 30;

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function formatBox(box: Box): string {
  return `x ${round(box.x)}, y ${round(box.y)}, ${round(box.width)}×${round(box.height)}`;
}

function formatGaps(g: PickedElement["gaps"]): string {
  const parts = (["top", "right", "bottom", "left"] as const)
    .filter((side) => g[side] !== null)
    .map((side) => `${side} ${round(g[side] as number)}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function shotCommand(context: CommentContext): string {
  return `cd desktop && bun run desktop-workbench:shot --url '${context.link.replaceAll("'", "'\\''")}'`;
}

function describeElement(el: PickedElement): string[] {
  const lines = [`- Label: \`${el.label}\``];
  if (el.chain.length > 0) lines.push(`- Component: ${formatChain(el.chain)}`);
  lines.push(`- Box: ${formatBox(el.box)}`);
  lines.push(`- Gaps to the nearest neighbour: ${formatGaps(el.gaps)}`);
  if (el.offGrid.x !== 0 || el.offGrid.y !== 0) {
    lines.push(
      `- Off the 4px grid by: x ${round(el.offGrid.x)}, y ${round(el.offGrid.y)}`,
    );
  }
  const styles = Object.entries(el.styles)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  if (styles.length > 0) lines.push(`- Styles: ${styles.join("; ")}`);
  const text = cut(el.text);
  if (text) lines.push(`- Text: "${text}"`);
  return lines;
}

function sortedElements(elements: PickedElement[]): PickedElement[] {
  return [...elements].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

function median(values: number[]): number {
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[mid]
    : (values[mid - 1] + values[mid]) / 2;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()].map(([k, n]) => `${k} (${n})`).join(", ");
}

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

function overlapsHorizontally(a: Box, b: Box): boolean {
  return Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0;
}

/**
 * For each box, the gap to the nearest box above it that shares some of its columns and is not
 * around it or in it. Boxes side by side on one row and nested boxes give no gap, and boxes that
 * overlap give no negative gap.
 */
export function verticalGaps(boxes: readonly Box[]): number[] {
  const result: number[] = [];
  for (const box of boxes) {
    let nearest: number | null = null;
    for (const other of boxes) {
      if (other === box || other.y >= box.y) continue;
      if (!overlapsHorizontally(box, other)) continue;
      if (contains(other, box) || contains(box, other)) continue;
      const gap = box.y - (other.y + other.height);
      if (gap >= 0 && (nearest === null || gap < nearest)) nearest = gap;
    }
    if (nearest !== null) result.push(nearest);
  }
  return result;
}

function spacingSummary(sorted: PickedElement[]): string[] {
  const lines = ["### Spacing in this area", ""];
  const gapsBetween = verticalGaps(sorted.map((e) => e.box));
  if (gapsBetween.length > 0) {
    const ordered = [...gapsBetween].sort((a, b) => a - b);
    lines.push(
      `- Vertical gaps between neighbouring elements (${ordered.length}): min ${round(ordered[0])}, median ${round(median(ordered))}, max ${round(ordered[ordered.length - 1])}`,
    );
  } else {
    lines.push("- Vertical gaps: not enough elements to measure.");
  }
  const fonts = sorted
    .filter((e) => e.styles["font-size"] && e.styles["line-height"])
    .map((e) => `${e.styles["font-size"]} / ${e.styles["line-height"]}`);
  if (fonts.length > 0) {
    lines.push(
      `- Font size / line height pairs: ${formatCounts(countBy(fonts))}`,
    );
  }
  const paddings = sorted
    .map((e) => e.styles.padding)
    .filter((p): p is string => Boolean(p));
  if (paddings.length > 0) {
    lines.push(`- Padding values: ${formatCounts(countBy(paddings))}`);
  }
  return lines;
}

function describeArea(area: Box, elements: PickedElement[]): string[] {
  const sorted = sortedElements(elements);
  const lines = [
    `- Area: ${formatBox(area)}`,
    `- Elements in the area: ${sorted.length}`,
    "",
  ];
  if (sorted.length === 0) return lines;
  lines.push("| Label | Component | Box | Gaps |", "| --- | --- | --- | --- |");
  for (const el of sorted.slice(0, MAX_ROWS)) {
    const component = el.chain[0]?.name ?? "";
    lines.push(
      `| ${cell(el.label)} | ${cell(component)} | ${formatBox(el.box)} | ${formatGaps(el.gaps)} |`,
    );
  }
  if (sorted.length > MAX_ROWS) {
    lines.push(
      "",
      `Showing the first ${MAX_ROWS} of ${sorted.length} elements.`,
    );
  }
  lines.push("", ...spacingSummary(sorted));
  return lines;
}

function appLines(context: CommentContext): string[] {
  if (!context.app) return [];
  const host = context.app.host === "browser" ? "Browser" : "OpenBot Desktop";
  return [`- Route: ${context.app.route}`, `- Host: ${host}`];
}

export function buildPrompt(
  target: CommentTarget,
  context: CommentContext,
): string {
  const w = context.window;
  const command = shotCommand(context);
  const quoted = context.comment
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  const lines = [
    "# Change request from the OpenBot Desktop workbench",
    "",
    quoted,
    "",
    "## Where",
    "",
    `- View: ${context.scene.title} (\`${context.scene.id}\`)`,
    `- Window: ${w.width}×${w.height}, OS ${w.os}, theme ${w.theme}`,
    ...appLines(context),
    `- Link: ${context.link}`,
    "",
    `To see it: \`${command}\``,
    "Or open the link with `bun run desktop-workbench` running.",
    "",
  ];

  if (target.kind === "element") {
    lines.push("## Element", "", ...describeElement(target.element));
  } else {
    lines.push("## Area", "", ...describeArea(target.area, target.elements));
  }

  lines.push(
    "",
    "## What to do",
    "",
    "1. Find the component in the file named above. Search the repo if no file is named.",
    "2. Make the change the comment asks for.",
    "3. Keep the 4px grid.",
    "4. Follow the repo's `openbot-copy` and `openbot-screen-layout` rules where they apply.",
  );
  if (context.app) {
    lines.push(
      "5. The app's files are under `app/src`. If the change loads or changes server data, follow the repo's `openbot-data-access` rules.",
    );
  }
  lines.push(
    `${context.app ? 6 : 5}. Shoot the same frame again with \`${command}\`. Compare it with the first frame.`,
    "",
  );
  return lines.join("\n");
}
