import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { queryClient } from "@/query-client";
import { router } from "@/router";

/**
 * The whole app as main.tsx mounts it, on the real route tree (app/src/routeTree.gen.ts), for
 * moved-apps-reconnect.test.tsx to bundle and load in a real browser. The server is the test's own,
 * answering at the API's addresses through the browser's routes, so what it holds lasts through a
 * reload as a real server's does.
 */

/** No socket: nothing here answers one. */
class OfflineWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 3;
  onclose = null;
  onerror = null;
  onmessage = null;
  onopen = null;
  close() {}
  send() {}
}
globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>,
  );
