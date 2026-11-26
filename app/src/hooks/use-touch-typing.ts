import { useSyncExternalStore } from "react";

/**
 * Whether a person is typing on a touch keyboard: a finger is the main pointer and there is no
 * mouse or trackpad at all.
 *
 * Asked of the pointer, not the window's width. A phone held sideways is wide, and a desktop window
 * can be narrow; what decides whether Return should send is the keyboard, and the pointer is what a
 * page can know about it. An iPad with a trackpad reports a fine pointer as well, so it counts as a
 * computer, as does a laptop with a touch screen, whose main pointer is its trackpad. An iPad with
 * only a keyboard still counts as touch: a page can't tell a hardware keyboard is there.
 */
const COARSE = "(pointer: coarse)";
const ANY_FINE = "(any-pointer: fine)";

function touchTyping(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return (
    window.matchMedia(COARSE).matches && !window.matchMedia(ANY_FINE).matches
  );
}

/** Attaching or removing a trackpad changes the answer while the page is open. */
function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const queries = [window.matchMedia(COARSE), window.matchMedia(ANY_FINE)];
  for (const query of queries) query.addEventListener("change", onChange);
  return () => {
    for (const query of queries) query.removeEventListener("change", onChange);
  };
}

export function useTouchTyping(): boolean {
  return useSyncExternalStore(subscribe, touchTyping, () => false);
}
