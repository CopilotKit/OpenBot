import { nativeControl } from "../src/fakeNative/control";
import type { PageClock } from "./clock";
import type { RunStep } from "./scenes/types";

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
function findClickable(root: Document, name: string): HTMLElement | null {
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
function findField(root: Document, name: string): HTMLElement | null {
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
function typeInto(field: HTMLElement, text: string): void {
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

export type RunOptions = {
  /** Called just before a click or a type step acts, with what it acts on. */
  onAction?(action: RunAction): void;
};

/** The click and type steps of a run, in time order, without their targets. */
export function runActions(
  steps: readonly RunStep[],
): Omit<RunAction, "target">[] {
  const actions: Omit<RunAction, "target">[] = [];
  for (const step of steps) {
    const at = step.at * 1000;
    if ("click" in step) actions.push({ kind: "click", name: step.click, at });
    else if ("type" in step)
      actions.push({ kind: "type", name: step.into, text: step.type, at });
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

/** The words for an action: "Click · Install", "Type · Code from your browser". */
export function actionLabel(action: Pick<RunAction, "kind" | "name">): string {
  return `${action.kind === "click" ? "Click" : "Type"} · ${action.name}`;
}

/**
 * Where a play with "Pause at each action" goes next. It goes to `wanted`, but it stops 1 ms
 * before the first action it would pass. At 1 ms before an action (where it stopped), it goes on
 * through that action. `stopAt` is the time of the action it stops before, or null.
 */
export function playTo(
  now: number,
  wanted: number,
  actionTimes: readonly number[],
): { to: number; stopAt: number | null } {
  let next: number | null = null;
  for (const t of actionTimes)
    if (t - 1 > now && (next === null || t < next)) next = t;
  if (next !== null && next - 1 <= wanted)
    return { to: next - 1, stopAt: next };
  return { to: wanted, stopAt: null };
}

function perform(
  step: RunStep,
  root: Document | undefined,
  options: RunOptions,
): void {
  const control = nativeControl();
  if ("emit" in step) control.emit(step.emit, step.payload);
  else if ("answer" in step) control.setAnswer(step.answer, step.with);
  else if ("settle" in step)
    control.setAnswer(step.settle, { mode: "value", value: step.value });
  else if ("fail" in step)
    control.setAnswer(step.fail, { mode: "fail", problem: step.problem });
  else if ("type" in step) {
    const field = findField(root ?? document, step.into);
    options.onAction?.({
      kind: "type",
      name: step.into,
      text: step.type,
      at: step.at * 1000,
      target: field,
    });
    if (field) typeInto(field, step.type);
    else
      console.warn(
        `Run step: nothing named "${step.into}" to type into on the page.`,
      );
  } else {
    const target = findClickable(root ?? document, step.click);
    options.onAction?.({
      kind: "click",
      name: step.click,
      at: step.at * 1000,
      target,
    });
    if (target) target.click();
    else
      console.warn(
        `Run step: nothing named "${step.click}" to click on the page.`,
      );
  }
}

export function startRun(
  steps: readonly RunStep[],
  clock: PageClock,
  root?: Document,
  options: RunOptions = {},
): { end: number; nextAt(ms: number): number | null } {
  for (const step of steps)
    clock.schedule(step.at * 1000, () => perform(step, root, options));
  const times = steps.map((step) => step.at * 1000);
  return {
    end: times.length === 0 ? 0 : Math.max(...times),
    nextAt(ms) {
      let best: number | null = null;
      for (const t of times)
        if (t > ms && (best === null || t < best)) best = t;
      return best;
    },
  };
}
