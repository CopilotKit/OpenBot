/**
 * What the page tells the native shell (`shell.ts`), as plain JSON objects:
 *
 * - `{ type: "ready" }` once, when the router has mounted.
 * - `{ type: "route", path, tab, signedIn, canGoBack }` on every change of page: the pathname only,
 *   never the query or the fragment; the tab whose stack the page is in (`use-tab-navigation.ts`;
 *   by the address, `tabForPath`, where the stacks have not started); and whether Back has somewhere
 *   to go inside that tab. Native sends `openbot:back` for its Back when it does.
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
