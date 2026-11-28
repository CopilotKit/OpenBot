import { createFileRoute } from "@tanstack/react-router";
import { ConnectProviderPage } from "@/components/settings/provider-pages";
import {
  ProviderPathsContext,
  providerPaths,
  providerSearch,
  scopeOf,
} from "@/lib/ai-connection/paths";

const ADMIN = providerPaths("admin");

export const Route = createFileRoute("/_authed/admin/providers_/new")({
  validateSearch: providerSearch,
  component: function ConnectProviderRoute() {
    return (
      <ProviderPathsContext.Provider value={ADMIN}>
        <ConnectProviderPage scope={scopeOf(Route.useSearch())} />
      </ProviderPathsContext.Provider>
    );
  },
});
