// The steps the collector does not record: a form submitted (`submit`) and Enter pressed in a field (`key`), each with the
// targeting of its form or field (targeting.ts) and never what was typed. Only trusted events count: a page script
// dispatching its own submit is the page, not the person.
import { targetingOf } from "./targeting";

type Emit = (name: "submit" | "key", value: Record<string, unknown>) => void;

const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "email",
  "url",
  "tel",
  "number",
  "password",
]);
/** What identifies a field or a form beside its targeting, never what was typed in it. */
const KEPT_ATTRIBUTES = [
  "id",
  "name",
  "type",
  "role",
  "aria-label",
  "placeholder",
  "method",
  "data-testid",
  "data-test-id",
] as const;

/** A field a person types into: a text-like input, a textarea, or an editable element. */
function fieldOf(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (target instanceof HTMLInputElement)
    return TEXT_INPUT_TYPES.has(target.type) ? target : null;
  if (target instanceof HTMLTextAreaElement) return target;
  return target.closest(
    '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]',
  );
}

const liveValue = (element: Element): string | undefined =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement
    ? element.value
    : element.matches('[contenteditable]:not([contenteditable="false"])')
      ? (element.textContent ?? undefined)
      : undefined;

/** The step for an element: its tag and identifying attributes as the collector keeps them, its role, name and input type,
 * and the rest of its targeting beside them. */
function stepFor(step: string, element: Element): Record<string, unknown> {
  const attributes: Record<string, string> = {};
  for (const name of KEPT_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value.slice(0, 200);
  }
  const { role, name, inputType, ...rest } = targetingOf(
    element,
    liveValue(element),
  );
  return {
    step,
    url: location.href,
    route: location.pathname,
    target: {
      tag: element.localName,
      role,
      name,
      ...(inputType ? { inputType } : {}),
      attributes,
    },
    ...rest,
  };
}

/** Installs the listeners on `window`, in the capture phase so a page that stops propagation hides nothing; null when the
 * page will not let them be added. `isTrusted` is a test seam only: a test cannot create a trusted event. */
export function installActionCapture(options: {
  emit: Emit;
  isTrusted?: (event: Event) => boolean;
}): (() => void) | null {
  const isTrusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
  const onSubmit = (event: Event) => {
    if (!isTrusted(event) || !(event.target instanceof HTMLFormElement)) return;
    try {
      const submitter = (event as SubmitEvent).submitter;
      options.emit("submit", {
        ...stepFor("submit", event.target),
        ...(submitter instanceof Element
          ? { submitter: stepFor("click", submitter).target }
          : {}),
      });
    } catch {
      // Capture must never break the page's own submit.
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isTrusted(event)) return;
    // Enter that sends what was typed: a newline (Shift+Enter) or a composition being confirmed is not.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const field = fieldOf(event.composedPath()[0] ?? event.target);
    if (!field) return;
    try {
      options.emit("key", { key: "Enter", ...stepFor("enter", field) });
    } catch {
      // Capture must never break the page's own key handling.
    }
  };

  const passive = { capture: true, passive: true } as const;
  const listeners: [string, (event: never) => void][] = [
    ["submit", onSubmit],
    ["keydown", onKeyDown],
  ];
  const uninstall = () => {
    for (const [type, listener] of listeners)
      window.removeEventListener(type, listener as EventListener, {
        capture: true,
      });
  };
  try {
    for (const [type, listener] of listeners)
      window.addEventListener(type, listener as EventListener, passive);
  } catch {
    uninstall();
    return null;
  }
  return uninstall;
}
