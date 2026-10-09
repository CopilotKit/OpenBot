import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { BotResponsibilities } from "@/components/responsibilities/responsibilities";

export const Route = createFileRoute("/_authed/_app/responsibilities")({
  component: ResponsibilitiesPage,
});

function ResponsibilitiesPage() {
  return (
    <PageShell
      title="Responsibilities"
      description="Give a Bot a lasting goal, follow its progress, and decide when it should work."
    >
      <BotResponsibilities />
    </PageShell>
  );
}
