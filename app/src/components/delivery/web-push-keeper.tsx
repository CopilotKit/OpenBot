import { useEffect } from "react";
import { useCurrentOrganizationId } from "@/lib/organizations/current";
import { keepThisBrowserSaved } from "@/lib/web-push/mutations";
import { queryClient } from "@/query-client";

/** What the service worker sends when the browser renewed this browser's subscription. */
const RESAVE = "openbot:resave";

/**
 * Keeps the server's copy of this browser's push subscription current while OpenBot is open: saved
 * again each time OpenBot starts in an organization, and when the service worker says the browser
 * renewed it. Draws nothing, and does nothing where notifications are off in this browser.
 *
 * A save that fails is left for the next start (`keepThisBrowserSaved`): nothing the person did
 * failed, and the browser still holds its subscription.
 */
export function WebPushKeeper() {
  const organization = useCurrentOrganizationId();
  useEffect(() => {
    if (organization === undefined) return;
    void keepThisBrowserSaved(queryClient).catch(() => undefined);
  }, [organization]);
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
      return;
    const container = navigator.serviceWorker;
    const resave = (event: MessageEvent) => {
      if ((event.data as { type?: unknown } | null)?.type !== RESAVE) return;
      void keepThisBrowserSaved(queryClient).catch(() => undefined);
    };
    container.addEventListener("message", resave);
    return () => container.removeEventListener("message", resave);
  }, []);
  return null;
}
