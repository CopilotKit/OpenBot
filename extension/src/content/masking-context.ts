import { describeDemonstrationTarget } from "@openbot/shared/demonstration-rules";
import {
  MIN_DIGEST_LENGTH,
  normaliseSecret,
  sha256HexSync,
} from "@openbot/shared/recorder-masking";

const FIELD = "input, textarea, select, [contenteditable]";

export type SensitivityTracker = {
  /** Capture-phase pointerdown, focusin, input and change on window; install it BEFORE the collector so a digest exists
   * before the collector's own listener builds the event it masks. */
  install(): () => void;
  /** input and change are judged by the focused field, a click by the last pointer target. */
  sensitiveForEvent(name: string): boolean;
  /** Values of at least MIN_DIGEST_LENGTH characters typed into sensitive fields, normalised then hashed, once per value. */
  onSensitiveValue(listener: (digest: string) => void): void;
  /** This frame's own digests, for masking this frame's events. */
  digests(): ReadonlySet<string>;
};

const fieldOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target.closest(FIELD) : null;

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

  const classify = (field: Element): boolean => {
    const sensitive =
      (field instanceof HTMLInputElement && field.type === "password") ||
      describeDemonstrationTarget({ point: null, element: field }).sensitive;
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
  const onFocus = (event: Event) => {
    if (!isTrusted(event)) return;
    const field = fieldOf(event.composedPath()[0] ?? null);
    if (field) classify(field);
  };
  const onValue = (event: Event) => {
    if (!isTrusted(event)) return;
    const field =
      fieldOf(event.composedPath()[0] ?? null) ??
      fieldOf(document.activeElement);
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
      window.addEventListener("input", onValue, capture);
      window.addEventListener("change", onValue, capture);
      return () => {
        window.removeEventListener("pointerdown", onPointer, capture);
        window.removeEventListener("focusin", onFocus, capture);
        window.removeEventListener("input", onValue, capture);
        window.removeEventListener("change", onValue, capture);
      };
    },
    sensitiveForEvent(name) {
      if (name === "input" || name === "change")
        return cached(fieldOf(document.activeElement));
      if (name === "click") return cached(pointerField);
      return false;
    },
    onSensitiveValue(listener) {
      listeners.push(listener);
    },
    digests: () => digests,
  };
}
