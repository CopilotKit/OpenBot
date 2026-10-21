import { createFileRoute, redirect } from "@tanstack/react-router";
import { searchTextEntry } from "@/lib/search-text";

/**
 * Connected accounts moved from Settings to their own page, Connections.
 *
 * Kept as a redirect, carrying `?connected=`, `?authorized=` and `?linked=`, because a consent
 * somebody began before an upgrade still comes back here: the vendor holds the return address it was
 * given at the time. Each is read as text whatever the router parsed it into, for the reason the
 * page it lands on gives (`searchText`): a report that happens to be digits must not be dropped on
 * the way through.
 */
export const Route = createFileRoute("/_authed/settings/connected-accounts/")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { connected?: string; authorized?: string; linked?: string } => ({
    ...searchTextEntry("connected", search.connected),
    ...searchTextEntry("authorized", search.authorized),
    ...searchTextEntry("linked", search.linked),
  }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/connections",
      search,
      replace: true,
    });
  },
});
