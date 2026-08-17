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
};

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

/** Build an element from a descriptor and whatever YAML gave as its value, or null if not actionable. */
function toElement(
  descriptor: Descriptor,
  value: unknown,
): SnapshotElement | null {
  if (!INTERACTIVE_ROLES.has(descriptor.role)) return null;

  const ref = descriptor.flags.get("ref");
  // No ref means nothing can be done to it, so it is noise in a list whose entire purpose is acting.
  if (!ref) return null;

  const element: SnapshotElement = {
    ref,
    role: descriptor.role,
    name: descriptor.name.slice(0, 200),
  };

  // Values arrive as text, with quoting and escapes already resolved.
  if (typeof value === "string") {
    const text = value.trim();
    if (text) element.value = text.slice(0, 200);
  }

  if (descriptor.flags.has("disabled")) element.disabled = true;

  // Playwright emits `[checked]` only when something is checked, so absence is ambiguous on its own: a
  // Bot cannot tell an unticked box from a control that does not tick. Reported as false for the roles
  // that can be checked, and left off entirely for the ones that cannot.
  if (descriptor.flags.has("checked")) {
    element.checked = descriptor.flags.get("checked") !== "false";
  } else if (CHECKABLE_ROLES.has(descriptor.role)) {
    element.checked = false;
  }

  return element;
}

/** Turn an aria snapshot into the flat element list the tool contract publishes. */
export function parseAriaSnapshot(yaml: string): {
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

  /** Depth first: the tree nests by containment, and a flat list is what a Bot acts on. */
  const walk = (node: unknown): void => {
    if (truncated) return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }

    if (typeof node === "string") {
      // An entry with no value: `- button "Submit order" [ref=e44]`.
      const descriptor = parseDescriptor(node);
      const element = descriptor ? toElement(descriptor, undefined) : null;
      if (element) push(element);
      return;
    }

    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        const descriptor = parseDescriptor(key);
        const element = descriptor ? toElement(descriptor, value) : null;
        if (element) push(element);
        // Descend regardless of whether this entry was actionable: a `group "Pizza Size"` is not, and
        // its radios are.
        if (value && typeof value === "object") walk(value);
      }
    }
  };

  walk(tree);
  return { elements, truncated };
}
