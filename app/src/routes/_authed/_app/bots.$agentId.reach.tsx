import { createFileRoute } from "@tanstack/react-router";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { ReachingYou } from "@/components/delivery/reaching-you";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/reach")({
  component: ReachPage,
});

function ReachPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Continue a conversation with this Bot in Slack, Microsoft Teams, or by text message."
      title="Reaching you"
    >
      {(agent) => (
        <div className="mt-6">
          <ReachingYou agentId={agent.id} />
        </div>
      )}
    </BotSubpage>
  );
}
