import { createFileRoute, Link } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { MemorySources } from "@/components/memory/sources";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/memory")({
  component: MemoryPage,
});

function MemoryPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Which connected apps feed this Bot facts, and the background research it does for you."
      title="Memory"
    >
      {(agent) => (
        <>
          <p className="mt-6 text-muted-foreground text-sm">
            What your Bots remember about you is in{" "}
            <Link
              className="underline underline-offset-4"
              to="/settings/memory"
            >
              Settings → Memory
            </Link>
            .
          </p>
          <MemorySources agentId={agent.id} />
          <ProactiveResearchSettings agentId={agent.id} />
        </>
      )}
    </BotSubpage>
  );
}
