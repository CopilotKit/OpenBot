/**
 * What every orb on the page shares, so a list of fifty Bots costs one animation loop and one set of
 * listeners rather than fifty of each: a clock that asks the browser for one frame and draws every
 * orb in it, and where the pointer is, for the orbs whose eyes follow it.
 *
 * Both start with their first subscriber and stop with their last, so nothing is left running or
 * listening on a page with no orb on it.
 */

type FrameCallback = (now: number) => void;

const subscribers = new Set<FrameCallback>();
let frame: number | null = null;
/** The document whose visibility the clock follows, while it has subscribers. */
let watched: Document | null = null;

function run(now: number) {
  frame = null;
  // A Set visits what is added during the loop and skips what is removed, so an orb that unmounts
  // mid-frame is not drawn after it has gone.
  for (const callback of subscribers) callback(now);
  schedule();
}

function schedule() {
  if (frame !== null || subscribers.size === 0 || document.hidden) return;
  frame = window.requestAnimationFrame(run);
}

function halt() {
  if (frame !== null) window.cancelAnimationFrame(frame);
  frame = null;
}

/** A hidden tab draws nothing, and picks up again where its orbs are now once it is shown. */
function onVisibility() {
  if (document.hidden) halt();
  else schedule();
}

/**
 * Calls `callback` once on every animation frame, with the frame's timestamp, until the returned
 * function is called. Every subscriber is drawn in the same frame; no frame is asked for while the
 * tab is hidden or nobody is subscribed.
 */
export function subscribeFrame(callback: FrameCallback): () => void {
  subscribers.add(callback);
  if (!watched) {
    watched = document;
    watched.addEventListener("visibilitychange", onVisibility);
  }
  schedule();
  return () => {
    if (!subscribers.delete(callback) || subscribers.size > 0) return;
    halt();
    watched?.removeEventListener("visibilitychange", onVisibility);
    watched = null;
  };
}

// ---------- the pointer ----------

type PointerState = { x: number; y: number; on: boolean; epoch: number };

const state: PointerState = { x: 0, y: 0, on: false, epoch: 0 };

/**
 * Where the pointer is, in client px, and whether it is on the page at all. `epoch` counts every
 * move, scroll and resize, so an orb measures itself again only when something has changed. Kept
 * up to date only while something is subscribed with `subscribePointer`.
 */
export const pointer: Readonly<PointerState> = state;

let watchers = 0;
let lift: ReturnType<typeof setTimeout> | undefined;
let listening: Window | null = null;

const aim = (event: PointerEvent) => {
  state.x = event.clientX;
  state.y = event.clientY;
  state.on = true;
  state.epoch++;
  clearTimeout(lift);
};
const away = () => {
  state.on = false;
  state.epoch++;
};
// A finger lifts off the glass; a mouse stays where it was. Give a tap a moment of being watched.
const lifted = (event: PointerEvent) => {
  if (event.pointerType !== "mouse") lift = setTimeout(away, 1600);
};
const left = (event: PointerEvent) => {
  if (!event.relatedTarget) away();
};
const moved = () => {
  state.epoch++;
};

function listen(target: Window) {
  target.addEventListener("pointermove", aim, { passive: true });
  target.addEventListener("pointerdown", aim, { passive: true });
  target.addEventListener("pointerup", lifted, { passive: true });
  target.document.addEventListener("pointerout", left, { passive: true });
  target.addEventListener("blur", away);
  target.addEventListener("scroll", moved, { capture: true, passive: true });
  target.addEventListener("resize", moved);
}

function unlisten(target: Window) {
  target.removeEventListener("pointermove", aim);
  target.removeEventListener("pointerdown", aim);
  target.removeEventListener("pointerup", lifted);
  target.document.removeEventListener("pointerout", left);
  target.removeEventListener("blur", away);
  target.removeEventListener("scroll", moved, { capture: true });
  target.removeEventListener("resize", moved);
  clearTimeout(lift);
  // Nobody is following it now, so what it last knew is stale for whoever subscribes next.
  away();
}

/**
 * Keeps `pointer` up to date until the returned function is called: one set of window listeners for
 * every orb that watches.
 */
export function subscribePointer(): () => void {
  if (watchers++ === 0) {
    listening = window;
    listen(listening);
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    if (--watchers > 0 || !listening) return;
    unlisten(listening);
    listening = null;
  };
}
