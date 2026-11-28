import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { isOwnPath, OPEN_REQUEST } from "@/lib/desktop/open-requests";

/**
 * Opens the page a clicked push notification points at, when OpenBot is already open: the service
 * worker brings this window to the front and sends it the page (`openFrom` in public/sw.js). A
 * route change, as a click on one of OpenBot Desktop's notifications is, so what the person was in
 * the middle of is kept.
 */
export function useServiceWorkerOpenRequests() {
  const router = useRouter();
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator))
      return;
    const container = navigator.serviceWorker;
    const open = (event: MessageEvent) => {
      const message = event.data as { type?: unknown; path?: unknown } | null;
      if (message?.type !== OPEN_REQUEST || !isOwnPath(message.path)) return;
      router.history.push(message.path);
    };
    container.addEventListener("message", open);
    return () => container.removeEventListener("message", open);
  }, [router]);
}
