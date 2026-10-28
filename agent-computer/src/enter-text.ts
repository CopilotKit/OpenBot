import type { Locator } from "playwright";

/** What every Playwright call here is given: the action timeout, and Stop when there is one. */
type Acting = { timeout: number; signal?: AbortSignal };

/**
 * The text a Bot sent cannot go in this field: a list with no option by that name.
 *
 * The caller's to fix, like a stale ref, so the route answers 400 rather than 502. The message names
 * neither the text (a typed value is never echoed) nor the options (they are page content, and page
 * content reaches the model only inside the untrusted envelope a snapshot puts it in).
 */
export class FieldValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldValueError";
  }
}

/**
 * Put `text` in a field the way a person would.
 *
 * A text box is filled: `fill` clears it first, which is what "put this value in this box" means.
 * A native `<select>` takes no typing at all, and `fill` waits on one until it times out, which the
 * server then reported as a ref that had gone stale. A person picks the option by what it says, so
 * this does too: the option whose label is the text, ignoring case and surrounding spaces, and
 * failing that the option whose value is. Picking it fires the same input and change events a
 * person's choice does, so the page reacts as it would to them.
 */
export async function enterText(
  field: Locator,
  text: string,
  acting: Acting,
): Promise<void> {
  const options = await field.evaluate(
    (element) =>
      element instanceof HTMLSelectElement
        ? Array.from(element.options, (option) => ({
            label: option.label,
            value: option.value,
            disabled: option.disabled,
          }))
        : null,
    undefined,
    { timeout: acting.timeout },
  );
  if (!options) {
    await field.fill(text, acting);
    return;
  }
  const wanted = text.trim().toLowerCase();
  const choosable = options.filter((option) => !option.disabled);
  const chosen =
    choosable.find((option) => option.label.trim().toLowerCase() === wanted) ??
    choosable.find((option) => option.value.trim().toLowerCase() === wanted);
  if (!chosen) {
    throw new FieldValueError(
      "That field is a list, and none of its options matches that text. Take a snapshot to see its options and send one of them exactly.",
    );
  }
  await field.selectOption({ value: chosen.value }, acting);
}
