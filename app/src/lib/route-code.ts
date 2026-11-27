import type { AnyRouter } from "@tanstack/react-router";

/**
 * The router asks each route's code to load only after the parents' `beforeLoad` gates have finished, so a page's
 * code waits behind the sign-in checks even though it does not depend on them. This starts every matched route's
 * code as soon as a navigation begins, in step with the gates. The router loads the chunk again itself and reports
 * its own failure, so a failure here is dropped. Returns the unsubscribe.
 */
export function loadCodeEarly(router: AnyRouter): () => void {
  return router.subscribe("onBeforeLoad", (event) => {
    for (const match of router.matchRoutes(event.toLocation)) {
      router
        .loadRouteChunk(router.routesById[match.routeId])
        ?.catch(() => undefined);
    }
  });
}
