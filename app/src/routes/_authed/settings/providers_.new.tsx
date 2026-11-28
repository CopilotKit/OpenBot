import { createFileRoute } from "@tanstack/react-router";
import { ConnectProviderPage } from "@/components/settings/provider-pages";
import { providerSearch, scopeOf } from "@/lib/ai-connection/paths";

export const Route = createFileRoute("/_authed/settings/providers_/new")({
  validateSearch: providerSearch,
  component: function ConnectProviderRoute() {
    return <ConnectProviderPage scope={scopeOf(Route.useSearch())} />;
  },
});
