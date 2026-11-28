import { createRouter } from "@tanstack/react-router";
import { ReportedErrorComponent } from "./lib/error-reporting";
import { loadCodeEarly } from "./lib/route-code";
import { parseSearchText } from "./lib/search-text";
import type { RouterContext } from "./router-context";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  context: {} as RouterContext,
  /*
   * The router's own search parsing, minus the numbers it cannot render back: see
   * `parseSearchText`. Every route that reads a parameter as text reads it through `searchText`,
   * which needs what arrives to be something that text can be recovered from.
   */
  parseSearch: parseSearchText,
  // The router's own error screen, which also tells OpenBot what it caught (lib/error-reporting.tsx).
  defaultErrorComponent: ReportedErrorComponent,
  /*
   * Links load their page when a pointer rests on them. The query cache decides what is fresh, so
   * the router asks its loaders every time and does not keep a second opinion of its own. The
   * default 50 ms intent delay stays, so a pointer passing over a long sidebar does not flood the
   * server.
   */
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
});

/*
 * The page's code, and `_authed`'s chunk with the large shared chunk, download while the sign-in
 * gates are asked instead of after them. router-core 1.171.27 emits `onBeforeLoad` before any
 * `beforeLoad`.
 */
loadCodeEarly(router);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
