import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ModelAllowlistSection,
  ModelChoiceSection,
  ModelUsageSection,
  ProviderSection,
} from "@/components/admin/controls/model-sections";
import { PageShell } from "@/components/layout/page-shell";
import {
  AI_PROVIDERS_TITLE,
  ProviderPathsContext,
  providerPaths,
} from "@/lib/ai-connection/paths";
import { availableModelsQueryOptions } from "@/lib/models/queries";

export const Route = createFileRoute("/_authed/admin/providers")({
  component: ProvidersPage,
});

/**
 * Admin, AI providers: the AI provider Bots run on, which an admin changes or disconnects here, which
 * models people may pick, and what Bots ran on. Named for the provider rather than the model so a
 * second provider has a place to go.
 *
 * One person on their own machine is offered every model the credential lists, so there is nothing
 * to allow and no allowlist is shown. A team picks from every listed model too, until an admin
 * narrows it here.
 */
const ADMIN = providerPaths("admin");

export function ProvidersPage() {
  const available = useQuery(availableModelsQueryOptions());
  const team = available.data?.exposure === "allowed";
  return (
    // Each provider's row leads to its page here, under Admin, not to Settings'.
    <ProviderPathsContext.Provider value={ADMIN}>
      <PageShell
        description={
          team
            ? "Choose the AI provider your Bots run on and which models people may pick. All changes appear in Activity."
            : "Choose the AI provider your Bots run on, and see what they ran on."
        }
        title={AI_PROVIDERS_TITLE}
      >
        <ProviderSection />
        <ModelChoiceSection />
        {team ? <ModelAllowlistSection /> : null}
        <ModelUsageSection team={team} />
      </PageShell>
    </ProviderPathsContext.Provider>
  );
}
