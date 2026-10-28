import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { LearningSharing } from "@/components/settings/learning-sharing";

export const Route = createFileRoute("/_authed/settings/learning")({
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
