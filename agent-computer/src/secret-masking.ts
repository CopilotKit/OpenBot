/**
 * Keeping secrets typed into the page out of everything that reads the page back.
 *
 * A password field shows dots, and it is tempting to stop there. The snapshot does not: Playwright's
 * aria snapshot reports a textbox's current value, and for `<input type=password>` that is the
 * password in plain text (checked against Playwright 1.62: `textbox [ref=e4]: hunter2`). So a person
 * who typed their password through the private form, or through a secret request, would hand it to
 * the model on the Bot's very next snapshot. The same goes for a token or a one-time code typed into
 * an ordinary text field, which shows no dots at all on the live screen or in a screenshot.
 *
 * Three places, one rule:
 *  - the snapshot replaces the value of any sensitive field with a placeholder;
 *  - a screenshot masks sensitive fields (Playwright's documented `mask` option);
 *  - a field a secret was typed into is marked, and drawn with `-webkit-text-security: disc`, so the
 *    live screencast shows dots for it even when it is not a password field.
 *
 * WHAT A PERSON TYPED WHILE THEY HELD THE WHEEL is kept from the Bot the same way. A person takes over
 * a Bot's browser so they can do a step themselves, often because it is something the Bot must not be
 * told (a telephone number, an account number, an answer to a security question), and the Bot's next
 * snapshot used to read it straight back (`textbox "Telephone": 555-0100`). So every field a person
 * types into, or chooses in, during a takeover is marked as theirs (`markPersonFilled`), and from then
 * on the Bot reads that it was filled, never what with: the snapshot says `[hidden: filled in by the
 * person]`, the page's text says the same in place of an editor's words, and a screenshot masks it.
 * Unlike a secret it is not dotted on the live screen: the person is looking at what they typed. The
 * mark goes when the Bot types into the field itself, because the value is then the Bot's own.
 *
 * Only a type import of Playwright, so the pure parts have tests that need no browser.
 */

import type { ElementHandle, Frame, Page } from "playwright";
import type { SnapshotElement } from "./aria-snapshot";
import type { InputMessage } from "./screencast";

/** The attribute a field gets once a secret has been typed into it. */
export const SECRET_ATTRIBUTE = "data-openbot-secret";

/** What a sensitive value is replaced with. Says a value is there without saying what it is. */
export const MASKED_VALUE = "[hidden: sensitive field]";

/** The attribute a field gets once a person typed into it, or chose in it, while they held the wheel. */
export const PERSON_FILLED_ATTRIBUTE = "data-openbot-person-filled";

/** What a value a person filled in during a takeover is replaced with: filled, and not what with. */
export const PERSON_FILLED_VALUE = "[hidden: filled in by the person]";

/** Every field whose contents are never read back: passwords, one-time codes, and marked fields. */
export const SENSITIVE_FIELD_SELECTOR = [
  "input[type=password]",
  'input[autocomplete~="one-time-code"]',
  'input[autocomplete~="current-password"]',
  'input[autocomplete~="new-password"]',
  'input[autocomplete~="cc-number"]',
  'input[autocomplete~="cc-csc"]',
  `[${SECRET_ATTRIBUTE}]`,
].join(", ");

/** Every field a screenshot the Bot is given masks: the sensitive ones, and those a person filled. */
export const HIDDEN_FIELD_SELECTOR = `${SENSITIVE_FIELD_SELECTOR}, [${PERSON_FILLED_ATTRIBUTE}]`;

/** The roles whose `value` in a snapshot is text somebody typed. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** Whether an element's value is worth asking the page about at all. */
export function mayHoldTypedValue(element: SnapshotElement): boolean {
  return VALUE_ROLES.has(element.role) && element.value !== undefined;
}

/**
 * The snapshot's elements with every hidden value replaced: a set of refs is shown as sensitive, a map
 * of refs as what it names for each. Pure, so it can be tested alone.
 */
export function maskSensitiveValues(
  elements: SnapshotElement[],
  hidden: ReadonlySet<string> | ReadonlyMap<string, string>,
): SnapshotElement[] {
  const shownAs = (ref: string): string | undefined =>
    hidden instanceof Map
      ? hidden.get(ref)
      : hidden.has(ref)
        ? MASKED_VALUE
        : undefined;
  return elements.map((element) => {
    const instead =
      element.value === undefined ? undefined : shownAs(element.ref);
    return instead === undefined ? element : { ...element, value: instead };
  });
}

/**
 * The page-side check, passed to `locator.evaluate`. Written as a plain function over the element so
 * it serialises; it must not close over anything in this module.
 */
export function isSensitiveElement(
  element: Element,
  selector: string,
): boolean {
  return element.matches(selector);
}

/** The page-side question for one field: hidden as sensitive, as filled in by a person, or not at all. */
export function hiddenAs(
  element: Element,
  selectors: { sensitive: string; filled: string },
): "sensitive" | "filled" | null {
  if (element.matches(selectors.sensitive)) return "sensitive";
  return element.matches(selectors.filled) ? "filled" : null;
}

/** The page-side mark, passed to `locator.evaluate` after a secret lands in a field. */
export function markElementSecret(element: Element, attribute: string): void {
  element.setAttribute(attribute, "true");
  (element as HTMLElement).style?.setProperty(
    "-webkit-text-security",
    "disc",
    "important",
  );
}

/**
 * Which of a snapshot's filled fields the Bot must not read, asked of the page itself, and what each is
 * shown as instead: a secret as sensitive, a field a person filled during a takeover as theirs.
 *
 * Only fields that carry a value are asked about, and each question is answered from the element the
 * ref resolves to right now. A field that cannot be asked is treated as sensitive: hiding an ordinary
 * value is a small cost, and showing a password is not.
 */
export async function hiddenValues(
  target: Page,
  elements: SnapshotElement[],
): Promise<Map<string, string>> {
  const hidden = new Map<string, string>();
  await Promise.all(
    elements.filter(mayHoldTypedValue).map(async (element) => {
      const kind = await target
        .locator(`aria-ref=${element.ref}`)
        .evaluate(
          hiddenAs,
          {
            sensitive: SENSITIVE_FIELD_SELECTOR,
            filled: `[${PERSON_FILLED_ATTRIBUTE}]`,
          },
          { timeout: 1_000 },
        )
        .catch(() => "sensitive" as const);
      if (kind === "sensitive") hidden.set(element.ref, MASKED_VALUE);
      else if (kind === "filled") hidden.set(element.ref, PERSON_FILLED_VALUE);
    }),
  );
  return hidden;
}

/** Which of a snapshot's filled fields hold a secret (see `hiddenValues`). */
export async function sensitiveRefs(
  target: Page,
  elements: SnapshotElement[],
): Promise<Set<string>> {
  const hidden = await hiddenValues(target, elements);
  return new Set(
    [...hidden].flatMap(([ref, instead]) =>
      instead === MASKED_VALUE ? [ref] : [],
    ),
  );
}

/**
 * The page-side mark for the field a person has in focus, passed to `evaluate`: a text field or an
 * editor they typed into (`typed`), or a dropdown, whose choice moves with a click or an arrow key as
 * much as with typing. Answers whether it marked one. Self-contained, so it serialises.
 */
export function markIfFilled(
  element: Element,
  input: { attribute: string; typed: boolean },
): boolean {
  const notText = [
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ];
  const html = element as HTMLElement;
  const text =
    (element instanceof HTMLInputElement && !notText.includes(element.type)) ||
    element instanceof HTMLTextAreaElement ||
    html.isContentEditable === true;
  const choice = element instanceof HTMLSelectElement;
  if (!choice && !(text && input.typed)) return false;
  element.setAttribute(input.attribute, "true");
  return true;
}

/** Keys that move a dropdown's choice without typing: the arrows, and the jumps to either end. */
const CHOOSING_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageDown",
  "PageUp",
]);

/**
 * Whether a key could fill the field in focus: `typed` for a character (a paste is a character with
 * a modifier), a deletion, or text; `chose` for a key that moves a dropdown's choice; nothing for the
 * rest (Tab, Enter, Escape), which move the focus or submit and fill nothing.
 */
export function keyFills(key: string, text?: string): "typed" | "chose" | null {
  // `Control+V`, as a press of the person's input route names a shortcut: what counts is the last key.
  const last =
    key.length > 1 && key.includes("+") ? (key.split("+").at(-1) ?? key) : key;
  if (
    last.length === 1 ||
    last === "Backspace" ||
    last === "Delete" ||
    (text !== undefined && text !== "" && last !== "Enter")
  )
    return "typed";
  return CHOOSING_KEYS.has(last) ? "chose" : null;
}

/**
 * Whether one input from the live screen could fill the field in focus (see `keyFills`). A click can
 * only choose: in a dropdown, or a suggestion a field offers, which follows what was typed into it.
 */
export function inputFills(message: InputMessage): "typed" | "chose" | null {
  if (message.type === "text") return "typed";
  if (message.type === "key")
    return message.event === "down"
      ? keyFills(message.key, message.text)
      : null;
  if (message.type === "mouse" && message.event === "released") return "chose";
  return null;
}

/** The element with the focus in a frame: inside open shadow roots, and the frame element itself when a frame inside it has it. */
async function focusedIn(frame: Frame): Promise<ElementHandle | null> {
  const handle = await frame.evaluateHandle(() => {
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement)
      focused = focused.shadowRoot.activeElement;
    return focused;
  });
  return handle.asElement();
}

/**
 * Mark the field a person has in focus as filled by them, after their input lands: one keystroke,
 * a paste, a choice. `typed` when the input could have changed text (a character, a deletion, a
 * paste), not when it moved the caret or the focus. Followed into frames, where the focus is in one.
 * Answers whether a field was marked.
 */
export async function markPersonFilled(
  page: Page,
  typed: boolean,
): Promise<boolean> {
  let frame = page.mainFrame();
  // A frame inside a frame inside a frame is as deep as a form gets.
  for (let depth = 0; depth < 4; depth += 1) {
    const focused = await focusedIn(frame);
    if (!focused) return false;
    const inner = await focused.contentFrame();
    if (!inner)
      return focused.evaluate(markIfFilled, {
        attribute: PERSON_FILLED_ATTRIBUTE,
        typed,
      });
    frame = inner;
  }
  return false;
}

/** Take a person's mark off a field the Bot has just typed into: the value there is the Bot's own now. */
export function unmarkPersonFilled(element: Element, attribute: string): void {
  element.removeAttribute(attribute);
}
