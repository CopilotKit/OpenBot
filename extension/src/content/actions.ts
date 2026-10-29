// The Recorder's own steps, for what the collector does not record: Enter pressed in a field (`key`) and a form submitted
// (`submit`), each with the targeting of its field or form (targeting.ts) and never what was typed. One action is one
// row, and where CopilotKit's collector already records an action, its event is that row and these add nothing:
// - A form submitted by a click on its submit button is that click (the submit is its default action, in the same task).
// - Enter in a field whose form has a default button is the click the browser makes on that button (`input: "keyboard"`
//   in CopilotKit's click), and its submit: neither the key nor the submit is sent. Chrome makes that click as the
//   default action of the Enter's keypress, so the key is held from keydown until the keypress has run.
// - Enter in a field that submits a form with no button (or one CopilotKit does not record) is the key; the submit it
//   makes is the key's consequence.
// A submit is sent only when neither a click nor an Enter explains it. Only trusted events count: a page script
// dispatching its own submit is the page, not the person.
import { targetingOf } from "./targeting";

type Emit = (name: "submit" | "key", value: Record<string, unknown>) => void;

type Timers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The longest an Enter is held for the click its keypress may make, when neither the keypress nor the keyup comes. */
const ENTER_HOLD_MS = 1_000;

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

/** The form's default button (HTML's implicit submission): its first submit button, in tree order, of all the controls
 * the form owns. */
function defaultButton(form: HTMLFormElement): Element | null {
  for (const control of Array.from(form.elements))
    if (
      (control instanceof HTMLButtonElement && control.type === "submit") ||
      (control instanceof HTMLInputElement &&
        (control.type === "submit" || control.type === "image"))
    )
      return control;
  return null;
}

/** Whether Enter in the field makes the browser click its form's default button: an input of its form, with a default
 * button that is not disabled (a disabled one submits nothing). */
function entersClick(field: Element): boolean {
  if (!(field instanceof HTMLInputElement) || !field.form) return false;
  const button = defaultButton(field.form);
  return button !== null && !button.matches(":disabled");
}

const liveValue = (element: Element): string | undefined =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement
    ? element.value
    : element.matches('[contenteditable]:not([contenteditable="false"])')
      ? (element.textContent ?? undefined)
      : undefined;

/** The step for an element: its tag and identifying attributes as the collector keeps them, its computed role, name and
 * input type, and the rest of its targeting beside them. */
function stepFor(step: string, element: Element): Record<string, unknown> {
  const attributes: Record<string, string> = {};
  for (const name of KEPT_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value.slice(0, 200);
  }
  const { ariaRole, name, inputType, selectedLabels, ...rest } = targetingOf(
    element,
    liveValue(element),
  );
  return {
    step,
    url: location.href,
    route: location.pathname,
    target: {
      tag: element.localName,
      ariaRole,
      name,
      ...(inputType ? { inputType } : {}),
      ...(selectedLabels ? { selectedLabels } : {}),
      attributes,
    },
    ...rest,
  };
}

export type ActionCapture = {
  /** The collector sent a click (`keyboard` when the browser made it for a key, as an Enter's on a default button). */
  collectorClicked(keyboard: boolean): void;
  uninstall(): void;
};

/** Installs the listeners on `window`, in the capture phase so a page that stops propagation hides nothing; null when the
 * page will not let them be added. `isTrusted` is a test seam only: a test cannot create a trusted event. */
export function installActionCapture(options: {
  emit: Emit;
  isTrusted?: (event: Event) => boolean;
  timers?: Timers;
}): ActionCapture | null {
  const isTrusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
  const timers = options.timers ?? realTimers;

  // A click the collector sent in the task running now: a submit in the same task is that click's default action. Set
  // when the click is sent and cleared by the next task, which cannot run before this one ends.
  let clickedNow = false;
  let clickTask: unknown;
  // The Enter being pressed: held until its keypress has run when the browser may click a default button for it, else
  // already sent. Either way it explains the submit it makes.
  let enter: {
    held: Record<string, unknown> | null;
    timers: unknown[];
  } | null = null;

  const send = (name: "submit" | "key", value: Record<string, unknown>) => {
    try {
      options.emit(name, value);
    } catch {
      // Capture must never break the page's own key handling or submit.
    }
  };
  /** The Enter is over: a key still held is sent (no click came for it). */
  const endEnter = () => {
    const current = enter;
    if (!current) return;
    enter = null;
    for (const handle of current.timers) timers.clear(handle);
    if (current.held) send("key", current.held);
  };
  const later = (fn: () => void, ms = 0) => {
    const current = enter;
    if (current) current.timers.push(timers.set(fn, ms));
  };

  const onSubmit = (event: Event) => {
    if (!isTrusted(event) || !(event.target instanceof HTMLFormElement)) return;
    if (clickedNow) return;
    if (enter) {
      // The Enter's own submit (a form with no button to click): the key is the row.
      const held = enter.held;
      enter.held = null;
      if (held) send("key", held);
      return;
    }
    try {
      const submitter = (event as SubmitEvent).submitter;
      send("submit", {
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
    if (!isTrusted(event) || event.key !== "Enter") return;
    endEnter();
    // Enter that sends what was typed: a newline (Shift+Enter) or a composition being confirmed is not.
    if (event.shiftKey || event.isComposing) return;
    const field = fieldOf(event.composedPath()[0] ?? event.target);
    if (!field) return;
    let value: Record<string, unknown>;
    try {
      value = { key: "Enter", ...stepFor("enter", field) };
    } catch {
      // Capture must never break the page's own key handling.
      return;
    }
    if (!entersClick(field)) {
      send("key", value);
      enter = { held: null, timers: [] };
      later(endEnter, ENTER_HOLD_MS);
      return;
    }
    enter = { held: value, timers: [] };
    // A page that stops the Enter at keydown stops its keypress too, and with it the click: the key is the row.
    const current = enter;
    later(() => {
      if (enter === current && event.defaultPrevented) endEnter();
    });
    later(endEnter, ENTER_HOLD_MS);
  };
  const onKeyPress = (event: KeyboardEvent) => {
    if (!isTrusted(event) || event.key !== "Enter" || !enter) return;
    // The keypress's default action (the default button's click and its submit) runs in this task: by the next, the
    // Enter has had its click or never will.
    later(endEnter);
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (isTrusted(event) && event.key === "Enter") endEnter();
  };
  // Anything else the person does ends the Enter first, so the steps keep their order.
  const onOther = () => endEnter();

  const passive = { capture: true, passive: true } as const;
  const listeners: [string, (event: never) => void][] = [
    ["submit", onSubmit],
    ["keydown", onKeyDown],
    ["keypress", onKeyPress],
    ["keyup", onKeyUp],
    ["pointerdown", onOther],
    ["pagehide", onOther],
  ];
  const removeListeners = () => {
    for (const [type, listener] of listeners)
      window.removeEventListener(type, listener as EventListener, {
        capture: true,
      });
  };
  try {
    for (const [type, listener] of listeners)
      window.addEventListener(type, listener as EventListener, passive);
  } catch {
    removeListeners();
    return null;
  }
  return {
    collectorClicked(keyboard) {
      clickedNow = true;
      if (clickTask === undefined)
        clickTask = timers.set(() => {
          clickTask = undefined;
          clickedNow = false;
        }, 0);
      // The click the browser made for the Enter: CopilotKit's click is the row, and the key is never sent.
      if (keyboard && enter) enter.held = null;
    },
    uninstall() {
      endEnter();
      removeListeners();
      if (clickTask !== undefined) timers.clear(clickTask);
      clickTask = undefined;
      clickedNow = false;
    },
  };
}
