import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { MemorySources } from "@/components/memory/sources";
import { deploymentOffersMemory } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/memory")({
  /*
   * The personal edition has no memory (see `offersMemory`). This page once held the Bot's
   * check-ins too, which are on its Routines page now, so an old link there opens that.
   */
  beforeLoad: async ({ context, params }) => {
    if (!(await deploymentOffersMemory(context.queryClient))) {
      throw redirect({
        to: "/bots/$agentId/routines",
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
      description="Choose which apps this Bot learns from."
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
        </>
      )}
    </BotSubpage>
  );
}
