import { createFileRoute } from "@tanstack/react-router";
import {
  ModelAllowlistSection,
  ModelChoiceSection,
  ModelUsageSection,
  ProviderSection,
} from "@/components/admin/controls/model-sections";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/providers")({
  component: ProvidersPage,
});

/**
 * Admin, Providers: what serves the models built-in Bots run on, which models people may pick,
 * the allowlist, and what Bots ran on. Named for the provider rather than the model so a second
 * provider has a place to go.
 */
export function ProvidersPage() {
  return (
    <PageShell
      description="See which provider serves your Bots' models, and choose which models they may run on. All changes appear in Audit."
      title="Providers"
    >
      <ProviderSection />
      <ModelChoiceSection />
      <ModelAllowlistSection />
      <ModelUsageSection />
    </PageShell>
  );
}
