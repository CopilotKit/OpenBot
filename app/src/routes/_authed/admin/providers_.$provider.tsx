import { createFileRoute } from "@tanstack/react-router";
import { ProviderPage } from "@/components/settings/provider-pages";
import {
  ProviderPathsContext,
  providerPaths,
  providerSearch,
  scopeOf,
} from "@/lib/ai-connection/paths";

const ADMIN = providerPaths("admin");

export const Route = createFileRoute("/_authed/admin/providers_/$provider")({
  validateSearch: providerSearch,
  component: function ProviderRoute() {
    const { provider } = Route.useParams();
    const search = Route.useSearch();
    return (
      <ProviderPathsContext.Provider value={ADMIN}>
        <ProviderPage
          connected={search.connected}
          id={provider}
          scope={scopeOf(search)}
        />
      </ProviderPathsContext.Provider>
    );
  },
});
