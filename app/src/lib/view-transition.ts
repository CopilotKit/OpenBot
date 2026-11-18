import { flushSync } from "react-dom";

/*
 * Changes that redraw a lot at once, done as one movement instead of a snap, with the browser's view
 * transitions: it takes a picture of the page, the change happens under it, and the picture gives
 * way to the new page (the curves are in styles.css). Where the browser has no view transitions, or
 * the person asked their system for less motion, the change simply happens, as it always did.
 */

/** Whether the person asked their system for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Runs `change`, which redraws the whole app (the theme, the skin), as one cross-fade from the old
 * look to the new. React's updates inside it are flushed before the new picture is taken.
 */
export function crossFade(change: () => void): void {
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function" ||
    prefersReducedMotion()
  ) {
    change();
    return;
  }
  document.startViewTransition(() => {
    flushSync(change);
  });
}

/**
 * Which page changes the router draws as a transition: going to another page, never the first page
 * drawn, a change to the address's options alone (a pane opening over the same page has its own
 * motion), or anything for somebody who asked for less motion. The type names the transition, so
 * styles.css can give a page change its own curve.
 */
export function pageTransitionTypes({
  fromLocation,
  pathChanged,
}: {
  fromLocation?: unknown;
  pathChanged: boolean;
}): string[] | false {
  if (!fromLocation || !pathChanged || prefersReducedMotion()) return false;
  return ["page"];
}
