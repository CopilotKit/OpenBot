// The click and type steps of a run, as plain DOM code: find what a step names on the page, then
// click it or type into it. This file has no imports, so the desktop frame and the app frame both
// use it.

/** What a click step can press, in the order it looks. */
const CLICKABLE = [
  "button",
  "[role=button]",
  "[role=radio]",
  "input[type=radio]",
  "input[type=checkbox]",
  "label",
  "[role=tab]",
  "a",
];

function collapsed(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** The labels of a form control: those that name it by `for`, and the one around it. */
function labelsOf(root: Document, element: HTMLElement): HTMLLabelElement[] {
  const found: HTMLLabelElement[] = [];
  const id = element.getAttribute("id");
  if (id)
    for (const label of root.querySelectorAll<HTMLLabelElement>("label"))
      if (label.getAttribute("for") === id) found.push(label);
  const around = element.parentElement?.closest("label");
  if (around && !found.includes(around)) found.push(around);
  return found;
}

/** Every name an element goes by: aria-label, aria-labelledby, its labels, and its text. */
function namesOf(root: Document, element: HTMLElement): string[] {
  const names: string[] = [];
  const label = element.getAttribute("aria-label");
  if (label) names.push(collapsed(label));
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => root.getElementById(id)?.textContent ?? "")
      .join(" ");
    names.push(collapsed(text));
  }
  if (element.matches("input, select, textarea"))
    for (const each of labelsOf(root, element))
      names.push(collapsed(each.textContent));
  names.push(collapsed(element.textContent));
  return names.filter((name) => name.length > 0);
}

/** The radio or checkbox a label is for, if it is for one. */
function controlOf(root: Document, label: HTMLElement): HTMLElement | null {
  const id = label.getAttribute("for");
  const control = id
    ? root.getElementById(id)
    : label.querySelector("input, select, textarea");
  return control?.matches("input[type=radio], input[type=checkbox]")
    ? (control as HTMLElement)
    : null;
}

/**
 * The element a click step means: one with that exact name first, then the first whose name starts
 * with it. A label for a radio or a checkbox gives that input.
 */
export function findClickable(
  root: Document,
  name: string,
): HTMLElement | null {
  const candidates: HTMLElement[] = [];
  for (const selector of CLICKABLE)
    for (const element of root.querySelectorAll<HTMLElement>(selector))
      if (!candidates.includes(element)) candidates.push(element);
  const named = candidates.map((element) => ({
    element,
    names: namesOf(root, element),
  }));
  const found =
    named.find(({ names }) => names.includes(name)) ??
    named.find(({ names }) => names.some((each) => each.startsWith(name)));
  if (!found) return null;
  if (found.element.tagName === "LABEL")
    return controlOf(root, found.element) ?? found.element;
  return found.element;
}

/** The fields a type step can fill. */
const FIELDS = [
  "input:not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit]):not([type=hidden])",
  "textarea",
  "[contenteditable]:not([contenteditable=false])",
];

/** A field by its name: an exact one first, then the first that starts with it. */
export function findField(root: Document, name: string): HTMLElement | null {
  const fields = [...root.querySelectorAll<HTMLElement>(FIELDS.join(","))].map(
    (element) => {
      const names = namesOf(root, element).filter(
        (each) =>
          each !== collapsed(element.textContent) ||
          !element.matches("input, textarea"),
      );
      const placeholder = collapsed(element.getAttribute("placeholder"));
      return {
        element,
        names: names.length > 0 ? names : placeholder ? [placeholder] : [],
      };
    },
  );
  return (
    fields.find(({ names }) => names.includes(name))?.element ??
    fields.find(({ names }) => names.some((each) => each.startsWith(name)))
      ?.element ??
    null
  );
}

/** Types `text` into `field` the way React sees a change: the native setter, then input and change. */
export function typeInto(field: HTMLElement, text: string): void {
  const win = field.ownerDocument.defaultView as
    | (Window & typeof globalThis)
    | null;
  field.focus();
  if (field.matches("input, textarea") && win) {
    const proto = field.matches("textarea")
      ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (set) set.call(field, text);
    else (field as HTMLInputElement).value = text;
  } else field.textContent = text;
  const Ev = win?.Event ?? Event;
  field.dispatchEvent(new Ev("input", { bubbles: true }));
  field.dispatchEvent(new Ev("change", { bubbles: true }));
}

/** A click or a type step, as a person sees the bot do it. */
export type RunAction = {
  kind: "click" | "type";
  /** The name of what is clicked, or of the field typed into. */
  name: string;
  /** The text a type step types. */
  text?: string;
  /** Milliseconds from the scene start. */
  at: number;
  /** What the step found on the page, or null when nothing has that name. */
  target: Element | null;
};

/** The click and type steps of a run, in time order, without their targets. Other step kinds are left out. */
export function runActions<
  S extends { at: number } & (
    | { click: string }
    | { type: string; into: string }
    | object
  ),
>(steps: readonly S[]): Omit<RunAction, "target">[] {
  const actions: Omit<RunAction, "target">[] = [];
  for (const step of steps) {
    const at = step.at * 1000;
    const loose = step as { click?: unknown; type?: unknown; into?: unknown };
    if ("click" in step && typeof loose.click === "string")
      actions.push({ kind: "click", name: loose.click, at });
    else if (
      "type" in step &&
      typeof loose.type === "string" &&
      typeof loose.into === "string"
    )
      actions.push({ kind: "type", name: loose.into, text: loose.type, at });
  }
  return actions.sort((a, b) => a.at - b.at);
}

/** What a click or a type step with this name acts on, found as the run finds it. */
export function findTarget(
  root: Document,
  action: Pick<RunAction, "kind" | "name">,
): HTMLElement | null {
  return action.kind === "click"
    ? findClickable(root, action.name)
    : findField(root, action.name);
}

/** A click or a type step: what both frames' runs do on the page. */
export type DomStep = { click: string } | { type: string; into: string };

/**
 * Does one click or type step on `root`. It finds the target, calls `onFound` with it (or with
 * null) BEFORE it acts, then clicks or types. Returns false when nothing has that name.
 */
export function performDomStep(
  step: DomStep,
  root: Document,
  onFound?: (target: HTMLElement | null) => void,
): boolean {
  if ("type" in step) {
    const field = findField(root, step.into);
    onFound?.(field);
    if (field) typeInto(field, step.type);
    else
      console.warn(
        `Run step: nothing named "${step.into}" to type into on the page.`,
      );
    return field !== null;
  }
  const target = findClickable(root, step.click);
  onFound?.(target);
  if (target) target.click();
  else
    console.warn(
      `Run step: nothing named "${step.click}" to click on the page.`,
    );
  return target !== null;
}
