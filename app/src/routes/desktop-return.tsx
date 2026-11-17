import { createFileRoute } from "@tanstack/react-router";
import { DesktopReturn } from "@/components/desktop/desktop-return";
import { searchTextEntry } from "@/lib/search-text";

/**
 * Where an app's sign-in started in OpenBot Desktop comes back to, in the person's own browser. Not
 * behind sign-in: that browser is not the window, and the personal edition only admits requests
 * carrying its install's token, which only the window has. See `DesktopReturn`.
 */
export const Route = createFileRoute("/desktop-return")({
  /*
   * `status` is the broker's own report, added to the address on the way back (`success` or
   * `failed`). It decides only what the page says; the window confirms the account itself.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): { app?: string; status?: string } => ({
    ...searchTextEntry("app", search.app),
    ...searchTextEntry("status", search.status),
  }),
  component: function DesktopReturnRoute() {
    const { app, status } = Route.useSearch();
    return <DesktopReturn app={app} status={status} />;
  },
});
