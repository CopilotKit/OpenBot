import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { LearningReview } from "@/components/settings/learning-review";
import { LearningSharing } from "@/components/settings/learning-sharing";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/settings/learning")({
  component: LearningSettingsPage,
});

export function LearningSettingsPage() {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const personal = capabilities?.edition === "personal";
  return (
    <PageShell
      title="Learning"
      description={
        personal
          ? "Your recordings and conversations teach your Bots new skills. Review what they learned here."
          : "Every recording you make goes into your own Learning space, and the Skills learned there reach every Bot you use. Choose who else's Bots may use them too."
      }
    >
      <LearningReview />
      <LearningSharing />
    </PageShell>
  );
}
