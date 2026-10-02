import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BotProfile } from "@/components/bot-profile/profile";
import { PageShell } from "@/components/layout/page-shell";
import { agentQueryOptions } from "@/lib/agents/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId")({
  component: BotProfilePage,
});

function BotProfilePage() {
  const { agentId } = Route.useParams();
  const agent = useQuery(agentQueryOptions(agentId));
  return (
    <PageShell
      backButton={{ label: "Bots", linkProps: { to: "/bots" } }}
      description="What this Bot is doing for you, and how it runs."
      title={agent.data?.name ?? "Bot"}
    >
      {agent.isPending ? null : agent.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          This Bot is not one you can reach.
        </p>
      ) : (
        <BotProfile agent={agent.data} />
      )}
    </PageShell>
  );
}
