import {
  DEMONSTRATION_KEYS,
  describeDemonstrationTarget,
  safeDemonstrationUrl,
} from "@openbot/shared/demonstration-rules";
import type { DemonstrationAction } from "@openbot/shared/demonstration-schema";

const SCROLL_WINDOW_MS = 400;
const MAX_SCROLL = 2000;
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isTextEntry(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement)
    return !NON_TEXT_INPUTS.has(element.type.toLowerCase());
  return element instanceof HTMLElement && element.isContentEditable === true;
}

function elementOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : null;
}

/**
 * Records what the person did as demonstration steps, in the frame they did it. Listeners are on
 * the capture phase so a page that stops propagation cannot hide a step. A field's value is never read.
 */
export function startStepCapture(options: {
  send(action: DemonstrationAction): void;
  isIgnored(target: EventTarget | null, path: EventTarget[]): boolean;
  isTrusted?: (event: Event) => boolean;
  scrollWindowMs?: number;
}): { stop(): void } {
  const isTrusted = options.isTrusted ?? ((event: Event) => event.isTrusted);
  const scrollWindowMs = options.scrollWindowMs ?? SCROLL_WINDOW_MS;
  let typingField: Element | null = null;
  let scroll: {
    deltaY: number;
    element: Element | null;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const accepts = (event: Event) =>
    isTrusted(event) &&
    !options.isIgnored(event.target, [
      ...event.composedPath(),
    ] as EventTarget[]);
  const url = () => safeDemonstrationUrl(location.href);
  const target = (element: Element | null) =>
    describeDemonstrationTarget({ point: null, element });

  function flushScroll() {
    if (!scroll) return;
    const pending = scroll;
    scroll = null;
    clearTimeout(pending.timer);
    options.send({
      kind: "scroll",
      deltaY: Math.max(-MAX_SCROLL, Math.min(MAX_SCROLL, pending.deltaY)),
      url: url(),
      target: target(pending.element),
    });
  }

  const onClick = (event: Event) => {
    const { button } = event as MouseEvent;
    if ((button !== 0 && button !== 1) || !accepts(event)) return;
    flushScroll();
    typingField = null;
    options.send({
      kind: "click",
      url: url(),
      target: target(elementOf(event.target)),
    });
  };
  const onInput = (event: Event) => {
    const element = elementOf(event.target);
    if (!isTextEntry(element) || !accepts(event)) return;
    if (typingField === element) return;
    flushScroll();
    typingField = element;
    options.send({ kind: "type", url: url(), target: target(element) });
  };
  const resetStreak = () => {
    typingField = null;
  };
  const onKeyDown = (event: Event) => {
    const { key } = event as KeyboardEvent;
    if (!(DEMONSTRATION_KEYS as readonly string[]).includes(key)) return;
    if (!accepts(event)) return;
    flushScroll();
    options.send({
      kind: "key",
      key: key as (typeof DEMONSTRATION_KEYS)[number],
      url: url(),
      target: target(document.activeElement),
    });
  };
  const onWheel = (event: Event) => {
    if (!accepts(event)) return;
    const { deltaY, clientX, clientY } = event as WheelEvent;
    if (scroll) {
      scroll.deltaY += deltaY;
      return;
    }
    scroll = {
      deltaY,
      element:
        document.elementFromPoint(clientX, clientY) ?? elementOf(event.target),
      timer: setTimeout(flushScroll, scrollWindowMs),
    };
  };

  const listeners: [string, (event: Event) => void][] = [
    ["click", onClick],
    ["auxclick", onClick],
    ["input", onInput],
    ["focusin", resetStreak],
    ["focusout", resetStreak],
    ["keydown", onKeyDown],
    ["wheel", onWheel],
  ];
  for (const [name, listener] of listeners)
    window.addEventListener(name, listener, { capture: true, passive: true });

  return {
    stop() {
      for (const [name, listener] of listeners)
        window.removeEventListener(name, listener, { capture: true });
      if (scroll) clearTimeout(scroll.timer);
      scroll = null;
      typingField = null;
    },
  };
}
