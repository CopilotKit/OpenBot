// What a step carries so an agent can find and use the same element again: its accessible role and name, its input type,
// a ranked list of stable selectors, the frame it sits in, the page, and where it was on screen. Built in the page, before
// the step is masked, so the shared masking rules apply to all of it as they do to the rest of the step. Nothing here
// ever reads a field's value into a name or a selector.

/** The collector's own choice of the element a click or an edit is about (`@copilotkit/learning` 0.0.1 `clicks.ts`
 * INTERACTIVE), so the targeting describes the element the step names. */
export const INTERACTIVE =
  'button, a[href], input, select, textarea, label, summary, [role], [data-copilotkit-action], [contenteditable]:not([contenteditable="false"])';

/** Attributes a team puts on an element for tests and automation: the steadiest handle there is. */
const TEST_ATTRIBUTES = [
  "data-testid",
  "data-test-id",
  "data-test",
  "data-qa",
  "data-cy",
  "data-e2e",
  "data-automation-id",
  "data-test-selector",
] as const;

const MAX_NAME = 200;
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
  by: "testid" | "id" | "name" | "role" | "text" | "css";
  selector: string;
};

export type StepTargeting = {
  role: string | null;
  name: string;
  inputType?: string;
  selectors: Selector[];
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  frame?: { url: string; path: string[] };
  page?: { url: string; title: string };
};

const squash = (text: string | null | undefined, max = MAX_NAME): string =>
  (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** An id a framework made up (React's `:r1:`, `ember123`, a uuid, a long hex or number run) changes from one load to the
 * next, so it is never a selector. */
export function isGeneratedId(id: string): boolean {
  return (
    id.length > 64 ||
    /[:]/.test(id) ||
    /\d{4,}/.test(id) ||
    /(?=[0-9a-f]*\d)[0-9a-f]{8,}/i.test(id) ||
    /^(?:ember|ext-gen|yui_|gwt-|mui-|radix-|headlessui-|react-aria|rc-|downshift-|uid-|id-)/i.test(
      id,
    )
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

/** What is written on the element, as a person sees it: never a field's own value. */
function visibleText(element: Element): string {
  if (isField(element)) return "";
  const text = (element as HTMLElement).innerText ?? element.textContent;
  return squash(typeof text === "string" ? text : element.textContent);
}

function labelText(element: Element): string {
  const labels = (element as HTMLInputElement).labels;
  if (labels && labels.length > 0)
    return squash([...labels].map((label) => label.textContent).join(" "));
  const wrapping = element.closest("label");
  return wrapping ? squash(wrapping.textContent) : "";
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
      role === null || NAMED_BY_CONTENT.has(role) ? visibleText(element) : "";
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

function anchorOf(element: Element): string | null {
  for (const attribute of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) return `[${attribute}=${quote(value)}]`;
  }
  const id = element.getAttribute("id");
  if (id && !isGeneratedId(id)) return `#${cssIdent(id)}`;
  return null;
}

/** A short CSS path from the nearest ancestor with a stable handle (or the document), tag and position only: class
 * names are left out, as so many are build hashes. */
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

/** The selectors an agent can try, steadiest first: a test attribute, a hand-made id, the name attribute, role and name,
 * the text on it, and a short CSS path. None holds the field's value. */
export function selectorsOf(
  element: Element,
  role: string | null,
  name: string,
  echoes: (text: string) => boolean,
): Selector[] {
  const out: Selector[] = [];
  const tag = element.localName;
  for (const attribute of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value && !echoes(value))
      out.push({ by: "testid", selector: `[${attribute}=${quote(value)}]` });
  }
  const id = element.getAttribute("id");
  if (id && !isGeneratedId(id) && !echoes(id))
    out.push({ by: "id", selector: `#${cssIdent(id)}` });
  const nameAttribute = element.getAttribute("name");
  if (nameAttribute && !echoes(nameAttribute))
    out.push({ by: "name", selector: `${tag}[name=${quote(nameAttribute)}]` });
  if (role && name && !echoes(name))
    out.push({ by: "role", selector: `role=${role}[name=${quote(name)}]` });
  const text = role && CLICKED_BY_TEXT.has(role) ? visibleText(element) : "";
  if (text && text.length <= MAX_TEXT_SELECTOR && !echoes(text))
    out.push({ by: "text", selector: `text=${quote(text)}` });
  out.push({ by: "css", selector: cssPath(element) });
  return out;
}

/** The iframes from the top page down to this frame, each by its best selector where the parent can be read (a
 * cross-site parent cannot: `iframe` stands in), and this frame's address. */
function framePath(): { url: string; path: string[] } | undefined {
  if (window === window.top) return undefined;
  const path: string[] = [];
  let current: Window = window;
  for (let depth = 0; current !== current.top && depth < 10; depth++) {
    let selector = "iframe";
    try {
      const element = current.frameElement;
      if (element)
        selector =
          selectorsOf(element, null, "", () => false)[0]?.selector ?? "iframe";
    } catch {
      // A cross-site parent: its iframe element is not ours to read.
    }
    path.unshift(selector);
    current = current.parent;
  }
  return { url: location.href, path };
}

/** Everything an agent needs to find `element` again. `value` is the field's current value, so nothing derived here
 * repeats it. */
export function targetingOf(element: Element, value?: string): StepTargeting {
  const live = value?.trim() ?? "";
  const echoes = (text: string) => live.length >= 3 && text.includes(live);
  const role = roleOf(element);
  const named = nameOf(element);
  const name = echoes(named) ? "" : named;
  const rect = element.getBoundingClientRect();
  const frame = framePath();
  return {
    role,
    name,
    ...(inputTypeOf(element) ? { inputType: inputTypeOf(element) } : {}),
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

/** The step a collector event is: a click, an edit as typed (`input`), a finished edit (`change`), a choice in a list
 * (`select`) or a box ticked (`check`). */
export function stepKindOf(
  name: string,
  eventType: unknown,
  element: Element | null,
): string {
  if (name !== "input") return name;
  if (eventType === "input") return "input";
  if (element instanceof HTMLSelectElement) return "select";
  if (
    element instanceof HTMLInputElement &&
    (element.type === "checkbox" || element.type === "radio")
  )
    return "check";
  return "change";
}

const eventElement = (event: Event): Element | null => {
  const [first] = event.composedPath();
  return first instanceof Element ? first : null;
};
const isRootOrDetached = (element: Element) =>
  element.localName === "body" ||
  element.localName === "html" ||
  !element.isConnected;

/** Which element the collector's click or edit event is about, seen by listeners installed before the collector's (on
 * the same window, in the capture phase, so they run first for every event and the collector's beforeSend reads them). */
export function createElementTracker() {
  let pressed: Element | null = null;
  let current: { type: string; element: Element } | null = null;
  const onPointerDown = (event: Event) => {
    const element = eventElement(event);
    pressed = element ? (element.closest(INTERACTIVE) ?? element) : null;
  };
  const onClick = (event: Event) => {
    const element = eventElement(event);
    if (!element) {
      current = null;
      return;
    }
    // The collector describes a click a re-render moved to <body> or off a detached node by its pointerdown target.
    const chosen =
      isRootOrDetached(element) && pressed
        ? pressed
        : (element.closest(INTERACTIVE) ?? element);
    pressed = null;
    current = { type: "click", element: chosen };
  };
  const onEdit = (event: Event) => {
    const element = eventElement(event);
    current = element ? { type: event.type, element } : null;
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
  const step = stepKindOf(event.name, record.eventType, element);
  if (!element) return { ...event, value: { ...record, step } };
  const target =
    typeof record.target === "object" && record.target !== null
      ? (record.target as Record<string, unknown>)
      : {};
  const live = typeof target.value === "string" ? target.value : undefined;
  const { role, name, inputType, ...rest } = targetingOf(element, live);
  return {
    ...event,
    value: {
      ...record,
      step,
      target: { ...target, role, name, ...(inputType ? { inputType } : {}) },
      ...rest,
    },
  };
}
