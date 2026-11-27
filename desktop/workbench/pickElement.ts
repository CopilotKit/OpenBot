// Reads what the workbench Comment mode needs to know about an element of the window, or about
// the elements in an area: label, box, gaps, grid, styles, components and text.

import type { PickedElement } from "./commentPrompt";
import { componentChain } from "./componentChain";
import { type Box, gaps, offGrid } from "./geometry";
import { elementLabel, visibleElements } from "./layoutWatch";

export const PICKED_STYLES = [
  "font-size",
  "line-height",
  "font-weight",
  "padding",
  "margin",
  "gap",
  "display",
  "justify-content",
  "align-items",
  "text-align",
  "width",
  "height",
] as const;

const SIDES = ["top", "right", "bottom", "left"] as const;

export function toBox(rect: DOMRect | Box): Box {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** The boxes of every visible element of the document, with the element. */
export function visibleBoxes(doc: Document): { element: Element; box: Box }[] {
  const view = doc.defaultView;
  const result: { element: Element; box: Box }[] = [];
  for (const element of doc.body?.querySelectorAll("*") ?? []) {
    const box = toBox(element.getBoundingClientRect());
    if (box.width === 0 || box.height === 0) continue;
    const style = view?.getComputedStyle(element);
    if (
      style &&
      (style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0")
    ) {
      continue;
    }
    result.push({ element, box });
  }
  return result;
}

/** The boxes of the visible elements that are not the target, not around it and not in it. */
export function neighbourBoxes(
  target: Element,
  all: readonly { element: Element; box: Box }[],
): Box[] {
  return all
    .filter(
      ({ element }) =>
        element !== target &&
        !element.contains(target) &&
        !target.contains(element),
    )
    .map(({ box }) => box);
}

function fallbackLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute("id");
  if (id) return `${tag}#${id}`;
  const first = (element.getAttribute("class") ?? "").trim().split(/\s+/)[0];
  return first ? `${tag}.${first}` : tag;
}

function styleValue(style: CSSStyleDeclaration, name: string): string {
  const value = style.getPropertyValue(name);
  if (value || (name !== "padding" && name !== "margin")) return value;
  // Some engines give no shorthand: build it from the four sides.
  const sides = SIDES.map((side) => style.getPropertyValue(`${name}-${side}`));
  if (sides.every((side) => side === "")) return "";
  const [top, right, bottom, left] = sides.map((side) => side || "0px");
  if (top === bottom && right === left) {
    return top === right ? top : `${top} ${right}`;
  }
  return `${top} ${right} ${bottom} ${left}`;
}

function stylesOf(element: Element): Record<string, string> {
  const styles: Record<string, string> = {};
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  for (const name of PICKED_STYLES) {
    styles[name] = style ? styleValue(style, name) : "";
  }
  return styles;
}

function pick(
  element: Element,
  all: readonly { element: Element; box: Box }[],
  gridStep: number,
): PickedElement {
  const box = toBox(element.getBoundingClientRect());
  return {
    label: elementLabel(element) ?? fallbackLabel(element),
    box,
    gaps: gaps(box, neighbourBoxes(element, all)),
    offGrid: offGrid(box, gridStep),
    styles: stylesOf(element),
    chain: componentChain(element),
    text: (element.textContent ?? "").trim(),
  };
}

export function pickElement(
  element: Element,
  root: Document,
  gridStep = 4,
): PickedElement {
  return pick(element, visibleBoxes(root), gridStep);
}

function inside(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function sameBox(a: Box, b: Box): boolean {
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

/**
 * The elements with a key that are fully in the area. When an element and one inside it have the
 * same box (a button and its text), only the outer one stays.
 */
export function pickArea(
  area: Box,
  root: Document,
  gridStep = 4,
): PickedElement[] {
  const found = visibleElements(root).filter(({ box }) => inside(box, area));
  const kept = found.filter(
    ({ element, box }) =>
      !found.some(
        (other) =>
          other.element !== element &&
          other.element.contains(element) &&
          sameBox(other.box, box),
      ),
  );
  if (kept.length === 0) return [];
  const all = visibleBoxes(root);
  return kept.map(({ element }) => pick(element, all, gridStep));
}
