/**
 * Turning Playwright's aria snapshot into the flat element list the tool contract publishes.
 *
 * Playwright's `mode: "ai"` output is YAML: each entry is a mapping whose key describes the element
 * and whose value is that control's contents. A YAML parser preserves quoted values, colons, escaped
 * quotes, multi-line values and deeper indentation.
 *
 * Parsed under the failsafe schema, which resolves every scalar as a string. What a control contains
 * is text, and nothing here wants it typed.
 *
 * What remains to parse by hand is one descriptor per element,
 * `textbox "Customer name:" [ref=e5] [checked]`, and that is scanned rather than matched, because the
 * parts can contain one another: an accessible name can hold a bracket and a flag can hold a quote.
 *
 * This module has no Playwright import, so parser tests do not need a browser.
 */

import { parse as parseYaml } from "yaml";

/** How many elements a snapshot will describe. Bounded for the same reason the text extract is. */
const SNAPSHOT_ELEMENT_LIMIT = 200;

/**
 * The roles worth handing to a Bot that wants to act.
 *
 * Role allow-list, not a CSS selector list. `mode: "ai"` returns the whole accessible tree, which on
 * a real page is mostly headings, paragraphs and generic containers. What a Bot needs in order to fill
 * in a form is the controls, and naming them by ARIA role is both shorter and more correct than
 * guessing at tag names: a `div[role=button]` is a button here, and Playwright has already worked out
 * which is which.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

/** The roles whose unchecked state is meaningful, so absence of `[checked]` means false, not unknown. */
const CHECKABLE_ROLES = new Set([
  "checkbox",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "switch",
]);

/**
 * One thing on the page a Bot can act on.
 *
 * Mirrors `SnapshotElement` in the server's published contract (`server/src/computer/schema.ts`), the
 * same way the workspace entry type does. Duplicated rather than shared because this process is a
 * separate deployable with no code in common with the server; the two must be changed together, and a
 * field added here and not there is invisible until a Bot asks for it.
 */
export type SnapshotElement = {
  ref: string;
  role: string;
  name: string;
  /** Present for form controls, so the Bot can tell an empty field from a filled one. */
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  /**
   * A native dropdown's choices, by what each says. Its options carry no refs, so without this a Bot
   * saw `combobox "Industry"` and nothing it could choose; it chooses by sending one of these as text.
   */
  options?: string[];
  /**
   * Where a link goes, as an absolute address: its `href` resolved against the document's base, which
   * is what the browser itself would open. Only for a link on the top page that has one.
   *
   * The server opens this rather than clicking, so following a link is the same action as typing its
   * address, and is judged as one: a read, not a change. See `followableLink` in the server.
   */
  url?: string;
};

/** The longest link address reported. Past this it is left off, and the link is clicked as before. */
const URL_LIMIT = 2048;

/** The most choices one dropdown reports, so a list of every country cannot crowd out the form. */
const OPTION_LIMIT = 50;

/** The descriptor half of an entry: everything before the colon. */
type Descriptor = {
  role: string;
  name: string;
  flags: Map<string, string>;
};

/**
 * Read `textbox "Customer name:" [ref=e5] [checked]`.
 *
 * Scanned left to right rather than matched with a pattern, because the parts can contain each other:
 * an accessible name can contain a bracket, and a flag value can contain a quote. A single expression
 * that handles every page is not maintainable.
 */
export function parseDescriptor(text: string): Descriptor | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // The role runs up to the first space, quote or bracket.
  let index = 0;
  while (
    index < trimmed.length &&
    trimmed[index] !== " " &&
    trimmed[index] !== '"' &&
    trimmed[index] !== "["
  ) {
    index += 1;
  }
  const role = trimmed.slice(0, index);
  if (!role) return null;

  let name = "";
  const flags = new Map<string, string>();

  while (index < trimmed.length) {
    const char = trimmed[index];

    if (char === '"') {
      // The accessible name, consuming escapes so a name containing a quote survives intact.
      index += 1;
      let collected = "";
      while (index < trimmed.length && trimmed[index] !== '"') {
        if (trimmed[index] === "\\" && index + 1 < trimmed.length) {
          collected += trimmed[index + 1];
          index += 2;
          continue;
        }
        collected += trimmed[index];
        index += 1;
      }
      index += 1;
      name = collected;
      continue;
    }

    if (char === "[") {
      index += 1;
      let collected = "";
      while (index < trimmed.length && trimmed[index] !== "]") {
        collected += trimmed[index];
        index += 1;
      }
      index += 1;
      const equals = collected.indexOf("=");
      if (equals === -1) {
        flags.set(collected.trim(), "");
      } else {
        flags.set(
          collected.slice(0, equals).trim(),
          collected.slice(equals + 1).trim(),
        );
      }
      continue;
    }

    index += 1;
  }

  return { role, name, flags };
}

/**
 * The first `limit` UTF-16 code units of `text`, one fewer when the cut would split a character.
 *
 * `slice` counts code units and an emoji is two, so a limit landing between the halves leaves a lone
 * high surrogate last: JSON carries it as a bare `\ud83d` and UTF-8 as U+FFFD, and the Bot reads a
 * broken character that is not on the page. The server's `cutAtCodeUnits` is the same rule; this
 * process shares no code with the server, so it is repeated here rather than imported.
 *
 * Exported for `index.ts`, which cuts the readable page text the same way, and so that the rule has
 * its own tests. It lives here rather than beside that caller because this module imports no
 * Playwright: `index.ts` does, at load, so a helper declared there could not be tested at all.
 */
export function cutAtCodeUnits(text: string, limit: number): string {
  const sliced = text.slice(0, limit);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

/**
 * A link's address, resolved the way the browser resolves it, or undefined.
 *
 * Playwright writes a link's `href` as a `/url:` child, exactly as the page has it, so a relative one
 * needs the document's base (`document.baseURI`, which honours `<base href>`) to say where it goes.
 *
 * The caller passes no base for a link inside an iframe: it resolves against that frame's base, not
 * this one, and clicking it navigates the frame, not the page, so opening its address instead would
 * be a different action. Framed links keep no address and are clicked.
 */
function linkUrlOf(
  value: unknown,
  baseUrl: string | undefined,
): string | undefined {
  if (!baseUrl || !Array.isArray(value)) return undefined;
  for (const child of value) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const raw = (child as Record<string, unknown>)["/url"];
    if (typeof raw !== "string") continue;
    try {
      const resolved = new URL(raw.trim(), baseUrl).href;
      return resolved.length <= URL_LIMIT ? resolved : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Build an element from a descriptor and whatever YAML gave as its value, or null if not actionable. */
function toElement(
  descriptor: Descriptor,
  value: unknown,
  baseUrl?: string,
): SnapshotElement | null {
  if (!INTERACTIVE_ROLES.has(descriptor.role)) return null;

  const ref = descriptor.flags.get("ref");
  // No ref means nothing can be done to it, so it is noise in a list whose entire purpose is acting.
  if (!ref) return null;

  const element: SnapshotElement = {
    ref,
    role: descriptor.role,
    name: cutAtCodeUnits(descriptor.name, 200),
  };

  // Values arrive as text, with quoting and escapes already resolved.
  const typed =
    typeof value === "string" ? value : typedTextOf(descriptor, value);
  if (typed !== undefined) {
    const text = typed.trim();
    if (text) element.value = cutAtCodeUnits(text, 200);
  }

  if (descriptor.flags.has("disabled")) element.disabled = true;

  if (descriptor.role === "link") {
    const url = linkUrlOf(value, baseUrl);
    if (url) element.url = url;
  }

  // A native `<select>`: its value in the YAML is the list of its options, not text. The option marked
  // `[selected]` is what the field shows, which is the value a person reads off it.
  if (descriptor.role === "combobox" || descriptor.role === "listbox") {
    const list = optionsOf(value);
    if (list) {
      element.options = list.options;
      if (list.selected !== undefined && element.value === undefined)
        element.value = list.selected;
    }
  }

  // Playwright emits `[checked]` only when something is checked, so absence is ambiguous on its own: a
  // Bot cannot tell an unticked box from a control that does not tick. Reported as false for the roles
  // that can be checked, and left off entirely for the ones that cannot.
  //
  // `[checked=mixed]` is the third state and the one spelling Playwright gives the flag a value for:
  // `aria-checked="mixed"`, which is what the box above a partly-ticked list carries. It is not
  // ticked, and a Bot told it was left the rows underneath unselected and reported the job done. The
  // contract this fills in is `checked?: boolean`, so "neither" has to be said as false — which is
  // also the answer that gets the right action, since clicking a mixed box ticks it.
  if (descriptor.flags.has("checked")) {
    const state = descriptor.flags.get("checked");
    element.checked = state !== "mixed" && state !== "false";
  } else if (CHECKABLE_ROLES.has(descriptor.role)) {
    element.checked = false;
  }

  return element;
}

/** The roles a person types into, whose value is what was typed. */
const TYPED_ROLES = new Set(["combobox", "searchbox", "spinbutton", "textbox"]);

/**
 * What is typed in a field that also shows a placeholder.
 *
 * Playwright writes a filled field as `textbox "Name": Ada`, but one with a placeholder as a list, the
 * placeholder and the value each a child of their own (`- /placeholder: company.com` then
 * `- text: acme.com`). Read as text alone, every field with a placeholder looked empty however often it
 * was filled, and a Bot checking its work typed the same values in again and again.
 */
function typedTextOf(
  descriptor: Descriptor,
  value: unknown,
): string | undefined {
  if (!TYPED_ROLES.has(descriptor.role) || !Array.isArray(value))
    return undefined;
  for (const child of value) {
    if (!child || typeof child !== "object" || Array.isArray(child)) continue;
    const text = (child as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

/**
 * The options listed under a dropdown, and which one is selected.
 *
 * Only options with no ref of their own: one with a ref is a custom listbox's option, already an
 * element the Bot clicks, and listing it twice would offer two ways to do one thing.
 */
function optionsOf(
  value: unknown,
): { options: string[]; selected?: string } | null {
  if (!Array.isArray(value)) return null;
  const options: string[] = [];
  let selected: string | undefined;
  for (const child of value) {
    const key =
      typeof child === "string"
        ? child
        : child && typeof child === "object"
          ? Object.keys(child)[0]
          : undefined;
    const descriptor = key ? parseDescriptor(key) : null;
    if (descriptor?.role !== "option" || descriptor.flags.has("ref")) continue;
    const name = cutAtCodeUnits(descriptor.name, 200);
    if (descriptor.flags.has("selected") && selected === undefined)
      selected = name;
    if (options.length < OPTION_LIMIT) options.push(name);
  }
  return options.length ? { options, selected } : null;
}

/**
 * Turn an aria snapshot into the flat element list the tool contract publishes.
 *
 * `baseUrl` is the document's base, for resolving where links go. Without it links carry no address.
 */
export function parseAriaSnapshot(
  yaml: string,
  baseUrl?: string,
): {
  elements: SnapshotElement[];
  truncated: boolean;
} {
  const elements: SnapshotElement[] = [];
  let truncated = false;

  const push = (element: SnapshotElement): void => {
    if (elements.length >= SNAPSHOT_ELEMENT_LIMIT) {
      truncated = true;
      return;
    }
    elements.push(element);
  };

  let tree: unknown;
  try {
    tree = parseYaml(yaml, { schema: "failsafe" });
  } catch {
    // A snapshot that will not parse yields no elements rather than throwing. The caller's next move is
    // to take another one, and an exception here would reach the Bot as a broken computer.
    return { elements: [], truncated: false };
  }

  /**
   * Depth first: the tree nests by containment, and a flat list is what a Bot acts on.
   *
   * `base` is what links here resolve against: the page's, until the walk enters an `iframe` entry,
   * and none below one. Told by the tree, not by the ref: Playwright prefixes refs with a frame
   * counter (`f9e182`) that is not zero for every top page, so a prefix does not mean a frame.
   */
  const walk = (node: unknown, base: string | undefined): void => {
    if (truncated) return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, base);
      return;
    }

    if (typeof node === "string") {
      // An entry with no value: `- button "Submit order" [ref=e44]`.
      const descriptor = parseDescriptor(node);
      const element = descriptor
        ? toElement(descriptor, undefined, base)
        : null;
      if (element) push(element);
      return;
    }

    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        const descriptor = parseDescriptor(key);
        const element = descriptor ? toElement(descriptor, value, base) : null;
        if (element) push(element);
        // Descend regardless of whether this entry was actionable: a `group "Pizza Size"` is not, and
        // its radios are.
        if (value && typeof value === "object")
          walk(value, descriptor?.role === "iframe" ? undefined : base);
      }
    }
  };

  walk(tree, baseUrl);
  return { elements, truncated };
}
