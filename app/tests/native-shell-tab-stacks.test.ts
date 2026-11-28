import { describe, expect, test } from "bun:test";
import {
  canGoBack,
  cleared,
  goBack,
  pushLocation,
  replaceLocation,
  stacksFor,
  type TabStacks,
  tapTab,
  topOf,
} from "../src/lib/native-shell/tab-stacks";

/*
 * Where each of the phone app's tabs is (lib/native-shell/tab-stacks.ts): one stack per tab, as a
 * native tab bar app keeps them.
 */

/** Runs steps from a cold start at `start`, each a push, a tap, a replace or Back. */
function walk(
  start: string,
  steps: (["push" | "tap" | "replace", string] | ["back"])[],
): { state: TabStacks; scrolled: boolean } {
  let state = stacksFor(start);
  let scrolled = false;
  for (const [kind, location] of steps) {
    const next =
      kind === "back"
        ? goBack(state)
        : kind === "tap"
          ? tapTab(state, location)
          : kind === "push"
            ? pushLocation(state, location)
            : replaceLocation(state, location);
    expect(next.show).toBe(topOf(next.state));
    scrolled = next.scrollToTop === true;
    state = next.state;
  }
  return { state, scrolled };
}

describe("the phone app's tab stacks", () => {
  test("going deeper pushes onto the current tab's stack, and the page belongs to that tab", () => {
    const { state } = walk("/bots", [["push", "/channel/c-hiring"]]);
    expect(state.current).toBe("bots");
    expect(state.stacks.bots).toEqual(["/bots", "/channel/c-hiring"]);
    // The Chats tab is where it was: at its root.
    expect(state.stacks.conversations).toEqual(["/conversations"]);
    expect(canGoBack(state)).toBe(true);
  });

  test("a conversation sent from Home is in Home's stack", () => {
    const { state } = walk("/", [
      ["push", "/start/s-1"],
      ["replace", "/channel/c-new"],
    ]);
    expect(state.current).toBe("home");
    expect(state.stacks.home).toEqual(["/", "/channel/c-new"]);
  });

  test("switching away and back shows the tab exactly where it was left", () => {
    const { state } = walk("/conversations", [
      ["push", "/channel/c-forecast"],
      ["tap", "/bots"],
      ["push", "/bots/research-bot"],
      ["tap", "/conversations"],
    ]);
    expect(state.current).toBe("conversations");
    expect(topOf(state)).toBe("/channel/c-forecast");
    // And Bots kept its own place.
    expect(state.stacks.bots).toEqual(["/bots", "/bots/research-bot"]);
  });

  test("tapping the current tab pops it to its root; at its root, scrolls to the top", () => {
    const popped = walk("/conversations", [
      ["push", "/channel/c-forecast"],
      ["push", "/settings"],
      ["tap", "/conversations"],
    ]);
    expect(popped.state.stacks.conversations).toEqual(["/conversations"]);
    expect(topOf(popped.state)).toBe("/conversations");
    expect(popped.scrolled).toBe(false);
    const atRoot = walk("/conversations", [["tap", "/conversations"]]);
    expect(atRoot.scrolled).toBe(true);
    expect(topOf(atRoot.state)).toBe("/conversations");
  });

  test("Back pops only the current tab, never into another tab's pages", () => {
    const { state } = walk("/conversations", [
      ["push", "/channel/c-forecast"],
      ["tap", "/bots"],
      ["push", "/bots/research-bot"],
      ["back"],
    ]);
    expect(state.current).toBe("bots");
    expect(topOf(state)).toBe("/bots");
    const again = goBack(state);
    // At Bots' root: nothing, and still Bots, not the conversation left open in Chats.
    expect(again.state).toEqual(state);
    expect(again.show).toBe("/bots");
    expect(canGoBack(again.state)).toBe(false);
  });

  test("at a root Back does nothing and canGoBack is false", () => {
    for (const root of ["/conversations", "/", "/bots"]) {
      const state = stacksFor(root);
      expect(canGoBack(state)).toBe(false);
      expect(goBack(state).state).toEqual(state);
    }
  });

  test("a deep link builds its stack from the address, so Back has somewhere to go", () => {
    expect(stacksFor("/channel/c-forecast").stacks.conversations).toEqual([
      "/conversations",
      "/channel/c-forecast",
    ]);
    expect(stacksFor("/channel/c-forecast").current).toBe("conversations");
    expect(stacksFor("/bots/research-bot").stacks.bots).toEqual([
      "/bots",
      "/bots/research-bot",
    ]);
    // A page no tab owns belongs to Home when nothing says otherwise.
    const settings = stacksFor("/settings/notifications");
    expect(settings.current).toBe("home");
    expect(settings.stacks.home).toEqual(["/", "/settings/notifications"]);
    expect(canGoBack(settings)).toBe(true);
    // A root's search is kept: New Bot's sheet.
    expect(stacksFor("/bots?new=true").stacks.bots).toEqual(["/bots?new=true"]);
  });

  test("a page opened from the Account menu goes onto the tab it was opened from", () => {
    const { state } = walk("/bots", [
      ["push", "/settings"],
      ["push", "/settings/notifications"],
    ]);
    expect(state.current).toBe("bots");
    expect(state.stacks.bots).toEqual([
      "/bots",
      "/settings",
      "/settings/notifications",
    ]);
    const back = goBack(goBack(state).state);
    expect(topOf(back.state)).toBe("/bots");
  });

  test("a search change replaces the top, and the same location again pushes nothing", () => {
    const { state } = walk("/bots", [
      ["replace", "/bots?new=true"],
      ["replace", "/bots"],
      ["push", "/bots/research-bot"],
      ["push", "/bots/research-bot"],
    ]);
    expect(state.stacks.bots).toEqual(["/bots", "/bots/research-bot"]);
  });

  test("signing out clears every stack", () => {
    const { state } = walk("/conversations", [
      ["push", "/channel/c-forecast"],
      ["tap", "/bots"],
      ["push", "/bots/research-bot"],
    ]);
    expect(state.stacks.bots.length).toBe(2);
    const empty = cleared();
    expect(empty.current).toBe("home");
    expect(empty.stacks).toEqual({
      conversations: ["/conversations"],
      home: ["/"],
      bots: ["/bots"],
    });
    expect(canGoBack(empty)).toBe(false);
  });
});
