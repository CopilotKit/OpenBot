import { createFileRoute } from "@tanstack/react-router";
import { ProviderPage } from "@/components/settings/provider-pages";
import { providerSearch, scopeOf } from "@/lib/ai-connection/paths";

export const Route = createFileRoute("/_authed/settings/providers_/$provider")({
  validateSearch: providerSearch,
  component: function ProviderRoute() {
    const { provider } = Route.useParams();
    const search = Route.useSearch();
    return (
      <ProviderPage
        connected={search.connected}
        id={provider}
        scope={scopeOf(search)}
      />
    );
  },
});
