import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /**
     * Routes that hand over to each other without the person noticing share one arrival key, so
     * the page keeps its wrapper and doesn't fade in a second time.
     */
    arrival?: string;
  }
}

/**
 * Wraps the page in the app shell so each new page fades in instead of snapping.
 *
 * The key is the leaf route's arrival key, or its id when it has none, not the path: two
 * conversations or two Bots are the same route with other params, so they share one wrapper and
 * keep their place, while a different page gets a fresh wrapper and its fade plays again. Pages
 * that hand over to each other unseen, such as the placeholder a first message from home shows
 * and the conversation that replaces it, share an arrival key so the handover doesn't blink.
 */
export function PageArrival({ children }: { children: ReactNode }) {
  const arrivalKey = useRouterState({
    select: (s) => {
      const leaf = s.matches.at(-1);
      return leaf?.staticData?.arrival ?? leaf?.routeId;
    },
  });
  return (
    <div className="page-arrival flex min-h-0 flex-1 flex-col" key={arrivalKey}>
      {children}
    </div>
  );
}
