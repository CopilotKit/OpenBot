import { createRouter } from "@tanstack/react-router";
import { ReportedErrorComponent } from "./lib/error-reporting";
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
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
