import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * Wraps the page in the app shell so each new page fades in instead of snapping.
 *
 * The key is the leaf route's id, not the path: two conversations or two Bots are the same route
 * with other params, so they share one wrapper and keep their place, while a different page gets a
 * fresh wrapper and its fade plays again.
 */
export function PageArrival({ children }: { children: ReactNode }) {
  const leafRouteId = useRouterState({
    select: (s) => s.matches.at(-1)?.routeId,
  });
  return (
    <div
      className="page-arrival flex min-h-0 flex-1 flex-col"
      key={leafRouteId}
    >
      {children}
    </div>
  );
}
