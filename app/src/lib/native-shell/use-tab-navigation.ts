import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { type NativeTab, tabForPath } from "./bridge";
import { nativeShell } from "./shell";
import {
  canGoBack,
  cleared,
  goBack,
  pathOf,
  pushLocation,
  replaceLocation,
  rootTabOf,
  stacksFor,
  TAB_ROOTS,
  type TabStacks,
  type TabStep,
  tapTab,
} from "./tab-stacks";

/**
 * THE PHONE APP'S TABS, APPLIED (`tab-stacks.ts` is the model). Inside the native shell the web app
 * keeps one stack of locations per tab and shows the current tab's top:
 *
 * - Every navigation the page makes (a row, a link, `navigate`) goes onto the current tab's stack,
 *   and is written to the browser as a REPLACE, never a push: the web view's own back and forward
 *   list stays one entry long, so nothing native (Android's Back, iOS's edge swipe) can walk a
 *   history that mixes tabs. The stacks are the only history.
 * - A tab tap arrives as `openbot:open` with the tab's root (`useDesktopOpenRequests` hands it
 *   here): another tab's root switches to that tab where it was left, the current tab's pops it to
 *   its root, or scrolls its list to the top at the root.
 * - Back is `openbot:back` from native, or the page's own back control (`goBackInShell`): the
 *   current tab's stack popped once, never into another tab; nothing at a root.
 * - The `route` message says which tab's stack the page is in and whether Back can go anywhere
 *   (`shellTabState`, read by `route-reports.ts`).
 * - A list keeps its scroll: the panel's is saved as the page is left and put back when it is shown
 *   again, and its data comes from the query cache, so a tab comes back without a skeleton.
 * - Reaching the sign-in page (signing out, a session that ran out) clears every stack.
 *
 * Outside the shell none of this is installed: the browser's history is the history.
 */

/** The custom event native sends on `window` for Back, when the last `route` said `canGoBack`. */
export const BACK_REQUEST = "openbot:back";

/** The tabs' stacks for this page load, once the shell's navigation has started. */
let stacks: TabStacks | null = null;
/** Shows a step (set while the navigation is mounted). */
let apply: ((next: TabStep) => void) | null = null;

/** For tests: forget the stacks, as a new page load does. */
export function forgetTabStacksForTests(): void {
  stacks = null;
  apply = null;
  scrolls.clear();
}

/** The tab the page is in and whether Back can go anywhere, inside the shell; null outside it. */
export function shellTabState(): { tab: NativeTab; canGoBack: boolean } | null {
  return stacks ? { tab: stacks.current, canGoBack: canGoBack(stacks) } : null;
}

/** The root of the tab the page is in, inside the shell: where a back control falls back to. */
export function currentTabRoot(): string | null {
  return stacks ? TAB_ROOTS[stacks.current] : null;
}

/**
 * Back from the page's own control: the current tab's stack popped once. False where there is
 * nowhere to go in it (or outside the shell), and the control then follows its own link.
 */
export function goBackInShell(): boolean {
  if (!stacks || !apply || !canGoBack(stacks)) return false;
  apply(goBack(stacks));
  return true;
}

/**
 * What the shell asked for with `openbot:open`: a tab's root is a tab tap; any other page (a
 * notification's) opens in the tab that owns it, on top of where that tab was. False outside the
 * shell's navigation, where the caller opens it as before.
 */
export function openFromShell(location: string): boolean {
  if (!stacks || !apply) return false;
  if (rootTabOf(location)) {
    apply(tapTab(stacks, location));
    return true;
  }
  const owner = tabForPath(pathOf(location)) ?? stacks.current;
  apply(pushLocation({ ...stacks, current: owner }, location));
  return true;
}

/** Where each list was scrolled, by location, while the person was elsewhere. */
const scrolls = new Map<string, number>();

/** The scrolling part of a list the shell shows as a tab: a sidebar panel's content. */
const LIST = '[data-slot="section-panel"] [data-slot="sidebar-content"]';

function saveScroll(location: string) {
  const list = document.querySelector(LIST);
  if (list) scrolls.set(location, list.scrollTop);
}

/** Puts `location`'s list back where it was, once it has drawn enough to scroll that far. */
function restoreScroll(location: string) {
  const saved = scrolls.get(location);
  if (!saved) return;
  let frames = 0;
  const tick = () => {
    const list = document.querySelector(LIST);
    if (list) {
      list.scrollTop = saved;
      if (Math.abs(list.scrollTop - saved) < 2) return;
    }
    if (++frames < 60) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function scrollListToTop() {
  document.querySelector(LIST)?.scrollTo({ top: 0, behavior: "smooth" });
}

/** Mounted once, at the root, next to the reports and Desktop's open requests. */
export function useTabNavigation(): void {
  const router = useRouter();
  useEffect(() => {
    if (!nativeShell()) return;
    const history = router.history;
    const here = () =>
      `${history.location.pathname}${history.location.search}${history.location.hash}`;
    /** Signing out, or a session that ran out, ends on the sign-in page: no stack survives it. */
    const signedOut = (location: string) => pathOf(location) === "/sign";
    stacks ??= signedOut(here()) ? cleared() : stacksFor(here());
    const push = history.push;
    const replace = history.replace;

    history.push = (path, state, options) => {
      saveScroll(here());
      stacks = signedOut(path)
        ? cleared()
        : pushLocation(stacks ?? stacksFor(here()), path).state;
      replace(path, state, options);
    };
    history.replace = (path, state, options) => {
      stacks = signedOut(path)
        ? cleared()
        : replaceLocation(stacks ?? stacksFor(here()), path).state;
      replace(path, state, options);
    };
    apply = (next) => {
      const from = here();
      if (next.show !== from) saveScroll(from);
      stacks = next.state;
      if (next.show !== from) {
        replace(next.show);
        restoreScroll(next.show);
      }
      if (next.scrollToTop) scrollListToTop();
    };
    const onBack = () => {
      goBackInShell();
    };
    window.addEventListener(BACK_REQUEST, onBack);
    return () => {
      history.push = push;
      history.replace = replace;
      apply = null;
      window.removeEventListener(BACK_REQUEST, onBack);
    };
  }, [router]);
}
