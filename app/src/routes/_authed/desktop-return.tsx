import { createFileRoute } from "@tanstack/react-router";
import { DesktopReturn } from "@/components/desktop/desktop-return";
import { searchTextEntry } from "@/lib/search-text";

/** Where an app's sign-in started in OpenBot Desktop comes back to. See `DesktopReturn`. */
export const Route = createFileRoute("/_authed/desktop-return")({
  validateSearch: (search: Record<string, unknown>): { app?: string } =>
    searchTextEntry("app", search.app),
  component: function DesktopReturnRoute() {
    const { app } = Route.useSearch();
    return <DesktopReturn app={app} />;
  },
});
