/**
 * What the page tells the native shell (`shell.ts`), as plain JSON objects:
 *
 * - `{ type: "ready" }` once, when the router has mounted.
 * - `{ type: "route", path, tab, signedIn, canGoBack }` on every change of page: the pathname only,
 *   never the query or the fragment; the tab whose stack the page is in (`use-tab-navigation.ts`;
 *   by the address, `tabForPath`, where the stacks have not started); and whether Back has somewhere
 *   to go inside that tab. Native sends `openbot:back` for its Back when it does.
 *   It also carries `depth`, how many locations the current tab's stack holds (1 at its root, so
 *   `canGoBack` is `depth > 1`), and `scrollRestored: true`: a list returned to by Back has its
 *   `route` sent once its scroll position is back.
 * - `{ type: "will-navigate", tab, direction, depth }` before the page changes what is on screen,
 *   for a navigation inside a tab that the page started itself (a row, a link, its own Back) and
 *   that changes the path. `direction` is "push", "back" or "replace"; `depth` is where it leads.
 *   Not for a tab switch, a tap on the current tab, or Back native asked for (`openbot:back`). On
 *   iOS the page then waits for `openbot:navigate-ok` on `window`, at most 120 ms, before it shows
 *   the new page, so the app can take its snapshot for the swipe back.
 * - `{ type: "signed-out" }` when the page reaches the signed-out state, where the shell shows its
 *   own sign-in screen.
 *
 * On iOS through `window.webkit.messageHandlers.openbotShell`, on Android through
 * `window.OpenBotShellAndroid.postMessage(json)`. Nothing happens where neither is there.
 *
 * The shell asks for a page with the `openbot:open` event OpenBot Desktop already sends
 * (`lib/desktop/open-requests.ts`).
 */

/** The shell's tabs. */
export type NativeTab = "conversations" | "home" | "bots";

export type ShellMessage =
  | { type: "ready" }
  | {
      type: "route";
      path: string;
      tab: NativeTab | null;
      signedIn: boolean;
      canGoBack: boolean;
      /** How many locations the current tab's stack holds: 1 at its root. */
      depth: number;
      /** Always true: a page whose list position is being put back is reported once it is. */
      scrollRestored: true;
    }
  | {
      /** Sent before the page changes what is on screen, for a navigation the page started. */
      type: "will-navigate";
      tab: NativeTab;
      direction: "push" | "back" | "replace";
      /** The depth the navigation leads to. */
      depth: number;
    }
  | { type: "signed-out" };

type ShellWindow = {
  webkit?: {
    messageHandlers?: {
      openbotShell?: { postMessage(message: unknown): void };
    };
  };
  OpenBotShellAndroid?: { postMessage(message: string): void };
};

/** Whether a shell is listening for messages: its iOS handler or its Android object is there. */
export function shellListens(
  target: ShellWindow = window as ShellWindow,
): boolean {
  try {
    return Boolean(
      target.webkit?.messageHandlers?.openbotShell ??
        target.OpenBotShellAndroid,
    );
  } catch {
    return false;
  }
}

/** Sends `message` to the shell. Never throws: the shell not listening is no fault of the page's. */
export function postToShell(
  message: ShellMessage,
  target: ShellWindow = window as ShellWindow,
): void {
  try {
    const ios = target.webkit?.messageHandlers?.openbotShell;
    if (ios) {
      ios.postMessage(message);
      return;
    }
    target.OpenBotShellAndroid?.postMessage(JSON.stringify(message));
  } catch {
    // A shell that went away mid-message has nothing to hear.
  }
}

/**
 * Which of the shell's tabs a page belongs to, or null for a page none of them owns (Settings, a
 * routine, Admin): Home and `/bot` are Home's; the conversations list and every conversation,
 * started or starting, are Conversations'; the Bots list and every Bot's pages are Bots'.
 */
export function tabForPath(pathname: string): NativeTab | null {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.replace(/\/+$/, "") || "/"
      : pathname;
  if (path === "/" || path === "/bot") return "home";
  if (path === "/conversations" || /^\/(channel|group|start)\/./.test(path))
    return "conversations";
  if (path === "/bots" || path.startsWith("/bots/")) return "bots";
  return null;
}
