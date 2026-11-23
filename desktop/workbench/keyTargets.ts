/*
 * Which element the focus is on, for the page's keys (Workbench.tsx, KeysHelp.tsx). A key the
 * focused control uses itself does not also do the page's thing.
 */

/** True for a field that takes typed text, where the C key must type a letter. */
export function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  return ![
    "button",
    "checkbox",
    "radio",
    "range",
    "color",
    "submit",
    "reset",
    "image",
    "file",
  ].includes(type);
}

/** The roles of the app's Base UI controls that move with the arrow keys themselves. */
const ARROW_ROLES = [
  "separator",
  "slider",
  "combobox",
  "listbox",
  "option",
  "menu",
  "menuitem",
  "tab",
];

/** The roles of the app's Base UI controls that Space and Enter press. */
const PRESS_ROLES = [
  "separator",
  "checkbox",
  "switch",
  "combobox",
  "option",
  "menuitem",
  "tab",
  "button",
];

/**
 * True for a control that uses the arrow keys itself: a slider, a splitter, a Select and its list,
 * a menu or tabs.
 */
export function usesArrows(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.nodeType !== 1) return false;
  if (ARROW_ROLES.includes(el.getAttribute("role") ?? "")) return true;
  return (
    el.tagName.toLowerCase() === "input" &&
    (el.getAttribute("type") ?? "").toLowerCase() === "range"
  );
}

/** True for a control that Space and Enter press: a button, a link, a checkbox, a summary, an option. */
export function pressable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === "button" ||
    tag === "summary" ||
    tag === "a" ||
    tag === "input" ||
    PRESS_ROLES.includes(el.getAttribute("role") ?? "")
  );
}
