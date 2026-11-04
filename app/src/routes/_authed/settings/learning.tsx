import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { LearningSharing } from "@/components/settings/learning-sharing";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/settings/learning")({
  // Who else's Bots use your Skills: the personal edition has nobody else, so no page.
  beforeLoad: async ({ context }) => {
    const capabilities = await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    if (capabilities?.edition === "personal") {
      throw redirect({ to: "/settings" });
    }
  },
  component: LearningSettingsPage,
});

/** Who else's Bots use the Skills learned from your own recordings. */
function LearningSettingsPage() {
  return (
    <PageShell
      title="Learning"
      description="Every recording you make goes into your own Learning space, and the Skills learned there reach every Bot you use. Choose who else's Bots may use them too."
    >
      <LearningSharing />
    </PageShell>
  );
}
