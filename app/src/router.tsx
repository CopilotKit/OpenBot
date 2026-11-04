import { createRouter } from "@tanstack/react-router";
import { PAGE_SCROLLER } from "./components/layout/page-parts";
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
  /*
   * Coming back to a list lands where it was left, not at the top. Keyed on the address rather than
   * the history entry, because the way back from a detail screen is usually its "<" button, which
   * is a link — a new entry — and keyed by entry it would always find nothing to restore and start
   * the list over. By address, the list is the list however it is reached.
   *
   * The pages scroll in two places: the document, under `_authed`, and PageShell's own scroller
   * under `_authed/_app`, which carries `data-scroll-restoration-id` so it is found by name. It is
   * also listed as a scroll-to-top target, so a page opened for the first time starts at its top
   * instead of inheriting how far down the previous page was.
   */
  scrollRestoration: true,
  getScrollRestorationKey: (location) => location.pathname + location.searchStr,
  scrollToTopSelectors: [`[data-scroll-restoration-id="${PAGE_SCROLLER}"]`],
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
