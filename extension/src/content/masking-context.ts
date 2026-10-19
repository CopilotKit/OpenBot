import { describeDemonstrationTarget } from "@openbot/shared/demonstration-rules";
import {
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
   * input events count too), normalised then hashed, once per value. */
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

/** The field as the collector describes it (its tag and every attribute), with its label text: what isSensitiveTarget reads. */
const describeField = (field: Element) => ({
  tag: field.localName,
  attributes: Object.fromEntries(
    Array.from(field.attributes, ({ name, value }) => [name, value]),
  ),
  label: labelText(field),
});

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
    const sensitive =
      (field instanceof HTMLInputElement && field.type === "password") ||
      describeDemonstrationTarget({ point: null, element: field }).sensitive ||
      // The masking's own rule, with the label text: a one-time code field without autocomplete=one-time-code, by its id,
      // placeholder, aria-labelledby text, test id or shape, so its value is hashed and masked wherever it reappears.
      isSensitiveTarget(describeField(field), { url: location.href });
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
  const onValue = (event: Event) => {
    // A field inside a shadow root: document.activeElement is its host, composedPath()[0] the field itself.
    const own = fieldOf(event.composedPath()[0] ?? null);
    // A password manager fills a field with untrusted events: what it put there is hashed too, but the field the collector
    // judges its next event by moves only on a trusted one, the only kind the collector records.
    if (isTrusted(event)) valueField = own;
    const field = own ?? fieldOf(document.activeElement);
    if (!field || !classify(field)) return;
    const normalised = normaliseSecret(fieldValue(field));
    if (normalised.length < MIN_DIGEST_LENGTH) return;
    const digest = sha256HexSync(normalised);
    if (digests.has(digest)) return;
    digests.add(digest);
    for (const listener of listeners) listener(digest);
  };

  return {
    install() {
      const capture = { capture: true, passive: true } as const;
      window.addEventListener("pointerdown", onPointer, capture);
      window.addEventListener("focusin", onFocus, capture);
      window.addEventListener("click", onClick, capture);
      window.addEventListener("input", onValue, capture);
      window.addEventListener("change", onValue, capture);
      return () => {
        window.removeEventListener("pointerdown", onPointer, capture);
        window.removeEventListener("focusin", onFocus, capture);
        window.removeEventListener("click", onClick, capture);
        window.removeEventListener("input", onValue, capture);
        window.removeEventListener("change", onValue, capture);
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
