import { createFileRoute } from "@tanstack/react-router";
import { ChangeProviderPage } from "@/components/settings/provider-pages";
import { providerSearch, scopeOf } from "@/lib/ai-connection/paths";

export const Route = createFileRoute(
  "/_authed/settings/providers_/$provider_/change",
)({
  validateSearch: providerSearch,
  component: function ChangeProviderRoute() {
    const { provider } = Route.useParams();
    return (
      <ChangeProviderPage id={provider} scope={scopeOf(Route.useSearch())} />
    );
  },
});
