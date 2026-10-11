import { createFileRoute } from "@tanstack/react-router";
import { AccessSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/access")({
  component: AccessPage,
});

function AccessPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="The skills, apps and other Bots this Bot may use."
      title="Skills and access"
    >
      {(agent) => <AccessSections agent={agent} />}
    </BotSubpage>
  );
}
