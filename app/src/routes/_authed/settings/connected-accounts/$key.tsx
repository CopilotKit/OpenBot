import { createFileRoute, redirect } from "@tanstack/react-router";
import { searchTextEntry } from "@/lib/search-text";

/**
 * One connected account, moved from Settings to Connections with the rest.
 *
 * Carries `?action=` through, because the per-action verifier of a consent begun before an upgrade
 * still lands here to say which action was just authorized.
 */
export const Route = createFileRoute(
  "/_authed/settings/connected-accounts/$key",
)({
  validateSearch: (search: Record<string, unknown>): { action?: string } =>
    searchTextEntry("action", search.action),
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/connections/$key",
      params,
      search,
      replace: true,
    });
  },
});
