import type { AnyRouter } from "@tanstack/react-router";

/**
 * The router asks each route's code to load only after the parents' `beforeLoad` gates have finished, so a page's
 * code waits behind the sign-in checks even though it does not depend on them. This starts every matched route's
 * code as soon as a navigation begins, in step with the gates. The router shares this load rather than starting its
 * own while it is still running, so a failure that lands before the router asks is reported by the router as its own
 * and fails the page exactly as a load of its own would have. A load that has already failed clears itself, so the
 * router then tries again. Either way the router reports the failure, so the catch here only keeps it from also
 * surfacing as an unhandled rejection. Returns the unsubscribe.
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
