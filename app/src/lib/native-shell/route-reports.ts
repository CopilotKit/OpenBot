import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { postToShell, type ShellMessage, tabForPath } from "./bridge";
import { nativeShell } from "./shell";
import { shellTabState } from "./use-tab-navigation";

/**
 * WHEN THE SHELL HEARS `ready`: once per page load, when the first page has drawn something a person
 * can read. The shell keeps its own loading screen over the web view until then, so `ready` sent at
 * boot showed an empty page under the tabs for as long as a slow server took to answer.
 *
 * The rule, in this order:
 *
 * 1. The router has settled on the first address: it is idle with a resolved location, so no route
 *    is still loading and no pending component (the app frame's skeleton) stands in for the page.
 * 2. The page then shows readable text (`hasReadableText`): not a skeleton, not text kept for a
 *    screen reader alone, not something hidden. A page whose own data is still loading draws none,
 *    so it waits; an error screen has its words, so it counts. The signed-out page inside the shell
 *    (`components/auth/native-signed-out.tsx`) draws only the orb, by design, and counts as drawn.
 *    Watched with a MutationObserver from the moment the router settles, so no polling.
 * 3. Whatever happens, `ready` goes `READY_FALLBACK_MS` after the reports start, so a page whose
 *    drawing this cannot see still hands the screen over.
 *
 * THE ORDER THE SHELL CAN RELY ON: `ready` first, exactly once. Until then whatever else the page
 * would say (`route`, `signed-out`) is held and then sent, in the order it was said, right after
 * `ready`. So the first `route` always follows `ready`, and every `route` after it follows the
 * navigation it reports.
 */
export const READY_FALLBACK_MS = 20_000;

/** `ready` goes once per page load, not once per mount (StrictMode mounts twice in development). */
let readySent = false;
/** Whether the reports are running, so that what the page says waits for `ready`. */
let holding = false;
/** What the page said before `ready`, in order. */
let held: ShellMessage[] = [];

/** How long the fallback waits: `READY_FALLBACK_MS`, shorter only in tests. */
let fallbackMs = READY_FALLBACK_MS;

/** For tests: let the next mount say `ready` again, its fallback after `fallback` ms. */
export function forgetReadyForTests(fallback = READY_FALLBACK_MS): void {
  fallbackMs = fallback;
  readySent = false;
  holding = false;
  held = [];
}

function sendReady(): void {
  if (readySent) return;
  readySent = true;
  postToShell({ type: "ready" });
  const waiting = held;
  held = [];
  for (const message of waiting) postToShell(message);
}

/**
 * Tells the shell `message`, after `ready` when the reports are running and `ready` has not gone
 * yet. Everything the page says to the shell, but `ready`, goes through here.
 */
export function tellShell(
  message: Exclude<ShellMessage, { type: "ready" }>,
): void {
  if (holding && !readySent) held.push(message);
  else postToShell(message);
}

/** What does not count as text a person can read: hidden, for screen readers alone, a skeleton. */
const NOT_READABLE = [
  "[hidden]",
  '[aria-hidden="true"]',
  ".sr-only",
  '[data-slot="skeleton"]',
  "script",
  "style",
  "noscript",
  "template",
].join(", ");

/**
 * Whether `root` shows text a person can read: a text node with words in it whose element is not
 * hidden, not kept for a screen reader alone and not a skeleton, and, where the browser can say
 * (`checkVisibility`), is drawn at all.
 */
export function hasReadableText(root: Node = document.body): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const element = node.parentElement;
    if (!element || element.closest(NOT_READABLE)) continue;
    if (
      typeof element.checkVisibility === "function" &&
      !element.checkVisibility({
        visibilityProperty: true,
        opacityProperty: false,
      })
    )
      continue;
    return true;
  }
  return false;
}

/** Whether the page has drawn what it is for (see the rule above). */
function drawn(): boolean {
  return (
    document.querySelector('[data-slot="native-signed-out"]') !== null ||
    hasReadableText()
  );
}

/**
 * Tells the native shell when the first page has drawn (`ready`, above), then where the page is after
 * every navigation that settled: the pathname, the shell's tab for it, and whether the page is behind
 * the sign-in gate (`/_authed`), which only a signed-in person reaches. Nothing outside the shell.
 *
 * Mounted once, at the root, so pages outside the gate (`/sign`) are told too.
 */
export function useNativeShellRouteReports(): void {
  const inShell = nativeShell() !== null;
  const settled = useRouterState({
    select: (state) =>
      state.status === "idle" && state.resolvedLocation
        ? `${state.matches.some((match) => match.routeId === "/_authed") ? "1" : "0"}${state.resolvedLocation.pathname}`
        : null,
  });

  /*
   * Hold what the page says until `ready`, from this render on: a page's own effects (`signed-out`)
   * run before this component's, so an effect here would start holding too late. Idempotent.
   */
  if (inShell && !readySent) holding = true;

  // Hand the screen over in the end whatever happens.
  useEffect(() => {
    if (!inShell || readySent) return;
    const fallback = setTimeout(sendReady, fallbackMs);
    return () => clearTimeout(fallback);
  }, [inShell]);

  // Once the router has settled, `ready` as soon as the page shows something to read.
  const hasSettled = settled !== null;
  useEffect(() => {
    if (!inShell || readySent || !hasSettled) return;
    if (drawn()) {
      sendReady();
      return;
    }
    const observer = new MutationObserver(() => {
      if (readySent) observer.disconnect();
      else if (drawn()) {
        observer.disconnect();
        sendReady();
      }
    });
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [inShell, hasSettled]);

  useEffect(() => {
    if (!inShell || settled === null) return;
    const path = settled.slice(1);
    // The tab whose stack the page is in, and whether Back can go anywhere in it. The sign-in page
    // is in no tab: the shell shows its own sign-in over it.
    const tabs = path === "/sign" ? null : shellTabState();
    tellShell({
      type: "route",
      path,
      tab: tabs ? tabs.tab : tabForPath(path),
      signedIn: settled.startsWith("1"),
      canGoBack: tabs?.canGoBack ?? false,
    });
  }, [inShell, settled]);
}
