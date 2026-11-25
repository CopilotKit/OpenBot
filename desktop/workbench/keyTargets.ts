/*
 * Which element the focus is on, for the page's keys (Workbench.tsx). A key the
 * focused control uses itself does not also do the page's thing.
 */

/*
 * The app's Base UI controls that take the keys typed into them, though they are not native text
 * fields: a Select's trigger and its open list (they pick an option by its first letters), a
 * Combobox and a popup (the Comment box), which stands over the page.
 */
const OWN_KEYS = [
  '[data-slot="select-trigger"]',
  '[data-slot="combobox-input"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[data-slot="popover-content"]',
].join(", ");

/**
 * True for a field that takes typed text, where the C key must type a letter, and for an app
 * control or popup that takes the typed keys itself. The page's keys do nothing there.
 */
export function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  if (el.closest(OWN_KEYS)) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  return ![
    "button",
    "checkbox",
    "radio",
    "color",
    "submit",
    "reset",
    "image",
    "file",
  ].includes(type);
}
