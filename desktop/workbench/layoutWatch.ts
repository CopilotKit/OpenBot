import type { Box } from "./geometry";

/** `main` marks the main heading: the first h1 or h2 of the page. */
export type Snapshot = Map<string, { box: Box; label: string; main?: boolean }>;
export type Warning =
  | {
      kind: "moved";
      at: number;
      label: string;
      dx: number;
      dy: number;
      cause: string;
    }
  | { kind: "clipped"; at: number; label: string }
  | { kind: "outside"; at: number; label: string; overBy: number };

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

/** The elements with a key and a box that is not empty, in document order. */
export function visibleElements(root: Document) {
  const body = root.body;
  if (!body) return [];
  return Array.from(body.querySelectorAll("*")).flatMap((element) => {
    const identity = identify(element);
    const box = boxOf(element);
    if (!identity || box.width === 0 || box.height === 0) return [];
    return [{ element, ...identity, box }];
  });
}

export function snapshot(root: Document): Snapshot {
  const result: Snapshot = new Map();
  const seen = new Map<string, number>();
  let mainFound = false;
  for (const { element, key, label, box } of visibleElements(root)) {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    const main = !mainFound && /^h[12]$/i.test(element.tagName);
    if (main) mainFound = true;
    result.set(count === 1 ? key : `${key}#${count}`, {
      box,
      label,
      ...(main ? { main: true } : {}),
    });
  }
  return result;
}

/** The label of a warning for a group of elements that all moved by the same amount. */
export const WHOLE_PAGE = "The whole page";

/** Moves within this many pixels of each other are one move. */
const SAME_MOVE_PX = 1;

function mainHeading(snap: Snapshot): string | null {
  for (const [key, entry] of snap) if (entry.main) return key;
  return null;
}

export function compare(
  before: Snapshot,
  after: Snapshot,
  at: number,
  cause: string,
): Warning[] {
  // A new main heading is a new screen: what was on the old one did not move, it went away.
  if (mainHeading(before) !== mainHeading(after)) return [];
  const moves: { label: string; dx: number; dy: number }[] = [];
  let present = 0;
  for (const [key, was] of before) {
    const now = after.get(key);
    if (!now) continue;
    present += 1;
    const dx = now.box.x - was.box.x;
    const dy = now.box.y - was.box.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2)
      moves.push({ label: now.label, dx, dy });
  }
  // Moves of the same amount go in one group; a group is first seen at its first move.
  const groups: { dx: number; dy: number; members: number[] }[] = [];
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
      });
  });
  return warnings;
}

function scrolls(value: string) {
  return value === "auto" || value === "scroll";
}

export function clippedAndOutside(
  root: Document,
  at: number,
  viewport: { width: number; height: number },
): Warning[] {
  const view = root.defaultView;
  if (!view) return [];
  const warnings: Warning[] = [];
  for (const { element, label, box } of visibleElements(root)) {
    const style = view.getComputedStyle(element);
    if (ownText(element) && element.clientWidth > 0) {
      const overflowing =
        (element.scrollWidth > element.clientWidth + 1 &&
          !scrolls(style.overflowX || style.overflow)) ||
        (element.scrollHeight > element.clientHeight + 1 &&
          !scrolls(style.overflowY || style.overflow));
      if (overflowing) warnings.push({ kind: "clipped", at, label });
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
    const overBy = Math.round(
      Math.max(
        box.x + box.width - viewport.width,
        box.y + box.height - viewport.height,
        -box.x,
        -box.y,
      ),
    );
    if (overBy > 0) warnings.push({ kind: "outside", at, label, overBy });
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
