// What a step carries so an agent can find and use the same element again: its accessible role (`ariaRole`) and name, its
// input type, a ranked list of stable selectors, the frame it sits in, the page, and where it was on screen. Built in the
// page, before the step is masked, so the shared masking rules apply to all of it as they do to the rest of the step.
// Nothing here ever reads a field's value into a name or a selector. A click names the element the person meant
// (meantElement). The collector's own description of what was clicked or edited (its tag, role attribute, text,
// attributes and value) stays exactly as CopilotKit wrote it: the Recorder only adds fields of its own beside it.
import { REDACTED } from "@openbot/shared/recorder-masking";
import type { AgentTarget } from "../shared/agent-target";

/** Attributes a team puts on an element for tests and automation: the steadiest handle there is. `data-testid` first,
 * as Playwright's selector generator scores it (kTestIdScore 1, every other test attribute kOtherTestIdScore 2). */
const TEST_ATTRIBUTES = [
  "data-testid",
  "data-test-id",
  "data-test",
  "data-qa",
  "data-cy",
  "data-qa-id",
  "data-testing",
  "data-e2e",
  "data-automation-id",
  "data-test-selector",
] as const;

const MAX_NAME = 200;
/** A name read from what an element says is its first 60 characters: enough to tell it apart, never a whole panel. */
const MAX_TEXT_NAME = 60;
/** The roles ARIA names from their content (a form, a list or a region is named only by its own label). */
const NAMED_BY_CONTENT = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
  "listitem",
]);
/** The roles a person clicks by what is written on them, where `text=` finds the element; a form or a region is no such
 * thing, whatever its text holds. */
const CLICKED_BY_TEXT = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "checkbox",
  "radio",
  "switch",
  "treeitem",
]);
const MAX_TEXT_SELECTOR = 80;
const MAX_CSS_DEPTH = 5;

export type Selector = {
  /** `href`: a link by the address it is written with, which Selenium IDE ranks above a positional locator. */
  by: "testid" | "id" | "name" | "role" | "text" | "href" | "css";
  selector: string;
};

export type StepTargeting = {
  /** The element's accessible role, computed: never CopilotKit's `target.role`, which is the role attribute alone. */
  ariaRole: string | null;
  name: string;
  inputType?: string;
  /** A list's chosen options as the person read them, beside CopilotKit's `selectedValues`. */
  selectedLabels?: string[];
  selectors: Selector[];
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  frame?: { url: string; path: string[] };
  page?: { url: string; title: string };
};

const squash = (text: string | null | undefined, max = MAX_NAME): string =>
  (text ?? "").replace(/\s+/g, " ").trim().slice(0, max).trimEnd();

/** Playwright's own test for an id that looks random (selectorGenerator.ts isGuidLike): one change of character class
 * (lower, upper, digit, other) per four characters or more, a lower case letter after a capital not counting, `-` and
 * `_` ignored. Wikipedia's generated `mwGQ` is one; `searchInput` and `display-name` are not. */
function isGuidLike(id: string): boolean {
  let last: "lower" | "upper" | "digit" | "other" | undefined;
  let transitions = 0;
  for (const c of id) {
    if (c === "-" || c === "_") continue;
    const type =
      c >= "a" && c <= "z"
        ? "lower"
        : c >= "A" && c <= "Z"
          ? "upper"
          : c >= "0" && c <= "9"
            ? "digit"
            : "other";
    if (type === "lower" && last === "upper") {
      last = type;
      continue;
    }
    if (last && last !== type) transitions++;
    last = type;
  }
  return transitions >= id.length / 4;
}

/** An id a framework made up (React's `:r1:`, `ember123`, a uuid, a long hex or number run, Wikipedia's `mwGQ`) changes
 * from one load to the next, so it is never a selector, as Playwright's generator never makes one of a GUID-like id. */
export function isGeneratedId(id: string): boolean {
  return (
    id.length > 64 ||
    /[:]/.test(id) ||
    /\d{4,}/.test(id) ||
    /(?=[0-9a-f]*\d)[0-9a-f]{8,}/i.test(id) ||
    /^(?:ember|ext-gen|yui_|gwt-|mui-|radix-|headlessui-|react-aria|rc-|downshift-|uid-|id-)/i.test(
      id,
    ) ||
    isGuidLike(id)
  );
}

const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  button: "button",
  textarea: "textbox",
  summary: "button",
  option: "option",
  img: "img",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  li: "listitem",
  nav: "navigation",
  form: "form",
  table: "table",
  dialog: "dialog",
};

/** The element's role: its own `role`, else the one its tag and type give it. */
export function roleOf(element: Element): string | null {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.localName;
  if (tag === "a") return element.hasAttribute("href") ? "link" : null;
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox" || type === "radio") return type;
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (type === "hidden") return null;
    return "textbox";
  }
  if (tag === "select") {
    const select = element as HTMLSelectElement;
    return select.multiple || select.size > 1 ? "listbox" : "combobox";
  }
  if (element.matches('[contenteditable]:not([contenteditable="false"])'))
    return "textbox";
  return IMPLICIT_ROLES[tag] ?? null;
}

export function inputTypeOf(element: Element): string | undefined {
  if (element instanceof HTMLInputElement)
    return (element.getAttribute("type") ?? "text").toLowerCase();
  if (element instanceof HTMLTextAreaElement) return "textarea";
  if (element instanceof HTMLSelectElement)
    return element.multiple ? "select-multiple" : "select-one";
  if (element.matches('[contenteditable]:not([contenteditable="false"])'))
    return "contenteditable";
  return undefined;
}

const isField = (element: Element) =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement ||
  element.matches('[contenteditable]:not([contenteditable="false"])');

const SILENT = new Set(["script", "style", "noscript", "template"]);

/** What is written on the element, as a person reads it: each piece of text with a space between it and the next, so
 * "Sign in" and "or create an account" never run together as "Sign inor create"; never a field's own value, nor text a
 * page hides from everyone. Cut at `max` characters. */
function visibleText(element: Element, max = MAX_NAME): string {
  if (isField(element)) return "";
  const parts: string[] = [];
  let length = 0;
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
  );
  for (
    let node = walker.nextNode();
    node && length <= max;
    node = walker.nextNode()
  ) {
    const parent = node.parentElement;
    if (
      parent &&
      (SILENT.has(parent.localName) ||
        parent.closest('[hidden], [aria-hidden="true"]'))
    )
      continue;
    const text = node.nodeValue?.trim();
    if (!text) continue;
    parts.push(text);
    length += text.length + 1;
  }
  return squash(parts.join(" "), max);
}

function labelText(element: Element): string {
  const labels = (element as HTMLInputElement).labels;
  if (labels && labels.length > 0)
    return squash([...labels].map((label) => label.textContent).join(" "));
  const wrapping = element.closest("label");
  return wrapping ? squash(wrapping.textContent) : "";
}

/** An element a person acts on: a field, a button, a link, a summary, or anything whose role is one clicked (a menu
 * item, a tab, an option, a checkbox). A panel, a menu or a presentation wrapper is not. */
export function isActionable(element: Element): boolean {
  if (isField(element))
    return !(element instanceof HTMLInputElement && element.type === "hidden");
  if (element.localName === "button" || element.localName === "summary")
    return true;
  if (element.localName === "a" && element.hasAttribute("href")) return true;
  const role = roleOf(element);
  return role !== null && CLICKED_BY_TEXT.has(role);
}

/** The element a click was meant for: the clicked element or the nearest one around it a person acts on (through
 * shadow roots), or null when there is none, as when a page's empty space or a panel's text was clicked. */
export function meantElement(clicked: Element): Element | null {
  let current: Element | null = clicked;
  for (let depth = 0; current && depth < 40; depth++) {
    if (isActionable(current)) return current;
    const root = current.getRootNode();
    current =
      current.parentElement ??
      (typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot
        ? root.host
        : null);
  }
  return null;
}

/** The accessible name, as a screen reader would find it: aria-labelledby, aria-label, the field's label, the text on a
 * button or link, then placeholder, title and alt. */
export function nameOf(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = squash(
      labelledBy
        .split(/\s+/)
        .map(
          (id) => element.ownerDocument.getElementById(id)?.textContent ?? "",
        )
        .join(" "),
    );
    if (text) return text;
  }
  const aria = squash(element.getAttribute("aria-label"));
  if (aria) return aria;
  if (isField(element)) {
    const label = labelText(element);
    if (label) return label;
  } else {
    const role = roleOf(element);
    // A button, a link or an element with no role of its own is named by what it says; a form or a region never is.
    const text =
      role === null || NAMED_BY_CONTENT.has(role)
        ? visibleText(element, MAX_TEXT_NAME)
        : "";
    if (text) return text;
  }
  for (const attribute of ["placeholder", "title", "alt"]) {
    const text = squash(element.getAttribute(attribute));
    if (text) return text;
  }
  if (
    element instanceof HTMLInputElement &&
    ["button", "submit", "reset"].includes(element.type)
  )
    return squash(element.value);
  return "";
}

const quote = (text: string) =>
  `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const cssIdent = (text: string) =>
  typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(text)
    : text.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

/** Where a selector is looked up: the element's document, or the shadow root it sits in. */
const rootOf = (element: Element): ParentNode | null => {
  const root = element.getRootNode();
  return root.nodeType === Node.DOCUMENT_NODE ||
    root.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    ? (root as Document | ShadowRoot)
    : null;
};

/** Whether a CSS selector finds `element` and nothing else in its root. */
function findsOnly(element: Element, selector: string): boolean {
  try {
    const found = rootOf(element)?.querySelectorAll(selector);
    return found?.length === 1 && found[0] === element;
  } catch {
    return false;
  }
}

function anchorOf(element: Element): string | null {
  for (const attribute of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    const selector = value ? `[${attribute}=${quote(value)}]` : null;
    if (selector && findsOnly(element, selector)) return selector;
  }
  const id = element.getAttribute("id");
  if (id && !isGeneratedId(id)) return `#${cssIdent(id)}`;
  return null;
}

/** A short CSS path from the nearest ancestor with a stable handle that finds it alone (or the document), tag and
 * position only: class names are left out, as so many are build hashes. */
function cssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && parts.length < MAX_CSS_DEPTH) {
    if (parts.length > 0) {
      const anchor = anchorOf(current);
      if (anchor) {
        parts.unshift(anchor);
        return parts.join(" > ");
      }
    }
    const tag = current.localName;
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const same = [...parent.children].filter(
      (child) => child.localName === tag,
    );
    parts.unshift(
      same.length > 1
        ? `${tag}:nth-of-type(${same.indexOf(current) + 1})`
        : tag,
    );
    current = parent;
  }
  return parts.join(" > ");
}

/** A path segment or query value that changes from one visit to the next: a uuid, a long hex run, a clock reading,
 * something random. An order number (`/orders/1043`, `?order=1043`) stays. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const volatilePart = (part: string): boolean =>
  part.length > 64 ||
  UUID.test(part) ||
  /^[0-9a-f]{16,}$/i.test(part) ||
  /^\d{10,}$/.test(part) ||
  (part.length >= 8 && isGuidLike(part));
/** Query parameters that carry a session, a credential, a one-time code or a clock, never part of a link's address. */
const VOLATILE_PARAMS =
  /^(?:_|t|ts|cb|sid|code|state|nonce|sig|signature|expires?|timestamp|session(?:_?id)?|(?:access_|auth_|id_|refresh_)?token|auth|key|api_?key|jsessionid|phpsessid)$/i;

const decoded = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** A link's address as written, when it stays the same from one visit to the next: on the web (relative, or http and
 * https), with no session, credential, one-time code, clock or random part in it. Selenium IDE ranks such an `href`
 * locator above a positional one; Playwright and DevTools Recorder never use it. */
function stableHref(element: Element): string | null {
  const raw = element.getAttribute("href")?.trim();
  if (!raw || raw === "#" || raw.length > 200) return null;
  let url: URL;
  try {
    url = new URL(raw, element.ownerDocument.baseURI);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.some((segment) => volatilePart(decoded(segment)))) return null;
  for (const [key, value] of url.searchParams)
    if (VOLATILE_PARAMS.test(key) || volatilePart(value)) return null;
  return raw;
}

/** The selector scores of Playwright's selector generator (selectorGenerator.ts: lower is better), with the `href` and
 * CSS path places Selenium IDE gives them (after the name attribute, above position): a test attribute, then role and
 * name, the text on it, a hand-made id, the name attribute, the link's address, and a short CSS path last. */
const SCORE = {
  testid: 1,
  otherTestid: 2,
  role: 100,
  text: 180,
  id: 500,
  name: 520,
  href: 530,
  css: 10_000_000,
} as const;
/** Playwright's kNthScore: a selector that also finds other elements ranks after every one that finds this alone. */
const NOT_UNIQUE = 10_000;
/** No more than this many elements of one role are read for their names: past it a name is not proven unique. */
const MAX_ROLE_SCAN = 500;

/** The elements that can have each role without saying so, for counting an element's namesakes. */
const IMPLICIT_ROLE_QUERY: Record<string, string> = {
  link: "a[href], area[href]",
  button: "button, input, summary",
  textbox: "input, textarea, [contenteditable]",
  searchbox: "input",
  spinbutton: "input",
  slider: "input",
  checkbox: "input",
  radio: "input",
  combobox: "select, input",
  listbox: "select",
  option: "option",
  img: "img",
  heading: "h1, h2, h3, h4, h5, h6",
  listitem: "li",
  navigation: "nav",
  form: "form",
  table: "table",
  dialog: "dialog",
};

/** Whether role and name (and the text on it) find `element` alone among the elements of its role in its root. */
function uniqueByRole(
  element: Element,
  role: string,
  name: string,
  text: string,
): { role: boolean; text: boolean } {
  const root = rootOf(element);
  if (!root) return { role: false, text: false };
  const implicit = IMPLICIT_ROLE_QUERY[role];
  let candidates: Element[];
  try {
    candidates = [
      ...root.querySelectorAll(implicit ? `${implicit}, [role]` : "[role]"),
    ];
  } catch {
    return { role: false, text: false };
  }
  const sameRole = candidates.filter((other) => roleOf(other) === role);
  if (sameRole.length > MAX_ROLE_SCAN) return { role: false, text: false };
  let named = 0;
  let written = 0;
  for (const other of sameRole) {
    if (other === element) continue;
    if (name && nameOf(other) === name) named++;
    if (text && visibleText(other, MAX_TEXT_SELECTOR + 1) === text) written++;
    if (named > 0 && written > 0) break;
  }
  return { role: named === 0, text: written === 0 };
}

/** The selectors an agent can try, in the order Playwright's selector generator scores them: a test attribute, role and
 * name, the text on it, a hand-made id (never a made-up one), the name attribute, the link's stable address, and a short
 * CSS path. A selector that also finds another element ranks after every one that finds this alone, as Playwright
 * penalises it. None holds the field's value. */
export function selectorsOf(
  element: Element,
  role: string | null,
  name: string,
  echoes: (text: string) => boolean,
): Selector[] {
  const candidates: (Selector & { score: number })[] = [];
  const add = (
    by: Selector["by"],
    selector: string,
    score: number,
    unique: boolean,
  ) =>
    candidates.push({
      by,
      selector,
      score: unique ? score : score + NOT_UNIQUE,
    });
  const tag = element.localName;
  for (const attribute of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (!value || echoes(value)) continue;
    const selector = `[${attribute}=${quote(value)}]`;
    add(
      "testid",
      selector,
      attribute === "data-testid" ? SCORE.testid : SCORE.otherTestid,
      findsOnly(element, selector),
    );
  }
  const text =
    role && CLICKED_BY_TEXT.has(role)
      ? visibleText(element, MAX_TEXT_SELECTOR + 1)
      : "";
  const byRole = role && name && !echoes(name);
  const byText = text && text.length <= MAX_TEXT_SELECTOR && !echoes(text);
  const unique =
    role && (byRole || byText)
      ? uniqueByRole(element, role, byRole ? name : "", byText ? text : "")
      : { role: false, text: false };
  if (byRole)
    add("role", `role=${role}[name=${quote(name)}]`, SCORE.role, unique.role);
  if (byText) add("text", `text=${quote(text)}`, SCORE.text, unique.text);
  const id = element.getAttribute("id");
  if (id && !isGeneratedId(id) && !echoes(id)) {
    const selector = `#${cssIdent(id)}`;
    add("id", selector, SCORE.id, findsOnly(element, selector));
  }
  const nameAttribute = element.getAttribute("name");
  if (nameAttribute && !echoes(nameAttribute)) {
    const selector = `${tag}[name=${quote(nameAttribute)}]`;
    add("name", selector, SCORE.name, findsOnly(element, selector));
  }
  const href = stableHref(element);
  if (href && !echoes(href)) {
    const selector = `${tag}[href=${quote(href)}]`;
    add("href", selector, SCORE.href, findsOnly(element, selector));
  }
  candidates.push({ by: "css", selector: cssPath(element), score: SCORE.css });
  return candidates
    .sort((a, b) => a.score - b.score)
    .map(({ by, selector }) => ({ by, selector }));
}

/** The frame's position among its parent's frames, which a cross-site parent still lets a frame read. */
function frameIndex(frame: Window): number {
  try {
    const siblings = frame.parent.frames;
    for (let i = 0; i < siblings.length; i++)
      if (siblings[i] === frame) return i;
  } catch {
    // A frame being torn down.
  }
  return -1;
}

/** How a cross-site parent's iframe holding this frame is found, read from inside the frame (the parent's element is not
 * ours to read): by the name the iframe gave the frame, else by the address it loaded (with which of the frames loading
 * that same address it is, when there are more), else by its position among the parent's frames. */
function ownFrameSelector(): string {
  const name = window.name;
  if (name && name.length <= 64 && !isGeneratedId(name))
    return `iframe[name=${quote(name)}]`;
  if (location.protocol === "http:" || location.protocol === "https:") {
    const address = `//${location.host}${location.pathname}`;
    let same = 0;
    let mine = 0;
    try {
      const siblings = window.parent.frames;
      for (let i = 0; i < siblings.length; i++) {
        const sibling = siblings[i];
        if (sibling === window) mine = same;
        try {
          // Only a frame on this frame's own site can be read, and only such a frame can share its address.
          const at = sibling?.location;
          if (at && `//${at.host}${at.pathname}` === address) same++;
        } catch {
          // Another site's frame.
        }
      }
    } catch {
      // A frame being torn down.
    }
    const selector = `iframe[src*=${quote(address)}]`;
    return same > 1 ? `${selector} >> nth=${mine}` : selector;
  }
  const index = frameIndex(window);
  return index === -1 ? "iframe" : `iframe >> nth=${index}`;
}

/** The iframes from the top page down to this frame, and this frame's address. Each iframe is named by its best selector
 * where its parent can be read; across a cross-site parent, this frame's own iframe by its name or address, and an iframe
 * further up by its position among its parent's frames (Playwright's `>> nth=` counts from 0). */
function framePath(): { url: string; path: string[] } | undefined {
  if (window === window.top) return undefined;
  const path: string[] = [];
  let current: Window = window;
  for (let depth = 0; current !== current.top && depth < 10; depth++) {
    let selector: string | null = null;
    try {
      const element = current.frameElement;
      if (element)
        selector =
          selectorsOf(element, null, "", () => false)[0]?.selector ?? null;
    } catch {
      // A cross-site parent: its iframe element is not ours to read.
    }
    if (!selector) {
      if (current === window) selector = ownFrameSelector();
      else {
        const index = frameIndex(current);
        selector = index === -1 ? "iframe" : `iframe >> nth=${index}`;
      }
    }
    path.unshift(selector);
    current = current.parent;
  }
  return { url: location.href, path };
}

/** Everything an agent needs to find `element` again. `value` is the field's current value, so nothing derived here
 * repeats it. */
export function targetingOf(
  element: Element,
  value?: string,
  options: {
    /** The element the box is read from: the one actually clicked, when the step names the one around it. */
    boxOf?: Element;
    /** Name the element by its own short text whatever its role (a click that met nothing a person acts on). */
    ownText?: boolean;
  } = {},
): StepTargeting {
  const live = value?.trim() ?? "";
  const echoes = (text: string) => live.length >= 3 && text.includes(live);
  const role = roleOf(element);
  const named =
    nameOf(element) ||
    (options.ownText ? visibleText(element, MAX_TEXT_NAME) : "");
  const name = echoes(named) ? "" : named;
  const rect = (options.boxOf ?? element).getBoundingClientRect();
  const frame = framePath();
  const labels = chosenLabels(element);
  return {
    ariaRole: role,
    name,
    ...(inputTypeOf(element) ? { inputType: inputTypeOf(element) } : {}),
    ...(labels ? { selectedLabels: labels } : {}),
    selectors: selectorsOf(element, role, name, echoes),
    box: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...(frame
      ? { frame }
      : { page: { url: location.href, title: squash(document.title) } }),
  };
}

/** A list's chosen options as the person read them: each option's label, or its text. */
function chosenLabels(element: Element): string[] | undefined {
  if (!(element instanceof HTMLSelectElement)) return undefined;
  return Array.from(element.selectedOptions, (option) =>
    squash(option.label || option.text),
  );
}

/** The kind of control a collector edit came from: its element, else the tag and type CopilotKit described it by. */
function controlOf(
  element: Element | null,
  target: unknown,
): "select" | "toggle" | "other" {
  if (element instanceof HTMLSelectElement) return "select";
  if (element instanceof HTMLInputElement)
    return element.type === "checkbox" || element.type === "radio"
      ? "toggle"
      : "other";
  if (element || typeof target !== "object" || target === null) return "other";
  const { tag, attributes } = target as { tag?: unknown; attributes?: unknown };
  if (tag === "select") return "select";
  const type =
    typeof attributes === "object" && attributes !== null
      ? (attributes as Record<string, unknown>).type
      : undefined;
  return tag === "input" &&
    typeof type === "string" &&
    /^(?:checkbox|radio)$/i.test(type)
    ? "toggle"
    : "other";
}

/** The step a collector event is: a click, a choice in a list (`select`), a box ticked or a radio chosen (`check`), an
 * edit as typed (`input`) or a finished edit (`change`). The kind comes from the control: CopilotKit sends every edit
 * of a list or a box as `eventType: "input"`, as Chrome fires `input` before `change` for each. */
export function stepKindOf(
  name: string,
  eventType: unknown,
  element: Element | null,
  target?: unknown,
): string {
  if (name !== "input") return name;
  const control = controlOf(element, target);
  if (control === "select") return "select";
  if (control === "toggle") return "check";
  return eventType === "input" ? "input" : "change";
}

const eventElement = (event: Event): Element | null => {
  const [first] = event.composedPath();
  return first instanceof Element ? first : null;
};
const isRootOrDetached = (element: Element) =>
  element.localName === "body" ||
  element.localName === "html" ||
  !element.isConnected;

/** The attributes that tell one field from another; a value the collector redacted is not compared. */
const IDENTITY_ATTRIBUTES = [
  "id",
  "name",
  "type",
  "placeholder",
  "aria-label",
  "aria-labelledby",
  "autocomplete",
  "maxlength",
];
const MAX_WAITING_EDITS = 50;

/** Whether a collector edit's target (its tag and attribute snapshot) describes `element`. */
function describes(target: unknown, element: Element): boolean {
  if (typeof target !== "object" || target === null) return false;
  const { tag, attributes } = target as {
    tag?: unknown;
    attributes?: unknown;
  };
  if (tag !== element.localName) return false;
  const seen =
    typeof attributes === "object" && attributes !== null
      ? (attributes as Record<string, unknown>)
      : {};
  return IDENTITY_ATTRIBUTES.every((name) => {
    const recorded = seen[name];
    if (recorded === REDACTED) return true;
    return (
      (typeof recorded === "string" ? recorded : null) ===
      element.getAttribute(name)
    );
  });
}

/** Which element the collector's click or edit event is about, seen by listeners installed before the collector's (on
 * the same window, in the capture phase, so they run first for every event and the collector's beforeSend reads them). */
export function createElementTracker() {
  let pressed: Element | null = null;
  let current: { type: string; element: Element } | null = null;
  // The collector holds a field's text edit until it settles (or another field is edited, a click or a submit comes, or
  // capture stops), at most one per field, and lets them go in the order they were edited: the edited fields still
  // waiting, in that order, so an edit that arrives while the person is in the next field is still that field's.
  let waiting: Element[] = [];
  const onPointerDown = (event: Event) => {
    pressed = eventElement(event);
  };
  const onClick = (event: Event) => {
    const element = eventElement(event);
    if (!element) {
      current = null;
      return;
    }
    // A click a re-render moved to <body> or off a detached node was meant for what the pointer went down on, as the
    // collector reads it too.
    const clicked = isRootOrDetached(element) && pressed ? pressed : element;
    pressed = null;
    current = { type: "click", element: clicked };
  };
  const onEdit = (event: Event) => {
    const element = eventElement(event);
    current = element ? { type: event.type, element } : null;
    if (!element) return;
    waiting = waiting.filter((other) => other !== element);
    waiting.push(element);
    if (waiting.length > MAX_WAITING_EDITS) waiting.shift();
  };
  const listeners: [string, (event: Event) => void][] = [
    ["pointerdown", onPointerDown],
    ["click", onClick],
    ["input", onEdit],
    ["change", onEdit],
  ];
  return {
    install(): () => void {
      const options = { capture: true, passive: true } as const;
      for (const [type, listener] of listeners)
        window.addEventListener(type, listener, options);
      return () => {
        for (const [type, listener] of listeners)
          window.removeEventListener(type, listener, { capture: true });
      };
    },
    /** The element of the event being dispatched now, when it is the one `type` names. */
    elementFor(type: string): Element | null {
      return current?.type === type ? current.element : null;
    },
    /** The field a collector edit came from: the earliest edited field still waiting that its target describes. */
    elementForEdit(target: unknown): Element | null {
      const index = waiting.findIndex((element) => describes(target, element));
      if (index === -1) return null;
      const [element] = waiting.splice(index, 1);
      return element ?? null;
    },
  };
}

/** A collector click or edit, with the step it is and everything targetingOf finds about its element. */
export function enrichStep<E extends { name: string; value: unknown }>(
  event: E,
  element: Element | null,
): E {
  const value = event.value;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return event;
  const record = value as Record<string, unknown>;
  const step = stepKindOf(event.name, record.eventType, element, record.target);
  if (!element) return { ...event, value: { ...record, step } };
  const target =
    typeof record.target === "object" && record.target !== null
      ? (record.target as Record<string, unknown>)
      : {};
  const live = typeof target.value === "string" ? target.value : undefined;
  // A click names and selects the element it was meant for (the button around the clicked text), and keeps the box of
  // what was clicked; one that met nothing a person acts on names the clicked element by its own short text.
  const meant = event.name === "click" ? meantElement(element) : element;
  const { ariaRole, name, inputType, selectedLabels, ...rest } = targetingOf(
    meant ?? element,
    live,
    { boxOf: element, ownText: meant === null },
  );
  // CopilotKit's own fields (tag, role, text, attributes, value, ...) stay exactly as it wrote them: the Recorder's
  // targeting goes beside them, under names CopilotKit never uses.
  return {
    ...event,
    value: {
      ...record,
      step,
      target: {
        ...target,
        ariaRole,
        name,
        ...(inputType ? { inputType } : {}),
        ...(selectedLabels ? { selectedLabels } : {}),
      },
      ...rest,
    },
  };
}

/** The elements CopilotKit's click capture describes a click by (`@copilotkit/learning` clicks.ts `INTERACTIVE`): its
 * enricher reads the chat message and tool call around that element, not around the node the pointer hit. */
const COPILOTKIT_INTERACTIVE =
  'button, a[href], input, select, textarea, label, summary, [role], [data-copilotkit-action], [contenteditable]:not([contenteditable="false"])';

/** The chat message and tool call a click landed in, read exactly as CopilotKit reads them (`LearningBridge.enrich` on the
 * element its click capture describes); null when the click is in neither. */
export function agentTargetOf(clicked: Element | null): AgentTarget | null {
  if (!clicked) return null;
  const described = clicked.closest(COPILOTKIT_INTERACTIVE) ?? clicked;
  const messageId =
    described.closest("[data-message-id]")?.getAttribute("data-message-id") ??
    null;
  const toolCallId =
    described
      .closest("[data-tool-call-id]")
      ?.getAttribute("data-tool-call-id") ?? null;
  return messageId === null && toolCallId === null
    ? null
    : { messageId, toolCallId };
}
