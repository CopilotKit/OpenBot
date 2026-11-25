import { createFileRoute } from "@tanstack/react-router";
import { ChangeProviderPage } from "@/components/settings/provider-pages";
import {
  ProviderPathsContext,
  providerPaths,
  providerSearch,
  scopeOf,
} from "@/lib/ai-connection/paths";

const ADMIN = providerPaths("admin");

export const Route = createFileRoute(
  "/_authed/admin/providers_/$provider_/change",
)({
  validateSearch: providerSearch,
  component: function ChangeProviderRoute() {
    const { provider } = Route.useParams();
    return (
      <ProviderPathsContext.Provider value={ADMIN}>
        <ChangeProviderPage id={provider} scope={scopeOf(Route.useSearch())} />
      </ProviderPathsContext.Provider>
    );
  },
});
