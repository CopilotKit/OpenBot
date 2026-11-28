import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { nativeShell } from "@/lib/native-shell/shell";
import { openFromShell } from "@/lib/native-shell/use-tab-navigation";

/**
 * The event OpenBot Desktop dispatches on the window when a click on a notification asks for one of
 * OpenBot's pages (`navigate_to_notice_page` in desktop/src-tauri). Its `detail.path` is the page.
 */
export const OPEN_REQUEST = "openbot:open";

/** A page path of this OpenBot: `/channel/c-1`, never another site or a protocol-relative link. */
export function isOwnPath(path: unknown): path is string {
  return (
    typeof path === "string" && path.startsWith("/") && !path.startsWith("//")
  );
}

/**
 * Opens the page a click on a notification asked for, as a route change: what the person was in the
 * middle of (a draft, an open dialog, a conversation's live stream) is kept, where loading the page
 * again lost it. The event is cancelled to tell the shell it was handled; an OpenBot page from before
 * this leaves it, and the shell loads the page instead.
 *
 * The phone app's native shell asks the same way when one of its tabs is tapped, and there the tabs'
 * own stacks decide what it means (`lib/native-shell/use-tab-navigation.ts`). Elsewhere a page that
 * is already open is handled and left as it is, as the sidebar's link to it does: Home keeps what is
 * in its box, a conversation its scroll.
 */
export function useDesktopOpenRequests() {
  const router = useRouter();
  useEffect(() => {
    const open = (event: Event) => {
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
      if (!isOwnPath(path)) return;
      event.preventDefault();
      // In the phone app's native shell a tab's root is a tab tap, kept by the tabs' own stacks.
      if (nativeShell() && openFromShell(path)) return;
      const here = router.history.location;
      if (path === here.pathname + here.search + here.hash) return;
      router.history.push(path);
    };
    window.addEventListener(OPEN_REQUEST, open);
    return () => window.removeEventListener(OPEN_REQUEST, open);
  }, [router]);
}
