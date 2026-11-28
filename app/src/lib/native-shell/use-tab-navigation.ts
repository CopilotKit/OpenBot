import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { type NativeTab, shellListens, tabForPath } from "./bridge";
import { tellShell } from "./route-reports";
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
/** Shows a step, announced to the app as `direction` when given (set while mounted). */
let apply: ((next: TabStep, direction?: Direction) => void) | null = null;

type Direction = "push" | "back" | "replace";

/** For tests: forget the stacks, as a new page load does. */
export function forgetTabStacksForTests(): void {
  stacks = null;
  apply = null;
  scrolls.clear();
  restoring = null;
}

/**
 * The tab the page is in, whether Back can go anywhere, and how deep its stack is (1 at its root),
 * inside the shell; null outside it.
 */
export function shellTabState(): {
  tab: NativeTab;
  canGoBack: boolean;
  depth: number;
} | null {
  return stacks
    ? {
        tab: stacks.current,
        canGoBack: canGoBack(stacks),
        depth: stacks.stacks[stacks.current].length,
      }
    : null;
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
  apply(goBack(stacks), "back");
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

/**
 * A list being put back where it was, while it is: the `route` for its page waits for it
 * (`whenScrollRestored`), so the app drops its snapshot only once nothing will jump.
 */
let restoring: { done: Promise<void> } | null = null;

/** Puts `location`'s list back where it was, once it has drawn enough to scroll that far. */
function restoreScroll(location: string) {
  const saved = scrolls.get(location);
  if (!saved) return;
  let frames = 0;
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const current = { done };
  restoring = current;
  const finish = () => {
    if (restoring === current) restoring = null;
    settle();
  };
  const tick = () => {
    const list = document.querySelector(LIST);
    if (list) {
      list.scrollTop = saved;
      if (Math.abs(list.scrollTop - saved) < 2) return finish();
    }
    // About a second at most: a list that can no longer scroll that far is shown where it can.
    if (++frames < 60) requestAnimationFrame(tick);
    else finish();
  };
  requestAnimationFrame(tick);
}

/** Runs `then` once no list is being put back (at once, mostly). */
export function whenScrollRestored(then: () => void): () => void {
  let live = true;
  const pending = restoring;
  if (!pending) then();
  else void pending.done.then(() => live && then());
  return () => {
    live = false;
  };
}

/** The app's answer to `will-navigate`: it holds its snapshot, so the page may change. */
export const NAVIGATE_OK = "openbot:navigate-ok";
/** How long the page waits for that answer before it goes ahead anyway. */
export const NAVIGATE_OK_MS = 120;

/**
 * Tells the app a navigation the page started is coming (`will-navigate`), then runs `go`: at once,
 * or on iOS, where the app takes a snapshot of the page for its swipe back, once the app answers
 * `openbot:navigate-ok` or after `NAVIGATE_OK_MS`, whichever is first. Never waits where nothing
 * received the message, nor on Android, which does not answer.
 */
function announce(direction: Direction, next: TabStacks, go: () => void): void {
  const message = {
    type: "will-navigate",
    tab: next.current,
    direction,
    depth: next.stacks[next.current].length,
  } as const;
  if (nativeShell()?.platform !== "ios" || !shellListens()) {
    tellShell(message);
    go();
    return;
  }
  // Listening before it is said, so an answer given at once is not missed.
  let gone = false;
  const once = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    window.removeEventListener(NAVIGATE_OK, once);
    go();
  };
  const timer = setTimeout(once, NAVIGATE_OK_MS);
  window.addEventListener(NAVIGATE_OK, once);
  tellShell(message);
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

    /** Whether going from `from` to `to` changes the page, as opposed to its search or fragment. */
    const changesPage = (from: string, to: string) =>
      pathOf(from) !== pathOf(to);

    history.push = (path, state, options) => {
      const from = here();
      saveScroll(from);
      stacks = signedOut(path)
        ? cleared()
        : pushLocation(stacks ?? stacksFor(from), path).state;
      if (signedOut(path) || !changesPage(from, path))
        replace(path, state, options);
      else announce("push", stacks, () => replace(path, state, options));
    };
    history.replace = (path, state, options) => {
      const from = here();
      stacks = signedOut(path)
        ? cleared()
        : replaceLocation(stacks ?? stacksFor(from), path).state;
      if (signedOut(path) || !changesPage(from, path))
        replace(path, state, options);
      else announce("replace", stacks, () => replace(path, state, options));
    };
    apply = (next, direction) => {
      const from = here();
      if (next.show !== from) saveScroll(from);
      stacks = next.state;
      if (next.scrollToTop) scrollListToTop();
      if (next.show === from) return;
      const go = () => {
        replace(next.show);
        restoreScroll(next.show);
      };
      if (direction && changesPage(from, next.show))
        announce(direction, next.state, go);
      else go();
    };
    // Back the app asked for: popped as the page's own Back is, but not announced, since the app
    // started it and already knows.
    const onBack = () => {
      if (stacks && apply && canGoBack(stacks)) apply(goBack(stacks));
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
