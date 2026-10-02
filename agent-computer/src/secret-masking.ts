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
 * Only a type import of Playwright, so the pure parts have tests that need no browser.
 */

import type { Page } from "playwright";
import type { SnapshotElement } from "./aria-snapshot";

/** The attribute a field gets once a secret has been typed into it. */
export const SECRET_ATTRIBUTE = "data-openbot-secret";

/** What a sensitive value is replaced with. Says a value is there without saying what it is. */
export const MASKED_VALUE = "[hidden: sensitive field]";

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

/** The roles whose `value` in a snapshot is text somebody typed. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** Whether an element's value is worth asking the page about at all. */
export function mayHoldTypedValue(element: SnapshotElement): boolean {
  return VALUE_ROLES.has(element.role) && element.value !== undefined;
}

/** The snapshot's elements with every sensitive value replaced. Pure, so it can be tested alone. */
export function maskSensitiveValues(
  elements: SnapshotElement[],
  sensitiveRefs: ReadonlySet<string>,
): SnapshotElement[] {
  return elements.map((element) =>
    sensitiveRefs.has(element.ref) && element.value !== undefined
      ? { ...element, value: MASKED_VALUE }
      : element,
  );
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
 * Which of a snapshot's filled fields hold a secret, asked of the page itself.
 *
 * Only fields that carry a value are asked about, and each question is answered from the element the
 * ref resolves to right now. A field that cannot be asked is treated as sensitive: hiding an ordinary
 * value is a small cost, and showing a password is not.
 */
export async function sensitiveRefs(
  target: Page,
  elements: SnapshotElement[],
): Promise<Set<string>> {
  const sensitive = new Set<string>();
  await Promise.all(
    elements.filter(mayHoldTypedValue).map(async (element) => {
      const matches = await target
        .locator(`aria-ref=${element.ref}`)
        .evaluate(isSensitiveElement, SENSITIVE_FIELD_SELECTOR, {
          timeout: 1_000,
        })
        .catch(() => true);
      if (matches) sensitive.add(element.ref);
    }),
  );
  return sensitive;
}
