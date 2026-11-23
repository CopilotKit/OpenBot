import type { Box } from "./geometry";

export type Snapshot = Map<string, { box: Box; label: string }>;
/**
 * A layout warning. The boxes are in the window's own CSS pixels, from the top left of the window.
 */
export type Warning =
  | {
      kind: "moved";
      at: number;
      label: string;
      dx: number;
      dy: number;
      cause: string;
      /** Where the element was before the move. */
      from: Box;
      /** Where the element is after the move. */
      to: Box;
    }
  | {
      kind: "clipped";
      at: number;
      label: string;
      box: Box;
      /** The width and height of all of the element's content, also the part that is cut off. */
      scrollWidth: number;
      scrollHeight: number;
    }
  | { kind: "outside"; at: number; label: string; overBy: number; box: Box };

const TEXT_INPUTS = new Set([
  "",
  "text",
  "email",
  "search",
  "url",
  "tel",
  "password",
  "number",
]);

function collapse(text: string | null | undefined) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function roleOf(element: Element): string | null {
  const explicit = element.getAttribute("role")?.trim();
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a") return element.hasAttribute("href") ? "link" : null;
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "img") return "img";
  if (tag === "dialog") return "dialog";
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (TEXT_INPUTS.has(type)) return "textbox";
  }
  return null;
}

function nameOf(element: Element): string | null {
  const doc = element.ownerDocument;
  const label = collapse(element.getAttribute("aria-label"));
  if (label) return label;

  const by = element.getAttribute("aria-labelledby");
  if (by) {
    const text = collapse(
      by
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? "")
        .join(" "),
    );
    if (text) return text;
  }

  const id = element.getAttribute("id");
  if (id) {
    for (const candidate of Array.from(doc.querySelectorAll("label"))) {
      if (candidate.getAttribute("for") === id) {
        const text = collapse(candidate.textContent);
        if (text) return text;
      }
    }
  }
  const wrapping = element.closest("label");
  if (wrapping) {
    const text = collapse(wrapping.textContent);
    if (text) return text;
  }

  const alt = collapse(element.getAttribute("alt"));
  if (alt) return alt;

  const text = collapse(element.textContent);
  return text && text.length <= 80 ? text : null;
}

function ownText(element: Element) {
  let text = "";
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) text += node.textContent ?? "";
  }
  return collapse(text);
}

function isHidden(element: Element) {
  const view = element.ownerDocument.defaultView;
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (at.hasAttribute("hidden")) return true;
    if (at.getAttribute("aria-hidden") === "true") return true;
  }
  if (!view) return false;
  const style = view.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}

/** The key plus the words a person sees for an element, or null when it has no key. */
function identify(element: Element): { key: string; label: string } | null {
  if (isHidden(element)) return null;
  const role = roleOf(element);
  if (role) {
    const name = nameOf(element);
    if (name) return { key: `${role}:${name}`, label: `${role} "${name}"` };
  }
  const tag = element.tagName.toLowerCase();
  const text = ownText(element);
  if (text) return { key: `${tag}:${text}`, label: `${role ?? tag} "${text}"` };
  return null;
}

export function elementKey(element: Element): string | null {
  return identify(element)?.key ?? null;
}

/** The words a person sees for an element, as the warnings name it, or null when it has no key. */
export function elementLabel(element: Element): string | null {
  return identify(element)?.label ?? null;
}

function boxOf(element: Element): Box {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
}

/** Each side of `rect(top, right, bottom, left)` in px, or null when it is not a rect. */
function clipRect(value: string): number[] | null {
  const m = /^rect\((.*)\)$/.exec(value.trim());
  if (!m) return null;
  const sides = m[1]
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((side) => Number.parseFloat(side));
  return sides.length === 4 && sides.every(Number.isFinite) ? sides : null;
}

/** True when a `clip` value lets at most 1 px of width or height show. */
function clipHides(value: string): boolean {
  const sides = clipRect(value);
  if (!sides) return false;
  const [top, right, bottom, left] = sides;
  return right - left <= 1 || bottom - top <= 1;
}

/** True when a `clip-path` value shows nothing: `inset(50%)`, or a circle or ellipse of size 0. */
function clipPathHides(value: string): boolean {
  const text = value.trim();
  const inset = /^inset\(([^)]*)\)/.exec(text);
  if (inset) {
    // The four sides as CSS writes them: 1 to 4 values, then an optional `round`.
    const parts = inset[1]
      .split(/\s+round\s+/)[0]
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.every((part) => part.endsWith("%"))) return false;
    const [top, right = top, bottom = top, left = right] = parts.map((part) =>
      Number.parseFloat(part),
    );
    return top + bottom >= 100 || left + right >= 100;
  }
  return /^(circle|ellipse)\(\s*0(px|%)?[\s)]/.test(text);
}

function overflowHidden(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some(
    (value) => value === "hidden" || value === "clip",
  );
}

/** True when an element hides itself and all inside it: `clip`, `clip-path`, or a box of 1 px or
 * less that hides what goes past it. */
function hidesContent(element: Element, known: Map<Element, boolean>): boolean {
  const cached = known.get(element);
  if (cached !== undefined) return cached;
  const view = element.ownerDocument.defaultView;
  let hides = false;
  if (view) {
    const style = view.getComputedStyle(element);
    const { width, height } = boxOf(element);
    hides =
      clipHides(style.clip) ||
      clipPathHides(style.clipPath) ||
      ((width <= 1 || height <= 1) && overflowHidden(style));
  }
  known.set(element, hides);
  return hides;
}

/**
 * True when a person does not see an element, as with text for screen readers only (`sr-only`):
 * its box is 1 px or less in width or height, or it or an ancestor hides it with `clip`,
 * `clip-path`, or a box of 1 px or less with hidden overflow. `known` keeps the answer of each
 * ancestor for one walk of the page.
 */
export function isVisuallyHidden(
  element: Element,
  known: Map<Element, boolean> = new Map(),
): boolean {
  const { width, height } = boxOf(element);
  if (width <= 1 || height <= 1) return true;
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (hidesContent(at, known)) return true;
  }
  return false;
}

/**
 * The elements with a key and a box that is not empty, in document order. Text for screen readers
 * only is not in the list: a person does not see it, so it cannot move, be cut off or go outside.
 */
export function visibleElements(root: Document) {
  const body = root.body;
  if (!body) return [];
  const known = new Map<Element, boolean>();
  return Array.from(body.querySelectorAll("*")).flatMap((element) => {
    const identity = identify(element);
    if (!identity) return [];
    const box = boxOf(element);
    if (box.width === 0 || box.height === 0) return [];
    if (isVisuallyHidden(element, known)) return [];
    return [{ element, ...identity, box }];
  });
}

export function snapshot(root: Document): Snapshot {
  const result: Snapshot = new Map();
  const seen = new Map<string, number>();
  for (const { key, label, box } of visibleElements(root)) {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    result.set(count === 1 ? key : `${key}#${count}`, { box, label });
  }
  return result;
}

/** The label of a warning for a group of elements that all moved by the same amount. */
export const WHOLE_PAGE = "The whole page";

/** Moves within this many pixels of each other are one move. */
const SAME_MOVE_PX = 1;

export function compare(
  before: Snapshot,
  after: Snapshot,
  at: number,
  cause: string,
): Warning[] {
  // A new screen (a new main heading) is not a reason to skip: an element that stays on the
  // screen across the change, such as the background row or the step list, must not jump. What
  // was only on the old screen has no key in the new one, so it is not compared.
  const moves: {
    label: string;
    dx: number;
    dy: number;
    from: Box;
    to: Box;
  }[] = [];
  let present = 0;
  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now) continue;
    present += 1;
    const dx = now.box.x - was.box.x;
    const dy = now.box.y - was.box.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2)
      moves.push({ label: now.label, dx, dy, from: was.box, to: now.box });
  }
  // Moves of the same amount go in one group; a group is first seen at its first move.
  const groups: { dx: number; dy: number; members: number[] }[] = [];
  // The first move of a group stands for all of it: its boxes go on the group's warning.
  const groupOf = moves.map((move, index) => {
    const group = groups.find(
      (g) =>
        Math.abs(g.dx - move.dx) <= SAME_MOVE_PX &&
        Math.abs(g.dy - move.dy) <= SAME_MOVE_PX,
    );
    if (group) {
      group.members.push(index);
      return group;
    }
    const created = { dx: move.dx, dy: move.dy, members: [index] };
    groups.push(created);
    return created;
  });
  // Two or more that moved together, and at least half of what is on both: the page moved.
  const whole = (group: (typeof groups)[number]) =>
    group.members.length >= 2 && group.members.length * 2 >= present;
  const warnings: Warning[] = [];
  moves.forEach((move, index) => {
    const group = groupOf[index];
    if (!whole(group)) warnings.push({ kind: "moved", at, ...move, cause });
    else if (group.members[0] === index)
      warnings.push({
        kind: "moved",
        at,
        label: WHOLE_PAGE,
        dx: group.dx,
        dy: group.dy,
        cause,
        from: move.from,
        to: move.to,
      });
  });
  return warnings;
}

function scrolls(value: string) {
  return value === "auto" || value === "scroll";
}

/** Text cut off by this many px or less is not reported: a rounding, not text a person misses. */
export const CLIP_TOLERANCE_PX = 2;

/** True when an element cuts its own text on purpose: an ellipsis, or a clamp to a number of lines. */
export function truncatesOnPurpose(style: CSSStyleDeclaration): boolean {
  if (style.textOverflow === "ellipsis") return true;
  return ["-webkit-line-clamp", "line-clamp"].some((name) => {
    const clamp = style.getPropertyValue(name).trim();
    return clamp !== "" && clamp !== "none";
  });
}

/** The box an element shows its content in: inside the border, without the scroll bars. */
function contentClip(element: Element): Box {
  const rect = element.getBoundingClientRect();
  const html = element as HTMLElement;
  return {
    x: rect.x + (html.clientLeft || 0),
    y: rect.y + (html.clientTop || 0),
    width: html.clientWidth,
    height: html.clientHeight,
  };
}

function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

/**
 * How many px of the text the clip box hides: the most any line of the text goes past a side of
 * the box. 0 when every line is inside it.
 */
export function hiddenPx(textRects: readonly Box[], clip: Box): number {
  let most = 0;
  for (const r of textRects) {
    if (r.width === 0 || r.height === 0) continue;
    most = Math.max(
      most,
      clip.x - r.x,
      clip.y - r.y,
      r.x + r.width - (clip.x + clip.width),
      r.y + r.height - (clip.y + clip.height),
    );
  }
  return most;
}

/** The boxes of the lines of an element's own text (its text nodes, not its children's). */
function ownTextRects(element: Element): Box[] {
  const doc = element.ownerDocument;
  const rects: Box[] = [];
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType !== 3 || !collapse(node.textContent)) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects()))
      rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
  }
  return rects;
}

/**
 * How many px of an element's own text a person cannot see, or 0. Text cut on purpose (an
 * ellipsis or a line clamp, on the element or on the box that cuts it) does not count, nor text
 * that overflows where nothing cuts it (overflow visible), nor text in a box that scrolls.
 */
function cutOffBy(element: Element, view: Window): number {
  const style = view.getComputedStyle(element);
  if (truncatesOnPurpose(style)) return 0;
  let clip: Box | null = null;
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (at === element.ownerDocument.documentElement) break;
    const s = at === element ? style : view.getComputedStyle(at);
    if (at !== element && truncatesOnPurpose(s) && overflowHidden(s)) return 0;
    if (scrolls(s.overflowX) || scrolls(s.overflowY)) {
      // A person scrolls to the rest of the text. Only what cut it before the scroller counts.
      break;
    }
    if (overflowHidden(s)) {
      const box = contentClip(at);
      clip = clip ? intersect(clip, box) : box;
    }
  }
  if (!clip) return 0;
  return hiddenPx(ownTextRects(element), clip);
}

/** True when an element moves with the page's own scroll (it is not fixed to the window). */
function movesWithPage(element: Element, view: Window): boolean {
  for (let at: Element | null = element; at; at = at.parentElement) {
    if (view.getComputedStyle(at).position === "fixed") return false;
  }
  return true;
}

/** The axes the page itself scrolls on (the window's own scroll bar, not an element's). */
function pageScrolls(root: Document, view: Window): { x: boolean; y: boolean } {
  const scroller = root.scrollingElement ?? root.documentElement;
  if (!scroller) return { x: false, y: false };
  const styles = [root.documentElement, root.body]
    .filter((e): e is HTMLElement => e !== null)
    .map((e) => view.getComputedStyle(e));
  const open = (axis: "overflowX" | "overflowY") =>
    styles.every((s) => s[axis] !== "hidden" && s[axis] !== "clip");
  return {
    x: scroller.scrollWidth > scroller.clientWidth + 1 && open("overflowX"),
    y: scroller.scrollHeight > scroller.clientHeight + 1 && open("overflowY"),
  };
}

export function clippedAndOutside(
  root: Document,
  at: number,
  viewport: { width: number; height: number },
): Warning[] {
  const view = root.defaultView;
  if (!view) return [];
  const warnings: Warning[] = [];
  const page = pageScrolls(root, view);
  for (const { element, label, box } of visibleElements(root)) {
    const style = view.getComputedStyle(element);
    if (ownText(element) && element.clientWidth > 0) {
      const overflowing =
        (element.scrollWidth > element.clientWidth + 1 &&
          !scrolls(style.overflowX || style.overflow)) ||
        (element.scrollHeight > element.clientHeight + 1 &&
          !scrolls(style.overflowY || style.overflow));
      if (overflowing && cutOffBy(element, view) > CLIP_TOLERANCE_PX)
        warnings.push({
          kind: "clipped",
          at,
          label,
          box,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
        });
    }

    let inScroller = false;
    for (let up = element.parentElement; up; up = up.parentElement) {
      const s = view.getComputedStyle(up);
      if (scrolls(s.overflow) || scrolls(s.overflowX) || scrolls(s.overflowY)) {
        inScroller = true;
        break;
      }
    }
    if (inScroller) continue;
    // The page's own scroll brings an element past the right or the bottom edge into view.
    const withPage = (page.x || page.y) && movesWithPage(element, view);
    const overBy = Math.round(
      Math.max(
        withPage && page.x ? 0 : box.x + box.width - viewport.width,
        withPage && page.y ? 0 : box.y + box.height - viewport.height,
        withPage && page.x ? 0 : -box.x,
        withPage && page.y ? 0 : -box.y,
      ),
    );
    if (overBy > 0) warnings.push({ kind: "outside", at, label, overBy, box });
  }
  return warnings;
}

export function describeElements(
  root: Document,
): { key: string; label: string; box: Box; text: string }[] {
  const seen = new Map<string, number>();
  return visibleElements(root).map(({ element, key, label, box }) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return {
      key: count === 1 ? key : `${key}#${count}`,
      label,
      box,
      text: collapse(element.textContent).slice(0, 200),
    };
  });
}

/**
 * What screen a check saw, and what had the focus: one entry each time either changes. The
 * findings use it to tell a move across a screen change, or of the focused element, from the rest.
 */
export type ScreenMark = {
  /** The clock time of the check, in ms. */
  at: number;
  /** The route and the main heading, for example `/settings · General`. */
  screen: string;
  /** The label of the focused element, or null when nothing has the focus. */
  focus: string | null;
};

/** The route and the main heading of a window: its `h1`, or else its first heading. */
export function screenOf(root: Document): string {
  const loc = root.defaultView?.location;
  const route = loc ? `${loc.pathname}${loc.hash}` : "";
  const heading =
    root.querySelector("h1") ?? root.querySelector("h2, h3, [role='heading']");
  const words = collapse(heading?.textContent).slice(0, 80);
  return words ? `${route} · ${words}` : route;
}

/** The label of the focused element of a window, or null for none (the body). */
export function focusOf(root: Document): string | null {
  const active = root.activeElement;
  if (!active || active === root.body || active === root.documentElement)
    return null;
  return elementLabel(active);
}
