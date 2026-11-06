/**
 * One animation loop for every Bot on the page, so a list of fifty costs one frame request rather
 * than fifty. It starts with its first subscriber, stops with its last, and asks for no frame while
 * the tab is hidden.
 */

type FrameCallback = (now: number) => void;

const subscribers = new Set<FrameCallback>();
let frame: number | null = null;
/** The document whose visibility the clock follows, while it has subscribers. */
let watched: Document | null = null;

function run(now: number) {
  frame = null;
  // A Set visits what is added during the loop and skips what is removed, so a Bot that unmounts
  // mid-frame is not drawn after it has gone. One that throws is reported and skipped: it must not
  // stop every other Bot on the page, or the frames after this one.
  for (const callback of subscribers) {
    try {
      callback(now);
    } catch (error) {
      console.error(error);
    }
  }
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

/** A hidden tab draws nothing, and picks up where its Bots are now once it is shown. */
function onVisibility() {
  if (document.hidden) halt();
  else schedule();
}

/**
 * Calls `callback` once every animation frame, with the frame's timestamp, until the returned
 * function is called.
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
