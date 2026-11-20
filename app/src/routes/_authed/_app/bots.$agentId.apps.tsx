import { createFileRoute } from "@tanstack/react-router";
import { AppsSections } from "@/components/bot-profile/access";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

/** This Bot's Apps: yours it may use, and every app it holds with whether it's ready for you. */
export const Route = createFileRoute("/_authed/_app/bots/$agentId/apps")({
  component: AppsPage,
});

function AppsPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Manage the apps this Bot can use. Connect your accounts on Connections."
      title="Apps"
    >
      {(agent) => <AppsSections agent={agent} />}
    </BotSubpage>
  );
}
