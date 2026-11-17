import { createFileRoute } from "@tanstack/react-router";
import { DesktopReturn } from "@/components/desktop/desktop-return";
import { searchTextEntry } from "@/lib/search-text";

/**
 * Where an app's sign-in started in OpenBot Desktop comes back to, in the person's own browser. Not
 * behind sign-in: that browser is not the window, and the personal edition only admits requests
 * carrying its install's token, which only the window has. See `DesktopReturn`.
 */
export const Route = createFileRoute("/desktop-return")({
  validateSearch: (search: Record<string, unknown>): { app?: string } =>
    searchTextEntry("app", search.app),
  component: function DesktopReturnRoute() {
    const { app } = Route.useSearch();
    return <DesktopReturn app={app} />;
  },
});
