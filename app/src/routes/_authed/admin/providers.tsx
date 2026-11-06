import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ModelAllowlistSection,
  ModelChoiceSection,
  ModelUsageSection,
  ProviderSection,
} from "@/components/admin/controls/model-sections";
import { availableModelsQueryOptions } from "@/lib/models/queries";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/providers")({
  component: ProvidersPage,
});

/**
 * Admin, Providers: what serves the models built-in Bots run on, which models people may pick, and
 * what Bots ran on. Named for the provider rather than the model so a second provider has a place
 * to go.
 *
 * One person on their own machine is offered every model the credential lists, so there is nothing
 * to allow and no allowlist is shown. A team picks among the models an admin allows here.
 */
export function ProvidersPage() {
  const available = useQuery(availableModelsQueryOptions());
  const team = available.data?.exposure === "allowed";
  return (
    <PageShell
      description={
        team
          ? "See which provider serves your Bots' models, and choose which models people may pick. All changes appear in Audit."
          : "See which provider serves your Bots' models and what they ran on."
      }
      title="Providers"
    >
      <ProviderSection />
      <ModelChoiceSection />
      {team ? <ModelAllowlistSection /> : null}
      <ModelUsageSection team={team} />
    </PageShell>
  );
}
