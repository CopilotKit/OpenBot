import { type NativeTab, tabForPath } from "./bridge";

/**
 * WHERE EACH OF THE PHONE APP'S TABS IS: one stack of locations per tab, as a native tab bar app
 * keeps them. The web app owns this inside the native shell (`use-tab-navigation.ts` applies it);
 * outside the shell nothing reads it and the browser's own history is the history.
 *
 * - Each tab's stack starts at its root (`TAB_ROOTS`). Going deeper pushes onto the CURRENT tab's
 *   stack, so a page opened from a tab belongs to that tab: a conversation opened from the Bots
 *   panel is in the Bots stack, one sent from Home in Home's. A page no tab owns (Settings, Admin,
 *   opened from the Account menu) goes onto the current tab's stack too, so Back returns to where it
 *   was opened.
 * - A tab tap is the shell asking for a tab's root. Another tab's root: switch to that tab, exactly
 *   where it was left. The current tab's root: pop it to its root, and at its root, scroll to the top.
 * - Back pops the current tab's stack only, never into another tab; at a root it does nothing, and
 *   `canGoBack` is false there.
 * - With no stacks yet (a cold start, a reload, a deep link) the stack is built from the address:
 *   the tab that owns it, with its root under it, so a deep page always has a way out.
 * - Signing out clears every stack.
 *
 * Pure: every function returns the next state and what to show; nothing here touches the router.
 */

/** Each tab's root, the location its tap asks for. */
export const TAB_ROOTS: Record<NativeTab, string> = {
  conversations: "/conversations",
  home: "/",
  bots: "/bots",
};

const TABS = Object.keys(TAB_ROOTS) as NativeTab[];

export type TabStacks = {
  /** The tab on screen. */
  current: NativeTab;
  /** Each tab's locations, root first, top last: path, search and fragment. */
  stacks: Record<NativeTab, string[]>;
};

/** What a change of the stacks asks the page to do. */
export type TabStep = {
  state: TabStacks;
  /** The location to show now: the current tab's top. */
  show: string;
  /** The current tab was tapped at its root: scroll its list to the top. */
  scrollToTop?: true;
};

/** A location's path, without its search or fragment. */
export function pathOf(location: string): string {
  const path = location.split(/[?#]/)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/** The tab whose root `location` is, or null when it is no tab's root. */
export function rootTabOf(location: string): NativeTab | null {
  const path = pathOf(location);
  return TABS.find((tab) => TAB_ROOTS[tab] === path) ?? null;
}

/** The top of the current tab's stack: what is on screen. */
export function topOf(state: TabStacks): string {
  const stack = state.stacks[state.current];
  return stack[stack.length - 1] ?? TAB_ROOTS[state.current];
}

/** Whether Back has somewhere to go inside the current tab. */
export function canGoBack(state: TabStacks): boolean {
  return state.stacks[state.current].length > 1;
}

function rootsOnly(): Record<NativeTab, string[]> {
  return {
    conversations: [TAB_ROOTS.conversations],
    home: [TAB_ROOTS.home],
    bots: [TAB_ROOTS.bots],
  };
}

/**
 * The stacks for a page opened with none (a cold start, a reload, a deep link): the tab that owns
 * the address (`tabForPath`), or Home where no tab does, with that tab's root under the page.
 */
export function stacksFor(location: string): TabStacks {
  const stacks = rootsOnly();
  const root = rootTabOf(location);
  if (root) {
    stacks[root] = [location];
    return { current: root, stacks };
  }
  const current = tabForPath(pathOf(location)) ?? "home";
  stacks[current] = [TAB_ROOTS[current], location];
  return { current, stacks };
}

function withStack(
  state: TabStacks,
  tab: NativeTab,
  stack: string[],
): TabStacks {
  return { current: tab, stacks: { ...state.stacks, [tab]: stack } };
}

function step(state: TabStacks, extra?: { scrollToTop: true }): TabStep {
  return { state, show: topOf(state), ...extra };
}

/**
 * The shell's tab tap: `location` is a tab's root. Another tab's: that tab, where it was left. The
 * current tab's: popped to its root, or, at its root already, scrolled to the top.
 */
export function tapTab(state: TabStacks, location: string): TabStep {
  const tab = rootTabOf(location);
  if (!tab) return pushLocation(state, location);
  if (tab !== state.current) return step({ ...state, current: tab });
  const stack = state.stacks[tab];
  if (stack.length <= 1) return step(state, { scrollToTop: true });
  return step(withStack(state, tab, [stack[0] ?? TAB_ROOTS[tab]]));
}

/**
 * Going somewhere from inside the page (a row, a link, a button). Deeper: onto the current tab's
 * stack. A tab's root: that tab at its root, as following a link to a list does. The same location
 * again: nothing.
 */
export function pushLocation(state: TabStacks, location: string): TabStep {
  const tab = rootTabOf(location);
  if (tab) return step(withStack(state, tab, [location]));
  const stack = state.stacks[state.current];
  if (stack[stack.length - 1] === location) return step(state);
  return step(withStack(state, state.current, [...stack, location]));
}

/**
 * The page put another location in place of the one on screen (a search change, a closed sheet):
 * the current tab's top is replaced. A tab's root replacing a deeper page is that tab at its root.
 */
export function replaceLocation(state: TabStacks, location: string): TabStep {
  const tab = rootTabOf(location);
  const stack = state.stacks[state.current];
  if (tab && (tab !== state.current || stack.length > 1))
    return step(withStack(state, tab, [location]));
  return step(
    withStack(state, state.current, [...stack.slice(0, -1), location]),
  );
}

/** Back: the current tab's stack popped once; at its root, nothing. */
export function goBack(state: TabStacks): TabStep {
  const stack = state.stacks[state.current];
  if (stack.length <= 1) return step(state);
  return step(withStack(state, state.current, stack.slice(0, -1)));
}

/** Signed out: every stack back to its root, on Home, with nowhere to go back to. */
export function cleared(): TabStacks {
  return { current: "home", stacks: rootsOnly() };
}
