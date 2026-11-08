import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { MemorySources } from "@/components/memory/sources";
import { ProactiveResearchSettings } from "@/components/suggestions/proactive-panel";
import { deploymentOffersMemory } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/memory")({
  /*
   * The personal edition has no memory (see `offersMemory`). This Bot's check-ins, the other half of
   * this page, are on What it can do there, so an old link to this page opens that.
   */
  beforeLoad: async ({ context, params }) => {
    if (!(await deploymentOffersMemory(context.queryClient))) {
      throw redirect({
        to: "/bots/$agentId/access",
        params: { agentId: params.agentId },
        replace: true,
      });
    }
  },
  component: MemoryPage,
});

function MemoryPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Choose which apps this Bot learns from and manage its check-ins."
      title="Memory"
    >
      {(agent) => (
        <>
          <p className="mt-6 text-muted-foreground text-sm">
            What your Bots remember about you is in{" "}
            <Link
              className="underline underline-offset-4"
              to="/capabilities/memory"
            >
              Capabilities
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
