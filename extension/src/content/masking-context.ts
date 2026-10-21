import { describeDemonstrationTarget } from "@openbot/shared/demonstration-rules";
import {
  holdsValue,
  isSensitiveTarget,
  MIN_DIGEST_LENGTH,
  normaliseSecret,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";

const FIELD = "input, textarea, select, [contenteditable]";

export type SensitivityTracker = {
  /** Capture-phase pointerdown, focusin, click, input and change on window; install it BEFORE the collector so a digest
   * exists, and a click's field is known, before the collector's own listener builds the event it masks. */
  install(): () => void;
  /** input and change are judged by the field the event came from (else the focused field), a click by the field it
   * landed on: the field a label forwards its click to, never an earlier pointer target. */
  sensitiveForEvent(name: string): boolean;
  /** Values of at least MIN_DIGEST_LENGTH characters typed or filled into sensitive fields (a password manager's untrusted
   * input events count too), and the code a row of one-character boxes holds together, normalised then hashed, once per
   * value. */
  onSensitiveValue(listener: (digest: string) => void): void;
  /** This frame's own digests, for masking this frame's events. */
  digests(): ReadonlySet<string>;
};

const fieldOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target.closest(FIELD) : null;

// The collector describes a click that a re-render moved to <body> or <html>, or off a detached node, by its pointerdown
// target (`clicks.ts` `installClickCapture` > `onClick`), so such a click keeps the pointerdown field.
const describedByPointerdown = (target: EventTarget | null): boolean =>
  !(target instanceof Element) ||
  target.localName === "body" ||
  target.localName === "html" ||
  !target.isConnected;

/** The longest label text read for a field: an aria-labelledby can point at a whole region. */
const LABEL_TEXT_LIMIT = 1000;

/** The text of the field's own labels and of what its aria-labelledby names: a label that is not a <label for> (a span
 * named by aria-labelledby) still names the field. */
const labelText = (field: Element): string => {
  const parts: string[] = [];
  if (
    field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement ||
    field instanceof HTMLSelectElement
  )
    for (const label of Array.from(field.labels ?? []))
      parts.push(label.textContent ?? "");
  const root = field.getRootNode() as Partial<NonElementParentNode>;
  for (const id of (field.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .filter(Boolean)) {
    const named = root.getElementById?.(id) ?? document.getElementById(id);
    if (named) parts.push(named.textContent ?? "");
  }
  return parts.join(" ").slice(0, LABEL_TEXT_LIMIT);
};

/** The field as the collector describes it (its tag and every attribute), with its label text and what it holds: what
 * isSensitiveTarget reads. */
const describeField = (field: Element) => ({
  tag: field.localName,
  attributes: Object.fromEntries(
    Array.from(field.attributes, ({ name, value }) => [name, value]),
  ),
  label: labelText(field),
  value: fieldValue(field),
});

/** A one-time code typed a character per box: a row of 4 to 8 boxes, each one character long. */
const CODE_BOXES_MIN = 4;
const CODE_BOXES_MAX = 8;
/** How far above a box its row is looked for: each box can sit in its own wrapper, inside a row, inside a form. */
const CODE_BOX_DEPTH = 3;
/** Inputs a code box can be: text-like, never a checkbox or a button. */
const BOX_TYPES: ReadonlySet<string> = new Set([
  "",
  "text",
  "tel",
  "number",
  "password",
]);

const isBoxType = (element: Element): element is HTMLInputElement =>
  element instanceof HTMLInputElement &&
  BOX_TYPES.has((element.getAttribute("type") ?? "").toLowerCase());
/** A box that takes one character: maxlength=1. */
const isOneCharBox = (element: Element): element is HTMLInputElement =>
  isBoxType(element) && element.maxLength === 1;
/** A box of that shape without maxlength=1: numeric (inputmode numeric, type tel or a digits pattern) and no longer than one
 * character, which counts only beside its siblings in one parent. */
const isNumericBox = (element: Element): element is HTMLInputElement =>
  isBoxType(element) &&
  element.maxLength <= 1 &&
  (element.getAttribute("inputmode")?.toLowerCase() === "numeric" ||
    element.getAttribute("type")?.toLowerCase() === "tel" ||
    /^\^?(?:\\d|\[0-9)/.test(element.getAttribute("pattern") ?? ""));
/** Each box among `elements`, in document order. */
const boxesAmong = (
  elements: Iterable<Element>,
  isBox: (element: Element) => element is HTMLInputElement,
): HTMLInputElement[] => Array.from(elements).filter(isBox);

const inRow = (
  field: HTMLInputElement,
  boxes: HTMLInputElement[],
): HTMLInputElement[] | null =>
  boxes.length >= CODE_BOXES_MIN &&
  boxes.length <= CODE_BOXES_MAX &&
  boxes.includes(field)
    ? boxes
    : null;

/** The row of code boxes `field` is one of, in document order (the order the code is typed), or null: the nearest parent,
 * wrapper or form holding 4 to 8 one-character boxes, or 4 to 8 numeric boxes side by side in one parent. Found with no label,
 * since a row of boxes usually has none. */
const codeBoxes = (field: Element): HTMLInputElement[] | null => {
  if (!isBoxType(field)) return null;
  if (field.maxLength === 1) {
    let container: ParentNode | null = field.parentNode;
    for (let depth = 0; container && depth <= CODE_BOX_DEPTH; depth++) {
      const boxes = boxesAmong(
        container.querySelectorAll("input"),
        isOneCharBox,
      );
      if (boxes.length >= CODE_BOXES_MIN) return inRow(field, boxes);
      if (
        container instanceof HTMLFormElement ||
        !(container instanceof Element)
      )
        break;
      container = container.parentNode;
    }
    return field.form
      ? inRow(field, boxesAmong(field.form.elements, isOneCharBox))
      : null;
  }
  const parent = field.parentNode;
  return parent && isNumericBox(field)
    ? inRow(field, boxesAmong(parent.children, isNumericBox))
    : null;
};

/** The code a row of boxes holds together, in order. */
const rowValue = (boxes: HTMLInputElement[]): string =>
  boxes.map((box) => box.value.trim()).join("");

const fieldValue = (field: Element): string =>
  field instanceof HTMLInputElement ||
  field instanceof HTMLTextAreaElement ||
  field instanceof HTMLSelectElement
    ? field.value
    : (field.textContent ?? "");

export function createSensitivityTracker(options?: {
  isTrusted?: (event: Event) => boolean;
}): SensitivityTracker {
  const isTrusted = options?.isTrusted ?? ((event: Event) => event.isTrusted);
  const cache = new WeakMap<Element, boolean>();
  const digests = new Set<string>();
  const listeners: Array<(digest: string) => void> = [];
  let pointerField: Element | null = null;
  let valueField: Element | null = null;

  const classify = (field: Element): boolean => {
    const described = describeField(field);
    // Only a field that holds what the person enters can hold a secret: a checkbox or a button input that says "Show
    // password" only names one.
    const sensitive =
      holdsValue(described) &&
      ((field instanceof HTMLInputElement && field.type === "password") ||
        describeDemonstrationTarget({ point: null, element: field })
          .sensitive ||
        // The masking's own rule, with the label text: a one-time code field without autocomplete=one-time-code, by its
        // id, placeholder, aria-labelledby text, test id or shape, or by a label that says the code was texted or sent to
        // the person and the digits typed into it, so its value is hashed and masked wherever it reappears. Judged again
        // on every edit, as the value changes; once sensitive, always sensitive.
        isSensitiveTarget(described, { url: location.href }) ||
        // One box of a code typed a character per box, with no label: every box's value is masked.
        codeBoxes(field) !== null);
    // A field that was ever sensitive (a show-password toggle flips its type) stays sensitive.
    const known = cache.get(field) === true || sensitive;
    cache.set(field, known);
    return known;
  };
  const cached = (field: Element | null): boolean =>
    field === null ? false : (cache.get(field) ?? classify(field));

  const onPointer = (event: Event) => {
    if (!isTrusted(event)) return;
    pointerField = fieldOf(event.composedPath()[0] ?? null);
    if (pointerField) classify(pointerField);
  };
  const onClick = (event: Event) => {
    if (!isTrusted(event)) return;
    // A click on a label reaches its field as a second click, after a pointerdown on the label itself.
    const target = event.composedPath()[0] ?? null;
    if (describedByPointerdown(target)) return;
    pointerField = fieldOf(target);
    if (pointerField) classify(pointerField);
  };
  const onFocus = (event: Event) => {
    if (!isTrusted(event)) return;
    const field = fieldOf(event.composedPath()[0] ?? null);
    if (field) classify(field);
  };
  const report = (value: string) => {
    const normalised = normaliseSecret(value);
    if (normalised.length < MIN_DIGEST_LENGTH) return;
    const digest = sha256HexSync(normalised);
    if (digests.has(digest)) return;
    digests.add(digest);
    for (const listener of listeners) listener(digest);
  };
  /** The code a row of boxes makes together is hashed, since no single box holds it. */
  const reportRow = (field: Element | null) => {
    const boxes = field ? codeBoxes(field) : null;
    if (boxes) report(rowValue(boxes));
  };
  const onValue = (event: Event) => {
    // A field inside a shadow root: document.activeElement is its host, composedPath()[0] the field itself.
    const own = fieldOf(event.composedPath()[0] ?? null);
    // A password manager fills a field with untrusted events: what it put there is hashed too, but the field the collector
    // judges its next event by moves only on a trusted one, the only kind the collector records.
    if (isTrusted(event)) valueField = own;
    const field = own ?? fieldOf(document.activeElement);
    if (!field || !classify(field)) return;
    report(fieldValue(field));
    reportRow(field);
  };
  // A row of boxes is often filled without an input event per box: a paste the page spreads across them itself, or digits
  // moved along by script. The row is hashed again once the page has handled a paste, and when a box loses focus.
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const onPaste = (event: Event) => {
    const field = fieldOf(event.composedPath()[0] ?? null);
    if (!field || codeBoxes(field) === null) return;
    const timer = setTimeout(() => {
      pending.delete(timer);
      reportRow(field);
    }, 0);
    pending.add(timer);
  };
  const onBlur = (event: Event) =>
    reportRow(fieldOf(event.composedPath()[0] ?? null));

  return {
    install() {
      const capture = { capture: true, passive: true } as const;
      window.addEventListener("pointerdown", onPointer, capture);
      window.addEventListener("focusin", onFocus, capture);
      window.addEventListener("click", onClick, capture);
      window.addEventListener("input", onValue, capture);
      window.addEventListener("change", onValue, capture);
      window.addEventListener("paste", onPaste, capture);
      window.addEventListener("focusout", onBlur, capture);
      return () => {
        window.removeEventListener("pointerdown", onPointer, capture);
        window.removeEventListener("focusin", onFocus, capture);
        window.removeEventListener("click", onClick, capture);
        window.removeEventListener("input", onValue, capture);
        window.removeEventListener("change", onValue, capture);
        window.removeEventListener("paste", onPaste, capture);
        window.removeEventListener("focusout", onBlur, capture);
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
      };
    },
    sensitiveForEvent(name) {
      if (name === "input" || name === "change")
        return cached(valueField ?? fieldOf(document.activeElement));
      if (name === "click") return cached(pointerField);
      return false;
    },
    onSensitiveValue(listener) {
      listeners.push(listener);
    },
    digests: () => digests,
  };
}
