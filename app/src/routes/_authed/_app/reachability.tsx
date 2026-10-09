import { createFileRoute } from "@tanstack/react-router";
import { ReachingYou } from "@/components/delivery/reaching-you";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/_app/reachability")({
  component: ReachabilityPage,
});

function ReachabilityPage() {
  return (
    <PageShell
      title="Reachability"
      description="Continue a conversation in Slack, Microsoft Teams, or by text message. Questions and approval requests reach the same person who owns the conversation."
    >
      <ReachingYou />
    </PageShell>
  );
}
