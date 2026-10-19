// What the person does in a frame beyond the collector's clicks and edits: a form submitted and Enter pressed in a field
// are recorded as `submit` and `key` events (the collector records neither), and every real action (a pointer press, a
// click, an edit, a submit, a key press) is reported by its time alone, so the service worker can tell the network
// calls it caused from the ones the page makes on its own. Only trusted events count: a page script dispatching its own
// click is the page, not the person.

type Emit = (name: "submit" | "key", value: Record<string, unknown>) => void;

/** At most one action time per this many milliseconds: the window it opens is far longer, so nothing is lost. */
export const ACTION_PING_MS = 100;

const MODIFIERS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Fn",
  "AltGraph",
]);
/** What identifies a field or a form without carrying what was typed in it. */
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

function describe(element: Element): Record<string, unknown> {
  const attributes: Record<string, string> = {};
  for (const name of KEPT_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value.slice(0, 200);
  }
  return {
    tag: element.localName,
    role: element.getAttribute("role"),
    attributes,
  };
}

/** A field a person types into: a text-like input, a textarea, or an editable element. */
function fieldOf(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  if (target instanceof HTMLInputElement)
    return TEXT_INPUT_TYPES.has(target.type) ? target : null;
  if (target instanceof HTMLTextAreaElement) return target;
  const editable = target.closest(
    '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"]',
  );
  return editable;
}

const where = () => ({ url: location.href, route: location.pathname });

/** Installs the listeners on `window`, in the capture phase so a page that stops propagation hides nothing; null when the
 * page will not let them be added. `isTrusted` is a test seam only: a test cannot create a trusted event. */
export function installActionCapture(options: {
  emit: Emit;
  action(at: number): void;
  now?: () => number;
  isTrusted?: (event: Event) => boolean;
}): (() => void) | null {
  const now = options.now ?? Date.now;
  const isTrusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
  let lastPing = Number.NEGATIVE_INFINITY;
  const ping = () => {
    const at = now();
    if (at - lastPing < ACTION_PING_MS) return;
    lastPing = at;
    options.action(at);
  };

  const onAction = (event: Event) => {
    if (!isTrusted(event)) return;
    if (event instanceof KeyboardEvent && MODIFIERS.has(event.key)) return;
    ping();
  };
  const onSubmit = (event: Event) => {
    if (!isTrusted(event) || !(event.target instanceof HTMLFormElement)) return;
    ping();
    try {
      const submitter = (event as SubmitEvent).submitter;
      options.emit("submit", {
        ...where(),
        target: describe(event.target),
        ...(submitter instanceof Element
          ? { submitter: describe(submitter) }
          : {}),
      });
    } catch {
      // Capture must never break the page's own submit.
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isTrusted(event)) return;
    if (!MODIFIERS.has(event.key)) ping();
    // Enter that sends what was typed: a newline (Shift+Enter) or a composition being confirmed is not.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const field = fieldOf(event.composedPath()[0] ?? event.target);
    if (!field) return;
    try {
      options.emit("key", {
        key: "Enter",
        ...where(),
        target: describe(field),
      });
    } catch {
      // Capture must never break the page's own key handling.
    }
  };

  const passive = { capture: true, passive: true } as const;
  const listeners: [string, (event: never) => void][] = [
    ...(["pointerdown", "click", "input", "change"] as const).map(
      (type) => [type, onAction] as [string, (event: never) => void],
    ),
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
